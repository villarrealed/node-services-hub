// Sends an outbound SMS by POSTing to a Webex Connect Flow's Webhook trigger
// (Tenant B) — the Flow's SMS Send node makes the actual carrier call.
//
// This replaced an earlier direct-REST design after this sandbox tenant's
// Simple REST Messaging API base URL turned out to be undiscoverable — see
// ARCHITECTURE.md Decisions #3a for the full trade-off (this reintroduces a
// flow-execution cost on outbound that the original design tried to avoid).

// Webex Connect's API docs mark E.164 (+1XXXXXXXXXX) as required/recommended
// for the `to` field. Upstream sources (e.g. the SMS trigger's
// sms.senderNumber, which becomes the stored `from` and later the outbound
// `to` on replies) don't reliably include the leading `+`.
function toE164(number) {
  const digits = String(number).replace(/\D/g, '');
  return `+${digits}`;
}

export async function sendSms(toPhoneNumber, text) {
  const webhookUrl = process.env.WEBEX_CONNECT_OUTBOUND_WEBHOOK_URL;
  const from = process.env.WEBEX_CONNECT_FROM_NUMBER;
  if (!webhookUrl || !from) {
    throw new Error('WEBEX_CONNECT_OUTBOUND_WEBHOOK_URL and WEBEX_CONNECT_FROM_NUMBER must be set');
  }

  const headers = { 'Content-Type': 'application/json' };
  // Trigger's "Service key or JWT" auth option is enabled. Confirmed via direct
  // testing 2026-08-11: Webex Connect expects this in a header literally named
  // `key` — NOT `Authorization`. An `Authorization` header (with or without a
  // `Bearer` prefix) returns HTTP 200 with a *body-level* error
  // ({"response":{"code":"7001","description":"Authentication failed."}}),
  // which is why this was silently "succeeding" from this code's point of
  // view while Connect's own flow transaction log showed zero invocations.
  if (process.env.WEBEX_CONNECT_SERVICE_KEY) {
    headers.key = process.env.WEBEX_CONNECT_SERVICE_KEY;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from, to: toE164(toPhoneNumber), text }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Webex Connect outbound webhook failed: ${res.status} ${bodyText}`);
  }

  // Webex Connect returns HTTP 200 even on auth/validation failures — the
  // actual result is in the response body's `response.code`. A successful
  // queue looks like {"response":[{"code":"1002","description":"Queued",...}]}.
  // Any other shape/code is treated as a failure so it surfaces as a real
  // error instead of a false "success".
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Webex Connect outbound webhook returned non-JSON body: ${bodyText}`);
  }
  const responseField = parsed?.response;
  const entries = Array.isArray(responseField) ? responseField : [responseField];
  const failed = entries.find((entry) => entry?.code && entry.code !== '1002');
  if (failed) {
    throw new Error(`Webex Connect outbound webhook rejected the request: ${JSON.stringify(failed)}`);
  }
}
