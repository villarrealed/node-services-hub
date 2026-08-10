const WEBEX_API = 'https://webexapis.com/v1';

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.WEBEX_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function createRoomForPhoneNumber(phoneNumber) {
  const res = await fetch(`${WEBEX_API}/rooms`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ title: `SMS: ${phoneNumber}` }),
  });
  if (!res.ok) throw new Error(`createRoom failed: ${res.status} ${await res.text()}`);
  const room = await res.json();

  const recipientEmail = process.env.SMS_RECIPIENT_EMAIL;
  if (recipientEmail) await addMembership(room.id, recipientEmail);

  return room.id;
}

export async function addMembership(roomId, personEmail) {
  const res = await fetch(`${WEBEX_API}/memberships`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ roomId, personEmail }),
  });
  if (!res.ok) throw new Error(`addMembership failed: ${res.status} ${await res.text()}`);
}

export async function postMessage(roomId, text) {
  const res = await fetch(`${WEBEX_API}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ roomId, text }),
  });
  if (!res.ok) throw new Error(`postMessage failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getMessage(messageId) {
  const res = await fetch(`${WEBEX_API}/messages/${messageId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`getMessage failed: ${res.status} ${await res.text()}`);
  return res.json();
}
