import crypto from 'node:crypto';

// Webex webhooks: HMAC-SHA1 over the raw request body, hex-encoded, sent as X-Spark-Signature.
export function verifyWebexSignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
  return Boolean(signatureHeader) && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

// Webex Connect inbound: shared-secret header, exact scheme depends on your
// tenant's HTTP Request node config — this checks a static header value.
export function verifyConnectSecret(headerValue, expected) {
  if (!expected) return false;
  return Boolean(headerValue) && crypto.timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected));
}
