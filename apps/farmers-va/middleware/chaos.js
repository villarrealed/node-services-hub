/**
 * chaos.js
 * 
 * Chaos engineering middleware - simulates random RADD outages when enabled.
 * 30% failure rate on /radd/* endpoints when system:chaos_mode = Y.
 */

import redis from '../shared/redis-client.js';

let chaosEnabled = false;
let lastCheck = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Check if chaos mode is enabled (cached for 5s)
 */
async function isChaosEnabled() {
  const now = Date.now();
  if (now - lastCheck > CACHE_TTL) {
    const mode = await redis.get('system:chaos_mode');
    chaosEnabled = mode === 'Y';
    lastCheck = now;
  }
  return chaosEnabled;
}

/**
 * Chaos middleware - randomly fails /radd/* requests when enabled
 */
export async function chaosMiddleware(req, res, next) {
  // Only apply to /radd/* paths
  if (!req.path.startsWith('/radd/')) {
    return next();
  }

  const enabled = await isChaosEnabled();
  if (enabled && Math.random() < 0.30) {
    return res.status(500).json({
      error: 'simulated RADD outage',
      chaos: true,
    });
  }

  next();
}
