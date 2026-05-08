/**
 * claims-ivr-sim — mounted as a sub-router under /claims in node-services-hub.
 *
 * Simulates the Farmers Claims IVR at 8664557827 that the Voice Advantage IVR
 * transfers to (per spec §5.2) when intent=claims AND agency.claimsToAgent=N.
 * This is a downstream IVR — the AI agent transfers the call to it; this sim
 * represents what happens once the call lands.
 *
 * Reference docs (in the farmers-voice-advantage-ivr repo):
 *   - requirements/voice-advantage-ivr-phase2-requirements-v1.2.md  (FR-5.2)
 *
 * Pattern: mirrors apps/radd-sim/router.js — custom JSON-RPC 2.0 over HTTP,
 * in-memory hardcoded fixtures, per-app CORS, request log, manifest endpoint.
 *
 * Endpoints exposed under /claims:
 *   GET  /claims/             — JSON manifest
 *   GET  /claims/health
 *   POST /claims/mcp          — JSON-RPC (plain JSON, not SSE)
 *   GET  /claims/mcp          — 405
 *   DELETE /claims/mcp        — 405
 *   GET  /claims/mcp-log      — last 20 requests
 */

import express from "express";

// ============================================================
// HELPERS — phone normalization
// ============================================================

/**
 * Strip a phone number to bare digits and, for US numbers, drop a leading "1".
 * Lookups are tolerant of "+1 555 010 1234", "(555) 010-1234", "5550101234",
 * "15550101234", etc. — all collapse to "5550101234".
 */
function normalizePhone(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * Generate random jitter for queue metrics to make them look realistic.
 * Returns a small integer offset: -2 to +2.
 */
function jitter() {
  return Math.floor(Math.random() * 5) - 2;
}

/**
 * Format a date as "N days ago" for fixture timestamps.
 */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

// ============================================================
// STATIC DATA — Hardcoded claims + queues for demo purposes
// ============================================================

/**
 * CLAIMS — keyed lookup by claim number.
 *
 * Cross-referenced to demo ANIs from radd-sim via PNI (Primary Named Insured).
 * These are in-flight claims that callers can look up or follow up on.
 */
const CLAIMS = {
  "CLM-100200300": {
    claim_number: "CLM-100200300",
    status: "pending_inspection",
    loss_date: daysAgo(14),
    loss_type: "auto_collision",
    adjuster_name: "Sarah Mitchell",
    adjuster_phone: "8005550199",
    adjuster_extension: "4521",
    last_update: daysAgo(2),
    pni: "John Smith",
    ani: "6235550111",
  },
  "CLM-100200301": {
    claim_number: "CLM-100200301",
    status: "in_review",
    loss_date: daysAgo(28),
    loss_type: "home_water",
    adjuster_name: "David Park",
    adjuster_phone: "8005550199",
    adjuster_extension: "4533",
    last_update: daysAgo(5),
    pni: "Maria Garcia",
    ani: "6235550112",
  },
  "CLM-100200302": {
    claim_number: "CLM-100200302",
    status: "payment_issued",
    loss_date: daysAgo(45),
    loss_type: "auto_glass",
    adjuster_name: "Lisa Rodriguez",
    adjuster_phone: "8005550199",
    adjuster_extension: "4515",
    last_update: daysAgo(12),
    pni: "Robert Chen",
    ani: "6235550113",
  },
};

/**
 * ANI_TO_CLAIM — reverse lookup from ANI to claim number.
 * Used by route_claim_call to determine if the caller has an open claim.
 */
const ANI_TO_CLAIM = {};
for (const [claimNum, claim] of Object.entries(CLAIMS)) {
  const normalized = normalizePhone(claim.ani);
  if (normalized) ANI_TO_CLAIM[normalized] = claimNum;
}

/**
 * QUEUE_SEEDS — baseline metrics for the three claims queues.
 * Actual values returned by get_queue_status add small random jitter.
 */
const QUEUE_SEEDS = {
  open_claim_followup: { callers_ahead: 4, agents_available: 8, base_wait: 120 },
  new_claim_intake: { callers_ahead: 7, agents_available: 12, base_wait: 180 },
  general_claims: { callers_ahead: 11, agents_available: 6, base_wait: 300 },
};

/**
 * HIGH_VOLUME mode — env-driven demo helper for "storm event" scenario.
 * Set CLAIMS_SIM_HIGH_VOLUME=Y to multiply wait times by 3 and add 10 callers.
 */
function isHighVolume() {
  return (process.env.CLAIMS_SIM_HIGH_VOLUME || "N").toUpperCase() === "Y";
}

/**
 * CLAIM_COUNTER — used to generate new claim numbers in start_new_claim_intake.
 * Starts at 100200303 (one past the last fixture claim).
 */
let CLAIM_COUNTER = 100200303;

// ============================================================
// TOOL SCHEMAS
// ============================================================

const TOOL_SCHEMAS = [
  {
    name: "route_claim_call",
    description:
      "Entry point when a call is transferred into the Farmers Claims IVR (per FR 5.2). Determines the appropriate queue based on whether the caller has an open claim and whether a policy_id was provided. Returns session_id, queue assignment, estimated wait time, and the prompt that was played to the caller. Queue logic: has_open_claim=true → open_claim_followup (120s wait); has_open_claim=false AND policy_id provided → new_claim_intake (180s wait); no policy_id → general_claims (300s wait). Wait times are tripled if CLAIMS_SIM_HIGH_VOLUME=Y.",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description:
            "Automatic Number Identification — the caller's phone number. Used to look up existing claims. Accepts any common format. Demo ANIs: 6235550111 (John Smith, open claim), 6235550112 (Maria Garcia, open claim), 6235550113 (Robert Chen, open claim).",
        },
        has_open_claim: {
          type: "boolean",
          description:
            "Whether the caller has an open claim (determined by the Voice Advantage IVR via RADD lookup before transfer). If true, routes to open_claim_followup queue.",
        },
        policy_id: {
          type: "string",
          description:
            "Optional policy ID provided by the Voice Advantage IVR. If has_open_claim=false and policy_id is provided, routes to new_claim_intake. If missing, routes to general_claims.",
        },
      },
      required: ["ani", "has_open_claim"],
    },
  },
  {
    name: "lookup_claim_status",
    description:
      "Looks up the status of an existing claim by claim number. Returns claim_number, status (open, pending_inspection, in_review, payment_issued, closed), loss_date, loss_type, adjuster_name, adjuster_phone, and last_update timestamp. If the claim number is not found in the system, returns found=false.",
    inputSchema: {
      type: "object",
      properties: {
        claim_number: {
          type: "string",
          description:
            "The claim number to look up. Format: CLM-NNNNNNNNN (9 digits). Demo claims: CLM-100200300 (auto collision, pending inspection), CLM-100200301 (home water, in review), CLM-100200302 (auto glass, payment issued).",
        },
      },
      required: ["claim_number"],
    },
  },
  {
    name: "start_new_claim_intake",
    description:
      "Initiates a new claim intake process. Generates a new claim number, assigns it to the caller, and returns the next steps. The loss_type parameter determines the intake workflow and adjuster assignment. Returns intake_id, claim_number_assigned, next_step instructions, and agent_callback_eta_minutes. The claim is created in pending status and will be assigned an adjuster within the callback window.",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description: "The caller's phone number. Required for claim record creation.",
        },
        policy_id: {
          type: "string",
          description:
            "The policy ID associated with the claim. Required to validate coverage and link the claim to the correct policy.",
        },
        loss_type: {
          type: "string",
          enum: ["auto_collision", "auto_glass", "home_water", "home_fire", "roadside", "other"],
          description:
            "The type of loss being claimed. Determines the intake workflow and adjuster assignment. auto_collision = vehicle collision damage, auto_glass = windshield/glass damage, home_water = water damage to home, home_fire = fire damage to home, roadside = roadside assistance, other = other loss types.",
        },
      },
      required: ["ani", "policy_id", "loss_type"],
    },
  },
  {
    name: "get_queue_status",
    description:
      "Returns current queue metrics for a specified claims queue. Shows the number of callers ahead, estimated wait time in seconds, and number of agents available. Metrics include small random variation to simulate real-time queue dynamics. If CLAIMS_SIM_HIGH_VOLUME=Y, wait times are tripled and callers_ahead is increased by 10 to simulate a storm event or high-volume period.",
    inputSchema: {
      type: "object",
      properties: {
        queue: {
          type: "string",
          enum: ["open_claim_followup", "new_claim_intake", "general_claims"],
          description:
            "Which queue to check. open_claim_followup = callers with existing open claims (fastest), new_claim_intake = callers starting a new claim with policy ID (medium), general_claims = callers without policy ID or unrecognized (slowest).",
        },
      },
      required: ["queue"],
    },
  },
  {
    name: "transfer_to_adjuster",
    description:
      "Attempts to transfer the caller directly to the adjuster assigned to their claim. Returns adjuster_name, adjuster_extension, and transferred_at timestamp if the claim is found and has an assigned adjuster. If the claim is not found or has no adjuster assigned yet, returns found=false with a reason code (no_adjuster_assigned or claim_not_found).",
    inputSchema: {
      type: "object",
      properties: {
        claim_number: {
          type: "string",
          description:
            "The claim number to look up the adjuster for. Format: CLM-NNNNNNNNN. Must be an existing claim with an assigned adjuster.",
        },
      },
      required: ["claim_number"],
    },
  },
];

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleRouteClaimCall({ ani, has_open_claim, policy_id }) {
  const normalizedAni = normalizePhone(ani);
  const sessionId = `CLMSESS-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  let queue;
  let baseWait;
  let promptPlayed;

  if (has_open_claim) {
    queue = "open_claim_followup";
    baseWait = QUEUE_SEEDS[queue].base_wait;
    promptPlayed =
      "Thank you for calling Farmers Claims. I see you have an open claim. Please hold while we connect you to a claims specialist.";
  } else if (policy_id) {
    queue = "new_claim_intake";
    baseWait = QUEUE_SEEDS[queue].base_wait;
    promptPlayed =
      "Thank you for calling Farmers Claims. I'll help you start a new claim. Please hold while we connect you to a claims intake specialist.";
  } else {
    queue = "general_claims";
    baseWait = QUEUE_SEEDS[queue].base_wait;
    promptPlayed =
      "Thank you for calling Farmers Claims. Please hold while we connect you to a claims representative.";
  }

  const highVolume = isHighVolume();
  const estimatedWait = highVolume ? baseWait * 3 : baseWait;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            session_id: sessionId,
            queue,
            estimated_wait_seconds: estimatedWait,
            prompt_played: promptPlayed,
            high_volume_mode: highVolume,
            note: highVolume
              ? "High volume mode active (CLAIMS_SIM_HIGH_VOLUME=Y) — wait times tripled to simulate storm event."
              : "Normal volume mode.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleLookupClaimStatus({ claim_number }) {
  const claim = CLAIMS[claim_number];

  if (!claim) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              claim_number,
              message: `Claim ${claim_number} not found in system. Demo claims: ${Object.keys(
                CLAIMS,
              ).join(", ")}.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            found: true,
            claim_number: claim.claim_number,
            status: claim.status,
            loss_date: claim.loss_date,
            loss_type: claim.loss_type,
            adjuster_name: claim.adjuster_name,
            adjuster_phone: claim.adjuster_phone,
            last_update: claim.last_update,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleStartNewClaimIntake({ ani, policy_id, loss_type }) {
  const normalizedAni = normalizePhone(ani);
  const claimNumber = `CLM-${String(CLAIM_COUNTER++).padStart(9, "0")}`;
  const intakeId = `INTAKE-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Estimate callback time based on loss type (more complex claims take longer)
  let callbackEta;
  switch (loss_type) {
    case "auto_glass":
    case "roadside":
      callbackEta = 30;
      break;
    case "auto_collision":
      callbackEta = 45;
      break;
    case "home_water":
    case "home_fire":
      callbackEta = 60;
      break;
    default:
      callbackEta = 45;
  }

  const highVolume = isHighVolume();
  if (highVolume) callbackEta *= 2;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            intake_id: intakeId,
            claim_number_assigned: claimNumber,
            next_step:
              "Your claim has been created. A claims adjuster will call you back to gather additional details and schedule an inspection if needed.",
            agent_callback_eta_minutes: callbackEta,
            loss_type,
            policy_id,
            high_volume_mode: highVolume,
            note: `Claim ${claimNumber} created for ANI ${normalizedAni}. Callback ETA: ${callbackEta} minutes.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleGetQueueStatus({ queue }) {
  const seed = QUEUE_SEEDS[queue];

  if (!seed) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              queue,
              message: `Unknown queue '${queue}'. Valid queues: ${Object.keys(QUEUE_SEEDS).join(
                ", ",
              )}.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const highVolume = isHighVolume();
  const callersAhead = Math.max(
    0,
    seed.callers_ahead + jitter() + (highVolume ? 10 : 0),
  );
  const agentsAvailable = Math.max(1, seed.agents_available + jitter());
  const baseWait = seed.base_wait;
  const estimatedWait = highVolume ? baseWait * 3 : baseWait;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            queue,
            callers_ahead: callersAhead,
            estimated_wait_seconds: estimatedWait,
            agents_available: agentsAvailable,
            high_volume_mode: highVolume,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleTransferToAdjuster({ claim_number }) {
  const claim = CLAIMS[claim_number];

  if (!claim) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              claim_number,
              reason: "claim_not_found",
              message: `Claim ${claim_number} not found in system.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Check if claim has an assigned adjuster (all fixture claims do, but new claims might not)
  if (!claim.adjuster_name) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              claim_number,
              reason: "no_adjuster_assigned",
              message: `Claim ${claim_number} does not have an assigned adjuster yet. Please hold for the next available agent.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            found: true,
            claim_number: claim.claim_number,
            adjuster_name: claim.adjuster_name,
            adjuster_extension: claim.adjuster_extension,
            transferred_at: new Date().toISOString(),
            message: `Transferring to ${claim.adjuster_name}, extension ${claim.adjuster_extension}.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const TOOL_HANDLERS = {
  route_claim_call: handleRouteClaimCall,
  lookup_claim_status: handleLookupClaimStatus,
  start_new_claim_intake: handleStartNewClaimIntake,
  get_queue_status: handleGetQueueStatus,
  transfer_to_adjuster: handleTransferToAdjuster,
};

// ============================================================
// JSON-RPC HANDLER (mirrors radd-sim pattern)
// ============================================================

async function handleJsonRpc(body) {
  const { method, params, id } = body;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          result: {
            protocolVersion: params?.protocolVersion || "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "Claims IVR Simulator", version: "0.1.0" },
          },
          id,
        };

      case "notifications/initialized":
        return { jsonrpc: "2.0", result: {}, id };

      case "ping":
        return { jsonrpc: "2.0", result: {}, id };

      case "tools/list":
        return { jsonrpc: "2.0", result: { tools: TOOL_SCHEMAS }, id };

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const handler = TOOL_HANDLERS[toolName];

        if (!handler) {
          return {
            jsonrpc: "2.0",
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
            id,
          };
        }

        const result = await handler(toolArgs);
        console.log(`[claims][MCP] Result: ${result.content[0].text.substring(0, 100)}...`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[claims][MCP] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[claims][MCP] Error:", err);
    return {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: id || null,
    };
  }
}

// ============================================================
// REQUEST LOG
// ============================================================

const REQUEST_LOG = [];
const MAX_LOG_ENTRIES = 50;

// ============================================================
// ROUTER
// ============================================================

const router = express.Router();

// Per-app CORS — same allowlist as radd-sim so the Webex AI
// Agent Studio MCP client can send Mcp-Session-Id without preflight failure.
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id",
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Request logging for /mcp — captures into REQUEST_LOG ring buffer.
router.use("/mcp", (req, res, next) => {
  if (req.method === "POST") {
    const logEntry = {
      timestamp: new Date().toISOString(),
      method: req.body?.method || "(no method)",
      headers: { ...req.headers },
      body: req.body,
      response: null,
    };

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      logEntry.response = data;
      REQUEST_LOG.push(logEntry);
      if (REQUEST_LOG.length > MAX_LOG_ENTRIES) REQUEST_LOG.shift();
      return originalJson(data);
    };

    const accept = req.headers["accept"] || "(none)";
    const contentType = req.headers["content-type"] || "(none)";
    console.log(
      `[claims][MCP] POST /claims/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[claims][MCP]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
          req.body?.params?.arguments,
        )}`,
      );
    }
  }
  next();
});

router.get("/mcp-log", (_req, res) => {
  res.json({
    total_requests: REQUEST_LOG.length,
    requests: REQUEST_LOG.slice(-20).reverse(),
  });
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "claims-ivr-sim",
    version: "0.1.0",
    tools: TOOL_SCHEMAS.map((t) => t.name),
    timestamp: new Date().toISOString(),
    fixtures: {
      claims: Object.keys(CLAIMS).length,
      queues: Object.keys(QUEUE_SEEDS).length,
    },
    high_volume_mode: isHighVolume(),
  });
});

router.get("/", (_req, res) => {
  res.json({
    name: "Claims IVR Simulator",
    description:
      "Simulates the Farmers Claims IVR at 8664557827 that the Voice Advantage IVR transfers to (per spec §5.2) when intent=claims AND agency.claimsToAgent=N. This is a downstream IVR — the AI agent transfers the call to it; this sim represents what happens once the call lands.",
    version: "0.1.0",
    tools: TOOL_SCHEMAS.map((t) => t.name),
    health: "/claims/health",
    mcp_endpoint: "/claims/mcp",
    mcp_log: "/claims/mcp-log",
    demo_fixtures: {
      claims: Object.keys(CLAIMS),
      queues: Object.keys(QUEUE_SEEDS),
    },
    high_volume_mode: isHighVolume(),
    env_vars: {
      CLAIMS_SIM_HIGH_VOLUME:
        "Set to Y to simulate storm event (3x wait times, +10 callers ahead)",
    },
  });
});

router.post("/mcp", async (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) {
      const r = await handleJsonRpc(item);
      if (r) results.push(r);
    }
    return res.json(results);
  }
  return res.json(await handleJsonRpc(body));
});

router.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});

router.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Session management not supported in stateless mode." });
});

export default router;
