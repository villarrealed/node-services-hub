/**
 * salesforce-mcp — Salesforce MCP server mounted as a sub-router under /salesforce in node-services-hub.
 *
 * Purpose: Provide MCP tools for Salesforce Contacts, Accounts, and Cases,
 * plus purpose-built Agent Assist tools for Webex Contact Center Real-Time Assist.
 *
 * Features:
 *   - Custom JSON-RPC over HTTP (NOT MCP SDK)
 *   - SSE streaming support (GET /salesforce/mcp for stream, POST with Accept: text/event-stream for framed responses)
 *   - Session management with Mcp-Session-Id header
 *   - Protocol version 2025-03-26
 *   - Bearer token authentication (SALESFORCE_MCP_BEARER_TOKEN env var)
 *   - 14 MCP tools across 4 categories (contacts, accounts, cases, agent-assist)
 *   - Request logging (last 50 requests at /salesforce/mcp-log)
 *
 * Endpoints exposed under /salesforce:
 *   GET  /salesforce/             — JSON manifest
 *   GET  /salesforce/health
 *   POST /salesforce/mcp          — JSON-RPC (plain JSON or SSE-framed if Accept: text/event-stream)
 *   GET  /salesforce/mcp          — SSE stream (keepalive every 15s)
 *   DELETE /salesforce/mcp        — Session close stub (200)
 *   GET  /salesforce/mcp-log      — Last 50 requests
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import { contactTools } from "./tools/contact-tools.js";
import { accountTools } from "./tools/account-tools.js";
import { caseTools } from "./tools/case-tools.js";
import { agentAssistTools } from "./tools/agent-assist-tools.js";

// ============================================================
// TOOL REGISTRY
// ============================================================

const allTools = {
  ...contactTools,
  ...accountTools,
  ...caseTools,
  ...agentAssistTools,
};

const toolDescriptions = {
  search_contacts: 'Search Salesforce contacts by name, email, or phone number',
  lookup_contact_by_phone: 'Look up Salesforce contacts by phone number, handling any formatting variations',
  get_contact: 'Get full details for a Salesforce contact by record ID',
  verify_identity: "Verify a caller's claimed identity by cross-checking phone + name against Salesforce",
  create_contact: 'Create a new Salesforce contact (last_name required)',
  search_accounts: 'Search Salesforce accounts by name',
  get_account: 'Get full details for a Salesforce account by record ID',
  create_account: 'Create a new Salesforce account (name required)',
  search_cases: 'Search Salesforce cases by subject, case number, status, or priority',
  get_case: 'Get full details for a Salesforce case by record ID or case number',
  create_case: 'Create a new case in Salesforce',
  // Agent Assist tools — purpose-built for Webex Real-Time Assist
  identify_caller_by_ani:
    'Screen-pop equivalent for a human agent. Given an ANI (caller phone number), returns the matching contact, account, loyalty tier, open-case count, and Lightning UI deep links. Designed to be the first call when a call starts. Does NOT disclose PII beyond name until identity is verified.',
  verify_caller_lightweight:
    "Lightweight voice-check identity verification suitable for outbound callbacks where the customer was already authenticated on the portal. Requires last name; accepts DOB or ZIP as an optional second factor. Returns confidence (high|medium|low|none). Use after identify_caller_by_ani.",
  get_customer_summary:
    "One-shot agent briefing: returns the contact, account, all open cases plus any closed in the last 7 days, sorted recent-first, with Lightning UI deep links and a one-line agent_briefing string the agent can read at a glance. Call after the caller is verified.",
};

// Convert zod schemas to JSON Schema for MCP
const TOOL_SCHEMAS = Object.keys(allTools).map((name) => {
  const tool = allTools[name];
  const schema = {
    name,
    description: toolDescriptions[name],
    inputSchema: zodToJsonSchema(tool.schema),
  };
  
  // Include outputSchema if defined
  if (tool.outputSchema) {
    schema.outputSchema = zodToJsonSchema(tool.outputSchema);
  }
  
  return schema;
});

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleToolCall(toolName, toolArgs) {
  const tool = allTools[toolName];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  try {
    // Validate input
    const validated = tool.schema.parse(toolArgs);
    
    // Execute handler
    const result = await tool.handler(validated);
    
    const response = {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
    
    // Include structuredContent if outputSchema is defined
    if (tool.outputSchema) {
      response.structuredContent = result;
    }
    
    return response;
  } catch (error) {
    console.error(`[salesforce-mcp] Tool ${toolName} failed:`, error.message);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: true,
              message: error.message,
              tool: toolName,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

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
            serverInfo: { name: "Salesforce MCP Server", version: "1.0.0" },
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

        const result = await handleToolCall(toolName, toolArgs);
        console.log(`[salesforce-mcp] Tool ${toolName} executed`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[salesforce-mcp] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[salesforce-mcp] Error:", err);
    return {
      jsonrpc: "2.0",
      error: { code: -32603, message: err.message || "Internal server error" },
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
    console.log(`[salesforce-mcp] Stream ${streamId} closed`);
  };

  res.on("close", cleanup);
  SSE_STREAMS.set(streamId, { res, cleanup });
  console.log(`[salesforce-mcp] Stream ${streamId} opened`);

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

// Bearer token authentication middleware — gates /mcp and /mcp-log (NOT /health, /)
const BEARER = process.env.SALESFORCE_MCP_BEARER_TOKEN || "";
if (!BEARER) {
  console.warn("[salesforce-mcp] ⚠️  SALESFORCE_MCP_BEARER_TOKEN not set — /mcp is UNAUTHENTICATED");
}

// Request logging for /mcp POST (runs BEFORE auth so 401s get logged)
router.use("/mcp", (req, res, next) => {
  if (req.method === "POST") {
    // Redact sensitive headers — never store the bearer token in memory
    const safeHeaders = { ...req.headers };
    if (safeHeaders.authorization) safeHeaders.authorization = "[REDACTED]";
    if (safeHeaders.Authorization) safeHeaders.Authorization = "[REDACTED]";
    if (safeHeaders.cookie) safeHeaders.cookie = "[REDACTED]";

    const logEntry = {
      timestamp: new Date().toISOString(),
      method: req.body?.method || "(no method)",
      headers: safeHeaders,
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
      `[salesforce-mcp] POST /salesforce/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[salesforce-mcp]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
          req.body?.params?.arguments,
        )}`,
      );
    }
  }
  next();
});

// Auth middleware for /mcp endpoint only
router.use("/mcp", (req, res, next) => {
  if (!BEARER) return next(); // dev mode
  const got = req.headers.authorization || "";
  if (got !== `Bearer ${BEARER}`) {
    console.warn(`[salesforce-mcp] 401 — bad/missing bearer on ${req.method} ${req.path}`);
    return res.status(401).json({ error: "unauthorized", detail: "Missing or invalid Bearer token" });
  }
  next();
});

// /mcp-log is also gated — it contains request bodies + responses with SF data
router.get("/mcp-log", (req, res) => {
  if (!BEARER) {
    // dev mode: open access matches /mcp behaviour
    return res.json({
      total_requests: REQUEST_LOG.length,
      requests: REQUEST_LOG.slice(-50).reverse(),
    });
  }
  const got = req.headers.authorization || "";
  if (got !== `Bearer ${BEARER}`) {
    console.warn(`[salesforce-mcp] 401 — bad/missing bearer on GET /mcp-log`);
    return res.status(401).json({ error: "unauthorized", detail: "Missing or invalid Bearer token" });
  }
  res.json({
    total_requests: REQUEST_LOG.length,
    requests: REQUEST_LOG.slice(-50).reverse(),
  });
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "Salesforce MCP Server", tools: Object.keys(allTools).length });
});

router.get("/", (_req, res) => {
  res.json({
    name: "Salesforce MCP Server",
    description: "MCP server with 11 tools for managing Salesforce Contacts, Accounts, and Cases",
    version: "1.0.0",
    tools: Object.keys(allTools),
    health: "/salesforce/health",
    mcp_endpoint: "/salesforce/mcp",
    mcp_log: "/salesforce/mcp-log",
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
    console.log(`[salesforce-mcp] Initialize — session ID: ${sessionId}`);
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
