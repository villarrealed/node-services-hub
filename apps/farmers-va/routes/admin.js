/**
 * admin.js
 * 
 * Admin API routes for CRUD operations on agencies, customers, destinations,
 * system flags, scenario presets, and database reset.
 */

import express from 'express';
import redis from '../shared/redis-client.js';
import { ALL_SEED_ENTRIES } from '../shared/seed-data.js';

const router = express.Router();

// ============================================================
// AGENCIES
// ============================================================

router.get('/agencies', async (req, res) => {
  try {
    const keys = await redis.keys('agency:*');
    const agencies = [];

    for (const key of keys) {
      const dnis = key.replace('agency:', '');
      const agency = await redis.get(key);
      agencies.push({ dnis, ...agency });
    }

    res.json(agencies);
  } catch (err) {
    console.error('Error in /admin/agencies:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.get('/agency/:dnis', async (req, res) => {
  try {
    const agency = await redis.get(`agency:${req.params.dnis}`);
    if (!agency) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json(agency);
  } catch (err) {
    console.error('Error in /admin/agency/:dnis:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.put('/agency/:dnis', async (req, res) => {
  try {
    await redis.set(`agency:${req.params.dnis}`, req.body);
    res.json(req.body);
  } catch (err) {
    console.error('Error in PUT /admin/agency/:dnis:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.patch('/agency/:dnis', async (req, res) => {
  try {
    const existing = await redis.get(`agency:${req.params.dnis}`);
    if (!existing) {
      return res.status(404).json({ error: 'not found' });
    }

    const updated = { ...existing, ...req.body };
    await redis.set(`agency:${req.params.dnis}`, updated);
    res.json(updated);
  } catch (err) {
    console.error('Error in PATCH /admin/agency/:dnis:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

// ============================================================
// CUSTOMERS
// ============================================================

router.get('/customers', async (req, res) => {
  try {
    const keys = await redis.keys('customer:*');
    const customers = [];

    for (const key of keys) {
      const ani = key.replace('customer:', '');
      const customer = await redis.get(key);
      customers.push({ ani, ...customer });
    }

    res.json(customers);
  } catch (err) {
    console.error('Error in /admin/customers:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.get('/customer/:ani', async (req, res) => {
  try {
    const customer = await redis.get(`customer:${req.params.ani}`);
    if (!customer) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json(customer);
  } catch (err) {
    console.error('Error in /admin/customer/:ani:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.put('/customer/:ani', async (req, res) => {
  try {
    await redis.set(`customer:${req.params.ani}`, req.body);
    res.json(req.body);
  } catch (err) {
    console.error('Error in PUT /admin/customer/:ani:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

// ============================================================
// DESTINATIONS
// ============================================================

router.get('/destinations', async (req, res) => {
  try {
    const keys = await redis.keys('destination:*');
    const destinations = [];

    for (const key of keys) {
      const value = await redis.get(key);
      destinations.push({ key, value });
    }

    res.json(destinations);
  } catch (err) {
    console.error('Error in /admin/destinations:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.put('/destination/:key', async (req, res) => {
  try {
    const { value } = req.body;
    await redis.set(`destination:${req.params.key}`, value);
    res.json({ key: req.params.key, value });
  } catch (err) {
    console.error('Error in PUT /admin/destination/:key:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

// ============================================================
// SYSTEM FLAGS
// ============================================================

router.get('/system', async (req, res) => {
  try {
    const webexAvailable = await redis.get('webex:available');
    const chaosMode = await redis.get('system:chaos_mode');

    res.json({
      webex_available: webexAvailable || 'N',
      chaos_mode: chaosMode || 'N',
    });
  } catch (err) {
    console.error('Error in /admin/system:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.patch('/system', async (req, res) => {
  try {
    const { webex_available, chaos_mode } = req.body;

    if (webex_available !== undefined) {
      await redis.set('webex:available', webex_available);
    }

    if (chaos_mode !== undefined) {
      await redis.set('system:chaos_mode', chaos_mode);
    }

    // Return current state
    const current = await redis.get('webex:available');
    const currentChaos = await redis.get('system:chaos_mode');

    res.json({
      webex_available: current || 'N',
      chaos_mode: currentChaos || 'N',
    });
  } catch (err) {
    console.error('Error in PATCH /admin/system:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

// ============================================================
// SCENARIO PRESETS
// ============================================================

router.post('/scenario/load/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const appliedChanges = [];

    switch (id) {
      case 'scenario1': {
        // Standard: chaos=N, webex=Y, customer 1000001000 baseline
        await redis.set('system:chaos_mode', 'N');
        appliedChanges.push('system:chaos_mode = N');

        await redis.set('webex:available', 'Y');
        appliedChanges.push('webex:available = Y');

        const customer = await redis.get('customer:1000001000');
        const updated = { ...customer, OpenClaim: 'N', RetFlag: 'N', VAPayElig: 'Y' };
        await redis.set('customer:1000001000', updated);
        appliedChanges.push('customer:1000001000 PATCH (OpenClaim=N, RetFlag=N, VAPayElig=Y)');

        break;
      }

      case 'scenario2': {
        // Open claim: chaos=N, webex=Y, customer 1016852710 OpenClaim=Y
        await redis.set('system:chaos_mode', 'N');
        appliedChanges.push('system:chaos_mode = N');

        await redis.set('webex:available', 'Y');
        appliedChanges.push('webex:available = Y');

        const customer = await redis.get('customer:1016852710');
        const updated = { ...customer, OpenClaim: 'Y' };
        await redis.set('customer:1016852710', updated);
        appliedChanges.push('customer:1016852710 PATCH (OpenClaim=Y)');

        break;
      }

      case 'scenario3': {
        // Vague intent: same as scenario1 (agent behavior, not data)
        await redis.set('system:chaos_mode', 'N');
        appliedChanges.push('system:chaos_mode = N');

        await redis.set('webex:available', 'Y');
        appliedChanges.push('webex:available = Y');

        const customer = await redis.get('customer:1000001000');
        const updated = { ...customer, OpenClaim: 'N', RetFlag: 'N', VAPayElig: 'Y' };
        await redis.set('customer:1000001000', updated);
        appliedChanges.push('customer:1000001000 PATCH (OpenClaim=N, RetFlag=N, VAPayElig=Y)');

        break;
      }

      case 'scenario4': {
        // Cancel/retention eligible: chaos=N, webex=Y, customer 1016293699
        await redis.set('system:chaos_mode', 'N');
        appliedChanges.push('system:chaos_mode = N');

        await redis.set('webex:available', 'Y');
        appliedChanges.push('webex:available = Y');

        const customer = await redis.get('customer:1016293699');
        const updated = { ...customer, RetFlag: 'N', VaRetBu: '1' };
        await redis.set('customer:1016293699', updated);
        appliedChanges.push('customer:1016293699 PATCH (RetFlag=N, VaRetBu=1)');

        break;
      }

      case 'scenario5': {
        // Payment eligible + Paymentus: chaos=N, webex=Y
        await redis.set('system:chaos_mode', 'N');
        appliedChanges.push('system:chaos_mode = N');

        await redis.set('webex:available', 'Y');
        appliedChanges.push('webex:available = Y');

        const customer = await redis.get('customer:1002467890');
        const updatedCustomer = { ...customer, VAPayElig: 'Y' };
        await redis.set('customer:1002467890', updatedCustomer);
        appliedChanges.push('customer:1002467890 PATCH (VAPayElig=Y)');

        const agency = await redis.get('agency:7472574611');
        const updatedAgency = { ...agency, PaymentToPaymentus: 'Y' };
        await redis.set('agency:7472574611', updatedAgency);
        appliedChanges.push('agency:7472574611 PATCH (PaymentToPaymentus=Y)');

        break;
      }

      case 'scenario6': {
        // Chaos mode: chaos=Y
        await redis.set('system:chaos_mode', 'Y');
        appliedChanges.push('system:chaos_mode = Y');

        break;
      }

      default:
        return res.status(404).json({
          error: 'unknown scenario',
          id,
        });
    }

    res.json({
      loaded: id,
      appliedChanges,
    });
  } catch (err) {
    console.error('Error in /admin/scenario/load/:id:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

// ============================================================
// RESET
// ============================================================

router.post('/reset', async (req, res) => {
  try {
    // Re-seed from shared seed data
    for (const entry of ALL_SEED_ENTRIES) {
      await redis.set(entry.key, entry.value);
    }

    // Ensure system flags are reset
    await redis.set('system:chaos_mode', 'N');
    await redis.set('webex:available', 'Y');

    res.json({
      reset: true,
      entriesRestored: ALL_SEED_ENTRIES.length,
    });
  } catch (err) {
    console.error('Error in /admin/reset:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

export default router;
