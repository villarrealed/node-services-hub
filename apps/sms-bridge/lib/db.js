import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv(); // reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

const PHONE_PREFIX = 'sms-bridge:phone:';
const ROOM_PREFIX = 'sms-bridge:room:';

export async function getRoomByPhone(phoneNumber) {
  return (await redis.get(PHONE_PREFIX + phoneNumber)) ?? null;
}

export async function getPhoneByRoom(roomId) {
  return (await redis.get(ROOM_PREFIX + roomId)) ?? null;
}

export async function saveMapping(phoneNumber, roomId) {
  await Promise.all([
    redis.set(PHONE_PREFIX + phoneNumber, roomId),
    redis.set(ROOM_PREFIX + roomId, phoneNumber),
  ]);
}
