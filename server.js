/**
 * node-services-hub
 *
 * A single Express app that mounts multiple sub-applications under path prefixes.
 * Purpose: consolidate several small Node services onto one Render paid plan so
 * none of them spin down on the free tier.
 *
 * Layout:
 *   /             — landing page (added in Step 5)
 *   /jds/*        — jds-web-manager (Step 2 ✓)
 *   /wxcc/*       — wxcc-config-mcp (Step 3)
 *   /farmers/*    — farmers-insurance-mcp (Step 4)
 *   /health       — top-level health check
 */

import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import jdsRouter from "./apps/jds-web-manager/router.js";
import wxccRouter from "./apps/wxcc-config-mcp/router.js";
import farmersRouter from "./apps/farmers-insurance-mcp/router.js";

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

// Hub-level middleware applied to ALL sub-apps.
// JDS used cors() and express.json() in its standalone server; we install them once here.
app.use(cors());
app.use(express.json());

// ─── Mount sub-apps ──────────────────────────────────────────────────────────
const MOUNTED = [];
const STATUS_APPS = [
  { prefix: "/jds", name: "jds-web-manager", healthPath: "/jds/auth/status" },
  { prefix: "/wxcc", name: "wxcc-config-mcp", healthPath: "/wxcc/health" },
  { prefix: "/farmers", name: "farmers-insurance-mcp", healthPath: "/farmers/health" },
];

app.use("/jds", jdsRouter);
MOUNTED.push({ prefix: "/jds", name: "jds-web-manager" });

app.use("/wxcc", wxccRouter);
MOUNTED.push({ prefix: "/wxcc", name: "wxcc-config-mcp" });

app.use("/farmers", farmersRouter);
MOUNTED.push({ prefix: "/farmers", name: "farmers-insurance-mcp" });

// ─── Hub routes ──────────────────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));

app.get("/_status", async (_req, res) => {
  const baseUrl = `http://127.0.0.1:${PORT}`;

  const apps = await Promise.all(
    STATUS_APPS.map(async (service) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      try {
        const response = await fetch(`${baseUrl}${service.healthPath}`, {
          signal: controller.signal,
        });

        return {
          ...service,
          ok: response.ok,
        };
      } catch {
        return {
          ...service,
          ok: false,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }),
  );

  res.json({
    ok: apps.every((service) => service.ok),
    apps,
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "node-services-hub",
    version: "0.6.0",
    mounted: MOUNTED,
    uptime_sec: Math.round(process.uptime()),
  });
});

app.listen(PORT, () => {
  console.log(`[hub] listening on :${PORT}`);
  console.log(`[hub] mounted: ${MOUNTED.map((m) => m.prefix).join(", ") || "(none)"}`);
});
