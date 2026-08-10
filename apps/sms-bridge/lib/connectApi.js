// Sends an outbound SMS by POSTing to a Webex Connect Flow's Webhook trigger
// (Tenant B) — the Flow's SMS Send node makes the actual carrier call.
//
// This replaced an earlier direct-REST design after this sandbox tenant's
// Simple REST Messaging API base URL turned out to be undiscoverable — see
// ARCHITECTURE.md Decisions #3a for the full trade-off (this reintroduces a
// flow-execution cost on outbound that the original design tried to avoid).
export async function sendSms(toPhoneNumber, text) {
  const webhookUrl = process.env.WEBEX_CONNECT_OUTBOUND_WEBHOOK_URL;
  const from = process.env.WEBEX_CONNECT_FROM_NUMBER;
  if (!webhookUrl || !from) {
    throw new Error('WEBEX_CONNECT_OUTBOUND_WEBHOOK_URL and WEBEX_CONNECT_FROM_NUMBER must be set');
  }

  const headers = { 'Content-Type': 'application/json' };
  // Trigger's "Service key or JWT" auth option is enabled — same Service Key
  // value confirmed working earlier against production Connect infrastructure.
  if (process.env.WEBEX_CONNECT_SERVICE_KEY) {
    headers.Authorization = process.env.WEBEX_CONNECT_SERVICE_KEY;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from, to: toPhoneNumber, text }),
  });

  if (!res.ok) {
    throw new Error(`Webex Connect outbound webhook failed: ${res.status} ${await res.text()}`);
  }
}
