/**
 * fsa-sim — mounted as a sub-router under /fsa in node-services-hub.
 *
 * Simulates the Farmers Service Advantage (FSA) centralized service operation
 * for the Voice Advantage IVR Phase 2 demo. FSA is the destination for service
 * intents after the WxCC + Webex AI Agent flow routes the call via RADD.
 *
 * Reference docs (in the farmers-voice-advantage-ivr repo):
 *   - requirements/voice-advantage-ivr-phase2-requirements-v1.2.md  (FR 7.2, FR 7.4, FR 8.2.2)
 *   - architecture/demo-build-outline.md                             (§7)
 *
 * Context: Farmers Service Advantage is the centralized service operation.
 * Two queues per spec §7 / FR 7.2 / FR 7.4:
 *   - VA_FSA_Destination (Unlicensed CSRs) — handles billing, documents
 *   - VA_FSA_LicDestination (Licensed CSRs) — handles id_cards, payment_question,
 *     and general service intents
 *
 * The Voice Advantage IVR transfers in via the destinations returned by RADD's
 * lookup_destination tool. This sim represents what happens once the call lands
 * at FSA.
 *
 * Pattern: mirrors apps/radd-sim/router.js — custom JSON-RPC 2.0 over HTTP,
 * in-memory hardcoded fixtures, per-app CORS, request log, manifest endpoint.
 *
 * Endpoints exposed under /fsa:
 *   GET  /fsa/             — JSON manifest
 *   GET  /fsa/health
 *   POST /fsa/mcp          — JSON-RPC (plain JSON, not SSE)
 *   GET  /fsa/mcp          — 405
 *   DELETE /fsa/mcp        — 405
 *   GET  /fsa/mcp-log      — last 20 requests
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
 * Simple deterministic hash for session_id → CSR assignment.
 * Returns an integer 0–7 for indexing into the CSR pool.
 */
function hashSessionId(sessionId) {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash << 5) - hash + sessionId.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash) % 8;
}

// ============================================================
// STATIC DATA — Hardcoded queues, CSRs, customer history for demo
// ============================================================

/**
 * QUEUES — Two FSA queues per FR 7.2 / FR 7.4.
 *
 * VA_FSA_Destination (Unlicensed): handles billing, documents
 * VA_FSA_LicDestination (Licensed): handles id_cards, payment_question, general service
 *
 * Baseline values (when FSA_SIM_PEAK_HOURS != "Y"):
 *   - Unlicensed: 6 callers ahead, 14/20 CSRs available, ~180s wait
 *   - Licensed: 9 callers ahead, 8/12 CSRs available, ~280s wait
 *
 * Peak-hours mode (FSA_SIM_PEAK_HOURS=Y): doubles wait times, reduces csrs_available by 40%.
 */
const QUEUES = {
  VA_FSA_Destination: {
    queue_label: "FSA Unlicensed CSR Pool",
    callers_ahead_base: 6,
    csrs_total: 20,
    csrs_available_base: 14,
    estimated_wait_seconds_base: 180,
  },
  VA_FSA_LicDestination: {
    queue_label: "FSA Licensed CSR Pool",
    callers_ahead_base: 9,
    csrs_total: 12,
    csrs_available_base: 8,
    estimated_wait_seconds_base: 280,
  },
};

/**
 * CSR_POOL — 8 CSRs with specializations.
 * Pseudo-random assignment by hash of session_id for determinism.
 *
 * Licensed CSRs (0–3): Auto, Home, Multi-line, Bristol West
 * Unlicensed CSRs (4–7): Billing, Documents, Billing, ID cards
 */
const CSR_POOL = [
  { csr_name: "Jennifer Williams", csr_id: "FSA-L-001", csr_specialization: "Licensed - Auto" },
  { csr_name: "Marcus Thompson", csr_id: "FSA-L-002", csr_specialization: "Licensed - Home" },
  { csr_name: "Aisha Patel", csr_id: "FSA-L-003", csr_specialization: "Licensed - Multi-line" },
  { csr_name: "Carlos Rivera", csr_id: "FSA-L-004", csr_specialization: "Licensed - Bristol West" },
  { csr_name: "Emily Foster", csr_id: "FSA-U-005", csr_specialization: "Unlicensed - Billing" },
  { csr_name: "Daniel Kim", csr_id: "FSA-U-006", csr_specialization: "Unlicensed - Documents" },
  { csr_name: "Rachel O'Brien", csr_id: "FSA-U-007", csr_specialization: "Unlicensed - Billing" },
  { csr_name: "Tom Nakamura", csr_id: "FSA-U-008", csr_specialization: "Unlicensed - ID cards" },
];

/**
 * CUSTOMER_HISTORY — Prior FSA interactions for the 3 demo ANIs.
 *
 * 6235550111 John Smith: 1 prior interaction 8 days ago, billing question, resolved by Emily Foster, 412s
 * 6235550112 Maria Garcia: 2 prior interactions — 22 days ago payment_question (resolved by Aisha Patel, 287s)
 *                          and 67 days ago documents (resolved by Daniel Kim, 195s)
 * 6235550113 Robert Chen: no prior interactions, found=true with empty array
 */
const CUSTOMER_HISTORY = {
  "6235550111": [
    {
      date: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      queue_type: "VA_FSA_Destination",
      intent: "billing",
      csr_name: "Emily Foster",
      resolution: "resolved",
      duration_seconds: 412,
    },
  ],
  "6235550112": [
    {
      date: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      queue_type: "VA_FSA_LicDestination",
      intent: "payment_question",
      csr_name: "Aisha Patel",
      resolution: "resolved",
      duration_seconds: 287,
    },
    {
      date: new Date(Date.now() - 67 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      queue_type: "VA_FSA_Destination",
      intent: "documents",
      csr_name: "Daniel Kim",
      resolution: "resolved",
      duration_seconds: 195,
    },
  ],
  "6235550113": [],
};

/**
 * SESSION_STORE — in-memory map of session_id → session data.
 * Tracks active FSA sessions for lookup_csr_assignment and end_fsa_session.
 */
const SESSION_STORE = new Map();

/**
 * Peak-hours toggle — env-driven so a presenter can flip it on stage
 * to demo the "peak-volume" scenario. Default N (normal hours).
 * Set FSA_SIM_PEAK_HOURS=Y before starting the server to flip.
 */
function isPeakHours() {
  const env = (process.env.FSA_SIM_PEAK_HOURS || "N").toUpperCase();
  return env === "Y";
}

/**
 * Get current queue status with optional peak-hours adjustments.
 * Adds slight random jitter (±10%) for realism.
 */
function getQueueStatus(queueType) {
  const queue = QUEUES[queueType];
  if (!queue) return null;

  const peakMode = isPeakHours();
  const jitter = () => 0.9 + Math.random() * 0.2; // 0.9–1.1

  let callersAhead = Math.round(queue.callers_ahead_base * jitter());
  let csrsAvailable = queue.csrs_available_base;
  let estimatedWait = Math.round(queue.estimated_wait_seconds_base * jitter());

  if (peakMode) {
    estimatedWait *= 2;
    csrsAvailable = Math.max(1, Math.round(csrsAvailable * 0.6)); // reduce by 40%
    callersAhead = Math.round(callersAhead * 1.5);
  }

  const slaCompliant = estimatedWait < 300; // SLA: < 5 minutes

  return {
    queue_type: queueType,
    queue_label: queue.queue_label,
    callers_ahead: callersAhead,
    estimated_wait_seconds: estimatedWait,
    csrs_available: csrsAvailable,
    csrs_total: queue.csrs_total,
    sla_compliant: slaCompliant,
  };
}

// ============================================================
// TOOL SCHEMAS
// ============================================================

const TOOL_SCHEMAS = [
  {
    name: "route_to_fsa_queue",
    description:
      "Entry point for routing a call to the Farmers Service Advantage (FSA) queue. Per FR 7.2 / FR 7.4, FSA has two queues: VA_FSA_Destination (Unlicensed CSRs for billing/documents) and VA_FSA_LicDestination (Licensed CSRs for id_cards/payment_question/general service). Returns a session_id, queue position, estimated wait time, CSR pool size, and intent acknowledgment. The session_id is used for subsequent lookup_csr_assignment and end_fsa_session calls.",
    inputSchema: {
      type: "object",
      properties: {
        queueType: {
          type: "string",
          enum: ["licensed", "unlicensed", "VA_FSA_Destination", "VA_FSA_LicDestination"],
          description:
            "Which FSA queue to route to. 'licensed' or 'VA_FSA_LicDestination' = Licensed CSRs (id_cards, payment_question, general service). 'unlicensed' or 'VA_FSA_Destination' = Unlicensed CSRs (billing, documents).",
        },
        customerId: {
          type: "string",
          description:
            "Customer identifier (phone number/ANI). Used for customer history lookup and session tracking. Accepts any common format.",
        },
        reason: {
          type: "string",
          description:
            "The customer's service intent (from the 11 Phase 2 intents). Examples: billing, documents, id_cards, payment_question, policy_change, add_driver, etc. Used for routing validation and logging.",
        },
        policyId: {
          type: "string",
          description:
            "Optional policy identifier. If provided, logged with the session for CSR context.",
        },
      },
      required: ["queueType", "customerId", "reason"],
    },
  },
  {
    name: "get_queue_status",
    description:
      "Returns current status of an FSA queue: callers ahead, estimated wait time, CSRs available/total, and SLA compliance. Per FR 8.2.2, this helps the agent set customer expectations ('You're number 6 in the queue, estimated wait is 3 minutes'). Uses slight random jitter for realism. If FSA_SIM_PEAK_HOURS=Y, wait times double and CSR availability drops by 40%.",
    inputSchema: {
      type: "object",
      properties: {
        queueType: {
          type: "string",
          enum: ["licensed", "unlicensed", "VA_FSA_Destination", "VA_FSA_LicDestination"],
          description:
            "Which FSA queue to check. 'licensed' or 'VA_FSA_LicDestination' = Licensed. 'unlicensed' or 'VA_FSA_Destination' = Unlicensed.",
        },
      },
      required: ["queueType"],
    },
  },
  {
    name: "lookup_csr_assignment",
    description:
      "Looks up the CSR assigned to a session. For the demo, this ALWAYS returns a CSR after the first call (deterministic assignment by hash of session_id). Returns CSR name, ID, specialization, and connection timestamp. If session_id not found, returns found=false. Per FR 8.2.2, the agent can use this to say 'You're now connected with Jennifer Williams, our Auto specialist.'",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "The session_id returned by route_to_fsa_queue. Used to look up the assigned CSR.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "lookup_customer_history",
    description:
      "Returns recent FSA interaction history for the caller. Useful for the agent to say 'I see you called us 3 days ago about billing.' Returns ANI, found flag, and an array of interactions (date, queue_type, intent, csr_name, resolution, duration_seconds). Uses fixtures for the 3 demo ANIs only. Other ANIs return found=true with an empty interactions array.",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description:
            "Caller's phone number (ANI). Accepts any common format. Demo ANIs: 6235550111, 6235550112, 6235550113.",
        },
      },
      required: ["ani"],
    },
  },
  {
    name: "end_fsa_session",
    description:
      "Ends an FSA session and records the outcome. Outcome enum: resolved (issue fixed), escalated (transferred to supervisor), callback_scheduled (CSR will call back), abandoned (customer hung up). Returns session_id, outcome, duration_seconds, and recorded_at timestamp. Per FR 8.2.2, this closes the loop for session tracking and analytics.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id returned by route_to_fsa_queue.",
        },
        outcome: {
          type: "string",
          enum: ["resolved", "escalated", "callback_scheduled", "abandoned"],
          description:
            "How the session ended. resolved = issue fixed. escalated = transferred to supervisor. callback_scheduled = CSR will call back. abandoned = customer hung up.",
        },
        notes: {
          type: "string",
          description:
            "Optional free-text notes from the CSR. Logged with the session for future reference.",
        },
      },
      required: ["session_id", "outcome"],
    },
  },
];

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleRouteToFsaQueue({ queueType, customerId, reason, policyId }) {
  // Normalize queueType: accept both shorthand ("licensed"/"unlicensed") and full names
  let queue_type = queueType;
  if (queueType === "licensed") queue_type = "VA_FSA_LicDestination";
  if (queueType === "unlicensed") queue_type = "VA_FSA_Destination";

  const normalizedAni = normalizePhone(customerId);
  if (!normalizedAni) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "customerId is required and must contain digits." },
            null,
            2,
          ),
        },
      ],
    };
  }

  const queueStatus = getQueueStatus(queue_type);
  if (!queueStatus) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              message: `Unknown queueType '${queueType}'. Valid types: licensed, unlicensed, VA_FSA_Destination, VA_FSA_LicDestination.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Generate session_id: timestamp + normalized ANI + random suffix
  const sessionId = `FSA-${Date.now()}-${normalizedAni}-${Math.random().toString(36).substring(2, 6)}`;

  // Store session
  SESSION_STORE.set(sessionId, {
    queue_type,
    ani: normalizedAni,
    intent: reason,
    policy_id: policyId || null,
    created_at: new Date().toISOString(),
    csr_assigned: false,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            session_id: sessionId,
            queue_type,
            queue_position: queueStatus.callers_ahead + 1,
            estimated_wait_seconds: queueStatus.estimated_wait_seconds,
            csr_pool_size: queueStatus.csrs_total,
            intent_acknowledged: reason,
            message: `Routed to ${queueStatus.queue_label}. You are number ${queueStatus.callers_ahead + 1} in the queue. Estimated wait: ${Math.round(queueStatus.estimated_wait_seconds / 60)} minutes.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleGetQueueStatus({ queueType }) {
  // Normalize queueType: accept both shorthand ("licensed"/"unlicensed") and full names
  let queue_type = queueType;
  if (queueType === "licensed") queue_type = "VA_FSA_LicDestination";
  if (queueType === "unlicensed") queue_type = "VA_FSA_Destination";

  const queueStatus = getQueueStatus(queue_type);
  if (!queueStatus) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              message: `Unknown queueType '${queueType}'. Valid types: licensed, unlicensed, VA_FSA_Destination, VA_FSA_LicDestination.`,
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
        text: JSON.stringify(queueStatus, null, 2),
      },
    ],
  };
}

async function handleLookupCsrAssignment({ session_id }) {
  const session = SESSION_STORE.get(session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              session_id,
              message: "Session not found. Ensure route_to_fsa_queue was called first.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Deterministic CSR assignment by hash of session_id
  const csrIndex = hashSessionId(session_id);
  const csr = CSR_POOL[csrIndex];

  // Mark CSR as assigned (for demo purposes, always succeeds on first call)
  if (!session.csr_assigned) {
    session.csr_assigned = true;
    session.connected_at = new Date().toISOString();
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            found: true,
            session_id,
            csr_name: csr.csr_name,
            csr_id: csr.csr_id,
            csr_specialization: csr.csr_specialization,
            connected_at: session.connected_at,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleLookupCustomerHistory({ ani }) {
  const normalizedAni = normalizePhone(ani);
  const history = CUSTOMER_HISTORY[normalizedAni];

  if (history === undefined) {
    // ANI not in demo fixtures — return found=true with empty array
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ani: normalizedAni,
              found: true,
              interactions: [],
              message: "No prior FSA interactions found for this customer.",
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
            ani: normalizedAni,
            found: true,
            interactions: history,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleEndFsaSession({ session_id, outcome, notes }) {
  const session = SESSION_STORE.get(session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              session_id,
              message: "Session not found. Cannot end a session that doesn't exist.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const now = new Date();
  const createdAt = new Date(session.created_at);
  const durationSeconds = Math.round((now - createdAt) / 1000);

  // Record outcome (in a real system, this would persist to a database)
  session.ended_at = now.toISOString();
  session.outcome = outcome;
  session.notes = notes || null;
  session.duration_seconds = durationSeconds;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            session_id,
            outcome,
            duration_seconds: durationSeconds,
            recorded_at: session.ended_at,
            message: `Session ended with outcome: ${outcome}. Duration: ${durationSeconds}s.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const TOOL_HANDLERS = {
  route_to_fsa_queue: handleRouteToFsaQueue,
  get_queue_status: handleGetQueueStatus,
  lookup_csr_assignment: handleLookupCsrAssignment,
  lookup_customer_history: handleLookupCustomerHistory,
  end_fsa_session: handleEndFsaSession,
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
            serverInfo: { name: "FSA Simulator", version: "0.1.1" },
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
        console.log(`[fsa][MCP] Result: ${result.content[0].text.substring(0, 100)}...`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[fsa][MCP] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[fsa][MCP] Error:", err);
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
      `[fsa][MCP] POST /fsa/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[fsa][MCP]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
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
    service: "fsa-sim",
    version: "0.1.0",
    tools: TOOL_SCHEMAS.map((t) => t.name),
    timestamp: new Date().toISOString(),
    fixtures: {
      queues: Object.keys(QUEUES).length,
      csrs: CSR_POOL.length,
      customer_history_records: Object.keys(CUSTOMER_HISTORY).length,
      active_sessions: SESSION_STORE.size,
    },
    peak_hours_mode: isPeakHours(),
  });
});

router.get("/", (_req, res) => {
  res.json({
    name: "FSA Simulator",
    description:
      "Simulates the Farmers Service Advantage (FSA) centralized service operation for the Voice Advantage IVR Phase 2 demo. Provides queue routing, CSR assignment, customer history lookup, and session management MCP tools for the Webex AI Agent.",
    version: "0.1.0",
    tools: TOOL_SCHEMAS.map((t) => t.name),
    health: "/fsa/health",
    mcp_endpoint: "/fsa/mcp",
    mcp_log: "/fsa/mcp-log",
    demo_fixtures: {
      queues: Object.keys(QUEUES),
      csrs: CSR_POOL.length,
      customer_history_anis: Object.keys(CUSTOMER_HISTORY),
    },
    peak_hours_mode: isPeakHours(),
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

router.get("/mcp", (req, res) => {
  // Streamable HTTP transport: open SSE stream for server→client messages.
  // We have no server-initiated messages to push, so stream stays idle with keepalives.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* socket closed */ }
  }, 15000);
  req.on("close", () => clearInterval(keepalive));
});

router.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Session management not supported in stateless mode." });
});

export default router;
