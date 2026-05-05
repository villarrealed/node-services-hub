# node-services-hub

Single Express app that mounts multiple Node services under path prefixes. Lets several small apps share **one Render paid plan** instead of paying per-service or running each on the free tier (which spins down after 15 minutes idle).

## Why

Render charges $7/mo per always-on Node service. Running N services on N paid plans costs N × $7. Running them all in one Express process costs $7 total.

## Architecture

```
node-services-hub.onrender.com
├── /              → landing page (per-app links)
├── /health        → hub health check
├── /jds/*         → jds-web-manager       (planned, Step 2)
├── /wxcc/*        → wxcc-config-mcp       (planned, Step 3)
└── /farmers/*     → farmers-insurance-mcp (planned, Step 4)
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
| 1 | ✅ | Repo scaffold (this commit) |
| 2 | ⏳ | Mount jds-web-manager at `/jds` |
| 3 | ⏳ | Mount wxcc-config-mcp at `/wxcc` |
| 4 | ⏳ | Mount farmers-insurance-mcp at `/farmers` |
| 5 | ⏳ | Landing page with per-app status |
| 6 | ⏳ | `render.yaml` + deploy on paid Starter plan |

## Vendoring policy

Sub-apps are **copied** into `apps/`, not linked via submodules. The original repos remain untouched as reference. Updates to a sub-app are made in this repo and (optionally) backported.
