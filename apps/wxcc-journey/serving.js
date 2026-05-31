/**
 * serving.js — Node.js port of the Python gRPC sidecar (serving_proxy.py).
 *
 * Calls Cisco WxCC AI Serving API via gRPC to fetch:
 *   - VA transcripts  (StreamingInsightServing — server-side streaming RPC)
 *   - VA wrap-up summaries (InsightServing — unary RPC)
 *
 * No code generation required — proto-loader loads .proto files at runtime.
 *
 * gRPC host pattern: serving-api-streaming.wxcc-{region}.cisco.com:443
 * Region is passed by the browser as X-WxCC-Region (same header used for REST proxy).
 */

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_ROOT = path.join(__dirname, "proto");
const SERVING_PROTO = path.join(PROTO_ROOT, "com/cisco/wcc/ccai/v1/serving.proto");

// Load proto package once at startup.
// enums: Number so raw integers pass through as-is — required because the
// InsightServing call uses insightType=5 which is an undocumented server-side
// value not present in the proto enum (0-4). With enums: String, proto-loader
// silently falls back to 0 (DEFAULT_TRANSCRIPTION) for unknown integers.
const packageDef = protoLoader.loadSync(SERVING_PROTO, {
  keepCase: true,
  longs: String,
  enums: Number,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
});
const proto = grpc.loadPackageDefinition(packageDef);
const AiInsight = proto.com.cisco.wcc.ccai.v1.AiInsight;

// Cache stubs per region — each stub maintains its own channel pool
const stubCache = new Map();
function getStub(region) {
  if (!stubCache.has(region)) {
    const host = `serving-api-streaming.wxcc-${region}.cisco.com:443`;
    stubCache.set(region, new AiInsight(host, grpc.credentials.createSsl()));
  }
  return stubCache.get(region);
}

// ─── Enum value maps (numeric → string) ──────────────────────────────────────
// With enums: Number, responses carry integers. Map them to the same strings
// the Python sidecar produced so the browser-side JS is unchanged.
const ROLE_MAP        = { 0: "IVR", 1: "CALLER", 2: "AGENT" };
const INSIGHT_MAP     = {
  0: "DEFAULT_TRANSCRIPTION",
  1: "AGENT_ANSWERS",
  2: "TRANSCRIPTION",
  3: "VIRTUAL_AGENT",
  4: "MESSAGE",
};
const CALL_INSIGHT_MAP = {
  0: "CALL_INSIGHT_TYPE_UNSPECIFIED",
  1: "VA_CALL_SUMMARY",
};

// ─── Response normalisation ───────────────────────────────────────────────────
// Mirrors normalize_response() in serving_proxy.py

function normalizeResponse(resp) {
  const role        = ROLE_MAP[resp.role]        ?? `UNKNOWN(${resp.role})`;
  const insightType = INSIGHT_MAP[resp.insightType] ?? `UNKNOWN(${resp.insightType})`;

  let text = "";
  const content = resp.responseContent;
  if (content) {
    if (resp.insightType === 3 /* VIRTUAL_AGENT */ && content.virtualAgentResult) {
      text = content.virtualAgentResult.raw || "";
    } else if (resp.insightType === 2 /* TRANSCRIPTION */ && content.recognitionResult) {
      const alts = content.recognitionResult.alternatives || [];
      text = alts[0]?.transcript || "";
    } else if (resp.insightType === 4 /* MESSAGE */ && content.messageResult) {
      text = content.messageResult.content || "";
    } else if (content.rawContent) {
      text = content.rawContent;
    }
  }

  return {
    ts:           parseInt(resp.publishTimestamp || "0", 10),
    role,
    insightType,
    text:         text.trim(),
    languageCode: resp.languageCode  || "",
    utteranceId:  resp.utteranceId   || "",
    isFinal:      resp.isFinal       || false,
    raw: {
      orgId:           resp.orgId,
      conversationId:  resp.conversationId,
      roleId:          resp.roleId,
      startTimestamp:  resp.startTimestamp,
      endTimestamp:    resp.endTimestamp,
      insightProvider: resp.insightProvider,
    },
  };
}

// ─── gRPC error → HTTP status mapping ────────────────────────────────────────

function grpcStatusToHttp(grpcCode) {
  const map = {
    [grpc.status.UNAUTHENTICATED]:  { status: 401, reason: "auth" },
    [grpc.status.PERMISSION_DENIED]:{ status: 403, reason: "forbidden" },
    [grpc.status.NOT_FOUND]:        { status: 404, reason: "not_found" },
    [grpc.status.DEADLINE_EXCEEDED]:{ status: 504, reason: "timeout" },
    [grpc.status.UNAVAILABLE]:      { status: 503, reason: "unavailable" },
  };
  return map[grpcCode] || { status: 500, reason: "grpc_error" };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch VA transcript for a task via StreamingInsightServing (server-side streaming).
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.orgId
 * @param {string} opts.token   — Bearer token
 * @param {string} [opts.region="us1"]
 * @returns {Promise<Array>}    — Normalised transcript entries sorted by ts, VA roles only
 * @throws  {object}            — { httpStatus, message } on gRPC error
 */
export function fetchVATranscript({ taskId, orgId, token, region = "us1" }) {
  return new Promise((resolve, reject) => {
    const stub = getStub(region);
    const metadata = new grpc.Metadata();
    metadata.add("authorization", `Bearer ${token}`);

    const call = stub.StreamingInsightServing(
      {
        insightServingRequest: {
          conversationId:      taskId,
          orgId,
          historicalTranscripts:    true,
          historicalVirtualAgent:   true,
          agentDetails: { agentId: "explorer" },
        },
      },
      metadata,
    );

    const results = [];

    call.on("data", (msg) => {
      const resp = msg.insightServingResponse;
      if (!resp) return;
      const n = normalizeResponse(resp);
      // Drop non-final intermediate transcription and empty-text entries
      if (resp.insightType === 2 /* TRANSCRIPTION */ && !n.isFinal) return;
      if (!n.text) return;
      results.push(n);
    });

    call.on("error", (err) => {
      const { status, reason } = grpcStatusToHttp(err.code);
      reject({ httpStatus: status, message: err.details || reason });
    });

    call.on("end", () => {
      results.sort((a, b) => a.ts - b.ts);
      // Return VA-only: filter out human AGENT turns (role 2)
      resolve(results.filter((r) => r.role !== "AGENT"));
    });
  });
}

/**
 * Fetch VA wrap-up summary for a task via InsightServing (unary RPC).
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.orgId
 * @param {string} opts.token
 * @param {string} [opts.region="us1"]
 * @returns {Promise<object>}  — { summary, callInsightType, raw } or { summary: null, reason }
 * @throws  {object}           — { httpStatus, message } on gRPC error
 */
export function fetchVASummary({ taskId, orgId, token, region = "us1" }) {
  return new Promise((resolve, reject) => {
    const stub = getStub(region);
    const metadata = new grpc.Metadata();
    metadata.add("authorization", `Bearer ${token}`);

    stub.InsightServing(
      {
        conversationId: taskId,
        messageId:      "virtual-agent-call-summary",
        orgId,
        insightType:    5,   // Undocumented server-side value for call insights / VA summary
      },
      metadata,
      (err, response) => {
        if (err) {
          // NOT_FOUND is the normal "no summary for this call" case
          if (err.code === grpc.status.NOT_FOUND) {
            resolve({ summary: null, reason: "no_summary_for_call" });
            return;
          }
          const { status, reason } = grpcStatusToHttp(err.code);
          reject({ httpStatus: status, message: err.details || reason });
          return;
        }

        const contents = response?.responseContent || [];
        for (const content of contents) {
          if (content.callInsightsResult) {
            let summaryData = null;
            try {
              summaryData = content.callInsightsResult.content
                ? JSON.parse(content.callInsightsResult.content)
                : null;
            } catch {
              reject({ httpStatus: 500, message: "Invalid JSON in summary content" });
              return;
            }
              resolve({
                summary:         summaryData,
                callInsightType: CALL_INSIGHT_MAP[content.callInsightsResult.callInsightType] ?? `UNKNOWN(${content.callInsightsResult.callInsightType})`,
              raw: {
                conversationId:  response.conversationId,
                orgId:           response.orgId,
                configId:        response.configId,
                languageCode:    response.languageCode,
                startTimestamp:  response.startTimestamp,
                endTimestamp:    response.endTimestamp,
                insightProvider: response.insightProvider,
              },
            });
            return;
          }
        }

        // Response OK but no callInsightsResult found
        resolve({ summary: null, reason: "no_summary_for_call" });
      },
    );
  });
}
