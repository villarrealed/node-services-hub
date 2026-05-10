import { z } from 'zod';
import client from '../lib/api-client.js';

export const systemTools = {
  get_system_status: {
    schema: z.object({}),
    handler: async () => {
      const response = await client.get('/admin/system');
      return response.data;
    },
  },

  toggle_chaos_mode: {
    schema: z.object({
      enabled: z.boolean().describe('Enable or disable chaos mode'),
    }),
    handler: async ({ enabled }) => {
      const response = await client.patch('/admin/system', {
        chaos_mode: enabled ? 'Y' : 'N',
      });
      return response.data;
    },
  },

  toggle_webex_availability: {
    schema: z.object({
      available: z.boolean().describe('Set Webex AI Agent availability'),
    }),
    handler: async ({ available }) => {
      const response = await client.patch('/admin/system', {
        webex_available: available ? 'Y' : 'N',
      });
      return response.data;
    },
  },
};
