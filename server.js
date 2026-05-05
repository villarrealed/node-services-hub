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

import jdsRouter from "./apps/jds-web-manager/router.js";
import wxccRouter from "./apps/wxcc-config-mcp/router.js";
import farmersRouter from "./apps/farmers-insurance-mcp/router.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Hub-level middleware applied to ALL sub-apps.
// JDS used cors() and express.json() in its standalone server; we install them once here.
app.use(cors());
app.use(express.json());

// ─── Mount sub-apps ──────────────────────────────────────────────────────────
const MOUNTED = [];

app.use("/jds", jdsRouter);
MOUNTED.push({ prefix: "/jds", name: "jds-web-manager" });

app.use("/wxcc", wxccRouter);
MOUNTED.push({ prefix: "/wxcc", name: "wxcc-config-mcp" });

app.use("/farmers", farmersRouter);
MOUNTED.push({ prefix: "/farmers", name: "farmers-insurance-mcp" });

// ─── Hub routes ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "node-services-hub",
    version: "0.4.0",
    mounted: MOUNTED,
    uptime_sec: Math.round(process.uptime()),
  });
});

app.get("/", (_req, res) => {
  const list = MOUNTED.map(
    (m) => `<li><a href="${m.prefix}/"><code>${m.prefix}</code></a> — ${m.name}</li>`,
  ).join("");
  res.type("html").send(`
    <!doctype html>
    <html lang="en">
    <head><meta charset="utf-8"><title>node-services-hub</title>
    <style>
      body{font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;margin:60px auto;padding:0 20px;color:#1d1d1f}
      h1{font-size:22px;margin:0 0 4px}
      .muted{color:#6e6e73}
      code{background:#f2f2f7;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
      ul{padding-left:20px}
    </style></head>
    <body>
      <h1>node-services-hub</h1>
      <p class="muted">Mounted apps:</p>
      <ul>${list || "<li><em>none yet</em></li>"}</ul>
      <p>Status: <a href="/health"><code>/health</code></a></p>
    </body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`[hub] listening on :${PORT}`);
  console.log(`[hub] mounted: ${MOUNTED.map((m) => m.prefix).join(", ") || "(none)"}`);
});
