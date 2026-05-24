/**
 * Agent Assist tools for Salesforce MCP.
 *
 * Purpose-built tools for Webex Contact Center Real-Time Assist (human agent assistant).
 *
 * Three tools, locked schemas (do not change after registering in Control Hub —
 * MCP actions are read-only once created in Webex AI):
 *
 *   1. identify_caller_by_ani(ani)             — Screen-pop from inbound/outbound phone number
 *   2. verify_caller_lightweight(...)          — Voice-check verification (last name + DOB or zip)
 *   3. get_customer_summary(contact_id)        — One-shot package: contact + account + cases + deep links
 *
 * Output design principles:
 *   - Every record includes a `*_url` deep link to Lightning UI
 *   - Verification returns a confidence enum, not just a boolean
 *   - Cases are sorted recent-first and tagged "open" / "closed_recent" / "older"
 *   - All outputs are stable JSON-Schema-validated objects (Zod outputSchema)
 */

import { z } from 'zod';
import sf from '../lib/salesforce-client.js';
import { esc, digitsOnly, phoneLikePattern, toContact, toAccount, toCase, s, nested } from '../lib/helpers.js';

// ============================================================
// HELPERS
// ============================================================

/**
 * Build a Lightning Experience deep link for a given sObject + record ID.
 * Falls back to empty string if SF_INSTANCE_URL is missing or id is empty.
 */
function lightningUrl(sobject, recordId) {
  const base = (process.env.SF_INSTANCE_URL || '').replace(/\/$/, '');
  if (!base || !recordId) return '';
  return `${base}/lightning/r/${sobject}/${recordId}/view`;
}

/**
 * Tier inference from Account.Description or Industry.
 * No standard SF field for "loyalty tier" so we look for keywords in Description.
 * Returns one of: Platinum, Gold, Silver, Standard, or '' (unknown).
 */
function inferTier(account) {
  const desc = (account.description || account.Description || '').toLowerCase();
  if (desc.includes('platinum')) return 'Platinum';
  if (desc.includes('gold')) return 'Gold';
  if (desc.includes('silver')) return 'Silver';
  return 'Standard';
}

/**
 * Classify a case for the agent: open / closed_recent / older.
 */
function classifyCase(caseRec) {
  const status = (caseRec.status || '').toLowerCase();
  const isClosed = status === 'closed' || status === 'resolved';
  if (!isClosed) return 'open';

  const closedDate = caseRec.closed_date || caseRec.created_date;
  if (!closedDate) return 'older';
  const closedMs = Date.parse(closedDate);
  if (Number.isNaN(closedMs)) return 'older';
  const ageDays = (Date.now() - closedMs) / (1000 * 60 * 60 * 24);
  return ageDays <= 7 ? 'closed_recent' : 'older';
}

/**
 * Extract first non-empty line of the case description as a one-line summary.
 * Caps at 200 chars.
 */
function caseOneLine(description) {
  if (!description) return '';
  const firstLine = description.split('\n').map((l) => l.trim()).find((l) => l) || '';
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

// ============================================================
// OUTPUT SCHEMAS
// ============================================================

const IdentifyCallerResultSchema = z.object({
  found: z.boolean(),
  match_count: z.number(),
  contact_id: z.string(),
  full_name: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  account_id: z.string(),
  account_name: z.string(),
  tier: z.string(),
  has_open_cases: z.boolean(),
  open_case_count: z.number(),
  contact_url: z.string(),
  account_url: z.string(),
  notes: z.string(),
});

const VerifyCallerResultSchema = z.object({
  verified: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low', 'none']),
  matched_factors: z.array(z.string()),
  unmatched_factors: z.array(z.string()),
  reason: z.string(),
  contact_id: z.string(),
});

const CaseSummarySchema = z.object({
  case_id: z.string(),
  case_number: z.string(),
  subject: z.string(),
  status: z.string(),
  priority: z.string(),
  origin: z.string(),
  case_type: z.string(),
  classification: z.enum(['open', 'closed_recent', 'older']),
  one_line_summary: z.string(),
  created_date: z.string(),
  closed_date: z.string(),
  case_url: z.string(),
});

const CustomerSummaryResultSchema = z.object({
  found: z.boolean(),
  contact: z.object({
    contact_id: z.string(),
    full_name: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    email: z.string(),
    phone: z.string(),
    mobile_phone: z.string(),
    title: z.string(),
    department: z.string(),
    birthdate: z.string(),
    mailing_postal_code: z.string(),
    contact_url: z.string(),
  }),
  account: z.object({
    account_id: z.string(),
    account_name: z.string(),
    tier: z.string(),
    account_url: z.string(),
  }),
  cases: z.array(CaseSummarySchema),
  open_case_count: z.number(),
  closed_recent_count: z.number(),
  total_case_count: z.number(),
  agent_briefing: z.string(),
});

// ============================================================
// TOOLS
// ============================================================

export const agentAssistTools = {
  // ----------------------------------------------------------
  // 1. identify_caller_by_ani — screen-pop equivalent
  // ----------------------------------------------------------
  identify_caller_by_ani: {
    schema: z.object({
      ani: z
        .string()
        .describe(
          'The caller phone number (Automatic Number Identification). Accepts any format: E.164 (+14155551212), digits-only (4155551212), or formatted ((415) 555-1212). Country code optional for US/CA numbers.'
        ),
    }),
    outputSchema: IdentifyCallerResultSchema,
    handler: async ({ ani }) => {
      const digits = digitsOnly(ani);
      if (digits.length < 7) {
        return {
          found: false,
          match_count: 0,
          contact_id: '',
          full_name: '',
          first_name: '',
          last_name: '',
          account_id: '',
          account_name: '',
          tier: '',
          has_open_cases: false,
          open_case_count: 0,
          contact_url: '',
          account_url: '',
          notes: `ANI '${ani}' is too short to look up (need at least 7 digits).`,
        };
      }

      const pattern = phoneLikePattern(digits);
      const escapedPattern = esc(pattern);

      // 1) Find the contact by phone or mobile
      const contactSoql =
        `SELECT Id, FirstName, LastName, Phone, MobilePhone, AccountId, Account.Name, Account.Description ` +
        `FROM Contact ` +
        `WHERE Phone LIKE '${escapedPattern}' OR MobilePhone LIKE '${escapedPattern}' ` +
        `ORDER BY LastName ASC ` +
        `LIMIT 5`;
      const contacts = await sf.query(contactSoql);

      if (contacts.length === 0) {
        return {
          found: false,
          match_count: 0,
          contact_id: '',
          full_name: '',
          first_name: '',
          last_name: '',
          account_id: '',
          account_name: '',
          tier: '',
          has_open_cases: false,
          open_case_count: 0,
          contact_url: '',
          account_url: '',
          notes: `No Salesforce contact found with phone matching ${ani}. Caller is unknown — treat as new contact.`,
        };
      }

      const c = contacts[0];
      const contactId = s(c, 'Id');
      const accountId = s(c, 'AccountId');
      const accountName = nested(c, 'Account', 'Name');
      const accountDesc = nested(c, 'Account', 'Description');
      const tier = inferTier({ description: accountDesc });

      // 2) Count open cases on the contact
      let openCaseCount = 0;
      if (contactId) {
        const caseRows = await sf.query(
          `SELECT Id FROM Case WHERE ContactId = '${esc(contactId)}' AND IsClosed = false`
        );
        openCaseCount = caseRows.length;
      }

      const firstName = s(c, 'FirstName');
      const lastName = s(c, 'LastName');
      const fullName = `${firstName} ${lastName}`.trim();
      const moreMatches = contacts.length > 1;

      return {
        found: true,
        match_count: contacts.length,
        contact_id: contactId,
        full_name: fullName,
        first_name: firstName,
        last_name: lastName,
        account_id: accountId,
        account_name: accountName,
        tier,
        has_open_cases: openCaseCount > 0,
        open_case_count: openCaseCount,
        contact_url: lightningUrl('Contact', contactId),
        account_url: lightningUrl('Account', accountId),
        notes: moreMatches
          ? `Multiple contacts (${contacts.length}) share this phone — returned the first match. Verify identity before proceeding.`
          : `Identified by phone. Verify with last name + DOB or zip before disclosing PII.`,
      };
    },
  },

  // ----------------------------------------------------------
  // 2. verify_caller_lightweight — voice-check verification
  // ----------------------------------------------------------
  verify_caller_lightweight: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('The Salesforce Contact ID to verify against (from identify_caller_by_ani).'),
      spoken_last_name: z
        .string()
        .describe("Caller's spoken last name. Case-insensitive match."),
      spoken_dob: z
        .string()
        .default('')
        .describe(
          'Caller spoken date of birth. Accepts YYYY-MM-DD, MM/DD/YYYY, or MM-DD-YYYY. Leave empty if not provided — pass spoken_zip instead.'
        ),
      spoken_zip: z
        .string()
        .default('')
        .describe(
          "Caller spoken postal code (US 5-digit). Used as fallback factor when DOB isn't given."
        ),
    }),
    outputSchema: VerifyCallerResultSchema,
    handler: async ({ contact_id, spoken_last_name, spoken_dob = '', spoken_zip = '' }) => {
      if (!contact_id) {
        return {
          verified: false,
          confidence: 'none',
          matched_factors: [],
          unmatched_factors: [],
          reason: 'No contact_id provided. Call identify_caller_by_ani first.',
          contact_id: '',
        };
      }

      let record;
      try {
        record = await sf.getRecord('Contact', contact_id);
      } catch (e) {
        return {
          verified: false,
          confidence: 'none',
          matched_factors: [],
          unmatched_factors: [],
          reason: `Contact ${contact_id} not found in Salesforce: ${e.message}`,
          contact_id,
        };
      }

      const storedLast = (s(record, 'LastName') || '').trim().toLowerCase();
      const storedBirthdate = s(record, 'Birthdate'); // SF format: YYYY-MM-DD
      const storedZip = (s(record, 'MailingPostalCode') || '').trim();

      const matched = [];
      const unmatched = [];

      // Factor 1: last name (always required)
      const claimedLast = (spoken_last_name || '').trim().toLowerCase();
      if (claimedLast && storedLast && claimedLast === storedLast) {
        matched.push('last_name');
      } else {
        unmatched.push('last_name');
      }

      // Factor 2: DOB (if provided)
      if (spoken_dob && spoken_dob.trim()) {
        // Normalize spoken DOB to YYYY-MM-DD
        const normalized = normalizeDob(spoken_dob);
        if (normalized && storedBirthdate && normalized === storedBirthdate) {
          matched.push('dob');
        } else {
          unmatched.push('dob');
        }
      }

      // Factor 3: ZIP (if provided)
      if (spoken_zip && spoken_zip.trim()) {
        const claimedZip = digitsOnly(spoken_zip).slice(0, 5);
        const stored5 = digitsOnly(storedZip).slice(0, 5);
        if (claimedZip && stored5 && claimedZip === stored5) {
          matched.push('zip');
        } else {
          unmatched.push('zip');
        }
      }

      // Decision logic:
      //  - high   : last_name + (dob OR zip) all match
      //  - medium : last_name matches but second factor not provided OR partial
      //  - low    : last_name matches but second factor mismatches
      //  - none   : last_name mismatches
      let confidence = 'none';
      let verified = false;
      let reason = '';

      const lastOk = matched.includes('last_name');
      const dobOk = matched.includes('dob');
      const zipOk = matched.includes('zip');
      const dobAttempted = spoken_dob && spoken_dob.trim();
      const zipAttempted = spoken_zip && spoken_zip.trim();

      if (!lastOk) {
        confidence = 'none';
        verified = false;
        reason = `Last name mismatch — caller said "${spoken_last_name}", record has "${s(
          record,
          'LastName'
        )}". DO NOT disclose PII; re-verify or escalate.`;
      } else if (dobOk || zipOk) {
        confidence = 'high';
        verified = true;
        reason = `Verified — last name + ${dobOk ? 'DOB' : 'ZIP'} match. Safe to proceed.`;
      } else if (lastOk && !dobAttempted && !zipAttempted) {
        confidence = 'medium';
        verified = false;
        reason = `Last name matches but no second factor was provided. For an outbound callback this may be sufficient (caller was already authenticated on the portal). Ask for DOB or ZIP if disclosing sensitive information.`;
      } else {
        confidence = 'low';
        verified = false;
        reason = `Last name matches but ${
          dobAttempted ? 'DOB' : 'ZIP'
        } does not. Re-ask for the second factor before proceeding.`;
      }

      return {
        verified,
        confidence,
        matched_factors: matched,
        unmatched_factors: unmatched,
        reason,
        contact_id,
      };
    },
  },

  // ----------------------------------------------------------
  // 3. get_customer_summary — one-shot agent briefing
  // ----------------------------------------------------------
  get_customer_summary: {
    schema: z.object({
      contact_id: z
        .string()
        .describe(
          'Salesforce Contact ID to summarize. Returns contact + account + recent cases (open + closed-last-7-days) with deep links and a one-paragraph agent briefing.'
        ),
      case_limit: z
        .number()
        .default(10)
        .describe('Max number of cases to return (default 10, max 25).'),
    }),
    outputSchema: CustomerSummaryResultSchema,
    handler: async ({ contact_id, case_limit = 10 }) => {
      case_limit = Math.min(Math.max(case_limit, 1), 25);

      // 1) Contact
      let contactRec;
      try {
        contactRec = await sf.getRecord('Contact', contact_id);
      } catch (e) {
        return emptySummary(contact_id, `Contact ${contact_id} not found: ${e.message}`);
      }

      const accountId = s(contactRec, 'AccountId');
      let accountRec = null;
      if (accountId) {
        try {
          accountRec = await sf.getRecord('Account', accountId);
        } catch (e) {
          // soft-fail — continue without account
          accountRec = null;
        }
      }

      // 2) Cases for this contact — open + recently closed, recent first
      const caseSoql =
        `SELECT Id, CaseNumber, Subject, Status, Priority, Type, Origin, ` +
        `Description, Contact.Name, Account.Name, Owner.Name, ` +
        `CreatedDate, ClosedDate ` +
        `FROM Case ` +
        `WHERE ContactId = '${esc(contact_id)}' ` +
        `ORDER BY CreatedDate DESC ` +
        `LIMIT ${case_limit}`;
      const caseRows = await sf.query(caseSoql);

      const cases = caseRows.map((row) => {
        const c = toCase(row);
        const classification = classifyCase(c);
        return {
          case_id: c.id,
          case_number: c.case_number,
          subject: c.subject,
          status: c.status,
          priority: c.priority,
          origin: c.origin,
          case_type: c.case_type,
          classification,
          one_line_summary: caseOneLine(c.description),
          created_date: c.created_date,
          closed_date: c.closed_date,
          case_url: lightningUrl('Case', c.id),
        };
      });

      const openCount = cases.filter((c) => c.classification === 'open').length;
      const closedRecentCount = cases.filter((c) => c.classification === 'closed_recent').length;

      // 3) Build the agent briefing — a one-paragraph summary the agent can glance at
      const firstName = s(contactRec, 'FirstName');
      const lastName = s(contactRec, 'LastName');
      const fullName = `${firstName} ${lastName}`.trim();
      const accountName = accountRec ? s(accountRec, 'Name') : '';
      const tier = accountRec
        ? inferTier({ description: s(accountRec, 'Description') })
        : 'Standard';

      const briefingParts = [];
      briefingParts.push(`${fullName || 'Caller'}${tier !== 'Standard' ? ` (${tier} tier)` : ''}`);
      if (accountName) briefingParts.push(`account "${accountName}"`);
      if (openCount > 0) {
        briefingParts.push(`${openCount} open case${openCount === 1 ? '' : 's'}`);
      } else {
        briefingParts.push('no open cases');
      }
      if (closedRecentCount > 0) {
        briefingParts.push(`${closedRecentCount} closed in the last 7 days`);
      }

      let briefing = briefingParts.join(' | ');

      // Add highlight of the most recent open case, if any
      const topOpen = cases.find((c) => c.classification === 'open');
      if (topOpen) {
        briefing += `. Most recent open: ${topOpen.case_number} — ${topOpen.subject}`;
      } else if (cases.length > 0) {
        const recent = cases[0];
        briefing += `. Most recent: ${recent.case_number} (${recent.status}) — ${recent.subject}`;
      }

      return {
        found: true,
        contact: {
          contact_id,
          full_name: fullName,
          first_name: firstName,
          last_name: lastName,
          email: s(contactRec, 'Email'),
          phone: s(contactRec, 'Phone'),
          mobile_phone: s(contactRec, 'MobilePhone'),
          title: s(contactRec, 'Title'),
          department: s(contactRec, 'Department'),
          birthdate: s(contactRec, 'Birthdate'),
          mailing_postal_code: s(contactRec, 'MailingPostalCode'),
          contact_url: lightningUrl('Contact', contact_id),
        },
        account: {
          account_id: accountId,
          account_name: accountName,
          tier,
          account_url: lightningUrl('Account', accountId),
        },
        cases,
        open_case_count: openCount,
        closed_recent_count: closedRecentCount,
        total_case_count: cases.length,
        agent_briefing: briefing,
      };
    },
  },
};

// ============================================================
// LOCAL HELPERS
// ============================================================

/**
 * Normalize a date-of-birth string to YYYY-MM-DD.
 * Accepts: YYYY-MM-DD, MM/DD/YYYY, MM-DD-YYYY, M/D/YYYY, "May 5 1990", etc.
 * Returns '' if it can't parse.
 */
function normalizeDob(input) {
  if (!input) return '';
  const trimmed = input.trim();

  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // MM/DD/YYYY or M/D/YYYY
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // MM-DD-YYYY or M-D-YYYY (but not YYYY-MM-DD which we handled)
  const dash = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dash) {
    const [, m, d, y] = dash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Fallback: try Date.parse (handles "May 5 1990")
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return '';
}

function emptySummary(contact_id, errorMsg) {
  return {
    found: false,
    contact: {
      contact_id,
      full_name: '',
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      mobile_phone: '',
      title: '',
      department: '',
      birthdate: '',
      mailing_postal_code: '',
      contact_url: '',
    },
    account: {
      account_id: '',
      account_name: '',
      tier: '',
      account_url: '',
    },
    cases: [],
    open_case_count: 0,
    closed_recent_count: 0,
    total_case_count: 0,
    agent_briefing: errorMsg,
  };
}
