import { getRoomByPhone, saveMapping, claimPhoneNumber } from './db.js';
import { createRoomForPhoneNumber, findRoomByTitle } from './webexApi.js';

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves the Webex room ID for an SMS phone number, creating one if needed.
// Shared by both the inbound Connect webhook path and the bot-DM compose flow
// so the duplicate-room safeguards (title lookup + atomic claim) live in one place.
export async function resolveOrCreateRoomForPhone(phoneNumber) {
  let roomId = await getRoomByPhone(phoneNumber);
  if (!roomId) {
    roomId = await findRoomByTitle(`SMS: ${phoneNumber}`);
    if (!roomId) {
      const won = await claimPhoneNumber(phoneNumber);
      if (won) {
        roomId = await createRoomForPhoneNumber(phoneNumber);
      } else {
        // Another concurrent request already won the race — wait for it to
        // finish writing the real room ID instead of creating a second room.
        for (let attempt = 0; attempt < RETRY_ATTEMPTS && (!roomId || roomId === 'pending'); attempt++) {
          await sleep(RETRY_DELAY_MS);
          roomId = await getRoomByPhone(phoneNumber);
        }
        if (!roomId || roomId === 'pending') {
          // Edge case: the winner claimed but never finished (e.g. crashed).
          // Fall back to creating anyway rather than hanging forever.
          console.warn('claimPhoneNumber race: winner never finished, creating room anyway', phoneNumber);
          roomId = await createRoomForPhoneNumber(phoneNumber);
        }
      }
    }
    await saveMapping(phoneNumber, roomId);
  }
  return roomId;
}
