/**
 * node-services-hub
 *
 * A single Express app that mounts multiple sub-applications under path prefixes.
 * Purpose: consolidate several small Node services onto one Render paid plan so
 * none of them spin down on the free tier.
 *
 * Layout:
 *   /             — landing page (added in Step 5)
 *   /jds/*        — jds-web-manager (added in Step 2)
 *   /wxcc/*       — wxcc-config-mcp (added in Step 3)
 *   /farmers/*    — farmers-insurance-mcp (added in Step 4)
 *   /health       — top-level health check
 */

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Top-level health check — used by Render and by you to confirm the hub is up.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "node-services-hub",
    version: "0.1.0",
    mounted: [], // will list mounted sub-apps as they're added in later steps
    uptime_sec: Math.round(process.uptime()),
  });
});

// Placeholder root — replaced by a real landing page in Step 5.
app.get("/", (_req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="en">
    <head><meta charset="utf-8"><title>node-services-hub</title>
    <style>
      body{font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;margin:60px auto;padding:0 20px;color:#1d1d1f}
      h1{font-size:22px;margin:0 0 4px}
      .muted{color:#6e6e73}
      code{background:#f2f2f7;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
    </style></head>
    <body>
      <h1>node-services-hub</h1>
      <p class="muted">Scaffold ready · no apps mounted yet.</p>
      <p>Status: <a href="/health"><code>/health</code></a></p>
    </body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`[hub] listening on :${PORT}`);
});
