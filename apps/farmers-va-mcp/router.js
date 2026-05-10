/**
 * farmers-va-mcp — Farmers Voice Advantage MCP server mounted as a sub-router under /farmers-va-mcp in node-services-hub.
 *
 * Purpose: Provide 14 MCP tools for managing Farmers VA demo environment:
 * agencies, customers, system flags, scenarios, and analytics.
 *
 * Features:
 *   - Custom JSON-RPC over HTTP (NOT MCP SDK)
 *   - SSE streaming support (GET /farmers-va-mcp/mcp for stream, POST with Accept: text/event-stream for framed responses)
 *   - Session management with Mcp-Session-Id header
 *   - Protocol version 2025-03-26
 *   - 14 MCP tools across 5 categories
 *   - Request logging (last 50 requests at /farmers-va-mcp/mcp-log)
 *
 * Endpoints exposed under /farmers-va-mcp:
 *   GET  /farmers-va-mcp/             — JSON manifest
 *   GET  /farmers-va-mcp/health
 *   POST /farmers-va-mcp/mcp          — JSON-RPC (plain JSON or SSE-framed if Accept: text/event-stream)
 *   GET  /farmers-va-mcp/mcp          — SSE stream (keepalive every 15s)
 *   DELETE /farmers-va-mcp/mcp        — Session close stub (200)
 *   GET  /farmers-va-mcp/mcp-log      — Last 50 requests
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import { agencyTools } from "./tools/agency-tools.js";
import { customerTools } from "./tools/customer-tools.js";
import { systemTools } from "./tools/system-tools.js";
import { scenarioTools } from "./tools/scenario-tools.js";
import { analyticsTools } from "./tools/analytics-tools.js";

// ============================================================
// TOOL REGISTRY
// ============================================================

const allTools = {
  ...agencyTools,
  ...customerTools,
  ...systemTools,
  ...scenarioTools,
  ...analyticsTools,
};

const toolDescriptions = {
  get_agency_profile: 'Get detailed profile for a specific agency by DNIS',
  list_agencies: 'List all agency profiles in the system',
  update_agency_flag: 'Update a specific flag on an agency profile',
  get_customer_profile: 'Get detailed profile for a specific customer by ANI',
  list_customers: 'List all customer profiles in the system',
  update_customer_flag: 'Update a specific flag on a customer profile',
  get_system_status: 'Get current system status (chaos mode, Webex availability)',
  toggle_chaos_mode: 'Enable or disable chaos mode (30% random failures)',
  toggle_webex_availability: 'Set Webex AI Agent availability',
  load_demo_scenario: 'Load a preset demo scenario (scenario1-6)',
  reset_demo_environment: 'Reset database to seed defaults',
  get_recent_calls: 'Get recent call events from analytics',
  get_intent_distribution: 'Get intent distribution counts',
  get_demo_summary: 'Get comprehensive analytics summary with containment rate and active calls',
};

// Convert zod schemas to JSON Schema for MCP
const TOOL_SCHEMAS = Object.keys(allTools).map((name) => ({
  name,
  description: toolDescriptions[name],
  inputSchema: zodToJsonSchema(allTools[name].schema),
}));

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
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error(`[farmers-va-mcp] Tool ${toolName} failed:`, error.message);
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
            serverInfo: { name: "Farmers VA MCP Server", version: "1.0.0" },
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
        console.log(`[farmers-va-mcp] Tool ${toolName} executed`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[farmers-va-mcp] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[farmers-va-mcp] Error:", err);
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
    console.log(`[farmers-va-mcp] Stream ${streamId} closed`);
  };

  res.on("close", cleanup);
  SSE_STREAMS.set(streamId, { res, cleanup });
  console.log(`[farmers-va-mcp] Stream ${streamId} opened`);

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
      `[farmers-va-mcp] POST /farmers-va-mcp/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[farmers-va-mcp]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
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
    requests: REQUEST_LOG.slice(-50).reverse(),
  });
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "Farmers VA MCP Server", tools: 14 });
});

router.get("/", (_req, res) => {
  res.json({
    name: "Farmers VA MCP Server",
    description: "MCP server with 14 tools for managing Farmers Voice Advantage demo environment",
    version: "1.0.0",
    tools: Object.keys(allTools),
    health: "/farmers-va-mcp/health",
    mcp_endpoint: "/farmers-va-mcp/mcp",
    mcp_log: "/farmers-va-mcp/mcp-log",
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
    console.log(`[farmers-va-mcp] Initialize — session ID: ${sessionId}`);
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
