import express from 'express';
import { createLogger } from './middleware/logger.js';
import { chaosMiddleware } from './middleware/chaos.js';
import { clientCount } from './utils/event-bus.js';
import redis from './shared/redis-client.js';
import raddRoutes from './routes/radd.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';

const router = express.Router();

// Per-app middleware (hub already provides cors + express.json globally,
// but radd-api uses its own logger + chaos)
const [morganLogger, timingLogger] = createLogger();
router.use(morganLogger);
router.use(timingLogger);
router.use(chaosMiddleware);

// Sub-routes
router.use('/radd', raddRoutes);
router.use('/admin', adminRoutes);
router.use('/analytics', analyticsRoutes);

// Health endpoint at /farmers-va/health
router.get('/health', async (req, res) => {
  try {
    const webexAvailable = await redis.get('webex:available');
    const redisUp = webexAvailable !== null;
    res.json({
      status: redisUp ? 'ok' : 'degraded',
      redis: redisUp ? 'up' : 'down',
      uptime: process.uptime(),
      sseClients: clientCount(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Root manifest (matches hub convention — see apps/radd-mcp/router.js)
router.get('/', (req, res) => {
  res.json({
    name: 'farmers-va',
    version: '0.1.0',
    description: 'Farmers Voice Advantage Phase 2 demo - RADD-compatible API',
    endpoints: {
      health: '/farmers-va/health',
      lookup: 'POST /farmers-va/radd/lookup',
      upsert: 'POST /farmers-va/radd/upsert',
      admin: '/farmers-va/admin/*',
      analytics: '/farmers-va/analytics/*',
    },
  });
});

export default router;
