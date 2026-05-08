## What was built

- Replaced the placeholder `/` response with a static `public/index.html` landing page.
- Added a dynamic `/_status` endpoint that checks each mounted app internally with a 2-second timeout.
- Bumped hub version to `0.5.0` in `package.json`, `package-lock.json`, and `/health`.

## Key decisions

- Static assets are served after `/jds`, `/wxcc`, and `/farmers` mounts so sub-app routing cannot be shadowed.
- The landing page is self-contained vanilla HTML/CSS/JS with no build step and no blocking external dependencies.
- Status badges only show liveness based on internal hub fetches, keeping auth details private.

## Rebuild prompt

Build a polished, Cisco-branded landing page for the node-services-hub Express app using plain HTML/CSS/JS only. Create `public/index.html` with three service cards for `/jds`, `/wxcc`, and `/farmers`, including live status badges fetched from a new `/_status` endpoint. In `server.js`, keep existing sub-app mount order untouched, add static serving for `public/` after the mounts, add `GET /_status` that internally fetches each app health endpoint with a 2-second timeout, keep `/health` JSON, and bump the hub version to `0.5.0`.

## Dependencies and context

- Node 18+ global `fetch`
- Existing mounted routers:
  - `/jds` → `./apps/jds-web-manager/router.js`
  - `/wxcc` → `./apps/wxcc-config-mcp/router.js`
  - `/farmers` → `./apps/farmers-insurance-mcp/router.js`
- Expected health paths:
  - `/jds/auth/status`
  - `/wxcc/health`
  - `/farmers/health`
