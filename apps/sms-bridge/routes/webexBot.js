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
    // TEMPORARY diagnostic logging — remove once the reply path is confirmed
    // working end-to-end. Every prior failure mode here has been silent
    // (early `return`s produce zero log output), so this traces every stage.
    console.log('[sms-bridge] webhook hit, has-signature-header:', !!req.get('x-spark-signature'));

    const signature = req.get('x-spark-signature');
    if (!verifyWebexSignature(req.body, signature, process.env.WEBEX_WEBHOOK_SECRET)) {
      console.log('[sms-bridge] signature verification FAILED');
      return res.status(401).json({ error: 'invalid signature' });
    }
    console.log('[sms-bridge] signature verified OK');

    const event = JSON.parse(req.body.toString('utf8'));
    res.status(204).end(); // ack immediately, Webex expects a fast response

    try {
      const messageId = event.data?.id;
      const roomId = event.data?.roomId;
      console.log('[sms-bridge] event data:', { messageId, roomId, resource: event.resource, eventType: event.event });
      if (!messageId || !roomId) {
        console.log('[sms-bridge] missing messageId or roomId, stopping');
        return;
      }

      const message = await getMessage(messageId);
      console.log('[sms-bridge] fetched message, personId:', message.personId, 'mentionedPeople:', message.mentionedPeople, 'text:', JSON.stringify(message.text));
      if (message.personId === process.env.WEBEX_BOT_ID) {
        console.log('[sms-bridge] message is from the bot itself, stopping');
        return; // ignore the bot's own posts
      }

      const phoneNumber = await getPhoneByRoom(roomId);
      console.log('[sms-bridge] getPhoneByRoom result:', phoneNumber);
      if (!phoneNumber) {
        console.log('[sms-bridge] no phone mapping for this room, stopping');
        return; // not an SMS-bridge room
      }

      let smsText = message.text;
      try {
        const botName = await getBotDisplayName();
        smsText = stripBotMention(message.text, botName);
      } catch (err) {
        console.warn('failed to fetch bot display name, sending unstripped text', err);
      }

      await sendSms(phoneNumber, smsText);
      console.log('[sms-bridge] sendSms completed OK for', phoneNumber);
    } catch (err) {
      console.error('outbound SMS handling failed', err);
    }
  }
);

export default router;
