/**
 * paymentus-sim — mounted as a sub-router under /paymentus in node-services-hub.
 *
 * Simulates the Paymentus payment portal for the Farmers Voice Advantage IVR
 * Phase 2 demo. Paymentus is the third-party payment processor that customers
 * are transferred to when they choose to make a payment (FR 6.4 / 6.5).
 *
 * Reference docs (in the farmers-voice-advantage-ivr repo):
 *   - requirements/voice-advantage-ivr-phase2-requirements-v1.2.md  (FR-6.4, FR-6.5)
 *   - architecture/demo-build-outline.md                             (§3c)
 *
 * Pattern: mirrors apps/radd-sim/router.js — custom JSON-RPC 2.0 over HTTP,
 * in-memory hardcoded fixtures, per-app CORS, request log, manifest endpoint.
 *
 * Endpoints exposed under /paymentus:
 *   GET  /paymentus/             — JSON manifest
 *   GET  /paymentus/health
 *   POST /paymentus/mcp          — JSON-RPC (plain JSON, not SSE)
 *   GET  /paymentus/mcp          — 405
 *   DELETE /paymentus/mcp        — 405
 *   GET  /paymentus/mcp-log      — last 20 requests
 */

import express from "express";

// ============================================================
// STATIC DATA — Hardcoded fixtures for demo purposes
// ============================================================

/**
 * PAYMENTUS_TFN — the toll-free number the IVR transfers customers to when
 * they choose to make a payment. Placeholder for the [TFN HERE] in spec FR 6.4.
 * Can be overridden via PAYMENTUS_SIM_TFN environment variable.
 */
const PAYMENTUS_TFN = process.env.PAYMENTUS_SIM_TFN || "8884447777";

/**
 * PAYMENT_SESSIONS — in-memory session store.
 * Keyed by session_id. Each session tracks:
 *   - session_id (generated)
 *   - ani (caller's phone number)
 *   - return_dnis (where the call should return to after payment)
 *   - amount_estimate (optional — the IVR's estimate of what the customer owes)
 *   - started_at (ISO timestamp)
 *   - payments (array of payment attempts)
 *   - ended_at (ISO timestamp, null if still active)
 *   - outcome (completed | abandoned | error, null if still active)
 */
const PAYMENT_SESSIONS = new Map();

/**
 * Pre-seeded completed sessions for demo recall (FR 6.5 — returning customer
 * scenarios). These sessions are already "completed" so get_payment_status
 * can return them immediately without requiring a full payment flow.
 */
const DEMO_SESSIONS = {
  "PMT-DEMO001": {
    session_id: "PMT-DEMO001",
    ani: "6235550111",
    return_dnis: "8005550101",
    amount_estimate: 185.42,
    started_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    payments: [
      {
        amount: 185.42,
        payment_method: "credit_card",
        status: "success",
        confirmation_number: "PMT-12345678",
        processed_at: new Date(Date.now() - 3540000).toISOString(),
      },
    ],
    ended_at: new Date(Date.now() - 3540000).toISOString(),
    outcome: "completed",
    pni: "John Smith",
    product: "AUTO",
  },
  "PMT-DEMO002": {
    session_id: "PMT-DEMO002",
    ani: "6235550112",
    return_dnis: "8005550102",
    amount_estimate: 312.99,
    started_at: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
    payments: [
      {
        amount: 312.99,
        payment_method: "debit_card",
        status: "success",
        confirmation_number: "PMT-23456789",
        processed_at: new Date(Date.now() - 7140000).toISOString(),
      },
    ],
    ended_at: new Date(Date.now() - 7140000).toISOString(),
    outcome: "completed",
    pni: "Maria Garcia",
    product: "Multiline",
  },
  "PMT-DEMO003": {
    session_id: "PMT-DEMO003",
    ani: "6235550113",
    return_dnis: "8005550101",
    amount_estimate: 89.5,
    started_at: new Date(Date.now() - 1800000).toISOString(), // 30 minutes ago
    payments: [
      {
        amount: 89.5,
        payment_method: "bank_account",
        status: "declined",
        confirmation_number: null,
        processed_at: new Date(Date.now() - 1740000).toISOString(),
        decline_reason: "Insufficient funds simulation",
      },
    ],
    ended_at: new Date(Date.now() - 1740000).toISOString(),
    outcome: "completed",
    pni: "Robert Chen",
    product: "BWI Auto",
  },
};

// Seed the demo sessions into the live store
for (const [id, session] of Object.entries(DEMO_SESSIONS)) {
  PAYMENT_SESSIONS.set(id, session);
}

/**
 * Environment-driven force-decline toggle. If PAYMENTUS_SIM_FORCE_DECLINE=Y,
 * every process_payment call returns declined regardless of amount/method.
 * Useful for demoing the decline path without needing to enter specific amounts.
 */
function shouldForceDecline() {
  return (process.env.PAYMENTUS_SIM_FORCE_DECLINE || "").toUpperCase() === "Y";
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Generate a random confirmation number for successful payments.
 * Format: PMT-XXXXXXXX (8 random digits).
 */
function generateConfirmationNumber() {
  const digits = Math.floor(10000000 + Math.random() * 90000000);
  return `PMT-${digits}`;
}

/**
 * Generate a unique session ID.
 * Format: PMT-YYYYMMDD-HHMMSS-RRR (timestamp + 3 random digits).
 */
function generateSessionId() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
  const randomPart = Math.floor(100 + Math.random() * 900);
  return `PMT-${datePart}-${randomPart}`;
}

/**
 * Determine payment status based on amount and payment method.
 * Business rules (from spec FR 6.4 / 6.5):
 *   - amount > 9999 → declined (unreasonably large)
 *   - payment_method = bank_account AND amount > 5000 → declined (ACH limit)
 *   - otherwise → success
 * If PAYMENTUS_SIM_FORCE_DECLINE=Y, always return declined.
 */
function determinePaymentStatus(amount, payment_method) {
  if (shouldForceDecline()) {
    return { status: "declined", decline_reason: "Force-decline mode enabled (PAYMENTUS_SIM_FORCE_DECLINE=Y)" };
  }

  if (amount > 9999) {
    return { status: "declined", decline_reason: "Amount exceeds maximum allowed ($9,999)" };
  }

  if (payment_method === "bank_account" && amount > 5000) {
    return { status: "declined", decline_reason: "Bank account payments limited to $5,000" };
  }

  return { status: "success" };
}

// ============================================================
// TOOL SCHEMAS
// ============================================================

const TOOL_SCHEMAS = [
  {
    name: "start_payment_session",
    description:
      "Creates a new Paymentus payment session for an inbound caller. Equivalent to the IVR transferring the customer to the Paymentus toll-free number (FR 6.4). Returns a session_id (for tracking), the paymentus_tfn (the toll-free number the customer would dial or be transferred to), the return_dnis (where the call should return after payment), and a started_at timestamp. The IVR should call upsert_session_data in RADD immediately after starting the payment session so the customer's routing context is preserved for when they return (FR 6.5).",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description:
            "The caller's ANI (phone number). Required — used as the lookup key when the customer returns from Paymentus.",
        },
        return_dnis: {
          type: "string",
          description:
            "The DNIS the call should return to after payment. Required — typically the original agency toll-free number the customer dialed.",
        },
        amount_estimate: {
          type: "number",
          description:
            "Optional — the IVR's estimate of what the customer owes (e.g. from a policy lookup). Paymentus may display this as a suggested amount but the customer can override it.",
        },
      },
      required: ["ani", "return_dnis"],
    },
  },
  {
    name: "process_payment",
    description:
      "Processes a payment for an active Paymentus session. Equivalent to the customer entering their payment details and submitting the payment (FR 6.4). Returns the session_id, status (success or declined), confirmation_number (if successful), amount, and processed_at timestamp. Status logic: amount > $9,999 → declined; payment_method = bank_account AND amount > $5,000 → declined; otherwise → success. If PAYMENTUS_SIM_FORCE_DECLINE=Y, all payments are declined regardless of amount/method (useful for demoing the decline path).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id returned by start_payment_session. Required.",
        },
        amount: {
          type: "number",
          description: "The payment amount in dollars. Required. Must be > 0.",
        },
        payment_method: {
          type: "string",
          enum: ["credit_card", "debit_card", "bank_account"],
          description:
            "The payment method the customer chose. Required. credit_card and debit_card have no special limits; bank_account is limited to $5,000.",
        },
      },
      required: ["session_id", "amount", "payment_method"],
    },
  },
  {
    name: "get_payment_status",
    description:
      "Retrieves the full state of a payment session including any payments processed. Equivalent to the IVR checking whether a returning customer successfully completed their payment (FR 6.5). Returns the session record with all payments, timestamps, and outcome. If the session_id is not found, returns found=false so the flow can handle the 'no record found' path (FR 6.5.2).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id to look up. Required.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "end_session",
    description:
      "Marks a payment session as ended with a specific outcome. Equivalent to the customer hanging up or the IVR explicitly closing the session (FR 6.5). Records the ended_at timestamp and outcome (completed, abandoned, or error), calculates the session duration, and returns the return_dnis so the IVR knows where to route the call back to. Once a session is ended, no further payments can be processed against it.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id to end. Required.",
        },
        outcome: {
          type: "string",
          enum: ["completed", "abandoned", "error"],
          description:
            "The session outcome. completed = customer finished payment flow (success or decline). abandoned = customer hung up mid-payment. error = system error occurred. Required.",
        },
      },
      required: ["session_id", "outcome"],
    },
  },
  {
    name: "simulate_caller_abandons",
    description:
      "Demo helper tool. Force-abandons a payment session as if the caller hung up mid-payment. Equivalent to the customer hanging up before completing the payment flow (FR 6.5.2 — exercises the 'no record found' / out-of-window paths upstream). Returns the session_id, outcome=abandoned, and abandoned_at timestamp. Useful for demoing the FR 6.5.2 error handling without needing to manually time out a session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id to abandon. Required.",
        },
      },
      required: ["session_id"],
    },
  },
];

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleStartPaymentSession({ ani, return_dnis, amount_estimate }) {
  if (!ani || !return_dnis) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "ani and return_dnis are required." },
            null,
            2,
          ),
        },
      ],
    };
  }

  const session_id = generateSessionId();
  const started_at = new Date().toISOString();

  const session = {
    session_id,
    ani,
    return_dnis,
    amount_estimate: amount_estimate || null,
    started_at,
    payments: [],
    ended_at: null,
    outcome: null,
  };

  PAYMENT_SESSIONS.set(session_id, session);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            session_id,
            paymentus_tfn: PAYMENTUS_TFN,
            return_dnis,
            started_at,
            message: `Payment session started. Customer should be transferred to ${PAYMENTUS_TFN}. IVR should call RADD upsert_session_data immediately to preserve routing context (FR 6.4).`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleProcessPayment({ session_id, amount, payment_method }) {
  if (!session_id || !amount || !payment_method) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "session_id, amount, and payment_method are required." },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (amount <= 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "amount must be greater than 0." },
            null,
            2,
          ),
        },
      ],
    };
  }

  const session = PAYMENT_SESSIONS.get(session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: `Session ${session_id} not found.` },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (session.ended_at) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              message: `Session ${session_id} is already ended (outcome: ${session.outcome}). Cannot process payment.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const { status, decline_reason } = determinePaymentStatus(amount, payment_method);
  const processed_at = new Date().toISOString();

  const payment = {
    amount,
    payment_method,
    status,
    confirmation_number: status === "success" ? generateConfirmationNumber() : null,
    processed_at,
  };

  if (decline_reason) {
    payment.decline_reason = decline_reason;
  }

  session.payments.push(payment);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            session_id,
            status,
            confirmation_number: payment.confirmation_number,
            amount,
            payment_method,
            processed_at,
            decline_reason: decline_reason || undefined,
            message:
              status === "success"
                ? `Payment of $${amount} processed successfully. Confirmation: ${payment.confirmation_number}.`
                : `Payment of $${amount} declined. Reason: ${decline_reason}.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleGetPaymentStatus({ session_id }) {
  if (!session_id) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "session_id is required." },
            null,
            2,
          ),
        },
      ],
    };
  }

  const session = PAYMENT_SESSIONS.get(session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              session_id,
              message: `No payment session found for ${session_id}. Per FR 6.5.2, set no_cust_Pmnts_error=Yes and play prompt 33 ('There seems to be a problem with the automated system…').`,
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
            session: session,
            message: session.ended_at
              ? `Session ended at ${session.ended_at} with outcome: ${session.outcome}.`
              : "Session is still active.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleEndSession({ session_id, outcome }) {
  if (!session_id || !outcome) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "session_id and outcome are required." },
            null,
            2,
          ),
        },
      ],
    };
  }

  const session = PAYMENT_SESSIONS.get(session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: `Session ${session_id} not found.` },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (session.ended_at) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              message: `Session ${session_id} is already ended (outcome: ${session.outcome}).`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const ended_at = new Date().toISOString();
  const started = new Date(session.started_at);
  const ended = new Date(ended_at);
  const duration_seconds = Math.round((ended - started) / 1000);

  session.ended_at = ended_at;
  session.outcome = outcome;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            session_id,
            outcome,
            duration_seconds,
            return_dnis: session.return_dnis,
            ended_at,
            message: `Session ended with outcome: ${outcome}. Duration: ${duration_seconds}s. Call should return to ${session.return_dnis}.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleSimulateCallerAbandons({ session_id }) {
  if (!session_id) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "session_id is required." },
            null,
            2,
          ),
        },
      ],
    };
  }

  const session = PAYMENT_SESSIONS.get(session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: `Session ${session_id} not found.` },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (session.ended_at) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              message: `Session ${session_id} is already ended (outcome: ${session.outcome}).`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const abandoned_at = new Date().toISOString();
  session.ended_at = abandoned_at;
  session.outcome = "abandoned";

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            session_id,
            outcome: "abandoned",
            abandoned_at,
            message: `Session ${session_id} force-abandoned. Useful for demoing FR 6.5.2 'no record found' / out-of-window paths upstream.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const TOOL_HANDLERS = {
  start_payment_session: handleStartPaymentSession,
  process_payment: handleProcessPayment,
  get_payment_status: handleGetPaymentStatus,
  end_session: handleEndSession,
  simulate_caller_abandons: handleSimulateCallerAbandons,
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
            serverInfo: { name: "Paymentus Simulator", version: "0.1.1" },
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
        console.log(`[paymentus][MCP] Result: ${result.content[0].text.substring(0, 100)}...`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[paymentus][MCP] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[paymentus][MCP] Error:", err);
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

// Per-app CORS — same allowlist as radd-sim so the Webex AI Agent Studio
// MCP client can send Mcp-Session-Id without preflight failure.
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
      `[paymentus][MCP] POST /paymentus/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[paymentus][MCP]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
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
    service: "paymentus-sim",
    version: "0.1.0",
    tools: TOOL_SCHEMAS.map((t) => t.name),
    timestamp: new Date().toISOString(),
  });
});

router.get("/", (_req, res) => {
  res.json({
    service: "paymentus-sim",
    description:
      "Simulates the Paymentus payment portal for the Farmers Voice Advantage IVR Phase 2 demo. Provides payment session management, payment processing, and status lookup MCP tools for the Webex AI Agent.",
    version: "0.1.0",
    transport: "JSON-RPC 2.0 over HTTP",
    tools: TOOL_SCHEMAS.map((t) => ({ name: t.name, description: t.description })),
    endpoints: {
      health: "/paymentus/health",
      mcp: "/paymentus/mcp",
      mcp_log: "/paymentus/mcp-log",
    },
    fixtures: {
      demo_sessions: Object.keys(DEMO_SESSIONS),
      active_sessions: PAYMENT_SESSIONS.size,
    },
    environment_variables: {
      PAYMENTUS_SIM_TFN: {
        description: "Overrides the default Paymentus toll-free number",
        default: "8884447777",
        current: PAYMENTUS_TFN,
      },
      PAYMENTUS_SIM_FORCE_DECLINE: {
        description: "If set to Y, all payments are declined regardless of amount/method",
        default: "not set",
        current: shouldForceDecline() ? "Y" : "not set",
      },
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
