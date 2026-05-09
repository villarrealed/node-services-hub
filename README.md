# node-services-hub

Single Express app that mounts multiple Node services under path prefixes. Lets several small apps share **one Render paid plan** instead of paying per-service or running each on the free tier (which spins down after 15 minutes idle).

## Why

Render charges $7/mo per always-on Node service. Running N services on N paid plans costs N × $7. Running them all in one Express process costs $7 total.

## Architecture

```
node-services-hub.onrender.com
├── /              → landing page (per-app links)
├── /health        → hub health check
├── /jds/*         → jds-web-manager
├── /wxcc/*        → wxcc-config-mcp
├── /farmers/*     → farmers-insurance-mcp
├── /radd/*        → radd-mcp (Farmers RADD routing lookups)
└── /tester/*      → mcp-tester (Interactive MCP testing UI)
```

Each sub-app is vendored under `apps/<name>/` and exports an Express `Router` instead of calling `app.listen()` itself. The top-level `server.js` does the listening and `app.use("/<prefix>", subRouter)`.

## Local development

```bash
npm install
npm start         # http://localhost:3000
npm run dev       # auto-reload on file changes
```

## Build progress

| Step | Status | Description |
|---|---|---|
| 1 | ✅ | Repo scaffold |
| 2 | ✅ | Mount jds-web-manager at `/jds` |
| 3 | ✅ | Mount wxcc-config-mcp at `/wxcc` |
| 4 | ✅ | Mount farmers-insurance-mcp at `/farmers` |
| 5 | ✅ | Mount radd-mcp at `/radd` (Farmers Voice Advantage IVR routing lookups) |
| 6 | ✅ | Landing page with per-app status |
| 7 | ✅ | `render.yaml` + deploy on paid Starter plan |
| 8 | ✅ | Mount mcp-tester at `/tester` (Interactive MCP testing UI) |

## Vendoring policy

Sub-apps are **copied** into `apps/`, not linked via submodules. The original repos remain untouched as reference. Updates to a sub-app are made in this repo and (optionally) backported.

## Deployment

### One-time Render setup

1. **Connect GitHub repo**: In the Render dashboard, click **New → Web Service**, connect your GitHub account, and select the `villarrealed/node-services-hub` repository.

2. **Auto-detect configuration**: Render will detect `render.yaml` at the repo root. Click **Apply** to create the service with the pre-configured settings:
   - Service name: `node-services-hub`
   - Plan: **Starter ($7/mo)**
   - Region: Oregon
   - Build: `npm install`
   - Start: `node server.js`
   - Health check: `/health`
   - Auto-deploy: enabled on `main` branch

3. **Configure environment variables**: In the Render dashboard, go to **Environment** and set the following variables. The `render.yaml` file pre-populates keys with `sync: false` — you must fill in the values manually (never commit secrets to git).

#### Environment variables checklist

| Variable | Required? | Where to get it | Notes |
|----------|-----------|-----------------|-------|
| **Hub-level** | | | |
| `BASE_URL` | ✅ | Pre-set to `https://node-services-hub.onrender.com` | Used by sub-apps to construct OAuth callback URLs |
| **JDS Web Manager** | | | |
| `WEBEX_CLIENT_ID` | ✅ | From `~/Documents/claude_projects/jds-web-manager/.env` or Webex developer portal | OAuth client ID for JDS API access |
| `WEBEX_CLIENT_SECRET` | ✅ | Same as above | OAuth client secret |
| `CJDS_REGION` | ❌ | Optional (e.g., `us1`, `eu1`) | Leave empty if not using region-specific JDS endpoints |
| `CJDS_WORKSPACE_ID` | ❌ | Optional | Leave empty unless you have a specific workspace ID |
| `CJDS_TOKEN` | ❌ | Optional | Can be left empty; OAuth will populate it on first login |
| **WxCC Config MCP** | | | |
| `WXCC_CLIENT_ID` | ✅ | From `~/Documents/claude_projects/WxCC-Config-MCP/.env` or Webex developer portal | OAuth client ID for WxCC API access |
| `WXCC_CLIENT_SECRET` | ✅ | Same as above | OAuth client secret |
| `WXCC_REGION` | ❌ | Pre-set to `us1` | Change if your WxCC tenant is in a different region |
| `WXCC_ORG_ID` | ❌ | Optional | Auto-discovered from token if not set |
| **Upstash Redis (shared)** | | | |
| `UPSTASH_REDIS_REST_URL` | ⚠️ | Upstash dashboard (create a free Redis instance) | **Recommended**: prevents token loss on Render restarts. Both `/jds` and `/wxcc` use this for token persistence. |
| `UPSTASH_REDIS_REST_TOKEN` | ⚠️ | Same as above | Required if `UPSTASH_REDIS_REST_URL` is set |
| **Farmers Insurance MCP** | | | |
| _(none)_ | — | — | All data is hardcoded for demo purposes |
| **RADD MCP** | | | |
| _(none)_ | — | — | All data is hardcoded for demo purposes (Farmers Voice Advantage IVR) |
| **MCP Tester** | | | |
| _(none)_ | — | — | Static UI for testing MCP servers on this hub |

### Critical post-deploy step: Update OAuth callback URLs

After the first successful deploy, you **must** update the OAuth redirect URIs in your Webex integration consoles:

1. **JDS Web Manager**:
   - Go to the Webex developer portal where you created the JDS OAuth integration
   - Update the **Redirect URI** to: `https://node-services-hub.onrender.com/jds/auth/callback`
   - Remove the old standalone URL (`https://jds-web-manager.onrender.com/auth/callback`) once verified

2. **WxCC Config MCP**:
   - Go to the Webex developer portal where you created the WxCC OAuth integration
   - Update the **Redirect URI** to: `https://node-services-hub.onrender.com/wxcc/auth/callback`
   - Remove the old standalone URL (`https://wxcc-config-mcp.onrender.com/auth/callback`) once verified

**Why this matters**: OAuth will fail with "redirect_uri mismatch" errors until these are updated. The sub-apps now derive their callback URLs from `BASE_URL` + their mount prefix.

### Verification

After deploy completes and OAuth callbacks are updated, verify all endpoints are working:

```bash
# Hub health check
curl https://node-services-hub.onrender.com/health

# Hub status (checks all sub-apps)
curl https://node-services-hub.onrender.com/_status

# JDS Web Manager
curl https://node-services-hub.onrender.com/jds/
curl https://node-services-hub.onrender.com/jds/auth/status

# WxCC Config MCP
curl https://node-services-hub.onrender.com/wxcc/
curl https://node-services-hub.onrender.com/wxcc/health

# Farmers Insurance MCP
curl https://node-services-hub.onrender.com/farmers/
curl https://node-services-hub.onrender.com/farmers/health

# RADD MCP (Farmers Voice Advantage IVR routing lookups)
curl https://node-services-hub.onrender.com/radd/health
curl -X POST https://node-services-hub.onrender.com/radd/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# MCP Tester (Interactive MCP testing UI)
curl https://node-services-hub.onrender.com/tester/health
curl https://node-services-hub.onrender.com/tester/servers
```

Expected results:
- `/health` → `{"ok": true, "version": "0.6.0", ...}`
- `/_status` → `{"ok": true, "apps": [...]}`
- All sub-app endpoints return JSON (not 404 or 500)

### Decommission old services

**Only after verification**, delete the 3 old Render services to stop paying for them:

1. `jds-web-manager` (was at `https://jds-web-manager.onrender.com`)
2. `wxcc-config-mcp` (was at `https://wxcc-config-mcp.onrender.com`)
3. `farmers-insurance-mcp` (was at `https://farmers-insurance-mcp.onrender.com`)

**Before deleting**:
- Confirm all OAuth flows work on the new URLs
- Update any external links or bookmarks
- Export logs if needed for historical reference

**Cost savings**: 3 services × $7/mo = $21/mo → 1 service × $7/mo = **$14/mo saved**.
