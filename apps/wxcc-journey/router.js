/**
 * wxcc-journey — WxCC Journey Explorer mounted at /journey in node-services-hub.
 *
 * Purpose: Browser-based tool to investigate Webex Contact Center interactions
 * end-to-end. Search interactions by date range + customer identifier, drill in
 * to render the full event timeline.
 *
 * Auth: Personal access token entered by the user in the Settings panel (stored
 * in localStorage). The browser sends it as Authorization: Bearer <token> on
 * every API call. No server-side token required — token is NOT stored server-side.
 *
 * Endpoints:
 *   GET  /journey/          — Journey Explorer UI (static HTML)
 *   ALL  /journey/api/*     — Proxy → https://api.wxcc-{region}.cisco.com/*
 *                             Region resolved from X-WxCC-Region request header (default: us1)
 *                             Authorization header forwarded as-is from browser
 *   ALL  /journey/s3/*      — Proxy → S3 presigned recording/transcript URLs
 *                             Browser passes the S3 path after /s3/ (avoids S3 CORS)
 *   POST /journey/serving/* — Returns 503; Python gRPC sidecar not available on Render
 *   GET  /journey/health    — Health check
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ─── Static files ────────────────────────────────────────────────────────────
router.use(express.static(path.join(__dirname, "public")));

// ─── Health check ────────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wxcc-journey" });
});

// ─── WxCC API proxy (/api/*) ─────────────────────────────────────────────────
// Browser sends: GET/POST /journey/api/v1/organization/...
// We forward to:          GET/POST https://api.wxcc-{region}.cisco.com/v1/organization/...
//
// Required headers from browser:
//   Authorization: Bearer <personal-access-token>
//   X-WxCC-Region: us1   (or eu1, eu2, ca1, anz1, jp1, sg1)
router.all("/api/*", async (req, res) => {
  const region = (req.headers["x-wxcc-region"] || "us1").replace(/[^a-z0-9]/gi, "");
  // req.url inside router is relative to mount point: /api/v1/...
  const upstreamPath = req.url.replace(/^\/api/, "");
  const upstream = `https://api.wxcc-${region}.cisco.com${upstreamPath}`;

  const headers = {
    Accept: "application/json",
    "Content-Type": req.headers["content-type"] || "application/json",
  };
  if (req.headers["authorization"]) {
    headers["Authorization"] = req.headers["authorization"];
  }

  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    init.body = JSON.stringify(req.body);
  }

  try {
    const upstream_res = await fetch(upstream, init);
    const text = await upstream_res.text();

    // Forward status and content-type
    res.status(upstream_res.status);
    const ct = upstream_res.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    const retryAfter = upstream_res.headers.get("retry-after");
    if (retryAfter) res.set("Retry-After", retryAfter);

    res.send(text);
  } catch (err) {
    console.error("[wxcc-journey] proxy error:", err.message);
    res.status(502).json({ error: "Upstream request failed", detail: err.message });
  }
});

// ─── S3 recording/transcript proxy (/s3/*) ───────────────────────────────────
// S3 presigned URLs don't include CORS headers. Browser passes the S3 path
// (everything after the bucket hostname) as the URL path after /s3/.
// Example: /journey/s3/path/to/file.json?X-Amz-Signature=...
const S3_HOST = "https://cjp-ccone-produs1-media-storage-recording.s3.amazonaws.com";

router.get("/s3/*", async (req, res) => {
  const s3Path = req.url.replace(/^\/s3/, "");
  const upstream = `${S3_HOST}${s3Path}`;

  try {
    const s3res = await fetch(upstream);
    const buffer = await s3res.arrayBuffer();
    res.status(s3res.status);
    const ct = s3res.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("[wxcc-journey] s3 proxy error:", err.message);
    res.status(502).json({ error: "S3 request failed", detail: err.message });
  }
});

// ─── VA sidecar stubs (/serving/*) ───────────────────────────────────────────
// The Python gRPC sidecar is a local-only component (not available on Render).
// Return 503 so the browser's graceful-fail path triggers (shows N/A, not an error).
router.all("/serving/*", (_req, res) => {
  res.status(503).json({ error: "VA gRPC sidecar not available on this deployment" });
});

// ─── Serve index.html for root ────────────────────────────────────────────────
router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

export default router;
