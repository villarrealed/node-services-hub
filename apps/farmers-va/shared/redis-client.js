/**
 * redis-client.js
 * 
 * Singleton Upstash Redis client for Farmers VA Demo.
 * Reads connection credentials from environment variables and exports
 * a configured Redis instance for use across all packages.
 * 
 * Required environment variables:
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  throw new Error('Missing UPSTASH_REDIS_REST_URL/TOKEN — check .env');
}

export const redis = new Redis({ url, token });
export default redis;
