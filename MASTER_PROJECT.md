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
- State: phone number ↔ Webex room ID mapping, stored in the hub's existing shared **Upstash Redis** instance (`UPSTASH_REDIS_REST_URL`/`TOKEN`, already used by jds/wxcc token storage — no new credentials), key prefix `sms-bridge:phone:` / `sms-bridge:room:`. **Migrated 2026-08-10 from SQLite+Disk** — the original Disk plan never actually took effect (Render Blueprint disk config doesn't retroactively attach to a pre-existing service), so `DATABASE_PATH` was silently never set and every mapping lived on ephemeral storage, wiped on every restart — root cause of an early reply-not-sending bug. Attaching a Disk after the fact was rejected too: it would disable zero-downtime deploys and block horizontal scaling for the *entire* 11-app hub, too big a cost for one small lookup table. Full task spec: `webex-connect-sms-bridge/UPSTASH_MAPPING_STORE_TASK.md`.
- All 8 required env vars are set on the live Render service (2 generated random secrets for the self-chosen shared secrets, 6 provided by the project owner from Webex Developer Portal / Webex Connect tenant). `DATABASE_PATH` and the Disk resource have been removed — no longer used.
- **Deployed and verified live**: `/sms-bridge/healthz` returns 200, `/health` lists it in `mounted`.
- **Reply path (Webex → SMS) fully working as of 2026-08-11.** Root cause of the original silent failure: Webex Connect's outbound webhook expects the Service Key in a header literally named `key`, not `Authorization` — the wrong header name returned HTTP 200 with a body-level error, so the code logged "success" while Connect's flow transaction log showed zero invocations (commit `38d45d3`). Also fixed along the way: membership re-add after a recipient leaves a room (`f69669c`), duplicate-room safeguards via title-lookup + atomic Redis claim (`aa379e6`), E.164 phone normalization (`8fb19ed`), and `@mention`-stripping for group-space replies — two passes, since Webex renders mentions using the bot's `nickName` ("SMS") not `displayName` ("SMS Bridge") (`05abca8`, `dfafba6`).
- **Compose flow shipped 2026-08-11** (commit `c1664a9`): DM the bot with `/newsms <number> <message>` to start a new SMS conversation from Webex. Extracted the duplicate-room-safe resolution logic into a shared `apps/sms-bridge/lib/roomResolver.js`, reused by both the inbound path and this command. Reports success/failure back into the DM synchronously — no silent failures.
- **Not yet done (deliberately out of scope):** registering the live URL with Webex's `messages:created` webhook, and with the Webex Connect Flow's HTTP Request node, are both already done directly by the project owner (not via this repo). No remaining out-of-scope items on the original deploy task.
- **Paused, pending manual setup 2026-08-11 — Webex Calling call summaries.** Goal: after a phone call with the same number this bridge texts, post an AI-generated call summary (or at minimum call metadata) into that number's Webex space. Licensing confirmed OK (Pro Pack, Call Recording, AI Assistant for Calling all enabled; Control Hub admin access available) but blocked on creating + authorizing a **Service Application** (bot tokens have zero access to calling data) with scopes `spark-admin:calling_cdr_read` (Detailed Call History) and `spark:recordings_read`/`spark-admin:recordings_read` (AI summaries/transcripts via the Converged Recordings API). Full research + design notes are in `webex-connect-sms-bridge/MASTER_PROJECT.md`'s corresponding goal entry. Do not build a tight polling loop once resumed — Webex's own CDR rate limit is 1 req/min per org with no server-side number filter; a webhook-based `cdr_stream` may be the better fit, worth re-evaluating once credentials exist.

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
