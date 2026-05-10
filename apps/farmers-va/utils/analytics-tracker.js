/**
 * analytics-tracker.js
 * 
 * Redis-backed analytics tracking for call events.
 * Maintains a capped list of recent calls and counters for intents/destinations.
 */

const CALLS_LIST_KEY = 'analytics:calls';
const MAX_CALLS = 500;

/**
 * Log a call event to Redis
 * @param {Object} redis - Redis client
 * @param {Object} event - Call event data
 * @returns {Promise<string>} callId
 */
export async function logCallEvent(redis, event) {
  // LPUSH the event
  await redis.lpush(CALLS_LIST_KEY, JSON.stringify(event));

  // LTRIM to keep only most recent 500
  await redis.ltrim(CALLS_LIST_KEY, 0, MAX_CALLS - 1);

  // Increment intent counter if present
  if (event.intent) {
    await redis.incr(`analytics:intents:${event.intent}`);
  }

  // Increment destination counter if present
  if (event.destination) {
    await redis.incr(`analytics:destinations:${event.destination}`);
  }

  return event.callId;
}

/**
 * Get recent call events
 * @param {Object} redis - Redis client
 * @param {number} limit - Max number of calls to retrieve
 * @returns {Promise<Array>} Array of call events
 */
export async function getCallEvents(redis, limit = 50) {
  const maxLimit = Math.min(limit, MAX_CALLS);
  const calls = await redis.lrange(CALLS_LIST_KEY, 0, maxLimit - 1);
  return calls.map((call) => typeof call === 'string' ? JSON.parse(call) : call);
}

/**
 * Get intent counts from Redis counters
 * @param {Object} redis - Redis client
 * @returns {Promise<Object>} Map of intent -> count
 */
export async function getIntentCounts(redis) {
  const keys = await redis.keys('analytics:intents:*');
  const counts = {};

  for (const key of keys) {
    const intent = key.replace('analytics:intents:', '');
    const count = await redis.get(key);
    counts[intent] = parseInt(count, 10);
  }

  return counts;
}

/**
 * Get destination counts from Redis counters
 * @param {Object} redis - Redis client
 * @returns {Promise<Object>} Map of destination -> count
 */
export async function getDestinationCounts(redis) {
  const keys = await redis.keys('analytics:destinations:*');
  const counts = {};

  for (const key of keys) {
    const destination = key.replace('analytics:destinations:', '');
    const count = await redis.get(key);
    counts[destination] = parseInt(count, 10);
  }

  return counts;
}
