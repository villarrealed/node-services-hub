/**
 * wxcc-config-mcp — mounted as a sub-router under /wxcc in node-services-hub.
 *
 * Original: ~/Documents/claude_projects/WxCC-Config-MCP/server.js (standalone Express + MCP).
 *
 * Changes from original:
 *   - Exports an express.Router instead of calling app.listen()
 *   - Removed local express.json() — hub installs it once
 *   - REDIRECT_URI now derives from BASE_URL env var (e.g. https://node-services-hub.onrender.com/wxcc/auth/callback)
 *   - OAuth callback success message links back to /wxcc/ instead of "/"
 *   - All MCP tool implementations and the createMcpServer() factory are unchanged
 *   - Pre-existing global ORG_ID race condition (line 19, 148 in original) is preserved as-is
 *     — single-org demo use is unaffected. Not a consolidation-introduced bug.
 *
 * Endpoints exposed under /wxcc:
 *   GET  /wxcc/             — JSON manifest
 *   GET  /wxcc/health       — health + auth status
 *   GET  /wxcc/auth/login   — start OAuth
 *   GET  /wxcc/auth/callback
 *   GET  /wxcc/auth/status
 *   POST /wxcc/auth/logout
 *   GET  /wxcc/debug/api-test
 *   POST /wxcc/mcp          — MCP Streamable HTTP transport (17 tools)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// ============================================================
// CONFIGURATION
// ============================================================

const CLIENT_ID = process.env.WXCC_CLIENT_ID || "";
const CLIENT_SECRET = process.env.WXCC_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.WXCC_REDIRECT_URI ||
  (process.env.BASE_URL ? `${process.env.BASE_URL.replace(/\/$/, "")}/wxcc/auth/callback` : "") ||
  "https://wxcc-config-mcp.onrender.com/auth/callback"; // legacy fallback
const REGION = process.env.WXCC_REGION || "us1";
const SCOPES = "cjp:config cjp:config_read cjp:config_write";
let ORG_ID = process.env.WXCC_ORG_ID || "ccd57f4b-7515-4806-8b80-a4af18968a72";
const TOKEN_FILE = path.join("/tmp", "wxcc_token_store.json");
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// ============================================================
// TOKEN MANAGEMENT
// ============================================================

function loadTokenStore() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      console.log("[wxcc] Loaded token store from disk, expires at", new Date(data.expiresAt).toISOString());
      return data;
    }
  } catch (e) {
    console.error("[wxcc] Failed to load token store:", e.message);
  }
  return { accessToken: "", refreshToken: "", expiresAt: 0 };
}

function saveTokenStore() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore), "utf8");
  } catch (e) {
    console.error("[wxcc] Failed to save token store:", e.message);
  }
  saveToUpstash().catch((e) => console.error("[wxcc] Upstash save error:", e.message));
}

async function saveToUpstash() {
  if (!UPSTASH_REDIS_REST_URL) return;
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}/set/wxcc_token_store`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(JSON.stringify(tokenStore)),
  });
  if (!res.ok) console.error("[wxcc] Upstash save failed:", res.status);
}

async function loadFromUpstash() {
  if (!UPSTASH_REDIS_REST_URL) return null;
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/wxcc_token_store`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.result) {
      const parsed = JSON.parse(data.result);
      console.log("[wxcc] Loaded token store from Upstash, expires at", new Date(parsed.expiresAt).toISOString());
      return parsed;
    }
  } catch (e) {
    console.error("[wxcc] Upstash load error:", e.message);
  }
  return null;
}

let tokenStore = loadTokenStore();

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) return false;
  console.log("[wxcc] Refreshing access token...");
  try {
    const res = await fetch("https://webexapis.com/v1/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: tokenStore.refreshToken,
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      tokenStore.accessToken = data.access_token;
      tokenStore.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
      if (data.refresh_token) tokenStore.refreshToken = data.refresh_token;
      console.log("[wxcc] Token refreshed, expires in", data.expires_in, "seconds");
      saveTokenStore();
      return true;
    }
    console.error("[wxcc] Token refresh failed:", data);
    return false;
  } catch (e) {
    console.error("[wxcc] Token refresh error:", e.message);
    return false;
  }
}

async function getValidToken() {
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 5 * 60 * 1000) {
    return tokenStore.accessToken;
  }
  if (tokenStore.refreshToken) {
    const ok = await refreshAccessToken();
    if (ok) return tokenStore.accessToken;
  }
  return tokenStore.accessToken || null;
}

// Background refresh — fires once per process.
setInterval(async () => {
  if (tokenStore.refreshToken && Date.now() > tokenStore.expiresAt - 10 * 60 * 1000) {
    await refreshAccessToken();
  }
}, 10 * 60 * 1000);

// On module load, attempt cold-start recovery from Upstash.
(async () => {
  if (!tokenStore.accessToken || tokenStore.expiresAt < Date.now()) {
    const remote = await loadFromUpstash();
    if (remote && remote.refreshToken) {
      tokenStore = remote;
      saveTokenStore();
      console.log("[wxcc] Recovered token from Upstash backup");
      if (tokenStore.expiresAt < Date.now()) await refreshAccessToken();
    }
  }
})();

// ============================================================
// WxCC API HELPER
// ============================================================

async function discoverOrgId() {
  if (ORG_ID) return ORG_ID;
  const token = await getValidToken();
  if (!token) return null;

  // Method 1: Decode org from Webex JWT token payload
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (payload.realm) {
        ORG_ID = payload.realm;
        console.log("[wxcc] Discovered org ID from JWT:", ORG_ID);
        return ORG_ID;
      }
    }
  } catch (e) {
    /* not a JWT or no realm */
  }

  // Method 2: Try /v1/people/me
  try {
    const res = await fetch("https://webexapis.com/v1/people/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.orgId) {
        ORG_ID = data.orgId;
        console.log("[wxcc] Discovered org ID from People API:", ORG_ID);
        return ORG_ID;
      }
    }
  } catch (e) {
    console.error("[wxcc] People API fallback failed:", e.message);
  }
  return null;
}

async function wxccApi(method, apiPath, body = null, queryParams = {}) {
  const token = await getValidToken();
  if (!token) throw new Error("Not authenticated. Visit /wxcc/auth/login to connect your WxCC account.");

  const orgId = await discoverOrgId();
  if (!orgId) throw new Error("Organization ID not found. Re-authenticate or set WXCC_ORG_ID env var.");

  const baseUrl = `https://api.wxcc-${REGION}.cisco.com`;
  let fullPath;
  if (apiPath.startsWith("/v1/organization/")) {
    fullPath = apiPath;
  } else if (apiPath.includes("/statistics") || apiPath.match(/^\/v1\/flow/)) {
    fullPath = `/v1/organization/${orgId}${apiPath.replace(/^\/v1/, "")}`;
  } else {
    fullPath = `/organization/${orgId}${apiPath.replace(/^\/v1/, "")}`;
  }
  const url = new URL(`${baseUrl}${fullPath}`);
  Object.entries(queryParams).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const options = { method, headers };
  if (body && ["POST", "PUT", "PATCH"].includes(method)) {
    options.body = JSON.stringify(body);
  }

  console.log(`[wxcc][API] ${method} ${url.toString()} (input: ${apiPath})`);
  const res = await fetch(url.toString(), options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `WxCC API Error: ${method} ${url.toString()} → HTTP ${res.status}: ${
        typeof data === "object" ? JSON.stringify(data) : text.slice(0, 300)
      }`,
    );
  }

  return data;
}

// ============================================================
// MCP SERVER FACTORY
// ============================================================

function createMcpServer() {
  const server = new McpServer({
    name: "WxCC Configuration Tools",
    version: "1.0.0",
  });

  // TOOL 1: list_queues
  server.tool(
    "list_queues",
    "List all contact service queues. Optionally filter by name.",
    { name: z.string().optional().describe("Filter queues by name (partial match)") },
    async ({ name }) => {
      try {
        const data = await wxccApi("GET", "/v1/contact-service-queue", null, name ? { name } : {});
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 2: manage_queue
  server.tool(
    "manage_queue",
    "Create, update, or delete a contact service queue. For routing, use callDistributionGroups to assign teams.",
    {
      action: z.enum(["create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("Queue ID (required for update/delete)"),
      name: z.string().optional().describe("Queue name"),
      description: z.string().optional().describe("Queue description"),
      channelType: z.string().optional().describe("Channel type: telephony, chat, email, social"),
      routingType: z.string().optional().describe("Routing type: LONGEST_AVAILABLE_AGENT, SKILLS_BASED"),
      callDistributionGroups: z
        .array(
          z.object({
            order: z.number().describe("Priority order (1 = highest)"),
            duration: z.number().optional().describe("Seconds before overflow to next group (0 = no overflow)"),
            agentGroups: z
              .array(
                z.object({
                  teamId: z.string().describe("Team ID to route calls to"),
                }),
              )
              .describe("Teams in this distribution group"),
          }),
        )
        .optional()
        .describe("Call distribution groups - defines which teams get calls and in what order"),
      maxTimeInQueue: z.number().optional().describe("Max time in queue in seconds (default 600)"),
      serviceLevelThreshold: z.number().optional().describe("Service level threshold in seconds"),
    },
    async ({
      action,
      id,
      name,
      description,
      channelType,
      routingType,
      callDistributionGroups,
      maxTimeInQueue,
      serviceLevelThreshold,
    }) => {
      try {
        let result;

        if (action === "create") {
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          if (channelType) body.channelType = channelType;
          if (routingType) body.routingType = routingType;
          if (callDistributionGroups) body.callDistributionGroups = callDistributionGroups;
          if (maxTimeInQueue !== undefined) body.maxTimeInQueue = maxTimeInQueue;
          if (serviceLevelThreshold !== undefined) body.serviceLevelThreshold = serviceLevelThreshold;
          result = await wxccApi("POST", "/v1/contact-service-queue", body);
        } else if (action === "update") {
          if (!id) throw new Error("Queue ID is required for update");
          const current = await wxccApi("GET", `/v1/contact-service-queue/${id}`);
          delete current.links;
          delete current.createdTime;
          delete current.lastUpdatedTime;
          delete current.systemDefault;
          if (name) current.name = name;
          if (description) current.description = description;
          if (channelType) current.channelType = channelType;
          if (routingType) current.routingType = routingType;
          if (callDistributionGroups) current.callDistributionGroups = callDistributionGroups;
          if (maxTimeInQueue !== undefined) current.maxTimeInQueue = maxTimeInQueue;
          if (serviceLevelThreshold !== undefined) current.serviceLevelThreshold = serviceLevelThreshold;
          result = await wxccApi("PUT", `/v1/contact-service-queue/${id}`, current);
        } else if (action === "delete") {
          if (!id) throw new Error("Queue ID is required for delete");
          result = await wxccApi("DELETE", `/v1/contact-service-queue/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 3: list_teams
  server.tool(
    "list_teams",
    "List all teams with their configurations.",
    { name: z.string().optional().describe("Filter teams by name") },
    async ({ name }) => {
      try {
        const data = await wxccApi("GET", "/v1/team", null, name ? { name } : {});
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 4: manage_team
  server.tool(
    "manage_team",
    "Create, update, or delete a team. Use teamType 'AGENT' for teams that hold agents.",
    {
      action: z.enum(["create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("Team ID (required for update/delete)"),
      name: z.string().optional().describe("Team name"),
      description: z.string().optional().describe("Team description"),
      siteId: z.string().optional().describe("Site ID to assign the team to"),
      teamType: z.enum(["AGENT", "CAPACITY"]).optional().describe("Team type: AGENT (holds agents) or CAPACITY"),
      active: z.boolean().optional().describe("Whether team is active"),
    },
    async ({ action, id, name, description, siteId, teamType, active }) => {
      try {
        let result;

        if (action === "create") {
          const body = { active: true, teamStatus: "IN_SERVICE" };
          if (name) body.name = name;
          if (description) body.description = description;
          if (siteId) body.siteId = siteId;
          if (teamType) body.teamType = teamType;
          if (active !== undefined) body.active = active;
          result = await wxccApi("POST", "/v1/team", body);
        } else if (action === "update") {
          if (!id) throw new Error("Team ID is required for update");
          const current = await wxccApi("GET", `/v1/team/${id}`);
          delete current.links;
          delete current.createdTime;
          delete current.lastUpdatedTime;
          delete current.systemDefault;
          delete current.siteName;
          if (name) current.name = name;
          if (description) current.description = description;
          if (siteId) current.siteId = siteId;
          if (teamType) current.teamType = teamType;
          if (active !== undefined) current.active = active;
          result = await wxccApi("PUT", `/v1/team/${id}`, current);
        } else if (action === "delete") {
          if (!id) throw new Error("Team ID is required for delete");
          result = await wxccApi("DELETE", `/v1/team/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 5: list_users
  server.tool(
    "list_users",
    "List all configured users/agents in the WxCC tenant.",
    { name: z.string().optional().describe("Filter users by name") },
    async ({ name }) => {
      try {
        const data = await wxccApi("GET", "/v1/user", null, name ? { name } : {});
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 6: manage_user
  server.tool(
    "manage_user",
    "Create, update, or delete a user/agent. For updates, fetches current data first and merges changes (WxCC API requires full object on PUT).",
    {
      action: z.enum(["create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("User ID (required for update/delete)"),
      email: z.string().optional().describe("User email address"),
      firstName: z.string().optional().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
      teamIds: z.array(z.string()).optional().describe("Array of team IDs to assign"),
      userProfileId: z.string().optional().describe("User profile ID"),
      skillProfileId: z.string().optional().describe("Skill profile ID"),
      siteId: z.string().optional().describe("Site ID"),
      contactCenterEnabled: z.boolean().optional().describe("Enable/disable contact center for this user"),
      agentProfileId: z.string().optional().describe("Desktop/Agent profile ID to assign"),
      multimediaProfileId: z.string().optional().describe("Multimedia profile ID to assign"),
    },
    async ({
      action,
      id,
      email,
      firstName,
      lastName,
      teamIds,
      userProfileId,
      skillProfileId,
      siteId,
      contactCenterEnabled,
      agentProfileId,
      multimediaProfileId,
    }) => {
      try {
        let result;

        if (action === "create") {
          const body = {};
          if (email) body.email = email;
          if (firstName) body.firstName = firstName;
          if (lastName) body.lastName = lastName;
          if (teamIds) body.teamIds = teamIds;
          if (userProfileId) body.userProfileId = userProfileId;
          if (skillProfileId) body.skillProfileId = skillProfileId;
          if (siteId) body.siteId = siteId;
          if (contactCenterEnabled !== undefined) body.contactCenterEnabled = contactCenterEnabled;
          if (agentProfileId) body.agentProfileId = agentProfileId;
          if (multimediaProfileId) body.multimediaProfileId = multimediaProfileId;
          result = await wxccApi("POST", "/v1/user", body);
        } else if (action === "update") {
          if (!id) throw new Error("User ID is required for update");
          const current = await wxccApi("GET", `/v1/user/${id}`);
          delete current.links;
          delete current.createdTime;
          delete current.lastUpdatedTime;
          delete current.systemDefault;
          if (email) current.email = email;
          if (firstName) current.firstName = firstName;
          if (lastName) current.lastName = lastName;
          if (teamIds) current.teamIds = teamIds;
          if (userProfileId) current.userProfileId = userProfileId;
          if (skillProfileId) current.skillProfileId = skillProfileId;
          if (siteId) current.siteId = siteId;
          if (contactCenterEnabled !== undefined) current.contactCenterEnabled = contactCenterEnabled;
          if (agentProfileId) current.agentProfileId = agentProfileId;
          if (multimediaProfileId) current.multimediaProfileId = multimediaProfileId;
          result = await wxccApi("PUT", `/v1/user/${id}`, current);
        } else if (action === "delete") {
          if (!id) throw new Error("User ID is required for delete");
          result = await wxccApi("DELETE", `/v1/user/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 7: list_entry_points
  server.tool(
    "list_entry_points",
    "List all entry points (initial landing place for customer contacts).",
    { name: z.string().optional().describe("Filter entry points by name") },
    async ({ name }) => {
      try {
        const data = await wxccApi("GET", "/v1/entry-point", null, name ? { name } : {});
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 8: manage_entry_point
  server.tool(
    "manage_entry_point",
    "Create, update, or delete an entry point.",
    {
      action: z.enum(["create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("Entry point ID (required for update/delete)"),
      name: z.string().optional().describe("Entry point name"),
      description: z.string().optional().describe("Entry point description"),
      channelType: z.string().optional().describe("Channel type: telephony, chat, email, social"),
    },
    async ({ action, id, name, description, channelType }) => {
      try {
        let result;
        const body = {};
        if (name) body.name = name;
        if (description) body.description = description;
        if (channelType) body.channelType = channelType;

        if (action === "create") {
          result = await wxccApi("POST", "/v1/entry-point", body);
        } else if (action === "update") {
          if (!id) throw new Error("Entry point ID is required for update");
          result = await wxccApi("PUT", `/v1/entry-point/${id}`, body);
        } else if (action === "delete") {
          if (!id) throw new Error("Entry point ID is required for delete");
          result = await wxccApi("DELETE", `/v1/entry-point/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 9: list_flows
  server.tool(
    "list_flows",
    "List all flows and subflows with their status (draft/published).",
    {
      name: z.string().optional().describe("Filter flows by name"),
      status: z.enum(["draft", "published"]).optional().describe("Filter by status"),
    },
    async ({ name, status }) => {
      try {
        const params = {};
        if (name) params.name = name;
        if (status) params.status = status;
        const data = await wxccApi("GET", "/v1/flow", null, params);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 10: publish_flow
  server.tool(
    "publish_flow",
    "Publish a draft flow to make it active in production.",
    { id: z.string().describe("The flow ID to publish") },
    async ({ id }) => {
      try {
        const result = await wxccApi("POST", `/v1/flow/${id}/publish`);
        return {
          content: [{ type: "text", text: JSON.stringify(result || { success: true, flowId: id, status: "published" }, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 11: manage_business_hours
  server.tool(
    "manage_business_hours",
    "List, create, update, or delete business hours schedules.",
    {
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("Business hours ID (required for update/delete)"),
      name: z.string().optional().describe("Schedule name"),
      timezone: z.string().optional().describe("Timezone (e.g., America/New_York)"),
      description: z.string().optional().describe("Description"),
    },
    async ({ action, id, name, timezone, description }) => {
      try {
        let result;
        if (action === "list") {
          result = await wxccApi("GET", "/v1/business-hour", null, name ? { name } : {});
        } else if (action === "create") {
          const body = {};
          if (name) body.name = name;
          if (timezone) body.timezone = timezone;
          if (description) body.description = description;
          result = await wxccApi("POST", "/v1/business-hour", body);
        } else if (action === "update") {
          if (!id) throw new Error("Business hours ID is required for update");
          const body = {};
          if (name) body.name = name;
          if (timezone) body.timezone = timezone;
          if (description) body.description = description;
          result = await wxccApi("PUT", `/v1/business-hour/${id}`, body);
        } else if (action === "delete") {
          if (!id) throw new Error("Business hours ID is required for delete");
          result = await wxccApi("DELETE", `/v1/business-hour/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 12: manage_skills
  server.tool(
    "manage_skills",
    "List, create, update, or delete skills and skill profiles for routing.",
    {
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      resourceType: z.enum(["skill", "skill-profile"]).describe("Resource type to manage"),
      id: z.string().optional().describe("Resource ID (required for update/delete)"),
      name: z.string().optional().describe("Skill or profile name"),
      description: z.string().optional().describe("Description"),
      skillType: z.string().optional().describe("Skill type: text, proficiency, boolean, enum (only for skills)"),
    },
    async ({ action, resourceType, id, name, description, skillType }) => {
      try {
        let result;
        const basePath = `/v1/${resourceType}`;

        if (action === "list") {
          result = await wxccApi("GET", basePath, null, name ? { name } : {});
        } else if (action === "create") {
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          if (skillType && resourceType === "skill") body.skillType = skillType;
          result = await wxccApi("POST", basePath, body);
        } else if (action === "update") {
          if (!id) throw new Error(`${resourceType} ID is required for update`);
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          result = await wxccApi("PUT", `${basePath}/${id}`, body);
        } else if (action === "delete") {
          if (!id) throw new Error(`${resourceType} ID is required for delete`);
          result = await wxccApi("DELETE", `${basePath}/${id}`);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result || { success: true, action, resourceType }, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 13: manage_desktop_profile
  server.tool(
    "manage_desktop_profile",
    "List, create, update, or delete agent desktop profiles (permissions and behaviors).",
    {
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("Desktop profile ID (required for update/delete)"),
      name: z.string().optional().describe("Profile name"),
      description: z.string().optional().describe("Description"),
    },
    async ({ action, id, name, description }) => {
      try {
        let result;
        if (action === "list") {
          result = await wxccApi("GET", "/v1/agent-profile", null, name ? { name } : {});
        } else if (action === "create") {
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          result = await wxccApi("POST", "/v1/agent-profile", body);
        } else if (action === "update") {
          if (!id) throw new Error("Desktop profile ID is required for update");
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          result = await wxccApi("PUT", `/v1/agent-profile/${id}`, body);
        } else if (action === "delete") {
          if (!id) throw new Error("Desktop profile ID is required for delete");
          result = await wxccApi("DELETE", `/v1/agent-profile/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 14: manage_desktop_layout
  server.tool(
    "manage_desktop_layout",
    "List, create, update, or delete desktop layouts (agent UI customization).",
    {
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("Layout ID (required for update/delete)"),
      name: z.string().optional().describe("Layout name"),
      description: z.string().optional().describe("Description"),
      layoutJson: z.string().optional().describe("Desktop layout JSON definition (as string)"),
    },
    async ({ action, id, name, description, layoutJson }) => {
      try {
        let result;
        if (action === "list") {
          result = await wxccApi("GET", "/v1/desktop-layout", null, name ? { name } : {});
        } else if (action === "create") {
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          if (layoutJson) body.layoutJson = layoutJson;
          result = await wxccApi("POST", "/v1/desktop-layout", body);
        } else if (action === "update") {
          if (!id) throw new Error("Layout ID is required for update");
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          if (layoutJson) body.layoutJson = layoutJson;
          result = await wxccApi("PUT", `/v1/desktop-layout/${id}`, body);
        } else if (action === "delete") {
          if (!id) throw new Error("Layout ID is required for delete");
          result = await wxccApi("DELETE", `/v1/desktop-layout/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 15: manage_multimedia_profile
  server.tool(
    "manage_multimedia_profile",
    "List, create, update, or delete multimedia profiles (channel capacity per agent: voice, chat, email).",
    {
      action: z.enum(["list", "create", "update", "delete"]).describe("Action to perform"),
      id: z.string().optional().describe("Profile ID (required for update/delete)"),
      name: z.string().optional().describe("Profile name"),
      description: z.string().optional().describe("Description"),
      voiceCount: z.number().optional().describe("Max simultaneous voice tasks"),
      chatCount: z.number().optional().describe("Max simultaneous chat tasks"),
      emailCount: z.number().optional().describe("Max simultaneous email tasks"),
    },
    async ({ action, id, name, description, voiceCount, chatCount, emailCount }) => {
      try {
        let result;
        if (action === "list") {
          result = await wxccApi("GET", "/v1/multimedia-profile", null, name ? { name } : {});
        } else if (action === "create") {
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          if (voiceCount !== undefined) body.voiceCount = voiceCount;
          if (chatCount !== undefined) body.chatCount = chatCount;
          if (emailCount !== undefined) body.emailCount = emailCount;
          result = await wxccApi("POST", "/v1/multimedia-profile", body);
        } else if (action === "update") {
          if (!id) throw new Error("Multimedia profile ID is required for update");
          const body = {};
          if (name) body.name = name;
          if (description) body.description = description;
          if (voiceCount !== undefined) body.voiceCount = voiceCount;
          if (chatCount !== undefined) body.chatCount = chatCount;
          if (emailCount !== undefined) body.emailCount = emailCount;
          result = await wxccApi("PUT", `/v1/multimedia-profile/${id}`, body);
        } else if (action === "delete") {
          if (!id) throw new Error("Multimedia profile ID is required for delete");
          result = await wxccApi("DELETE", `/v1/multimedia-profile/${id}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result || { success: true, action }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 16: get_agent_stats
  server.tool(
    "get_agent_stats",
    "Get real-time agent statistics including state, team, and channel utilization.",
    {
      teamId: z.string().optional().describe("Filter by team ID"),
      from: z.string().optional().describe("Start time (ISO 8601 format)"),
      to: z.string().optional().describe("End time (ISO 8601 format)"),
    },
    async ({ teamId, from, to }) => {
      try {
        const params = {};
        if (teamId) params.teamId = teamId;
        if (from) params.from = from;
        if (to) params.to = to;
        const data = await wxccApi("GET", "/v1/agents/statistics", null, params);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // TOOL 17: get_queue_stats
  server.tool(
    "get_queue_stats",
    "Get real-time queue statistics including calls waiting and service level.",
    {
      queueId: z.string().optional().describe("Filter by queue ID"),
      from: z.string().optional().describe("Start time (ISO 8601 format)"),
      to: z.string().optional().describe("End time (ISO 8601 format)"),
    },
    async ({ queueId, from, to }) => {
      try {
        const params = {};
        if (queueId) params.queueId = queueId;
        if (from) params.from = from;
        if (to) params.to = to;
        const data = await wxccApi("GET", "/v1/queues/statistics", null, params);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  return server;
}

// ============================================================
// OAUTH STATE STORAGE (Upstash)
// ============================================================

async function saveOAuthState(state) {
  if (!UPSTASH_REDIS_REST_URL) return;
  await fetch(`${UPSTASH_REDIS_REST_URL}/set/oauth_state_${state}/1/EX/600`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
}

async function checkOAuthState(state) {
  if (!UPSTASH_REDIS_REST_URL) return false;
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/oauth_state_${state}`, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.result !== null;
}

async function deleteOAuthState(state) {
  if (!UPSTASH_REDIS_REST_URL) return;
  await fetch(`${UPSTASH_REDIS_REST_URL}/del/oauth_state_${state}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
}

// ============================================================
// ROUTER
// ============================================================

const router = express.Router();

// OAuth login
router.get("/auth/login", async (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  await saveOAuthState(state);
  const url = new URL("https://webexapis.com/v1/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// OAuth callback
router.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`<h2>OAuth error: ${error}</h2>`);
  const validState = await checkOAuthState(state);
  if (!validState) return res.status(400).send("<h2>Invalid OAuth state. Please try logging in again.</h2>");
  await deleteOAuthState(state);

  try {
    const tokenRes = await fetch("https://webexapis.com/v1/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await tokenRes.json();
    if (!data.access_token) {
      return res.status(500).send(`<h2>Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token || "";
    tokenStore.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    console.log("[wxcc] OAuth complete. Token expires in", data.expires_in, "seconds");
    saveTokenStore();
    res.send(
      '<h2>Authenticated</h2><p>The MCP server is now connected to your WxCC tenant. <a href="/wxcc/">Back to /wxcc/</a></p>',
    );
  } catch (e) {
    res.status(500).send(`<h2>Error: ${e.message}</h2>`);
  }
});

router.get("/auth/status", async (_req, res) => {
  const hasToken = !!tokenStore.accessToken;
  const hasRefresh = !!tokenStore.refreshToken;
  const expiresIn = tokenStore.expiresAt ? Math.round((tokenStore.expiresAt - Date.now()) / 1000) : 0;
  const orgId = hasToken ? await discoverOrgId() : null;
  res.json({ authenticated: hasToken, hasRefreshToken: hasRefresh, expiresInSeconds: expiresIn, orgId: orgId || null });
});

router.post("/auth/logout", (_req, res) => {
  tokenStore = { accessToken: "", refreshToken: "", expiresAt: 0 };
  saveTokenStore();
  res.json({ ok: true });
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "WxCC Config MCP Server",
    tools: 17,
    authenticated: !!tokenStore.accessToken,
    orgId: ORG_ID || null,
  });
});

// Debug — verify token + raw API call
router.get("/debug/api-test", async (_req, res) => {
  const token = tokenStore.accessToken;
  if (!token) return res.json({ error: "Not authenticated" });

  let tokenInfo = {};
  try {
    const parts = token.split(".");
    tokenInfo.parts = parts.length;
    if (parts.length >= 2) {
      const payload = Buffer.from(parts[1], "base64url").toString();
      try {
        tokenInfo.payload = JSON.parse(payload);
      } catch {
        tokenInfo.payloadRaw = payload.slice(0, 200);
      }
    }
    const decoded = Buffer.from(token, "base64").toString();
    tokenInfo.decodedSnippet = decoded.slice(0, 300);
  } catch (e) {
    tokenInfo.decodeError = e.message;
  }

  const orgId = ORG_ID;
  const testUrl = `https://api.wxcc-${REGION}.cisco.com/organization/${orgId}/team`;
  let apiResult = {};
  try {
    const r = await fetch(testUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const text = await r.text();
    apiResult = { url: testUrl, status: r.status, body: text.slice(0, 500) };
  } catch (e) {
    apiResult = { url: testUrl, error: e.message };
  }

  res.json({ orgId, tokenInfo, apiResult });
});

// Manifest at /wxcc/
router.get("/", (_req, res) => {
  res.json({
    name: "WxCC Configuration MCP Server",
    description: "MCP server for natural language Webex Contact Center configuration",
    version: "1.0.0",
    tools: 17,
    authenticated: !!tokenStore.accessToken,
    endpoints: {
      mcp: "/wxcc/mcp",
      health: "/wxcc/health",
      auth_login: "/wxcc/auth/login",
      auth_status: "/wxcc/auth/status",
    },
  });
});

// MCP endpoint — stateless: new server+transport per request
router.post("/mcp", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[wxcc] MCP request error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

router.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST for MCP requests." });
});
router.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST for MCP requests." });
});

export default router;
