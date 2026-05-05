/**
 * jds-web-manager — mounted as a sub-router under /jds in node-services-hub.
 *
 * Original: ~/Documents/claude_projects/jds-web-manager/server.js (standalone Express app).
 * Changes from original:
 *   - Exports an express.Router instead of calling app.listen()
 *   - Uses ESM (import) to match the hub
 *   - Reconstructs __dirname (not available in ESM)
 *   - Removed top-level cors() and express.json() — hub installs them globally
 *   - REDIRECT_URI now derives from BASE_URL env var (e.g. https://node-services-hub.onrender.com/jds/auth/callback)
 *   - SPA fallback `router.get('*')` only fires for paths inside /jds (Express scopes it to the mount point)
 *   - Injects a small <base href="/jds/"> + fetch shim so the SPA's absolute fetch paths
 *     (/auth/..., /api/..., /config) get rewritten to /jds/auth/..., /jds/api/..., /jds/config
 *     without modifying ~3000 lines of inline JS in public/index.html
 */

import express from "express";
import fetch from "node-fetch";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ─── Mount-aware OAuth config ────────────────────────────────────────────────
// REDIRECT_URI must be the externally-reachable URL of /jds/auth/callback.
// Priority: explicit JDS_REDIRECT_URI → BASE_URL + /jds/auth/callback → legacy default.
const CLIENT_ID = process.env.WEBEX_CLIENT_ID || "";
const CLIENT_SECRET = process.env.WEBEX_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.JDS_REDIRECT_URI ||
  process.env.REDIRECT_URI ||
  (process.env.BASE_URL ? `${process.env.BASE_URL.replace(/\/$/, "")}/jds/auth/callback` : "") ||
  "https://jds-web-manager.onrender.com/auth/callback"; // legacy fallback
const SCOPES =
  "spark:kms spark:people_read cjp:config_write cjp:config cjp:config_read cjds:admin_org_read cjds:admin_org_write";
const TOKEN_FILE = path.join("/tmp", "jds_token_store.json");

// ─── Upstash Redis config (persistent token backup) ──────────────────────────
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// ─── Token persistence ───────────────────────────────────────────────────────
function loadTokenStore() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      console.log("[jds] Loaded token store from disk, expires at", new Date(data.expiresAt).toISOString());
      return data;
    }
  } catch (e) {
    console.error("[jds] Failed to load token store:", e.message);
  }
  return {
    accessToken: process.env.CJDS_TOKEN || "",
    refreshToken: "",
    expiresAt: process.env.CJDS_TOKEN ? Date.now() + 12 * 3600 * 1000 : 0,
  };
}

function saveTokenStore() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore), "utf8");
  } catch (e) {
    console.error("[jds] Failed to save token store:", e.message);
  }
  saveToUpstash().catch((e) => console.error("[jds] Upstash save error:", e.message));
}

async function saveToUpstash() {
  if (!UPSTASH_REDIS_REST_URL) return;
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}/set/jds_token_store`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(JSON.stringify(tokenStore)),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("[jds] Upstash save failed:", res.status, text);
  }
}

async function loadFromUpstash() {
  if (!UPSTASH_REDIS_REST_URL) return null;
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/jds_token_store`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.result) {
      const parsed = JSON.parse(data.result);
      console.log("[jds] Loaded token store from Upstash, expires at", new Date(parsed.expiresAt).toISOString());
      return parsed;
    }
  } catch (e) {
    console.error("[jds] Upstash load error:", e.message);
  }
  return null;
}

let tokenStore = loadTokenStore();
const oauthStates = new Map();

// ─── Token helpers ───────────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!tokenStore.refreshToken) return false;
  console.log("[jds] Refreshing access token...");
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
      console.log("[jds] Token refreshed, expires in", data.expires_in, "seconds");
      saveTokenStore();
      return true;
    }
    console.error("[jds] Token refresh failed:", data);
    return false;
  } catch (e) {
    console.error("[jds] Token refresh error:", e.message);
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
  return tokenStore.accessToken;
}

// Background refresh — kept inside the router module; runs once per process.
setInterval(async () => {
  if (tokenStore.refreshToken && Date.now() > tokenStore.expiresAt - 10 * 60 * 1000) {
    await refreshAccessToken();
  }
}, 10 * 60 * 1000);

// On module load, attempt cold-start recovery from Upstash if local /tmp is empty.
(async () => {
  if (!tokenStore.accessToken || tokenStore.expiresAt < Date.now()) {
    const remote = await loadFromUpstash();
    if (remote && remote.refreshToken) {
      tokenStore = remote;
      saveTokenStore();
      console.log("[jds] Recovered token from Upstash backup");
      if (tokenStore.expiresAt < Date.now()) await refreshAccessToken();
    }
  }
})();

// ─── SPA HTML middleware: inject <base> + fetch shim ─────────────────────────
// The SPA was written assuming it owned the root, with fetches like `/api/foo`,
// `/auth/status`, `/config`. Mounted at /jds, those would hit the hub root.
// We rewrite `index.html` once on first read, caching the result in memory.
const SPA_FILE = path.join(__dirname, "public", "index.html");
let spaHtmlCache = null;
function getSpaHtml() {
  if (spaHtmlCache) return spaHtmlCache;
  const raw = fs.readFileSync(SPA_FILE, "utf8");
  // Inject right after <head> (case-insensitive). Keeps original file untouched on disk.
  const shim = `
<base href="/jds/">
<script>
  // Mount-prefix shim. The SPA was written with absolute paths like /api/foo.
  // Rewrite them to /jds/api/foo so they hit this sub-app, not the hub root.
  (function () {
    var PREFIX = "/jds";
    var APP_PATHS = ["/api/", "/auth/", "/config"];
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === "string" && input.charAt(0) === "/" && input.indexOf(PREFIX + "/") !== 0) {
        for (var i = 0; i < APP_PATHS.length; i++) {
          if (input === APP_PATHS[i] || input.indexOf(APP_PATHS[i]) === 0) {
            input = PREFIX + input;
            break;
          }
        }
      }
      return origFetch.call(this, input, init);
    };
  })();
</script>
`;
  spaHtmlCache = raw.replace(/<head([^>]*)>/i, (m) => m + shim);
  return spaHtmlCache;
}

// ─── OAuth routes ────────────────────────────────────────────────────────────
router.get("/auth/login", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, Date.now());
  const url = new URL("https://webexapis.com/v1/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

router.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`<h2>OAuth error: ${error}</h2>`);
  if (!oauthStates.has(state)) return res.status(400).send("<h2>Invalid OAuth state</h2>");
  oauthStates.delete(state);

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
      return res
        .status(500)
        .send(`<h2>Token exchange failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }
    tokenStore.accessToken = data.access_token;
    tokenStore.refreshToken = data.refresh_token || "";
    tokenStore.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    console.log("[jds] OAuth complete. Token expires in", data.expires_in, "s. Refresh:", !!data.refresh_token);
    saveTokenStore();
    res.redirect("/jds/"); // mount-aware redirect
  } catch (e) {
    res.status(500).send(`<h2>Error: ${e.message}</h2>`);
  }
});

router.get("/auth/status", async (_req, res) => {
  const hasToken = !!tokenStore.accessToken;
  const hasRefresh = !!tokenStore.refreshToken;
  const expiresIn = tokenStore.expiresAt ? Math.round((tokenStore.expiresAt - Date.now()) / 1000) : 0;
  res.json({ authenticated: hasToken, hasRefreshToken: hasRefresh, expiresInSeconds: expiresIn });
});

router.post("/auth/logout", (_req, res) => {
  tokenStore = { accessToken: "", refreshToken: "", expiresAt: 0 };
  res.json({ ok: true });
});

// ─── Config endpoint ─────────────────────────────────────────────────────────
router.get("/config", (_req, res) => {
  res.json({
    region: process.env.CJDS_REGION || "",
    workspaceId: process.env.CJDS_WORKSPACE_ID || "",
    oauthEnabled: !!(CLIENT_ID && CLIENT_SECRET),
  });
});

// ─── API proxy ───────────────────────────────────────────────────────────────
// Note: req.originalUrl is "/jds/api/..." here (full URL), so we strip the
// /jds prefix as well as /api to get the upstream path.
router.all("/api/*", async (req, res) => {
  const region = req.headers["x-cjds-region"] || process.env.CJDS_REGION || "us1";
  const token = (await getValidToken()) || req.headers["x-cjds-token"];

  const rawPath = req.originalUrl.replace(/^\/jds/, "").replace(/^\/api/, "");

  const baseUrl = rawPath.startsWith("/v1/journey/")
    ? `https://jds-${region}.cjaas.cisco.com`
    : `https://api.wxcc-${region}.cisco.com`;

  const targetUrl = `${baseUrl}${rawPath}`;
  console.log(`[jds][PROXY] ${req.method} ${targetUrl}`);

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const fetchOptions = { method: req.method, headers };
    if (["POST", "PUT", "PATCH"].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }
    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get("content-type") || "";
    res.status(response.status);
    res.set("x-debug-target-url", targetUrl);
    res.set("x-debug-status", String(response.status));
    if (contentType.includes("application/json")) {
      res.json(await response.json());
    } else {
      res.send(await response.text());
    }
  } catch (err) {
    console.error("[jds][PROXY] Error:", err);
    res.status(502).json({ error: "Proxy error", message: err.message });
  }
});

// ─── Static assets + SPA fallback ────────────────────────────────────────────
// Serve everything in public/ EXCEPT index.html (we serve a transformed copy).
router.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    extensions: ["html"],
  }),
);

// Mount-scoped catch-all for the SPA. Express scopes "*" to the mount point,
// so this fires for /jds and /jds/anything-not-matched-above.
router.get("*", (_req, res) => {
  res.type("html").send(getSpaHtml());
});

export default router;
