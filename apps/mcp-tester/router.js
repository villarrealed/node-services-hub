/**
 * mcp-tester — Interactive MCP testing UI mounted at /tester in node-services-hub.
 *
 * Purpose: Test MCP servers mounted on this hub before exposing them to Webex AI Studio.
 * Built for the Farmers Voice Advantage IVR demo project.
 *
 * Endpoints:
 *   GET  /tester/         — Interactive testing UI (HTML page)
 *   GET  /tester/servers  — JSON list of MCP servers available on this hub
 *   GET  /tester/health   — Health check
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Serve static files from public directory
router.use(express.static(path.join(__dirname, "public")));

// Health check
router.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "MCP Tester" });
});

// List of MCP servers available on this hub
router.get("/servers", (_req, res) => {
  res.json([
    {
      id: "radd",
      name: "RADD MCP",
      url: "/radd/mcp",
      description: "DNIS/ANI lookup for Farmers Voice Advantage IVR",
    },
    {
      id: "farmers",
      name: "Farmers Insurance MCP",
      url: "/farmers/mcp",
      description: "Insurance tools for Webex AI Agent Lab",
    },
    {
      id: "wxcc",
      name: "WxCC Configuration MCP",
      url: "/wxcc/mcp",
      description: "Webex Contact Center configuration",
    },
  ]);
});

// Serve index.html at root
router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

export default router;
