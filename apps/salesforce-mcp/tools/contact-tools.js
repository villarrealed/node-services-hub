/**
 * Contact tools for Salesforce MCP.
 * Port of contact tools from server.py lines 325-480.
 */

import { z } from 'zod';
import sf from '../lib/salesforce-client.js';
import { esc, digitsOnly, phoneLikePattern, toContact } from '../lib/helpers.js';

export const contactTools = {
  search_contacts: {
    schema: z.object({
      query: z.string().describe('Search term to match against contact name, email, or phone'),
      limit: z.number().default(10).describe('Maximum number of results (default 10, max 50)'),
    }),
    handler: async ({ query, limit = 10 }) => {
      limit = Math.min(Math.max(limit, 1), 50);
      const soql = 
        `SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, ` +
        `Title, Department, Account.Name, ` +
        `MailingCity, MailingState, MailingStreet, MailingPostalCode, CreatedDate ` +
        `FROM Contact ` +
        `WHERE Name LIKE '%${esc(query)}%' ` +
        `OR Email LIKE '%${esc(query)}%' ` +
        `OR Phone LIKE '%${esc(query)}%' ` +
        `OR MobilePhone LIKE '%${esc(query)}%' ` +
        `ORDER BY LastName ASC ` +
        `LIMIT ${limit}`;
      
      const records = await sf.query(soql);
      return {
        count: records.length,
        records: records.map(toContact),
      };
    },
  },

  lookup_contact_by_phone: {
    schema: z.object({
      phone: z.string().describe('Phone number in any format — digits, dashes, dots, parens, spaces, country code all accepted'),
      limit: z.number().default(10).describe('Maximum number of results (default 10, max 50)'),
    }),
    handler: async ({ phone, limit = 10 }) => {
      limit = Math.min(Math.max(limit, 1), 50);
      const digits = digitsOnly(phone);

      if (digits.length < 7) {
        return { count: 0, records: [] };
      }

      const pattern = phoneLikePattern(digits);
      const escapedPattern = esc(pattern);

      const soql = 
        `SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, ` +
        `Title, Department, Account.Name, ` +
        `MailingCity, MailingState, MailingStreet, MailingPostalCode, CreatedDate ` +
        `FROM Contact ` +
        `WHERE Phone LIKE '${escapedPattern}' ` +
        `OR MobilePhone LIKE '${escapedPattern}' ` +
        `ORDER BY LastName ASC ` +
        `LIMIT ${limit}`;
      
      const records = await sf.query(soql);
      return {
        count: records.length,
        records: records.map(toContact),
      };
    },
  },

  get_contact: {
    schema: z.object({
      contact_id: z.string().describe('The 15- or 18-character Salesforce Contact ID'),
    }),
    handler: async ({ contact_id }) => {
      const r = await sf.getRecord('Contact', contact_id);
      return toContact(r);
    },
  },

  verify_identity: {
    schema: z.object({
      phone: z.string().describe("Caller's phone number (ANI) in any format"),
      claimed_name: z.string().describe("The name the caller stated — full name preferred, partial OK"),
    }),
    handler: async ({ phone, claimed_name }) => {
      const digits = digitsOnly(phone);
      if (digits.length < 7) {
        return {
          verified: false,
          match_confidence: 'none',
          contact_found: false,
          contact: null,
          reason: 'Phone number too short to verify',
        };
      }

      // Reuse the phone lookup
      const lookup = await contactTools.lookup_contact_by_phone.handler({ phone, limit: 1 });

      if (lookup.count === 0) {
        return {
          verified: false,
          match_confidence: 'none',
          contact_found: false,
          contact: null,
          reason: `No Salesforce contact found with phone matching ${phone}`,
        };
      }

      const contact = lookup.records[0];

      // Normalize names for comparison
      const claimedTokens = new Set(
        claimed_name
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(t => t)
      );
      const storedFirst = (contact.first_name || '').trim().toLowerCase();
      const storedLast = (contact.last_name || '').trim().toLowerCase();

      const firstMatch = storedFirst && claimedTokens.has(storedFirst);
      const lastMatch = storedLast && claimedTokens.has(storedLast);

      if (firstMatch && lastMatch) {
        return {
          verified: true,
          match_confidence: 'exact',
          contact_found: true,
          contact,
          reason: `Verified: ${contact.first_name} ${contact.last_name} matches phone and name`,
        };
      }

      if (firstMatch || lastMatch) {
        return {
          verified: false,
          match_confidence: 'partial',
          contact_found: true,
          contact,
          reason: 
            `Partial match: phone belongs to ${contact.first_name} ${contact.last_name}, ` +
            `caller said '${claimed_name}'. Ask a clarifying question (DOB, address, policy #).`,
        };
      }

      return {
        verified: false,
        match_confidence: 'mismatch',
        contact_found: true,
        contact,
        reason: 
          `Phone belongs to ${contact.first_name} ${contact.last_name}, ` +
          `but caller claimed '${claimed_name}'. Re-verify or escalate.`,
      };
    },
  },

  create_contact: {
    schema: z.object({
      first_name: z.string().default('').describe('Contact first name'),
      last_name: z.string().describe('Contact last name (REQUIRED — Salesforce requires LastName)'),
      email: z.string().default('').describe('Email address'),
      phone: z.string().default('').describe('Phone number'),
      mobile_phone: z.string().default('').describe('Mobile phone number'),
      title: z.string().default('').describe('Job title'),
      department: z.string().default('').describe('Department'),
      mailing_city: z.string().default('').describe('Mailing city'),
      mailing_state: z.string().default('').describe('Mailing state/province'),
      mailing_street: z.string().default('').describe('Mailing street address'),
      mailing_postal_code: z.string().default('').describe('Mailing ZIP/postal code'),
      description: z.string().default('').describe('Contact description/notes'),
      account_id: z.string().default('').describe('Salesforce Account ID to link to this contact'),
    }),
    handler: async ({ first_name = '', last_name, email = '', phone = '', mobile_phone = '', title = '', department = '', mailing_city = '', mailing_state = '', mailing_street = '', mailing_postal_code = '', description = '', account_id = '' }) => {
      // Build payload — only include non-empty values
      const payload = {
        LastName: last_name,
      };
      if (first_name) payload.FirstName = first_name;
      if (email) payload.Email = email;
      if (phone) payload.Phone = phone;
      if (mobile_phone) payload.MobilePhone = mobile_phone;
      if (title) payload.Title = title;
      if (department) payload.Department = department;
      if (mailing_city) payload.MailingCity = mailing_city;
      if (mailing_state) payload.MailingState = mailing_state;
      if (mailing_street) payload.MailingStreet = mailing_street;
      if (mailing_postal_code) payload.MailingPostalCode = mailing_postal_code;
      if (description) payload.Description = description;
      if (account_id) payload.AccountId = account_id;

      const result = await sf.createRecord('Contact', payload);

      if (result.success) {
        const newId = result.id;
        return {
          success: true,
          contact_id: newId,
          first_name,
          last_name,
          email,
          phone,
          account_id: account_id || '',
        };
      }

      const errorMsgs = (result.errors || []).map(e => String(e));
      return {
        success: false,
        errors: errorMsgs,
        first_name,
        last_name,
      };
    },
  },
};
