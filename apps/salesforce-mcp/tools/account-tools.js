/**
 * Account tools for Salesforce MCP.
 * Port of account tools from server.py lines 488-522.
 */

import { z } from 'zod';
import sf from '../lib/salesforce-client.js';
import { esc, toAccount } from '../lib/helpers.js';

// ============================================================
// OUTPUT SCHEMAS
// ============================================================

const AccountRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  account_type: z.string(),
  industry: z.string(),
  phone: z.string(),
  website: z.string(),
  number_of_employees: z.number().nullable(),
  annual_revenue: z.number().nullable(),
  billing_city: z.string(),
  billing_state: z.string(),
  billing_street: z.string(),
  billing_postal_code: z.string(),
  owner_name: z.string(),
  description: z.string(),
  created_date: z.string(),
});

const AccountSearchResultSchema = z.object({
  count: z.number(),
  records: z.array(AccountRecordSchema),
});

const CreateAccountSuccessSchema = z.object({
  success: z.literal(true),
  account_id: z.string(),
  name: z.string(),
  account_type: z.string(),
});

const CreateAccountFailureSchema = z.object({
  success: z.literal(false),
  errors: z.array(z.string()),
  name: z.string(),
});

const CreateAccountResultSchema = z.union([CreateAccountSuccessSchema, CreateAccountFailureSchema]);

export const accountTools = {
  search_accounts: {
    schema: z.object({
      query: z.string().describe('Search term to match against account name'),
      limit: z.number().default(10).describe('Maximum number of results (default 10, max 50)'),
    }),
    outputSchema: AccountSearchResultSchema,
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
    outputSchema: AccountRecordSchema,
    handler: async ({ account_id }) => {
      const r = await sf.getRecord('Account', account_id);
      return toAccount(r);
    },
  },

  create_account: {
    schema: z.object({
      name: z.string().describe('Account name (REQUIRED)'),
      account_type: z.string().default('').describe('Account type (e.g. Customer, Partner)'),
      industry: z.string().default('').describe('Industry classification'),
      phone: z.string().default('').describe('Main phone number'),
      website: z.string().default('').describe('Website URL'),
      description: z.string().default('').describe('Account description'),
      billing_city: z.string().default('').describe('Billing city'),
      billing_state: z.string().default('').describe('Billing state/province'),
      billing_street: z.string().default('').describe('Billing street address'),
      billing_postal_code: z.string().default('').describe('Billing ZIP/postal code'),
    }),
    outputSchema: CreateAccountResultSchema,
    handler: async ({ name, account_type = '', industry = '', phone = '', website = '', description = '', billing_city = '', billing_state = '', billing_street = '', billing_postal_code = '' }) => {
      // Build payload — only include non-empty values
      const payload = {
        Name: name,
      };
      if (account_type) payload.Type = account_type;
      if (industry) payload.Industry = industry;
      if (phone) payload.Phone = phone;
      if (website) payload.Website = website;
      if (description) payload.Description = description;
      if (billing_city) payload.BillingCity = billing_city;
      if (billing_state) payload.BillingState = billing_state;
      if (billing_street) payload.BillingStreet = billing_street;
      if (billing_postal_code) payload.BillingPostalCode = billing_postal_code;

      const result = await sf.createRecord('Account', payload);

      if (result.success) {
        const newId = result.id;
        return {
          success: true,
          account_id: newId,
          name,
          account_type: account_type || '',
        };
      }

      const errorMsgs = (result.errors || []).map(e => String(e));
      return {
        success: false,
        errors: errorMsgs,
        name,
      };
    },
  },
};
