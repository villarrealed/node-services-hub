import { z } from 'zod';
import client from '../lib/api-client.js';

export const analyticsTools = {
  get_recent_calls: {
    schema: z.object({
      limit: z.number().optional().default(10).describe('Number of recent calls to retrieve (default: 10)'),
    }),
    handler: async ({ limit = 10 }) => {
      const response = await client.get(`/analytics/calls?limit=${limit}`);
      return response.data;
    },
  },

  get_intent_distribution: {
    schema: z.object({
      since: z.string().optional().describe('ISO8601 timestamp to filter calls (optional)'),
    }),
    handler: async ({ since }) => {
      const url = since ? `/analytics/intents?since=${since}` : '/analytics/intents';
      const response = await client.get(url);
      return response.data;
    },
  },

  get_demo_summary: {
    schema: z.object({}),
    handler: async () => {
      const response = await client.get('/analytics/summary');
      return response.data;
    },
  },
};
