/**
 * Case tools for Salesforce MCP.
 * Port of case tools from server.py lines 530-652.
 */

import { z } from 'zod';
import sf from '../lib/salesforce-client.js';
import { esc, toCase, s } from '../lib/helpers.js';

export const caseTools = {
  search_cases: {
    schema: z.object({
      query: z.string().default('').describe('Search term to match against case subject or case number'),
      status: z.string().default('').describe('Filter by status (e.g. New, Working, Escalated, Closed)'),
      priority: z.string().default('').describe('Filter by priority (e.g. High, Medium, Low)'),
      limit: z.number().default(10).describe('Maximum number of results (default 10, max 50)'),
    }),
    handler: async ({ query = '', status = '', priority = '', limit = 10 }) => {
      limit = Math.min(Math.max(limit, 1), 50);
      const conditions = [];
      if (query) {
        conditions.push(`(Subject LIKE '%${esc(query)}%' OR CaseNumber LIKE '%${esc(query)}%')`);
      }
      if (status) {
        conditions.push(`Status = '${esc(status)}'`);
      }
      if (priority) {
        conditions.push(`Priority = '${esc(priority)}'`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} ` : '';
      const soql = 
        `SELECT Id, CaseNumber, Subject, Status, Priority, Type, Origin, ` +
        `Description, Contact.Name, Account.Name, Owner.Name, ` +
        `CreatedDate, ClosedDate FROM Case ${where}` +
        `ORDER BY CreatedDate DESC ` +
        `LIMIT ${limit}`;
      
      const records = await sf.query(soql);
      return {
        count: records.length,
        records: records.map(toCase),
      };
    },
  },

  get_case: {
    schema: z.object({
      case_id: z.string().describe('The Salesforce Case record ID or case number (e.g. 00001234)'),
    }),
    handler: async ({ case_id }) => {
      // If case_id is all digits or short non-500 prefix, do CaseNumber→Id lookup first
      if (/^\d+$/.test(case_id) || (case_id.length <= 10 && !case_id.startsWith('500'))) {
        const rows = await sf.query(
          `SELECT Id FROM Case WHERE CaseNumber = '${esc(case_id)}' LIMIT 1`
        );
        if (rows.length > 0) {
          case_id = rows[0].Id;
        } else {
          return {
            id: '',
            case_number: case_id,
            subject: 'NOT FOUND',
            status: '',
            priority: '',
            case_type: '',
            origin: '',
            description: '',
            contact_name: '',
            account_name: '',
            owner_name: '',
            created_date: '',
            closed_date: '',
          };
        }
      }

      const r = await sf.getRecord('Case', case_id);
      return toCase(r);
    },
  },

  create_case: {
    schema: z.object({
      subject: z.string().describe('Case subject / title (required)'),
      description: z.string().default('').describe('Detailed description of the issue'),
      priority: z.string().default('Medium').describe('High, Medium, or Low (default Medium)'),
      status: z.string().default('New').describe('Initial status (default New)'),
      origin: z.string().default('Web').describe('How the case originated — Web, Phone, or Email (default Web)'),
      case_type: z.string().default('').describe('Case type such as Problem, Feature Request, or Question'),
      contact_id: z.string().default('').describe('Salesforce Contact ID to link to this case'),
      account_id: z.string().default('').describe('Salesforce Account ID to link to this case'),
    }),
    handler: async ({ subject, description = '', priority = 'Medium', status = 'New', origin = 'Web', case_type = '', contact_id = '', account_id = '' }) => {
      const payload = {
        Subject: subject,
        Status: status,
        Priority: priority,
        Origin: origin,
      };
      if (description) payload.Description = description;
      if (case_type) payload.Type = case_type;
      if (contact_id) payload.ContactId = contact_id;
      if (account_id) payload.AccountId = account_id;

      const result = await sf.createRecord('Case', payload);

      if (result.success) {
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber', 'Subject', 'Status', 'Priority']);
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          subject: s(caseRecord, 'Subject'),
          status: s(caseRecord, 'Status'),
          priority: s(caseRecord, 'Priority'),
          errors: [],
        };
      }

      const errorMsgs = (result.errors || []).map(e => String(e));
      return {
        success: false,
        case_id: '',
        case_number: '',
        subject,
        status,
        priority,
        errors: errorMsgs,
      };
    },
  },
};
