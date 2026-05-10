import { z } from 'zod';
import client from '../lib/api-client.js';

export const customerTools = {
  get_customer_profile: {
    schema: z.object({
      ani: z.string().describe('Customer ANI (phone number)'),
    }),
    handler: async ({ ani }) => {
      const response = await client.get(`/admin/customer/${ani}`);
      return response.data;
    },
  },

  list_customers: {
    schema: z.object({}),
    handler: async () => {
      const response = await client.get('/admin/customers');
      return response.data;
    },
  },

  update_customer_flag: {
    schema: z.object({
      ani: z.string().describe('Customer ANI'),
      flag: z.string().describe('Flag name (e.g., RetFlag, OpenClaim, VAPayElig, VaRetBu)'),
      value: z.string().describe('New value (Y/N or numeric value)'),
    }),
    handler: async ({ ani, flag, value }) => {
      const response = await client.patch(`/admin/customer/${ani}`, {
        [flag]: value,
      });
      return response.data;
    },
  },
};
