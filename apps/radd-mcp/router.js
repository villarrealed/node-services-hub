/**
 * radd-mcp — minimal RADD MCP server mounted as a sub-router under /radd in node-services-hub.
 *
 * Purpose: Provide DNIS (agency) and ANI (customer) lookup tools for Farmers Insurance
 * call routing decisions via MCP protocol with proper SSE streaming support.
 *
 * Features:
 *   - Custom JSON-RPC over HTTP (NOT MCP SDK)
 *   - SSE streaming support (GET /radd/mcp for stream, POST with Accept: text/event-stream for framed responses)
 *   - Session management with Mcp-Session-Id header
 *   - Protocol version 2025-03-26
 *   - In-memory fixtures (4 agencies, 5 customers)
 *   - 2 MCP tools (lookup_agency_by_dnis, lookup_customer_by_ani)
 *   - Request logging (last 50 requests at /radd/mcp-log)
 *
 * Endpoints exposed under /radd:
 *   GET  /radd/             — JSON manifest
 *   GET  /radd/health
 *   POST /radd/mcp          — JSON-RPC (plain JSON or SSE-framed if Accept: text/event-stream)
 *   GET  /radd/mcp          — SSE stream (keepalive every 15s)
 *   DELETE /radd/mcp        — Session close stub (200)
 *   GET  /radd/mcp-log      — Last 20 requests
 */

import express from "express";
import { randomUUID } from "node:crypto";

// ============================================================
// STATIC DATA — Hardcoded agencies and customers
// ============================================================

const AGENCIES = [
  {
    dnis: "8005550101",
    AgencyName: "Aspen Ridge Insurance Agency",
    FSAEnrolled: "Y",
    ClaimsToAgent: "Y",
    ATT: "1",
    AgPhNum: "5036821583",
    AOR: "73247J",
    PaymentToPaymentus: "N",
    AgencyTransferNumber: "5036821583",
    ClaimsDestination: "8664557827",
    AgencySETN: "",
    AgencySATN: "",
    AgencyOTN: "",
    TransferPrompts: "Y",
    AltGreeting: "N",
    GreetWav: "",
  },
  {
    dnis: "8005550102",
    AgencyName: "Mesa Valley Insurance Agency",
    FSAEnrolled: "N",
    ClaimsToAgent: "N",
    ATT: "2",
    AgPhNum: "6025550199",
    AOR: "84518K",
    PaymentToPaymentus: "Y",
    AgencyTransferNumber: "6025550199",
    ClaimsDestination: "8664557827",
    AgencySETN: "6025550201",
    AgencySATN: "6025550202",
    AgencyOTN: "6025550203",
    TransferPrompts: "Y",
    AltGreeting: "Y",
    GreetWav: "va_84518k.wav",
  },
  {
    dnis: "8005550103",
    AgencyName: "Pinecrest Family Insurance",
    FSAEnrolled: "Y",
    ClaimsToAgent: "Y",
    ATT: "3",
    AgPhNum: "4805550155",
    AOR: "91204M",
    PaymentToPaymentus: "Y",
    AgencyTransferNumber: "4805550155",
    ClaimsDestination: "8664557827",
    AgencySETN: "",
    AgencySATN: "",
    AgencyOTN: "",
    TransferPrompts: "Y",
    AltGreeting: "N",
    GreetWav: "",
  },
  {
    dnis: "8005550104",
    AgencyName: "Coastal Shield Insurance",
    FSAEnrolled: "Y",
    ClaimsToAgent: "N",
    ATT: "4",
    AgPhNum: "3105550178",
    AOR: "55621A",
    PaymentToPaymentus: "Y",
    AgencyTransferNumber: "3105550178",
    ClaimsDestination: "8664557827",
    AgencySETN: "3105550179",
    AgencySATN: "",
    AgencyOTN: "",
    TransferPrompts: "Y",
    AltGreeting: "N",
    GreetWav: "",
  },
];

const CUSTOMERS = [
  {
    ani: "6235550111",
    PNI: "John Smith",
    RetFlag: "Y",
    Multiline: "Y",
    BUs: "PLA_FWS-ARS",
    PRD: "AUTO",
    CAOR: "",
    OpenClaim: "Y",
    VaRetBu: "1",
  },
  {
    ani: "6235550112",
    PNI: "Maria Garcia",
    RetFlag: "N",
    Multiline: "Y",
    BUs: "PLA_FWS",
    PRD: "AUTO",
    CAOR: "",
    OpenClaim: "N",
    VaRetBu: "0",
  },
  {
    ani: "6235550113",
    PNI: "Robert Chen",
    RetFlag: "N",
    Multiline: "N",
    BUs: "BWI",
    PRD: "AUTO",
    CAOR: "",
    OpenClaim: "N",
    VaRetBu: "0",
  },
  {
    ani: "6235550114",
    PNI: "Linda Patel",
    RetFlag: "Y",
    Multiline: "N",
    BUs: "PLA",
    PRD: "HOME",
    CAOR: "",
    OpenClaim: "N",
    VaRetBu: "2",
  },
  {
    ani: "6235550115",
    PNI: "David Johnson",
    RetFlag: "N",
    Multiline: "Y",
    BUs: "PLA_FWS",
    PRD: "AUTO_HOME",
    CAOR: "",
    OpenClaim: "Y",
    VaRetBu: "0",
  },
];

// ============================================================
// TOOL SCHEMAS
// ============================================================

const TOOL_SCHEMAS = [
  {
    name: "lookup_agency_by_dnis",
    description:
      "Looks up Farmers agency by dialed toll-free number (DNIS) for routing decisions. Returns ATT (Agency Transfer Type 1-5), agency phone, FSA enrollment, claims handling, and transfer numbers.",
    inputSchema: {
      type: "object",
      properties: {
        dnis: {
          type: "string",
          description: "The dialed toll-free number (DNIS), e.g., 8005550101",
        },
      },
      required: ["dnis"],
    },
  },
  {
    name: "lookup_customer_by_ani",
    description:
      "Looks up Farmers customer record by caller's phone number (ANI). Returns PNI (Primary Named Insured), retention flag, open-claim flag, multiline status, and product/business-unit info to drive routing.",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description: "The caller's phone number (ANI), e.g., 6235550111",
        },
      },
      required: ["ani"],
    },
  },
];

// ============================================================
// TOOL HANDLERS
// ============================================================

function buildReturnValue1Agency(agency) {
  return `AgencyName: ${agency.AgencyName} | FSAEnrolled : ${agency.FSAEnrolled} | ClaimsToAgent : ${agency.ClaimsToAgent} | ATT : ${agency.ATT} | AgPhNum : ${agency.AgPhNum} | AOR : ${agency.AOR} | PaymentToPaymentus : ${agency.PaymentToPaymentus}`;
}

function buildReturnValue2Agency(agency) {
  return `AgencyTransferNumber : ${agency.AgencyTransferNumber} | ClaimsDestination : ${agency.ClaimsDestination} | AgencySETN : ${agency.AgencySETN} | AgencySATN : ${agency.AgencySATN} | AgencyOTN : ${agency.AgencyOTN} | TransferPrompts : ${agency.TransferPrompts} | AltGreeting = ${agency.AltGreeting} | GreetWav = ${agency.GreetWav}`;
}

function buildReturnValue1Customer(customer) {
  return `RetFlag : ${customer.RetFlag} | Multiline : ${customer.Multiline} | BUs : ${customer.BUs} | PRD : ${customer.PRD} | CAOR : ${customer.CAOR} | OpenClaim : ${customer.OpenClaim} | VaRetBu : ${customer.VaRetBu} | PNI : ${customer.PNI}`;
}

async function handleLookupAgency({ dnis }) {
  const agency = AGENCIES.find((a) => a.dnis === dnis);

  if (agency) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: true,
              lookupCode: "EAAgentLookup",
              lookupValue: dnis,
              returnValue1: buildReturnValue1Agency(agency),
              returnValue2: buildReturnValue2Agency(agency),
              parsed: {
                AgencyName: agency.AgencyName,
                FSAEnrolled: agency.FSAEnrolled,
                ClaimsToAgent: agency.ClaimsToAgent,
                ATT: agency.ATT,
                AgPhNum: agency.AgPhNum,
                AOR: agency.AOR,
                PaymentToPaymentus: agency.PaymentToPaymentus,
                AgencyTransferNumber: agency.AgencyTransferNumber,
                ClaimsDestination: agency.ClaimsDestination,
                AgencySETN: agency.AgencySETN,
                AgencySATN: agency.AgencySATN,
                AgencyOTN: agency.AgencyOTN,
                TransferPrompts: agency.TransferPrompts,
                AltGreeting: agency.AltGreeting,
                GreetWav: agency.GreetWav,
              },
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
            found: false,
            lookupCode: "EAAgentLookup",
            lookupValue: dnis,
            message: "Agency not found",
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleLookupCustomer({ ani }) {
  const customer = CUSTOMERS.find((c) => c.ani === ani);

  if (customer) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: true,
              lookupCode: "EACustLookup2",
              lookupValue: ani,
              returnValue1: buildReturnValue1Customer(customer),
              parsed: {
                RetFlag: customer.RetFlag,
                Multiline: customer.Multiline,
                BUs: customer.BUs,
                PRD: customer.PRD,
                CAOR: customer.CAOR,
                OpenClaim: customer.OpenClaim,
                VaRetBu: customer.VaRetBu,
                PNI: customer.PNI,
              },
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
            found: false,
            lookupCode: "EACustLookup2",
            lookupValue: ani,
            message: "Customer not found",
          },
          null,
          2,
        ),
      },
    ],
  };
}

const TOOL_HANDLERS = {
  lookup_agency_by_dnis: handleLookupAgency,
  lookup_customer_by_ani: handleLookupCustomer,
};

// ============================================================
// JSON-RPC HANDLER
// ============================================================

async function handleJsonRpc(body) {
  const { method, params, id } = body;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "RADD MCP Server", version: "1.0.0" },
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
        console.log(`[radd][MCP] Result: ${result.content[0].text.substring(0, 100)}...`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[radd][MCP] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[radd][MCP] Error:", err);
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
// SSE STREAM MANAGEMENT
// ============================================================

const SSE_STREAMS = new Map();

function createSseStream(res) {
  const streamId = randomUUID();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const keepaliveInterval = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  const cleanup = () => {
    clearInterval(keepaliveInterval);
    SSE_STREAMS.delete(streamId);
    console.log(`[radd][SSE] Stream ${streamId} closed`);
  };

  res.on("close", cleanup);
  SSE_STREAMS.set(streamId, { res, cleanup });
  console.log(`[radd][SSE] Stream ${streamId} opened`);

  return streamId;
}

// ============================================================
// ROUTER
// ============================================================

const router = express.Router();

// Per-app CORS — allowlist Mcp-Session-Id for MCP clients
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id",
  );
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Request logging for /mcp POST
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
      `[radd][MCP] POST /radd/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[radd][MCP]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
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
  res.json({ status: "ok", server: "RADD MCP Server", tools: 2 });
});

router.get("/", (_req, res) => {
  res.json({
    name: "RADD MCP Server",
    description: "MCP server providing DNIS (agency) and ANI (customer) lookup tools for Farmers Insurance call routing",
    version: "1.0.0",
    tools: ["lookup_agency_by_dnis", "lookup_customer_by_ani"],
    health: "/radd/health",
    mcp_endpoint: "/radd/mcp",
    mcp_log: "/radd/mcp-log",
  });
});

// GET /mcp — SSE stream
router.get("/mcp", (req, res) => {
  createSseStream(res);
});

// POST /mcp — JSON-RPC handler with SSE framing support
router.post("/mcp", async (req, res) => {
  const body = req.body || {};
  const accept = req.headers["accept"] || "";
  const wantsSSE = accept.includes("text/event-stream");

  // Generate session ID on initialize
  if (body.method === "initialize") {
    const sessionId = randomUUID();
    res.setHeader("Mcp-Session-Id", sessionId);
    console.log(`[radd][MCP] Initialize — session ID: ${sessionId}`);
  }

  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) {
      const r = await handleJsonRpc(item);
      if (r) results.push(r);
    }

    if (wantsSSE) {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`event: message\ndata: ${JSON.stringify(results)}\n\n`);
      return res.end();
    }
    return res.json(results);
  }

  const result = await handleJsonRpc(body);

  if (wantsSSE) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    return res.end();
  }

  return res.json(result);
});

// DELETE /mcp — session close stub
router.delete("/mcp", (_req, res) => {
  res.status(200).json({ message: "Session closed" });
});

export default router;
