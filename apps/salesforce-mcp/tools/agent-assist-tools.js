/**
 * Agent Assist tools for Salesforce MCP.
 *
 * Purpose-built tools for Webex Contact Center Real-Time Assist (human agent assistant).
 *
 * Four tools, locked schemas (do not change after registering in Control Hub —
 * MCP actions are read-only once created in Webex AI):
 *
 *   1. identify_caller_by_ani(ani)             — Screen-pop from inbound/outbound phone number
 *   2. verify_caller_lightweight(...)          — Voice-check verification (last name + DOB or zip)
 *   3. get_customer_summary(contact_id)        — One-shot package: contact + account + cases + claims + deep links
 *   4. start_claim_fnol(...)                   — First Notice of Loss: open a new claim during the call (WRITE)
 *
 * Claim modeling convention:
 *   - This Salesforce org has no Claim__c object — we model claims as Cases whose
 *     Subject starts with "[CLAIM] " and whose Description contains a YAML-style
 *     `claim_metadata:` block. get_customer_summary parses that block back out
 *     so claims surface as first-class objects to the AI Assist UI.
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

/**
 * Detect whether a case subject indicates this is a claim record.
 * Convention: subject begins with "[CLAIM]".
 */
function isClaimCase(subject) {
  return /^\s*\[CLAIM\]/i.test(subject || '');
}

/**
 * Parse a claim_metadata block out of a Case.Description.
 *
 * Expected format (YAML-ish, lenient):
 *   claim_metadata:
 *     claim_number: FA-CLM-2026-00427
 *     claim_type: auto-glass
 *     date_of_loss: 2026-01-22
 *     vehicle: 2021 Toyota Camry SE
 *     damage: Rock chip on driver-side windshield
 *     deductible: Comprehensive $500 — waived for glass-only repair
 *     status: Closed paid
 *     ...any other key: value pairs
 *
 * Returns an object with snake_case keys, plus a `narrative` field containing
 * any text that came AFTER the metadata block. Returns {} if no block found.
 */
function parseClaimMetadata(description) {
  if (!description) return {};
  const lines = description.split('\n');
  const startIdx = lines.findIndex((l) => /^\s*claim_metadata\s*:\s*$/i.test(l));
  if (startIdx === -1) return {};

  const meta = {};
  let i = startIdx + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    // Stop at first non-indented non-empty line
    if (line.trim() === '') continue;
    if (!/^\s{2,}/.test(line) && line.trim() !== '') break;
    const m = line.match(/^\s+([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
    if (m) {
      meta[m[1].toLowerCase()] = m[2].trim();
    }
  }
  const narrative = lines.slice(i).join('\n').trim();
  if (narrative) meta.narrative = narrative;
  return meta;
}

/**
 * Generate a synthetic claim number for new FNOL claims.
 * Format: FA-CLM-YYYY-NNNNN where NNNNN is a pseudo-random 5-digit suffix.
 * Not collision-resistant — adequate for demo use.
 */
function generateClaimNumber() {
  const year = new Date().getUTCFullYear();
  const suffix = String(Math.floor(Math.random() * 90000) + 10000);
  return `FA-CLM-${year}-${suffix}`;
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
  is_claim: z.boolean(),
});

const ClaimSummarySchema = z.object({
  case_id: z.string(),
  case_number: z.string(),
  claim_number: z.string(),
  claim_type: z.string(),
  date_of_loss: z.string(),
  vehicle: z.string(),
  damage: z.string(),
  status: z.string(),
  deductible: z.string(),
  payout: z.string(),
  premium_impact: z.string(),
  classification: z.enum(['open', 'closed_recent', 'older']),
  created_date: z.string(),
  closed_date: z.string(),
  case_url: z.string(),
  one_line_summary: z.string(),
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
  claims: z.array(ClaimSummarySchema),
  open_case_count: z.number(),
  closed_recent_count: z.number(),
  total_case_count: z.number(),
  open_claim_count: z.number(),
  total_claim_count: z.number(),
  agent_briefing: z.string(),
});

const StartClaimFnolResultSchema = z.object({
  success: z.boolean(),
  case_id: z.string(),
  case_number: z.string(),
  claim_number: z.string(),
  subject: z.string(),
  status: z.string(),
  case_url: z.string(),
  next_steps: z.string(),
  errors: z.array(z.string()),
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
          is_claim: isClaimCase(c.subject),
        };
      });

      // 2b) Extract claim records — parse claim_metadata from descriptions
      const claims = caseRows
        .filter((row) => {
          const c = toCase(row);
          return isClaimCase(c.subject);
        })
        .map((row) => {
          const c = toCase(row);
          const meta = parseClaimMetadata(c.description);
          const classification = classifyCase(c);
          return {
            case_id: c.id,
            case_number: c.case_number,
            claim_number: meta.claim_number || '',
            claim_type: meta.claim_type || '',
            date_of_loss: meta.date_of_loss || '',
            vehicle: meta.vehicle || '',
            damage: meta.damage || '',
            status: meta.status || c.status,
            deductible: meta.deductible || '',
            payout: meta.repair_cost || meta.payout || '',
            premium_impact: meta.premium_impact || '',
            classification,
            created_date: c.created_date,
            closed_date: c.closed_date,
            case_url: lightningUrl('Case', c.id),
            one_line_summary: meta.damage
              ? `${meta.claim_type || 'claim'} — ${meta.damage}`
              : caseOneLine(c.description),
          };
        });

      const openCount = cases.filter((c) => c.classification === 'open').length;
      const closedRecentCount = cases.filter((c) => c.classification === 'closed_recent').length;
      const openClaimCount = claims.filter((c) => c.classification === 'open').length;

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
      if (claims.length > 0) {
        briefingParts.push(
          `${claims.length} claim${claims.length === 1 ? '' : 's'} on file${
            openClaimCount > 0 ? ` (${openClaimCount} open)` : ''
          }`
        );
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

      // Add most recent claim if any
      if (claims.length > 0) {
        const lastClaim = claims[0];
        const dol = lastClaim.date_of_loss ? ` (loss ${lastClaim.date_of_loss})` : '';
        briefing += `. Last claim: ${lastClaim.claim_number || lastClaim.case_number} ${lastClaim.claim_type}${dol} — ${lastClaim.status}`;
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
        claims,
        open_case_count: openCount,
        closed_recent_count: closedRecentCount,
        total_case_count: cases.length,
        open_claim_count: openClaimCount,
        total_claim_count: claims.length,
        agent_briefing: briefing,
      };
    },
  },

  // ----------------------------------------------------------
  // 4. start_claim_fnol — First Notice of Loss (WRITE)
  // ----------------------------------------------------------
  //
  // Opens a new claim during the live call. Creates a Salesforce Case with
  //   - Subject prefix "[CLAIM] FNOL — ..."
  //   - Status = New, Origin = Phone, Type = Question (org picklist doesn't have Claim)
  //   - Description = structured claim_metadata block + agent notes
  //
  // The synthetic claim_number returned is what the agent reads back to the
  // caller. It's NOT a real claim system number — this demo doesn't integrate
  // with Guidewire / Duck Creek / etc.
  start_claim_fnol: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('Salesforce Contact ID of the caller (from identify_caller_by_ani). REQUIRED.'),
      account_id: z
        .string()
        .default('')
        .describe('Salesforce Account ID — optional, will be looked up from contact if omitted.'),
      claim_type: z
        .string()
        .describe(
          'Type of claim. Examples: auto-glass, collision, comprehensive, theft, vandalism, roadside, total-loss.'
        ),
      date_of_loss: z
        .string()
        .describe(
          'Date the loss/incident occurred. Accepts YYYY-MM-DD, MM/DD/YYYY, or "today" / "yesterday". Will be normalized.'
        ),
      vehicle: z
        .string()
        .describe(
          'Vehicle involved — year/make/model and any identifying info (e.g. "2024 Honda CR-V EX, just added Saturday").'
        ),
      damage_description: z
        .string()
        .describe(
          'What happened and what is damaged. Plain language from the caller (e.g. "Rock chip on driver-side windshield from highway debris, about 1 inch, not spreading").'
        ),
      location_of_incident: z
        .string()
        .default('')
        .describe('Where the incident happened. City/state or highway/intersection.'),
      injuries_reported: z
        .boolean()
        .default(false)
        .describe('Were any injuries reported? If true, escalation to BI adjuster is recommended.'),
      police_report_filed: z
        .boolean()
        .default(false)
        .describe('Has a police report been filed? Required for theft, vandalism, hit-and-run.'),
      other_party_involved: z
        .boolean()
        .default(false)
        .describe('Is another driver / vehicle involved? If true, collision flow applies.'),
      agent_notes: z
        .string()
        .default('')
        .describe('Free-form notes from the agent — context, caller demeanor, anything relevant.'),
    }),
    outputSchema: StartClaimFnolResultSchema,
    handler: async ({
      contact_id,
      account_id = '',
      claim_type,
      date_of_loss,
      vehicle,
      damage_description,
      location_of_incident = '',
      injuries_reported = false,
      police_report_filed = false,
      other_party_involved = false,
      agent_notes = '',
    }) => {
      if (!contact_id) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          claim_number: '',
          subject: '',
          status: '',
          case_url: '',
          next_steps: '',
          errors: ['contact_id is required — call identify_caller_by_ani first.'],
        };
      }

      // Resolve account_id from contact if missing
      let resolvedAccountId = account_id;
      if (!resolvedAccountId) {
        try {
          const contactRec = await sf.getRecord('Contact', contact_id);
          resolvedAccountId = s(contactRec, 'AccountId');
        } catch (e) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            claim_number: '',
            subject: '',
            status: '',
            case_url: '',
            next_steps: '',
            errors: [`Contact ${contact_id} not found: ${e.message}`],
          };
        }
      }

      // Normalize date_of_loss
      let dol = (date_of_loss || '').trim().toLowerCase();
      const today = new Date();
      if (dol === 'today') {
        dol = today.toISOString().slice(0, 10);
      } else if (dol === 'yesterday') {
        const y = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        dol = y.toISOString().slice(0, 10);
      } else {
        const norm = normalizeDob(date_of_loss);
        dol = norm || date_of_loss;
      }

      const claimNumber = generateClaimNumber();
      const subject = `[CLAIM] FNOL — ${claim_type} — ${vehicle}`.slice(0, 255);

      // Build the structured claim_metadata block
      const metaLines = [
        'claim_metadata:',
        `  claim_number: ${claimNumber}`,
        `  claim_type: ${claim_type}`,
        `  date_of_loss: ${dol}`,
        `  vehicle: ${vehicle}`,
        `  damage: ${damage_description}`,
        `  location_of_incident: ${location_of_incident || 'not provided'}`,
        `  injuries_reported: ${injuries_reported ? 'yes' : 'no'}`,
        `  police_report_filed: ${police_report_filed ? 'yes' : 'no'}`,
        `  other_party_involved: ${other_party_involved ? 'yes' : 'no'}`,
        `  status: FNOL — pending adjuster assignment`,
        '',
      ];
      const description = metaLines.join('\n') + (agent_notes ? `Agent notes:\n${agent_notes}\n` : '');

      // Decide next steps based on claim characteristics
      const nextStepsList = [];
      if (claim_type.toLowerCase().includes('glass') || claim_type.toLowerCase().includes('windshield')) {
        nextStepsList.push('Glass fast-track: offer mobile repair (Safelite or local vendor). Comprehensive deductible may be waived for chip repair in most states.');
      }
      if (injuries_reported) {
        nextStepsList.push('ESCALATE: bodily-injury adjuster assignment required. Notify supervisor.');
      }
      if (other_party_involved && !police_report_filed) {
        nextStepsList.push('Advise customer to file a police report if not already done.');
      }
      if (!nextStepsList.length) {
        nextStepsList.push('Adjuster will be assigned within 1 business day. Customer will receive claim number via SMS + email.');
      }
      nextStepsList.push(`Claim number to read back to caller: ${claimNumber}`);
      const nextSteps = nextStepsList.join(' ');

      // Create the case
      const payload = {
        Subject: subject,
        Status: 'New',
        Priority: injuries_reported ? 'High' : 'Medium',
        Origin: 'Phone',
        Type: 'Question', // org picklist limitation — claims modeled as Question
        Reason: 'New problem',
        ContactId: contact_id,
        Description: description,
      };
      if (resolvedAccountId) payload.AccountId = resolvedAccountId;

      try {
        const result = await sf.createRecord('Case', payload);
        if (!result.success) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            claim_number: claimNumber,
            subject,
            status: '',
            case_url: '',
            next_steps: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber', 'Subject', 'Status']);
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          claim_number: claimNumber,
          subject: s(caseRecord, 'Subject'),
          status: s(caseRecord, 'Status'),
          case_url: lightningUrl('Case', newId),
          next_steps: nextSteps,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          claim_number: claimNumber,
          subject,
          status: '',
          case_url: '',
          next_steps: '',
          errors: [e.message || String(e)],
        };
      }
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
    claims: [],
    open_case_count: 0,
    closed_recent_count: 0,
    total_case_count: 0,
    open_claim_count: 0,
    total_claim_count: 0,
    agent_briefing: errorMsg,
  };
}
