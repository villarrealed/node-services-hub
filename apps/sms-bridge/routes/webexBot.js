import express from 'express';
import { getPhoneByRoom } from '../lib/db.js';
import { getMessage, getBotNames } from '../lib/webexApi.js';
import { sendSms } from '../lib/connectApi.js';
import { verifyWebexSignature } from '../lib/verifySignature.js';

const router = express.Router();

function stripLeadingName(text, name) {
  if (!text || !name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^@?${escaped}\\s+`, 'i');
  return pattern.test(text) ? text.replace(pattern, '') : null;
}

// Webex renders an @mention in the plain `text` field using the mentioned
// person's nickName, not displayName (confirmed 2026-08-11: nickName "SMS",
// displayName "SMS Bridge" — real mentioned messages arrive as "SMS gotcha").
// Try the LONGER name first: nickName is a prefix of displayName here, so
// checking nickName first would partially match a full "SMS Bridge ..." text
// and only strip "SMS ", leaving "Bridge ..." behind. Checking the longer
// name first avoids that ambiguity regardless of which one Webex actually used.
function stripBotMention(text, { nickName, displayName } = {}) {
  const candidates = [displayName, nickName].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of candidates) {
    const stripped = stripLeadingName(text, name);
    if (stripped !== null) return stripped;
  }
  return text;
}

// Webex `messages:created` webhook. Body only contains IDs, not message text —
// the actual content is fetched via GET /v1/messages/{id}.
router.post(
  '/messages',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.get('x-spark-signature');
    if (!verifyWebexSignature(req.body, signature, process.env.WEBEX_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    const event = JSON.parse(req.body.toString('utf8'));
    res.status(204).end(); // ack immediately, Webex expects a fast response

    try {
      const messageId = event.data?.id;
      const roomId = event.data?.roomId;
      if (!messageId || !roomId) return;

      const message = await getMessage(messageId);
      if (message.personId === process.env.WEBEX_BOT_ID) return; // ignore the bot's own posts

      const phoneNumber = await getPhoneByRoom(roomId);
      if (!phoneNumber) return; // not an SMS-bridge room

      let smsText = message.text;
      try {
        const botNames = await getBotNames();
        smsText = stripBotMention(message.text, botNames);
      } catch (err) {
        console.warn('failed to fetch bot names, sending unstripped text', err);
      }

      await sendSms(phoneNumber, smsText);
    } catch (err) {
      console.error('outbound SMS handling failed', err);
    }
  }
);

export default router;
