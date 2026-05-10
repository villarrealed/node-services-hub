/**
 * radd.js
 * 
 * RADD API routes - /radd/lookup and /radd/upsert
 * Implements RADD-compatible lookup interface for agency, customer, destination,
 * webex availability, and session data.
 */

import express from 'express';
import redis from '../shared/redis-client.js';
import { formatAgency, formatCustomer } from '../utils/radd-formatter.js';

const router = express.Router();

/**
 * POST /radd/lookup
 * RADD-compatible lookup endpoint supporting multiple lookupCodes
 */
router.post('/lookup', async (req, res) => {
  try {
    const { searchCriteria } = req.body;
    const { lookupCode, lookupValue } = searchCriteria;

    switch (lookupCode) {
      case 'EAAgentLookup': {
        const agency = await redis.get(`agency:${lookupValue}`);
        if (!agency) {
          return res.json({ results: [] });
        }
        const formatted = formatAgency(agency);
        return res.json({ results: [formatted] });
      }

      case 'EACustLookup2': {
        const customer = await redis.get(`customer:${lookupValue}`);
        if (!customer) {
          return res.json({ results: [] });
        }
        const formatted = formatCustomer(customer);
        return res.json({ results: [formatted] });
      }

      case 'DestinationLookup': {
        const destination = await redis.get(`destination:${lookupValue}`);
        if (!destination) {
          return res.json({ results: [] });
        }
        return res.json({
          results: [
            {
              returnValue1: destination,
              returnValue2: 'NULL',
              nsc: 'NULL',
            },
          ],
        });
      }

      case 'WebexAvailable': {
        const available = await redis.get('webex:available');
        return res.json({
          results: [
            {
              returnValue1: available || 'N',
              returnValue2: 'NULL',
              nsc: 'NULL',
            },
          ],
        });
      }

      case 'VACustSessionData': {
        const sessionData = await redis.get(`session:${lookupValue}`);
        if (!sessionData) {
          return res.json({ results: [] });
        }
        return res.json({
          results: [
            {
              returnValue1: sessionData,
              returnValue2: 'NULL',
              nsc: 'NULL',
            },
          ],
        });
      }

      default:
        return res.status(400).json({
          error: 'unknown lookupCode',
          lookupCode,
        });
    }
  } catch (err) {
    console.error('Error in /radd/lookup:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

/**
 * POST /radd/upsert
 * RADD-compatible upsert endpoint (VACustSessionData only in Phase 2)
 */
router.post('/upsert', async (req, res) => {
  try {
    const { record } = req.body;
    const { lookupCode, lookupValue, returnValue1 } = record;

    if (lookupCode === 'VACustSessionData') {
      // Store with 600s TTL
      await redis.set(`session:${lookupValue}`, returnValue1, { ex: 600 });
      return res.json({
        success: true,
        expiresIn: 600,
      });
    }

    return res.status(501).json({
      error: 'upsert not implemented for lookupCode',
      lookupCode,
    });
  } catch (err) {
    console.error('Error in /radd/upsert:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

export default router;
