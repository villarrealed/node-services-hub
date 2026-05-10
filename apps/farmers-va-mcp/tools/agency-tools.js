import { z } from 'zod';
import client from '../lib/api-client.js';

export const agencyTools = {
  get_agency_profile: {
    schema: z.object({
      dnis: z.string().describe('Agency DNIS (dialed number)'),
    }),
    handler: async ({ dnis }) => {
      const response = await client.get(`/admin/agency/${dnis}`);
      return response.data;
    },
  },

  list_agencies: {
    schema: z.object({}),
    handler: async () => {
      const response = await client.get('/admin/agencies');
      return response.data;
    },
  },

  update_agency_flag: {
    schema: z.object({
      dnis: z.string().describe('Agency DNIS'),
      flag: z.string().describe('Flag name (e.g., PaymentToPaymentus, ClaimsToAgent, FSAEnrolled)'),
      value: z.string().describe('New value (Y/N or other valid value)'),
    }),
    handler: async ({ dnis, flag, value }) => {
      const response = await client.patch(`/admin/agency/${dnis}`, {
        [flag]: value,
      });
      return response.data;
    },
  },
};
