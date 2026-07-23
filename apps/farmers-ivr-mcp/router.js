import express from "express";

// ============================================================
// STATIC DATA — Hardcoded caller profiles for RADD simulation
// ============================================================

const CALLER_PROFILES = [
  {
    phone: "5550001",
    found: true,
    policy_id: "POL-88801",
    pni: "Michael Torres",
    retention_flag: false,
    open_claim: false,
    claim_number: null,
    ret_eligible: false,
    va_ret_bu: null,
    vap_ay_elig: false,
    fsa_enrolled: false,
    bu: "BW",
    multiline: false,
    scenario: "Standard service call — no special flags",
  },
  {
    phone: "5550002",
    found: true,
    policy_id: "POL-88802",
    pni: "Jennifer Walsh",
    retention_flag: false,
    open_claim: true,
    claim_number: "CLM-2024-441892",
    ret_eligible: false,
    va_ret_bu: null,
    vap_ay_elig: false,
    fsa_enrolled: false,
    bu: "022",
    multiline: false,
    scenario: "Caller with open claim",
  },
  {
    phone: "5550003",
    found: true,
    policy_id: "POL-88803",
    pni: "Robert Kim",
    retention_flag: true,
    open_claim: false,
    claim_number: null,
    ret_eligible: true,
    va_ret_bu: "3",
    vap_ay_elig: false,
    fsa_enrolled: false,
    bu: "022",
    multiline: false,
    scenario: "Retention-eligible cancellation risk",
  },
  {
    phone: "5550004",
    found: true,
    policy_id: "POL-88804",
    pni: "Amanda Foster",
    retention_flag: false,
    open_claim: false,
    claim_number: null,
    ret_eligible: false,
    va_ret_bu: null,
    vap_ay_elig: true,
    fsa_enrolled: false,
    bu: "022",
    multiline: false,
    scenario: "Payment-eligible caller",
  },
  {
    phone: "5550099",
    found: false,
    message: "No account found for that phone number.",
  },
];

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

// ============================================================
// REQUEST LOG + TRANSFER LOG (in-memory)
// ============================================================

const REQUEST_LOG = [];
const TRANSFER_LOG = [];
const MAX_LOG_ENTRIES = 50;

// ============================================================
// TOOL DEFINITIONS (for tools/list response)
// ============================================================

const TOOL_SCHEMAS = [
  {
    name: "lookup_caller_by_phone",
    description:
      "Looks up a caller's account information using their phone number. This simulates a RADD (Real-time Agent Data Display) API call. Returns the caller's name, policy ID, and routing flags that determine how the call should be handled. Always call this first before helping a caller.",
    inputSchema: {
      type: "object",
      properties: {
        phone_number: {
          type: "string",
          description:
            "The caller's phone number in any format (e.g., 555-0001, (555) 000-1, 5550001)",
        },
      },
      required: ["phone_number"],
    },
  },
  {
    name: "simulate_transfer",
    description:
      "Simulates transferring the call to the appropriate team or system. This represents the IVR routing decision — it logs what would happen in a real deployment (which queue, which system, what CTI data would be passed). Call this when you have determined the caller's intent and are ready to route them.",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description:
            "The detected intent (e.g., service, sales, claims, cancel, cancel_retention, payment_automated, payment_agent, claims_open, human_request)",
        },
        destination: {
          type: "string",
          description:
            "The name of the team or system this call is being routed to (e.g., Service Team, Retention Team, Claims IVR, Automated Payment System, Agency Transfer)",
        },
        policy_id: {
          type: "string",
          description: "The caller's policy ID from the lookup (pass if available)",
        },
        transfer_reason: {
          type: "string",
          description:
            "Optional reason code for the transfer (e.g., Customer_Cancel, Retention_Risk, Pay_Success)",
        },
        notes: {
          type: "string",
          description: "Any additional context about the transfer decision",
        },
      },
      required: ["intent", "destination"],
    },
  },
];

// ============================================================
// TOOL HANDLERS (called by tools/call)
// ============================================================

async function handleLookupCaller({ phone_number }) {
  const normalizedInput = normalizePhone(phone_number);

  const match = CALLER_PROFILES.find((profile) => {
    const normalizedStored = normalizePhone(profile.phone);
    return normalizedStored === normalizedInput;
  });

  let payload;
  if (match && match.found) {
    const { phone, ...rest } = match;
    payload = {
      ...rest,
      timestamp: new Date().toISOString(),
    };
  } else {
    payload = { found: false, message: "No account found for that phone number." };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function handleSimulateTransfer({ intent, destination, policy_id, transfer_reason, notes }) {
  const correlation_id = "XFR-" + Math.floor(100000 + Math.random() * 900000);
  const timestamp = new Date().toISOString();

  TRANSFER_LOG.push({
    timestamp,
    intent,
    destination,
    policy_id: policy_id || null,
    transfer_reason: transfer_reason || null,
    notes: notes || null,
    correlation_id,
  });
  if (TRANSFER_LOG.length > MAX_LOG_ENTRIES) TRANSFER_LOG.shift();

  const payload = {
    transfer_simulated: true,
    correlation_id,
    intent,
    destination,
    policy_id: policy_id || null,
    transfer_reason: transfer_reason || null,
    timestamp,
    message: `Transfer logged. In a live deployment, this call would now be routed to: ${destination}`,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const TOOL_HANDLERS = {
  lookup_caller_by_phone: handleLookupCaller,
  simulate_transfer: handleSimulateTransfer,
};

// ============================================================
// JSON-RPC REQUEST HANDLER
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
            serverInfo: { name: "Farmers RADD Simulation Tools", version: "1.0.0" },
          },
          id,
        };

      case "notifications/initialized":
        return { jsonrpc: "2.0", result: {}, id };

      case "ping":
        return { jsonrpc: "2.0", result: {}, id };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          result: { tools: TOOL_SCHEMAS },
          id,
        };

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
        console.log(
          `[farmers-ivr][MCP]   Result: ${result.content[0].text.substring(0, 100)}...`,
        );
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[farmers-ivr][MCP] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[farmers-ivr][MCP] Error:", err);
    return {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: id || null,
    };
  }
}

// ============================================================
// ROUTER
// ============================================================

const router = express.Router();

// Per-router CORS headers
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id",
  );
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Request logging middleware for /mcp — captures to in-memory log
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

    const accept = req.headers.accept || "(none)";
    const contentType = req.headers["content-type"] || "(none)";
    console.log(
      `[farmers-ivr][MCP] POST /farmers-ivr/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[farmers-ivr][MCP]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(req.body?.params?.arguments)}`,
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

router.get("/transfer-log", (_req, res) => {
  res.json({
    total_transfers: TRANSFER_LOG.length,
    transfers: TRANSFER_LOG.slice(-20).reverse(),
  });
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "Farmers RADD Simulation Server", tools: 2, caller_profiles: 5 });
});

router.all("/mcp-debug", (req, res) => {
  res.json({ method: req.method, headers: req.headers, body: req.body });
});

router.get("/", (_req, res) => {
  res.json({
    name: "Farmers IVR RADD Simulation Server",
    description:
      "Mock RADD API MCP server for the Farmers Insurance IVR Lab. Simulates caller lookup and call transfer logging.",
    version: "1.0.0",
    tools: ["lookup_caller_by_phone", "simulate_transfer"],
    caller_profiles: 5,
    health: "/farmers-ivr/health",
    mcp_endpoint: "/farmers-ivr/mcp",
    mcp_log: "/farmers-ivr/mcp-log",
    transfer_log: "/farmers-ivr/transfer-log",
    test_numbers: {
      "555-0001": "Michael Torres - Standard service",
      "555-0002": "Jennifer Walsh - Open claim",
      "555-0003": "Robert Kim - Retention eligible",
      "555-0004": "Amanda Foster - Payment eligible",
      "555-0099": "Unknown caller (not found)",
    },
  });
});

router.post("/mcp", async (req, res) => {
  const body = req.body || {};

  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) {
      const result = await handleJsonRpc(item);
      if (result) results.push(result);
    }
    return res.json(results);
  }

  const result = await handleJsonRpc(body);
  return res.json(result);
});

router.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});

router.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Session management not supported in stateless mode." });
});

export default router;
