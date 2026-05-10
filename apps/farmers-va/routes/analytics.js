/**
 * analytics.js
 * 
 * Analytics API routes for call event logging and reporting.
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import redis from '../shared/redis-client.js';
import {
  logCallEvent,
  getCallEvents,
  getIntentCounts,
  getDestinationCounts,
} from '../utils/analytics-tracker.js';
import { addClient, removeClient, broadcast } from '../utils/event-bus.js';
import { computeContainmentRate } from '../utils/containment.js';

const router = express.Router();

/**
 * GET /analytics/stream
 * SSE endpoint for real-time call events
 */
router.get('/stream', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  res.flushHeaders();
  
  // Send initial hello event
  res.write('event: hello\n');
  res.write('data: {"connected":true}\n\n');
  
  // Add client to event bus
  addClient(res);
  
  // Remove client on disconnect
  req.on('close', () => {
    removeClient(res);
    res.end();
  });
});

/**
 * POST /analytics/event
 * Log a call event
 */
router.post('/event', async (req, res) => {
  try {
    const event = {
      callId: req.body.callId || uuidv4(),
      ani: req.body.ani,
      dnis: req.body.dnis,
      agencyName: req.body.agencyName,
      pni: req.body.pni,
      intent: req.body.intent,
      confidence: req.body.confidence,
      transferReason: req.body.transferReason,
      destination: req.body.destination,
      ivrDurationMs: req.body.ivrDurationMs,
      timestamp: req.body.timestamp || new Date().toISOString(),
    };

    await logCallEvent(redis, event);
    
    // Broadcast to SSE clients
    broadcast('call-event', event);

    res.json({
      logged: true,
      callId: event.callId,
    });
  } catch (err) {
    console.error('Error in /analytics/event:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

/**
 * GET /analytics/calls?limit=50
 * Get recent call events
 */
router.get('/calls', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const calls = await getCallEvents(redis, limit);

    res.json({ calls });
  } catch (err) {
    console.error('Error in /analytics/calls:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

/**
 * GET /analytics/intents?since=<iso8601>
 * Get intent distribution
 */
router.get('/intents', async (req, res) => {
  try {
    const { since } = req.query;

    if (since) {
      // Windowed query: filter calls by timestamp
      const calls = await getCallEvents(redis, 500);
      const sinceDate = new Date(since);
      const filteredCalls = calls.filter((call) => new Date(call.timestamp) >= sinceDate);

      const intents = {};
      for (const call of filteredCalls) {
        if (call.intent) {
          intents[call.intent] = (intents[call.intent] || 0) + 1;
        }
      }

      return res.json({
        intents,
        since,
        windowed: true,
      });
    }

    // Global counters
    const intents = await getIntentCounts(redis);
    res.json({
      intents,
      windowed: false,
    });
  } catch (err) {
    console.error('Error in /analytics/intents:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

/**
 * GET /analytics/summary
 * Get analytics summary
 */
router.get('/summary', async (req, res) => {
  try {
    const calls = await getCallEvents(redis, 500);
    const totalCalls = calls.length;

    const intentDistribution = await getIntentCounts(redis);
    const routingDestinations = await getDestinationCounts(redis);

    // Calculate averages
    let totalConfidence = 0;
    let confidenceCount = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const call of calls) {
      if (call.confidence !== undefined && call.confidence !== null) {
        totalConfidence += call.confidence;
        confidenceCount++;
      }
      if (call.ivrDurationMs !== undefined && call.ivrDurationMs !== null) {
        totalDuration += call.ivrDurationMs;
        durationCount++;
      }
    }

    const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : null;
    const avgIvrDurationMs = durationCount > 0 ? totalDuration / durationCount : null;
    
    // Compute containment rate
    const containmentRate = computeContainmentRate(calls);
    
    // Count active sessions
    const sessionKeys = await redis.keys('session:*');
    const activeCalls = sessionKeys.length;

    res.json({
      totalCalls,
      intentDistribution,
      avgConfidence,
      routingDestinations,
      avgIvrDurationMs,
      containmentRate,
      activeCalls,
    });
  } catch (err) {
    console.error('Error in /analytics/summary:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

export default router;
