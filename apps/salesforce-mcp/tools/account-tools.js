/**
 * Account tools for Salesforce MCP.
 * Port of account tools from server.py lines 488-522.
 */

import { z } from 'zod';
import sf from '../lib/salesforce-client.js';
import { esc, toAccount } from '../lib/helpers.js';

export const accountTools = {
  search_accounts: {
    schema: z.object({
      query: z.string().describe('Search term to match against account name'),
      limit: z.number().default(10).describe('Maximum number of results (default 10, max 50)'),
    }),
    handler: async ({ query, limit = 10 }) => {
      limit = Math.min(Math.max(limit, 1), 50);
      const soql = 
        `SELECT Id, Name, Type, Industry, Phone, Website, ` +
        `NumberOfEmployees, AnnualRevenue, ` +
        `BillingCity, BillingState, BillingStreet, BillingPostalCode, ` +
        `Owner.Name, Description, CreatedDate ` +
        `FROM Account ` +
        `WHERE Name LIKE '%${esc(query)}%' ` +
        `ORDER BY Name ASC ` +
        `LIMIT ${limit}`;
      
      const records = await sf.query(soql);
      return {
        count: records.length,
        records: records.map(toAccount),
      };
    },
  },

  get_account: {
    schema: z.object({
      account_id: z.string().describe('The 15- or 18-character Salesforce Account ID'),
    }),
    handler: async ({ account_id }) => {
      const r = await sf.getRecord('Account', account_id);
      return toAccount(r);
    },
  },
};
