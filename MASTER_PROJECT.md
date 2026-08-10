# Node Services Hub

**Status:** IN PROGRESS
**Created:** 2026-05-05

---

## Project Overview

Single Express app that mounts multiple Node services under path prefixes so several small apps share one Render paid plan instead of paying per service. Hosts jds-web-manager, wxcc-config-mcp, farmers-insurance-mcp, radd-mcp, mcp-tester, farmers-va (+ MCP), farmers-ivr-mcp, salesforce-mcp, wxcc-journey-explorer, and sms-bridge behind one process with a landing page and health checks.

### sms-bridge (/sms-bridge)

Ported from the standalone `webex-connect-sms-bridge` project (CommonJS → ESM, mechanical port, no logic changes). Bridges SMS (via Webex Connect) into Webex App messages (via a Webex bot).

- Routes: `POST /sms-bridge/webhooks/webex-connect/inbound` (Connect → Webex), `POST /sms-bridge/webhooks/webex/messages` (Webex → Connect), `GET /sms-bridge/healthz`
- Mounted **before** the hub's global `cors()`/`express.json()` middleware — required so the raw-body HMAC signature check on `/webhooks/webex/messages` isn't broken by the JSON parser consuming the stream first.
- State: single SQLite file (`better-sqlite3`) mapping phone number ↔ Webex room ID, persisted on a Render **Disk** (`sms-bridge-data`, 1GB, mounted at `/data`) — `DATABASE_PATH=/data/bridge.sqlite`. Without the Disk this data would be wiped on every redeploy/restart.
- All 8 required env vars are set on the live Render service (2 generated random secrets for the self-chosen shared secrets, 6 provided by the project owner from Webex Developer Portal / Webex Connect tenant).
- **Deployed and verified live** (commit `bb648fd`, deploy `dep-d9t4rvpsrm7s73bqpg8g`): `/sms-bridge/healthz` returns 200, `/health` lists it in `mounted`.
- **Not yet done (deliberately out of scope):** registering the live URL with Webex's `messages:created` webhook, and with the Webex Connect Flow's HTTP Request node. Both need the live URL above; happens as a separate follow-up step.

---

## Files

```
node-services-hub/
├── server.js       # Hub: mounts each sub-app under its path prefix
├── apps/           # Sub-app implementations
├── public/         # Landing page assets
├── render.yaml     # Render deployment config
├── package.json    # Node.js dependencies
└── project_notes/  # Session notes
```

---

## GitHub Repository

- **URL:** https://github.com/villarrealed/node-services-hub
- **Default Branch:** main

---

## Usage

```bash
npm install
node server.js
# Landing page:  http://localhost:3000/
# Hub health:    /health
# Sub-app health: /_status
```

Deployed at node-services-hub.onrender.com via `render.yaml`.

---

## Rebuild Prompt

```
Build a single Express app that mounts multiple independent Node services
under path prefixes (/jds, /wxcc, /farmers, /radd, /tester, /farmers-va,
/farmers-va-mcp, /salesforce, /journey) so they share one Render paid plan.
Include a landing page with per-app links and live status, a /health endpoint,
and a /_status endpoint returning all sub-app health as JSON.
```
