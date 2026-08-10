import express from 'express';
import { getRoomByPhone, saveMapping, claimPhoneNumber } from '../lib/db.js';
import { createRoomForPhoneNumber, postMessage, addMembership, findRoomByTitle } from '../lib/webexApi.js';
import { verifyConnectSecret } from '../lib/verifySignature.js';

const router = express.Router();

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      roomId = await findRoomByTitle(`SMS: ${from}`);
      if (!roomId) {
        const won = await claimPhoneNumber(from);
        if (won) {
          roomId = await createRoomForPhoneNumber(from);
        } else {
          // Another concurrent request already won the race — wait for it to
          // finish writing the real room ID instead of creating a second room.
          for (let attempt = 0; attempt < RETRY_ATTEMPTS && (!roomId || roomId === 'pending'); attempt++) {
            await sleep(RETRY_DELAY_MS);
            roomId = await getRoomByPhone(from);
          }
          if (!roomId || roomId === 'pending') {
            // Edge case: the winner claimed but never finished (e.g. crashed).
            // Fall back to creating anyway rather than hanging forever.
            console.warn('claimPhoneNumber race: winner never finished, creating room anyway', from);
            roomId = await createRoomForPhoneNumber(from);
          }
        }
      }
      await saveMapping(from, roomId);
    }
    // Every message, not just at creation — recovers a recipient who left the space.
    const recipientEmail = process.env.SMS_RECIPIENT_EMAIL;
    if (recipientEmail) await addMembership(roomId, recipientEmail);
    await postMessage(roomId, text);
    res.status(204).end();
  } catch (err) {
    console.error('inbound SMS handling failed', err);
    res.status(502).json({ error: 'failed to relay message to Webex' });
  }
});

export default router;
