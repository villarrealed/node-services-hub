import { z } from 'zod';
import client from '../lib/api-client.js';

export const scenarioTools = {
  load_demo_scenario: {
    schema: z.object({
      scenario_id: z.string().describe('Scenario ID (scenario1-6)'),
    }),
    handler: async ({ scenario_id }) => {
      const response = await client.post(`/admin/scenario/load/${scenario_id}`);
      return response.data;
    },
  },

  reset_demo_environment: {
    schema: z.object({}),
    handler: async () => {
      const response = await client.post('/admin/reset');
      return response.data;
    },
  },
};
