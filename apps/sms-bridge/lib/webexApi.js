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

  return room.id;
}

export async function findRoomByTitle(title) {
  const res = await fetch(`${WEBEX_API}/rooms?max=100&type=group&sortBy=lastactivity`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`listRooms failed: ${res.status} ${await res.text()}`);
  const { items } = await res.json();
  const match = items.find((r) => r.title === title);
  return match ? match.id : null;
}

export async function addMembership(roomId, personEmail) {
  const res = await fetch(`${WEBEX_API}/memberships`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ roomId, personEmail }),
  });
  if (res.status === 409) return;
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

let cachedBotNames = null;

// Webex renders an @mention in a message's plain `text` field using the
// person's `nickName`, not their `displayName` (confirmed via direct testing
// 2026-08-11: bot displayName "SMS Bridge", nickName "SMS" — mentioned
// messages arrived as text like "SMS gotcha", not "SMS Bridge gotcha").
// Cache both so the mention-stripping logic can try nickName first (the
// actual observed behavior) and fall back to displayName just in case.
export async function getBotNames() {
  if (cachedBotNames) return cachedBotNames;
  const res = await fetch(`${WEBEX_API}/people/${process.env.WEBEX_BOT_ID}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`getBotNames failed: ${res.status} ${await res.text()}`);
  const person = await res.json();
  cachedBotNames = { displayName: person.displayName, nickName: person.nickName };
  return cachedBotNames;
}
