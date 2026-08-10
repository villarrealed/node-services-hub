/**
 * webex-connect-sms-bridge — mounted as a sub-router under /sms-bridge in node-services-hub.
 *
 * Original: ~/Documents/claude_projects/webex-connect-sms-bridge/src/server.js (standalone Express app).
 * Changes from original:
 *   - Exports an express.Router instead of calling app.listen()
 *   - Uses ESM (import) to match the hub
 *   - Route paths are unchanged: /healthz, /webhooks/webex-connect/inbound, /webhooks/webex/messages
 *     (become /sms-bridge/healthz, /sms-bridge/webhooks/webex-connect/inbound,
 *     /sms-bridge/webhooks/webex/messages once mounted)
 *   - IMPORTANT: this router MUST be mounted in server.js BEFORE the hub's global
 *     express.json() middleware runs, because /webhooks/webex/messages uses
 *     express.raw({type:'application/json'}) to preserve the exact byte buffer
 *     needed for HMAC signature verification. If express.json() runs first, the
 *     body stream is already consumed and signature verification will always fail.
 *   - No behavior/logic changes were made to the routes or lib files (mechanical port only).
 */

import express from "express";
import webexConnectRoutes from "./routes/webexConnect.js";
import webexBotRoutes from "./routes/webexBot.js";

const router = express.Router();

router.get("/healthz", (_req, res) => res.status(200).send("ok"));

router.use("/webhooks/webex-connect", webexConnectRoutes);
router.use("/webhooks/webex", webexBotRoutes);

export default router;
