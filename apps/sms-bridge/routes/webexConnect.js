import express from 'express';
import { getRoomByPhone, saveMapping } from '../lib/db.js';
import { createRoomForPhoneNumber, postMessage } from '../lib/webexApi.js';
import { verifyConnectSecret } from '../lib/verifySignature.js';

const router = express.Router();

// Called by the Webex Connect Flow's HTTP Request node when an SMS arrives.
// Expected body: { from: "+15551234567", to: "+15559876543", text: "...", messageId: "..." }
router.post('/inbound', express.json(), async (req, res) => {
  const secretHeader = req.get('x-connect-secret');
  if (!verifyConnectSecret(secretHeader, process.env.WEBEX_CONNECT_INBOUND_SECRET)) {
    return res.status(401).json({ error: 'invalid secret' });
  }

  const { from, text } = req.body || {};
  if (!from || !text) {
    return res.status(400).json({ error: 'from and text are required' });
  }

  try {
    let roomId = await getRoomByPhone(from);
    if (!roomId) {
      roomId = await createRoomForPhoneNumber(from);
      await saveMapping(from, roomId);
    }
    await postMessage(roomId, text);
    res.status(204).end();
  } catch (err) {
    console.error('inbound SMS handling failed', err);
    res.status(502).json({ error: 'failed to relay message to Webex' });
  }
});

export default router;
