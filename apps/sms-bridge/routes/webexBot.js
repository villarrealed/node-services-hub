import express from 'express';
import { getPhoneByRoom } from '../lib/db.js';
import { getMessage, getBotDisplayName } from '../lib/webexApi.js';
import { sendSms } from '../lib/connectApi.js';
import { verifyWebexSignature } from '../lib/verifySignature.js';

const router = express.Router();

function stripBotMention(text, botName) {
  if (!text || !botName) return text;
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^@?${escaped}\\s+`, 'i');
  return text.replace(pattern, '');
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
        const botName = await getBotDisplayName();
        smsText = stripBotMention(message.text, botName);
      } catch (err) {
        console.warn('failed to fetch bot display name, sending unstripped text', err);
      }

      await sendSms(phoneNumber, smsText);
    } catch (err) {
      console.error('outbound SMS handling failed', err);
    }
  }
);

export default router;
