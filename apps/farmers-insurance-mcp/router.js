/**
 * farmers-insurance-mcp — mounted as a sub-router under /farmers in node-services-hub.
 *
 * Original: ~/Documents/claude_projects/farmers-insurance-lab-guide/mcp-server/server.js
 *
 * Changes from original:
 *   - Exports an express.Router instead of calling app.listen()
 *   - Removed local express.json() — hub installs it once
 *   - Per-app CORS headers retained (more specific than hub's cors() defaults
 *     and the Webex AI Agent Studio MCP client expects Mcp-Session-Id allowed)
 *   - Manifest at /farmers/ now reflects the /farmers-prefixed paths
 *
 * Preserved as-is (per non-goals):
 *   - Custom JSON-RPC handler returning plain application/json (NOT MCP SDK + SSE)
 *   - 4 hardcoded policyholders
 *   - 3 MCP tools (verify_policyholder_identity, add_vehicle_to_policy, deliver_proof_of_insurance)
 *   - Hardcoded Webex Connect webhook URL for SMS delivery
 *   - In-memory REQUEST_LOG (last 50 requests at /farmers/mcp-log)
 *
 * Endpoints exposed under /farmers:
 *   GET  /farmers/             — JSON manifest
 *   GET  /farmers/health
 *   POST /farmers/mcp          — JSON-RPC (plain JSON, not SSE)
 *   GET  /farmers/mcp          — 405
 *   DELETE /farmers/mcp        — 405
 *   ALL  /farmers/mcp-debug    — echo back request
 *   GET  /farmers/mcp-log      — last 20 requests
 */

import express from "express";

// ============================================================
// HELPERS — date and policy-number normalization
// ============================================================

function normalizeDate(input) {
  if (!input) return null;
  const str = input.trim();

  const wordNums = {
    first: "1", second: "2", third: "3", fourth: "4", fifth: "5",
    sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10",
    eleventh: "11", twelfth: "12", thirteenth: "13", fourteenth: "14",
    fifteenth: "15", sixteenth: "16", seventeenth: "17", eighteenth: "18",
    nineteenth: "19", twentieth: "20", "twenty-first": "21", "twenty-second": "22",
    "twenty-third": "23", "twenty-fourth": "24", "twenty-fifth": "25",
    "twenty-sixth": "26", "twenty-seventh": "27", "twenty-eighth": "28",
    "twenty-ninth": "29", thirtieth: "30", "thirty-first": "31",
  };

  let cleaned = str;
  for (const [word, num] of Object.entries(wordNums)) {
    const re = new RegExp(`\\b${word}\\b`, "gi");
    cleaned = cleaned.replace(re, num);
  }
  cleaned = cleaned.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
  cleaned = cleaned.replace(/\b(19|20)\s+(\d{2})\b/g, "$1$2");

  const mdyMatch = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdyMatch) {
    let [, m, d, y] = mdyMatch;
    if (y.length === 2) y = (parseInt(y) > 50 ? "19" : "20") + y;
    return `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}`;
  }

  const isoMatch = cleaned.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}`;
  }

  const months = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };

  const nlMatch1 = cleaned.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (nlMatch1) {
    const [, monthStr, d, y] = nlMatch1;
    const m = months[monthStr.toLowerCase()];
    if (m) return `${m}/${d.padStart(2, "0")}/${y}`;
  }

  const nlMatch2 = cleaned.match(/^(\d{1,2})\s+([a-zA-Z]+),?\s+(\d{4})$/);
  if (nlMatch2) {
    const [, d, monthStr, y] = nlMatch2;
    const m = months[monthStr.toLowerCase()];
    if (m) return `${m}/${d.padStart(2, "0")}/${y}`;
  }

  return str;
}

function normalizePolicyNumber(pn) {
  if (!pn) return null;
  const clean = pn.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = clean.match(/^(FRM)(\d+)$/);
  return match ? `${match[1]}-${match[2]}` : pn.toUpperCase();
}

// ============================================================
// STATIC DATA — Hardcoded policyholders for demo purposes
// ============================================================

const POLICYHOLDERS = [
  {
    policy_number: "FRM-101",
    first_name: "Sarah",
    last_name: "Smith",
    date_of_birth: "05/05/1990",
    phone_number: "555-0101",
    email: "sarah.smith@email.com",
    address: "123 Main Street, Phoenix, AZ 85001",
    vehicles: [{ year: 2022, make: "Toyota", model: "RAV4", primary_use: "commute" }],
  },
  {
    policy_number: "FRM-284719",
    first_name: "Sarah",
    last_name: "Martinez",
    date_of_birth: "03/15/1988",
    phone_number: "555-0147",
    email: "sarah.martinez@email.com",
    address: "742 Oak Street, Austin, TX 78701",
    vehicles: [{ year: 2021, make: "Toyota", model: "Camry", primary_use: "commute" }],
  },
  {
    policy_number: "FRM-551203",
    first_name: "James",
    last_name: "Thompson",
    date_of_birth: "07/22/1975",
    phone_number: "555-0298",
    email: "j.thompson@email.com",
    address: "1205 Maple Drive, Denver, CO 80202",
    vehicles: [
      { year: 2022, make: "Ford", model: "F-150", primary_use: "business" },
      { year: 2020, make: "Honda", model: "Civic", primary_use: "commute" },
    ],
  },
  {
    policy_number: "FRM-887341",
    first_name: "Linda",
    last_name: "Chen",
    date_of_birth: "11/03/1992",
    phone_number: "555-0463",
    email: "linda.chen@email.com",
    address: "88 Pine Avenue, Seattle, WA 98101",
    vehicles: [{ year: 2023, make: "Tesla", model: "Model 3", primary_use: "commute" }],
  },
];

// ============================================================
// TOOL SCHEMAS
// ============================================================

const TOOL_SCHEMAS = [
  {
    name: "verify_policyholder_identity",
    description:
      "Verifies a policyholder's identity by checking their information against policy records. The agent collects last name, date of birth, and policy number, but only one field needs to match for verification to succeed. Returns policyholder details and current vehicles on policy if verified.",
    inputSchema: {
      type: "object",
      properties: {
        last_name: { type: "string", description: "Policyholder's last name (required)" },
        date_of_birth: { type: "string", description: "Policyholder's date of birth in MM/DD/YYYY format (required)" },
        policy_number: { type: "string", description: "Policy number (optional, e.g., FRM-284719)" },
        phone_number: { type: "string", description: "Phone number on file (optional, e.g., 555-0147)" },
      },
      required: ["last_name", "date_of_birth"],
    },
  },
  {
    name: "add_vehicle_to_policy",
    description:
      "Adds a new vehicle to an existing Farmers Insurance policy. Requires the policy number, vehicle year, make, model, and primary use. Returns a confirmation number and estimated monthly premium adjustment.",
    inputSchema: {
      type: "object",
      properties: {
        policy_number: { type: "string", description: "The policy number to add the vehicle to (required, e.g., FRM-284719)" },
        vehicle_year: { type: "integer", description: "Model year of the vehicle (required, e.g., 2024)" },
        vehicle_make: { type: "string", description: "Vehicle manufacturer (required, e.g., Honda)" },
        vehicle_model: { type: "string", description: "Vehicle model name (required, e.g., CR-V)" },
        primary_use: {
          type: "string",
          enum: ["commute", "pleasure", "business"],
          description: "Primary use of the vehicle (required: commute, pleasure, or business)",
        },
      },
      required: ["policy_number", "vehicle_year", "vehicle_make", "vehicle_model", "primary_use"],
    },
  },
  {
    name: "deliver_proof_of_insurance",
    description:
      "Delivers proof of insurance (insurance ID card) to the policyholder via their preferred method: SMS text message, email, or through the Farmers mobile app. Returns delivery confirmation details.",
    inputSchema: {
      type: "object",
      properties: {
        policy_number: { type: "string", description: "The policy number for the proof of insurance (required, e.g., FRM-284719)" },
        delivery_method: {
          type: "string",
          enum: ["sms", "email", "app"],
          description: "How to deliver the proof of insurance (required: sms, email, or app)",
        },
        phone_number: {
          type: "string",
          description:
            "Phone number to send SMS to (required when delivery_method is sms). Format as +1 followed by 10 digits, e.g., +16025551234. Customer may provide any phone number — it does not have to match the number on file.",
        },
      },
      required: ["policy_number", "delivery_method"],
    },
  },
];

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleVerifyPolicyholder({ last_name, date_of_birth, policy_number, phone_number }) {
  const normalizedDob = normalizeDate(date_of_birth);
  const normalizedPolicy = policy_number ? normalizePolicyNumber(policy_number) : null;

  const match = POLICYHOLDERS.find((p) => {
    const nameMatch = last_name && p.last_name.toLowerCase() === last_name.toLowerCase();
    const dobMatch = date_of_birth && normalizeDate(p.date_of_birth) === normalizedDob;
    const policyMatch = normalizedPolicy && normalizePolicyNumber(p.policy_number) === normalizedPolicy;
    const phoneMatch = phone_number && p.phone_number === phone_number;
    return nameMatch || dobMatch || policyMatch || phoneMatch;
  });

  if (match) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              verified: true,
              policy_number: match.policy_number,
              first_name: match.first_name,
              last_name: match.last_name,
              vehicles_on_policy: match.vehicles.map((v) => ({
                year: v.year,
                make: v.make,
                model: v.model,
                primary_use: v.primary_use,
              })),
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
            verified: false,
            message: "Unable to verify identity. Please check the information provided and try again.",
            debug_received: {
              last_name,
              date_of_birth,
              date_of_birth_normalized: normalizedDob,
              policy_number: policy_number || "(not provided)",
              policy_number_normalized: normalizedPolicy || "(not provided)",
              phone_number: phone_number || "(not provided)",
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleAddVehicle({ policy_number, vehicle_year, vehicle_make, vehicle_model, primary_use }) {
  const normalizedPolicy = normalizePolicyNumber(policy_number);
  const policyholder = POLICYHOLDERS.find(
    (p) => normalizePolicyNumber(p.policy_number) === normalizedPolicy,
  );

  if (!policyholder) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              message: `Policy number ${policy_number} not found. Please verify the policy number and try again.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const confirmationNumber = "VH-" + Math.floor(100000 + Math.random() * 900000);
  const premiumMap = { commute: 47.5, pleasure: 38.25, business: 62.0 };
  const premium = premiumMap[primary_use] || 47.5;
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            confirmation_number: confirmationNumber,
            vehicle: { year: vehicle_year, make: vehicle_make, model: vehicle_model, primary_use },
            estimated_monthly_premium: `$${premium.toFixed(2)}`,
            effective_date: today,
            message: `${vehicle_year} ${vehicle_make} ${vehicle_model} has been successfully added to policy ${policy_number}. Coverage is effective immediately.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleDeliverProof({ policy_number, delivery_method, phone_number }) {
  const normalizedPolicy = normalizePolicyNumber(policy_number);
  const policyholder = POLICYHOLDERS.find(
    (p) => normalizePolicyNumber(p.policy_number) === normalizedPolicy,
  );

  if (!policyholder) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              message: `Policy number ${policy_number} not found. Please verify the policy number and try again.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  let deliveryConfirmation;
  let deliveryDetails;

  switch (delivery_method) {
    case "sms": {
      if (!phone_number) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message:
                    "A phone number is required for SMS delivery. Please ask the customer for the phone number they'd like the text sent to.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const digits = phone_number.replace(/\D/g, "");
      let smsPhone;
      if (digits.length === 10) {
        smsPhone = "+1" + digits;
      } else if (digits.length === 11 && digits.startsWith("1")) {
        smsPhone = "+" + digits;
      } else {
        smsPhone = "+1" + digits.slice(-10);
      }
      const lastFour = smsPhone.slice(-4);

      try {
        // Hardcoded Webex Connect webhook for SMS delivery — preserved from original.
        await fetch("https://hooks.us.webexconnect.io/events/67H8O1CZV1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone_number: smsPhone,
            policy_number,
            customer_name: `${policyholder.first_name} ${policyholder.last_name}`,
          }),
        });
        deliveryConfirmation = `SMS sent to phone number ending in ***${lastFour.slice(-2)}`;
        deliveryDetails = "A text message with your proof of insurance has been sent. Please check your phone.";
      } catch (error) {
        deliveryConfirmation = `SMS queued for phone number ending in ***${lastFour.slice(-2)}`;
        deliveryDetails =
          "Your proof of insurance text message is being processed. You should receive it shortly.";
      }
      break;
    }
    case "email": {
      const maskedEmail = policyholder.email.charAt(0) + "***@" + policyholder.email.split("@")[1];
      deliveryConfirmation = `Sent to ${maskedEmail}`;
      deliveryDetails = "You will receive an email with your insurance ID card attached as a PDF.";
      break;
    }
    case "app": {
      deliveryConfirmation = "Available in Farmers mobile app under 'My Documents'";
      deliveryDetails =
        "Open the Farmers app and navigate to My Documents > Insurance Cards to view your updated proof of insurance.";
      break;
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            delivery_method,
            delivery_confirmation: deliveryConfirmation,
            delivery_details: deliveryDetails,
            message: `Proof of insurance for policy ${policy_number} has been sent via ${delivery_method}. ${deliveryDetails}`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const TOOL_HANDLERS = {
  verify_policyholder_identity: handleVerifyPolicyholder,
  add_vehicle_to_policy: handleAddVehicle,
  deliver_proof_of_insurance: handleDeliverProof,
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
            protocolVersion: params?.protocolVersion || "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "Farmers Insurance Tools", version: "1.0.0" },
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
        console.log(`[farmers][MCP] Result: ${result.content[0].text.substring(0, 100)}...`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        // Lenient: unknown method → empty result
        console.log(`[farmers][MCP] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[farmers][MCP] Error:", err);
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

// Per-app CORS — preserved from original. Hub already has cors() but
// the original explicitly allowlisted Mcp-Session-Id which the Webex
// AI Agent Studio MCP client may send.
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

// Request logging for /mcp — captures into REQUEST_LOG
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
      `[farmers][MCP] POST /farmers/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[farmers][MCP]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
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
  res.json({ status: "ok", server: "Farmers Insurance MCP Server", tools: 3 });
});

router.all("/mcp-debug", (req, res) => {
  res.json({ method: req.method, headers: req.headers, body: req.body });
});

router.get("/", (_req, res) => {
  res.json({
    name: "Farmers Insurance MCP Server",
    description: "MCP server providing insurance tools for the Webex AI Agent Lab",
    version: "1.0.0",
    tools: ["verify_policyholder_identity", "add_vehicle_to_policy", "deliver_proof_of_insurance"],
    health: "/farmers/health",
    mcp_endpoint: "/farmers/mcp",
    mcp_log: "/farmers/mcp-log",
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
