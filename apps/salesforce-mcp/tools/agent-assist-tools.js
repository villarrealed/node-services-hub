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

  // ----------------------------------------------------------
  // 5. verify_caller_strict — 2-factor verification for autonomous AI
  // ----------------------------------------------------------
  verify_caller_strict: {
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

      // Strict decision logic: MUST have last_name AND (dob OR zip)
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
        reason = `Verified — last name + ${dobOk ? 'DOB' : 'ZIP'} match. Safe to proceed with autonomous operations.`;
      } else if (lastOk && !dobAttempted && !zipAttempted) {
        confidence = 'low';
        verified = false;
        reason = `Last name matches but no second factor was provided. For autonomous operations, a second factor (DOB or ZIP) is REQUIRED. Ask for DOB or ZIP before proceeding.`;
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
  // 6. add_vehicle_to_policy — Add vehicle as Asset
  // ----------------------------------------------------------
  add_vehicle_to_policy: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('Salesforce Contact ID of the policy holder. Account is looked up from contact.'),
      vin: z
        .string()
        .default('')
        .describe('Vehicle Identification Number (17 chars). Empty if not yet provided.'),
      year: z
        .number()
        .describe('Vehicle model year, e.g. 2024'),
      make: z
        .string()
        .describe('Vehicle manufacturer, e.g. Honda'),
      model: z
        .string()
        .describe('Vehicle model name, e.g. CR-V EX'),
      usage_type: z
        .string()
        .default('personal')
        .describe('How the vehicle is used: personal, commute, business, pleasure'),
      annual_mileage: z
        .number()
        .default(12000)
        .describe('Estimated annual miles'),
      garaged_zip: z
        .string()
        .default('')
        .describe('ZIP code where vehicle is garaged overnight'),
      coverage_template: z
        .string()
        .default('mirror_existing')
        .describe('Coverage to apply: mirror_existing (copy from another vehicle on policy), state_minimum, custom'),
      effective_date: z
        .string()
        .default('')
        .describe("When coverage begins. Accepts YYYY-MM-DD or 'today'. Defaults to today."),
      agent_notes: z
        .string()
        .default('')
        .describe('Free-form notes from Jessie or the agent'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      asset_id: z.string(),
      asset_name: z.string(),
      vehicle_description: z.string(),
      effective_date: z.string(),
      account_id: z.string(),
      asset_url: z.string(),
      next_steps: z.string(),
      errors: z.array(z.string()),
    }),
    handler: async ({
      contact_id,
      vin = '',
      year,
      make,
      model,
      usage_type = 'personal',
      annual_mileage = 12000,
      garaged_zip = '',
      coverage_template = 'mirror_existing',
      effective_date = '',
      agent_notes = '',
    }) => {
      if (!contact_id) {
        return {
          success: false,
          asset_id: '',
          asset_name: '',
          vehicle_description: '',
          effective_date: '',
          account_id: '',
          asset_url: '',
          next_steps: '',
          errors: ['contact_id is required'],
        };
      }

      // Look up account from contact
      let accountId = '';
      try {
        const contactRec = await sf.getRecord('Contact', contact_id);
        accountId = s(contactRec, 'AccountId');
        if (!accountId) {
          return {
            success: false,
            asset_id: '',
            asset_name: '',
            vehicle_description: '',
            effective_date: '',
            account_id: '',
            asset_url: '',
            next_steps: '',
            errors: ['Contact has no associated Account'],
          };
        }
      } catch (e) {
        return {
          success: false,
          asset_id: '',
          asset_name: '',
          vehicle_description: '',
          effective_date: '',
          account_id: '',
          asset_url: '',
          next_steps: '',
          errors: [`Contact ${contact_id} not found: ${e.message}`],
        };
      }

      // Normalize effective_date
      let effDate = (effective_date || '').trim().toLowerCase();
      const today = new Date();
      if (effDate === 'today' || effDate === '') {
        effDate = today.toISOString().slice(0, 10);
      } else {
        const norm = normalizeDob(effective_date);
        effDate = norm || effective_date;
      }

      // Build vehicle description
      const vehicleDescription = `${year} ${make} ${model}`;

      // Build Asset Name (max 255)
      let assetName = vehicleDescription;
      if (vin) {
        assetName += ` (VIN ${vin.slice(-6)})`;
      }
      assetName = assetName.slice(0, 255);

      // Build YAML metadata block
      const metaLines = [
        'vehicle_metadata:',
        `  vin: ${vin || 'pending'}`,
        `  year: ${year}`,
        `  make: ${make}`,
        `  model: ${model}`,
        `  usage_type: ${usage_type}`,
        `  annual_mileage: ${annual_mileage}`,
        `  garaged_zip: ${garaged_zip || 'not provided'}`,
        `  coverage_template: ${coverage_template}`,
        `  effective_date: ${effDate}`,
        `  added_by: jessie-autonomous`,
        `  status: active`,
        '',
      ];
      const description = metaLines.join('\n') + (agent_notes ? `Agent notes:\n${agent_notes}\n` : '');

      // Create Asset
      const payload = {
        Name: assetName,
        AccountId: accountId,
        ContactId: contact_id,
        Description: description,
        Status: 'Installed',
        PurchaseDate: effDate,
        InstallDate: effDate,
      };

      try {
        const result = await sf.createRecord('Asset', payload);
        if (!result.success) {
          return {
            success: false,
            asset_id: '',
            asset_name: assetName,
            vehicle_description: vehicleDescription,
            effective_date: effDate,
            account_id: accountId,
            asset_url: '',
            next_steps: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        return {
          success: true,
          asset_id: newId,
          asset_name: assetName,
          vehicle_description: vehicleDescription,
          effective_date: effDate,
          account_id: accountId,
          asset_url: lightningUrl('Asset', newId),
          next_steps: `Vehicle effective ${effDate}. Proof of insurance can be sent via send_insurance_proof.`,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          asset_id: '',
          asset_name: assetName,
          vehicle_description: vehicleDescription,
          effective_date: effDate,
          account_id: accountId,
          asset_url: '',
          next_steps: '',
          errors: [e.message || String(e)],
        };
      }
    },
  },

  // ----------------------------------------------------------
  // 7. send_insurance_proof — Send proof-of-insurance notification
  // ----------------------------------------------------------
  send_insurance_proof: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('Salesforce Contact ID'),
      channel: z
        .string()
        .describe('Delivery channel: email or sms'),
      recipient: z
        .string()
        .default('')
        .describe("Email address or phone number; defaults to contact's primary."),
      vehicles_included: z
        .string()
        .default('')
        .describe("Comma-separated list of vehicles covered, e.g. '2024 Honda CR-V, 2021 Toyota Camry'. Empty for all on policy."),
      purpose: z
        .string()
        .default('')
        .describe('Why proof is needed: DMV registration, lien holder, employer, etc.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      case_id: z.string(),
      case_number: z.string(),
      channel: z.string(),
      recipient_used: z.string(),
      case_url: z.string(),
      message: z.string(),
      errors: z.array(z.string()),
    }),
    handler: async ({
      contact_id,
      channel,
      recipient = '',
      vehicles_included = '',
      purpose = '',
    }) => {
      if (!contact_id) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          channel,
          recipient_used: '',
          case_url: '',
          message: '',
          errors: ['contact_id is required'],
        };
      }

      // Look up contact and account
      let accountId = '';
      let recipientUsed = recipient;
      try {
        const contactRec = await sf.getRecord('Contact', contact_id);
        accountId = s(contactRec, 'AccountId');
        if (!recipientUsed) {
          if (channel === 'email') {
            recipientUsed = s(contactRec, 'Email');
          } else if (channel === 'sms') {
            recipientUsed = s(contactRec, 'MobilePhone') || s(contactRec, 'Phone');
          }
        }
        if (!recipientUsed) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            channel,
            recipient_used: '',
            case_url: '',
            message: '',
            errors: [`No ${channel} on file; collect recipient.`],
          };
        }
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          channel,
          recipient_used: '',
          case_url: '',
          message: '',
          errors: [`Contact ${contact_id} not found: ${e.message}`],
        };
      }

      // Build YAML metadata block
      const metaLines = [
        'notification_metadata:',
        `  channel: ${channel}`,
        `  recipient: ${recipientUsed}`,
        `  vehicles_included: ${vehicles_included || 'all on policy'}`,
        `  purpose: ${purpose || 'not specified'}`,
        `  sent_by: jessie-autonomous`,
        `  sent_at: ${new Date().toISOString()}`,
        `  delivery_status: queued`,
        '',
      ];
      const description = metaLines.join('\n');

      // Create Case
      const subject = `[NOTIFICATION] Insurance Proof — ${channel} — ${recipientUsed}`.slice(0, 255);
      const payload = {
        Subject: subject,
        Status: 'Closed',
        Priority: 'Low',
        Origin: 'Phone',
        Type: 'Question',
        ContactId: contact_id,
        Description: description,
      };
      if (accountId) payload.AccountId = accountId;

      try {
        const result = await sf.createRecord('Case', payload);
        if (!result.success) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            channel,
            recipient_used: recipientUsed,
            case_url: '',
            message: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber']);
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          channel,
          recipient_used: recipientUsed,
          case_url: lightningUrl('Case', newId),
          message: `Proof of insurance sent via ${channel} to ${recipientUsed}.`,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          channel,
          recipient_used: recipientUsed,
          case_url: '',
          message: '',
          errors: [e.message || String(e)],
        };
      }
    },
  },

  // ----------------------------------------------------------
  // 8. send_confirmation — Generic confirmation message
  // ----------------------------------------------------------
  send_confirmation: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('Salesforce Contact ID'),
      channel: z
        .string()
        .describe('Delivery channel: email or sms'),
      recipient: z
        .string()
        .default('')
        .describe("Email address or phone number; defaults to contact's primary."),
      confirmation_type: z
        .string()
        .describe("What's being confirmed: vehicle_added, claim_filed, appointment_scheduled, callback_scheduled, policy_change"),
      reference_id: z
        .string()
        .default('')
        .describe('Related record: claim number, case number, asset name, etc.'),
      summary: z
        .string()
        .describe('One-paragraph human-readable confirmation text.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      case_id: z.string(),
      case_number: z.string(),
      channel: z.string(),
      recipient_used: z.string(),
      confirmation_type: z.string(),
      reference_id: z.string(),
      case_url: z.string(),
      message: z.string(),
      errors: z.array(z.string()),
    }),
    handler: async ({
      contact_id,
      channel,
      recipient = '',
      confirmation_type,
      reference_id = '',
      summary,
    }) => {
      if (!contact_id) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          channel,
          recipient_used: '',
          confirmation_type,
          reference_id,
          case_url: '',
          message: '',
          errors: ['contact_id is required'],
        };
      }

      // Look up contact and account
      let accountId = '';
      let recipientUsed = recipient;
      try {
        const contactRec = await sf.getRecord('Contact', contact_id);
        accountId = s(contactRec, 'AccountId');
        if (!recipientUsed) {
          if (channel === 'email') {
            recipientUsed = s(contactRec, 'Email');
          } else if (channel === 'sms') {
            recipientUsed = s(contactRec, 'MobilePhone') || s(contactRec, 'Phone');
          }
        }
        if (!recipientUsed) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            channel,
            recipient_used: '',
            confirmation_type,
            reference_id,
            case_url: '',
            message: '',
            errors: [`No ${channel} on file; collect recipient.`],
          };
        }
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          channel,
          recipient_used: '',
          confirmation_type,
          reference_id,
          case_url: '',
          message: '',
          errors: [`Contact ${contact_id} not found: ${e.message}`],
        };
      }

      // Build YAML metadata block
      const metaLines = [
        'notification_metadata:',
        `  channel: ${channel}`,
        `  recipient: ${recipientUsed}`,
        `  confirmation_type: ${confirmation_type}`,
        `  reference_id: ${reference_id || 'none'}`,
        `  summary: ${summary}`,
        `  sent_by: jessie-autonomous`,
        `  sent_at: ${new Date().toISOString()}`,
        `  delivery_status: queued`,
        '',
      ];
      const description = metaLines.join('\n');

      // Create Case
      const subject = `[NOTIFICATION] ${confirmation_type} — ${reference_id}`.slice(0, 255);
      const payload = {
        Subject: subject,
        Status: 'Closed',
        Priority: 'Low',
        Origin: 'Phone',
        Type: 'Question',
        ContactId: contact_id,
        Description: description,
      };
      if (accountId) payload.AccountId = accountId;

      try {
        const result = await sf.createRecord('Case', payload);
        if (!result.success) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            channel,
            recipient_used: recipientUsed,
            confirmation_type,
            reference_id,
            case_url: '',
            message: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber']);
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          channel,
          recipient_used: recipientUsed,
          confirmation_type,
          reference_id,
          case_url: lightningUrl('Case', newId),
          message: `Confirmation sent via ${channel} to ${recipientUsed}.`,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          channel,
          recipient_used: recipientUsed,
          confirmation_type,
          reference_id,
          case_url: '',
          message: '',
          errors: [e.message || String(e)],
        };
      }
    },
  },

  // ----------------------------------------------------------
  // 9. schedule_glass_repair — Book windshield repair appointment
  // ----------------------------------------------------------
  schedule_glass_repair: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('Salesforce Contact ID'),
      claim_case_id: z
        .string()
        .default('')
        .describe('Case ID of the FNOL claim this appointment is for'),
      claim_number: z
        .string()
        .default('')
        .describe('Synthetic claim number from start_claim_fnol'),
      vehicle: z
        .string()
        .describe("Vehicle being repaired, e.g. '2021 Toyota Camry'"),
      vendor: z
        .string()
        .default('Safelite Mobile')
        .describe("Repair vendor: 'Safelite Mobile', 'Safelite Shop', 'Local Glass Shop'"),
      appointment_window: z
        .string()
        .describe("When tech will arrive, e.g. '2026-05-25 morning (8am-12pm)'"),
      service_address: z
        .string()
        .describe('Where technician will perform the repair (home, work, etc.)'),
      mobile_repair: z
        .boolean()
        .default(true)
        .describe('True for mobile service (tech comes to customer); false for shop visit'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      case_id: z.string(),
      case_number: z.string(),
      claim_number: z.string(),
      vendor: z.string(),
      appointment_window: z.string(),
      case_url: z.string(),
      message: z.string(),
      errors: z.array(z.string()),
    }),
    handler: async ({
      contact_id,
      claim_case_id = '',
      claim_number = '',
      vehicle,
      vendor = 'Safelite Mobile',
      appointment_window,
      service_address,
      mobile_repair = true,
    }) => {
      if (!contact_id) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          claim_number,
          vendor,
          appointment_window,
          case_url: '',
          message: '',
          errors: ['contact_id is required'],
        };
      }

      // Look up account from contact
      let accountId = '';
      try {
        const contactRec = await sf.getRecord('Contact', contact_id);
        accountId = s(contactRec, 'AccountId');
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          claim_number,
          vendor,
          appointment_window,
          case_url: '',
          message: '',
          errors: [`Contact ${contact_id} not found: ${e.message}`],
        };
      }

      // Build YAML metadata block
      const metaLines = [
        'appointment_metadata:',
        `  claim_case_id: ${claim_case_id || 'none'}`,
        `  claim_number: ${claim_number || 'none'}`,
        `  vehicle: ${vehicle}`,
        `  vendor: ${vendor}`,
        `  appointment_window: ${appointment_window}`,
        `  service_address: ${service_address}`,
        `  mobile_repair: ${mobile_repair ? 'yes' : 'no'}`,
        `  scheduled_by: jessie-autonomous`,
        `  scheduled_at: ${new Date().toISOString()}`,
        '',
      ];
      const description = metaLines.join('\n');

      // Create Case
      const subject = `[REPAIR-APPT] ${vendor} — ${vehicle} — ${appointment_window}`.slice(0, 255);
      const payload = {
        Subject: subject,
        Status: 'New',
        Priority: 'Medium',
        Origin: 'Phone',
        Type: 'Question',
        ContactId: contact_id,
        Description: description,
      };
      if (accountId) payload.AccountId = accountId;

      try {
        const result = await sf.createRecord('Case', payload);
        if (!result.success) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            claim_number,
            vendor,
            appointment_window,
            case_url: '',
            message: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber']);
        const msg = `Repair scheduled with ${vendor} for ${appointment_window}. ${
          mobile_repair ? 'Mobile service at ' + service_address : 'Customer to visit shop'
        }.`;
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          claim_number,
          vendor,
          appointment_window,
          case_url: lightningUrl('Case', newId),
          message: msg,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          claim_number,
          vendor,
          appointment_window,
          case_url: '',
          message: '',
          errors: [e.message || String(e)],
        };
      }
    },
  },

  // ----------------------------------------------------------
  // 10. create_underwriting_referral — Flag for UW review
  // ----------------------------------------------------------
  create_underwriting_referral: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('Salesforce Contact ID'),
      referral_type: z
        .string()
        .describe('What needs review: classic_vehicle, high_value, modified_vehicle, commercial_use, exotic, multi_driver_change, coverage_change'),
      description: z
        .string()
        .describe('Plain-English description of what UW needs to look at'),
      vehicle_or_subject: z
        .string()
        .default('')
        .describe('Vehicle or policy element under review'),
      urgency: z
        .string()
        .default('next_business_day')
        .describe('next_business_day | same_day | urgent'),
      agent_notes: z
        .string()
        .default('')
        .describe('Free-form notes'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      case_id: z.string(),
      case_number: z.string(),
      referral_id: z.string(),
      urgency: z.string(),
      case_url: z.string(),
      message: z.string(),
      errors: z.array(z.string()),
    }),
    handler: async ({
      contact_id,
      referral_type,
      description,
      vehicle_or_subject = '',
      urgency = 'next_business_day',
      agent_notes = '',
    }) => {
      if (!contact_id) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          referral_id: '',
          urgency,
          case_url: '',
          message: '',
          errors: ['contact_id is required'],
        };
      }

      // Look up account from contact
      let accountId = '';
      try {
        const contactRec = await sf.getRecord('Contact', contact_id);
        accountId = s(contactRec, 'AccountId');
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          referral_id: '',
          urgency,
          case_url: '',
          message: '',
          errors: [`Contact ${contact_id} not found: ${e.message}`],
        };
      }

      // Generate referral_id
      const year = new Date().getUTCFullYear();
      const suffix = String(Math.floor(Math.random() * 90000) + 10000);
      const referralId = `UW-REF-${year}-${suffix}`;

      // Build YAML metadata block
      const metaLines = [
        'referral_metadata:',
        `  referral_id: ${referralId}`,
        `  referral_type: ${referral_type}`,
        `  description: ${description}`,
        `  vehicle_or_subject: ${vehicle_or_subject || 'policy review'}`,
        `  urgency: ${urgency}`,
        `  created_by: jessie-autonomous`,
        `  created_at: ${new Date().toISOString()}`,
        `  status: pending_uw_review`,
        '',
      ];
      const desc = metaLines.join('\n') + (agent_notes ? `Agent notes:\n${agent_notes}\n` : '');

      // Create Case
      const subject = `[UW-REFERRAL] ${referral_type} — ${vehicle_or_subject || 'policy review'}`.slice(0, 255);
      const payload = {
        Subject: subject,
        Status: 'New',
        Priority: urgency === 'urgent' ? 'High' : 'Medium',
        Origin: 'Phone',
        Type: 'Question',
        ContactId: contact_id,
        Description: desc,
      };
      if (accountId) payload.AccountId = accountId;

      try {
        const result = await sf.createRecord('Case', payload);
        if (!result.success) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            referral_id: referralId,
            urgency,
            case_url: '',
            message: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber']);
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          referral_id: referralId,
          urgency,
          case_url: lightningUrl('Case', newId),
          message: `Underwriting referral ${referralId} created. Review SLA: ${urgency}.`,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          referral_id: referralId,
          urgency,
          case_url: '',
          message: '',
          errors: [e.message || String(e)],
        };
      }
    },
  },

  // ----------------------------------------------------------
  // 11. transfer_to_human — Warm transfer with context
  // ----------------------------------------------------------
  transfer_to_human: {
    schema: z.object({
      contact_id: z
        .string()
        .default('')
        .describe('Salesforce Contact ID — empty allowed if caller unidentified'),
      transfer_reason: z
        .string()
        .describe('Why transferring: unverified_caller, out_of_scope_injury, out_of_scope_collision, coverage_change_request, complaint, quote_request, off_topic, queue_closed_alt_needed, other'),
      queue_destination: z
        .string()
        .default('general')
        .describe('Target queue: claims, billing, sales, retention, general, supervisor'),
      transfer_summary: z
        .string()
        .describe('Plain-English context for the receiving agent: what was discussed, what was attempted, what the caller needs.'),
      caller_sentiment: z
        .string()
        .default('neutral')
        .describe('Caller mood: calm, frustrated, distressed, angry, neutral'),
      verified: z
        .boolean()
        .default(false)
        .describe('Was caller identity verified before transfer?'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      case_id: z.string(),
      case_number: z.string(),
      queue_destination: z.string(),
      transfer_id: z.string(),
      case_url: z.string(),
      message: z.string(),
      errors: z.array(z.string()),
    }),
    handler: async ({
      contact_id = '',
      transfer_reason,
      queue_destination = 'general',
      transfer_summary,
      caller_sentiment = 'neutral',
      verified = false,
    }) => {
      // Generate transfer_id
      const year = new Date().getUTCFullYear();
      const suffix = String(Math.floor(Math.random() * 90000) + 10000);
      const transferId = `XFER-${year}-${suffix}`;

      // Look up account if contact_id provided
      let accountId = '';
      if (contact_id) {
        try {
          const contactRec = await sf.getRecord('Contact', contact_id);
          accountId = s(contactRec, 'AccountId');
        } catch (e) {
          // Soft fail — continue without account
        }
      }

      // Build YAML metadata block
      const metaLines = [
        'transfer_metadata:',
        `  transfer_id: ${transferId}`,
        `  transfer_reason: ${transfer_reason}`,
        `  queue_destination: ${queue_destination}`,
        `  caller_sentiment: ${caller_sentiment}`,
        `  verified: ${verified ? 'yes' : 'no'}`,
        `  transferred_by: jessie-autonomous`,
        `  transferred_at: ${new Date().toISOString()}`,
        `  transfer_summary: ${transfer_summary}`,
        '',
      ];
      const description = metaLines.join('\n');

      // Create Case
      const subject = `[TRANSFER] → ${queue_destination} — ${transfer_reason}`.slice(0, 255);
      const payload = {
        Subject: subject,
        Status: 'New',
        Priority: (caller_sentiment === 'distressed' || caller_sentiment === 'angry') ? 'High' : 'Medium',
        Origin: 'Phone',
        Type: 'Question',
        Description: description,
      };
      if (contact_id) payload.ContactId = contact_id;
      if (accountId) payload.AccountId = accountId;

      try {
        const result = await sf.createRecord('Case', payload);
        if (!result.success) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            queue_destination,
            transfer_id: transferId,
            case_url: '',
            message: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber']);
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          queue_destination,
          transfer_id: transferId,
          case_url: lightningUrl('Case', newId),
          message: `Transferred to ${queue_destination}. Transfer ID ${transferId}.`,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          queue_destination,
          transfer_id: transferId,
          case_url: '',
          message: '',
          errors: [e.message || String(e)],
        };
      }
    },
  },

  // ----------------------------------------------------------
  // 12. schedule_callback — Book callback for closed queue
  // ----------------------------------------------------------
  schedule_callback: {
    schema: z.object({
      contact_id: z
        .string()
        .describe('Salesforce Contact ID'),
      callback_window: z
        .string()
        .describe("When to call back: e.g. '2026-05-26 9am-11am PT'"),
      callback_number: z
        .string()
        .default('')
        .describe("Best number; defaults to contact's mobile or phone"),
      topic: z
        .string()
        .describe('Brief reason for callback'),
      urgency: z
        .string()
        .default('normal')
        .describe('normal | priority'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      case_id: z.string(),
      case_number: z.string(),
      callback_window: z.string(),
      callback_number_used: z.string(),
      case_url: z.string(),
      message: z.string(),
      errors: z.array(z.string()),
    }),
    handler: async ({
      contact_id,
      callback_window,
      callback_number = '',
      topic,
      urgency = 'normal',
    }) => {
      if (!contact_id) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          callback_window,
          callback_number_used: '',
          case_url: '',
          message: '',
          errors: ['contact_id is required'],
        };
      }

      // Look up contact and account
      let accountId = '';
      let callbackNumberUsed = callback_number;
      try {
        const contactRec = await sf.getRecord('Contact', contact_id);
        accountId = s(contactRec, 'AccountId');
        if (!callbackNumberUsed) {
          callbackNumberUsed = s(contactRec, 'MobilePhone') || s(contactRec, 'Phone');
        }
        if (!callbackNumberUsed) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            callback_window,
            callback_number_used: '',
            case_url: '',
            message: '',
            errors: ['No phone number on file; collect callback number.'],
          };
        }
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          callback_window,
          callback_number_used: '',
          case_url: '',
          message: '',
          errors: [`Contact ${contact_id} not found: ${e.message}`],
        };
      }

      // Build YAML metadata block
      const metaLines = [
        'callback_metadata:',
        `  callback_window: ${callback_window}`,
        `  callback_number: ${callbackNumberUsed}`,
        `  topic: ${topic}`,
        `  urgency: ${urgency}`,
        `  scheduled_by: jessie-autonomous`,
        `  scheduled_at: ${new Date().toISOString()}`,
        '',
      ];
      const description = metaLines.join('\n');

      // Create Case
      const subject = `[CALLBACK] ${callback_window} — ${topic}`.slice(0, 255);
      const payload = {
        Subject: subject,
        Status: 'New',
        Priority: urgency === 'priority' ? 'High' : 'Medium',
        Origin: 'Phone',
        Type: 'Question',
        ContactId: contact_id,
        Description: description,
      };
      if (accountId) payload.AccountId = accountId;

      try {
        const result = await sf.createRecord('Case', payload);
        if (!result.success) {
          return {
            success: false,
            case_id: '',
            case_number: '',
            callback_window,
            callback_number_used: callbackNumberUsed,
            case_url: '',
            message: '',
            errors: (result.errors || []).map((e) => String(e)),
          };
        }
        const newId = result.id;
        const caseRecord = await sf.getRecord('Case', newId, ['CaseNumber']);
        return {
          success: true,
          case_id: newId,
          case_number: s(caseRecord, 'CaseNumber'),
          callback_window,
          callback_number_used: callbackNumberUsed,
          case_url: lightningUrl('Case', newId),
          message: `Callback scheduled for ${callback_window} at ${callbackNumberUsed}.`,
          errors: [],
        };
      } catch (e) {
        return {
          success: false,
          case_id: '',
          case_number: '',
          callback_window,
          callback_number_used: callbackNumberUsed,
          case_url: '',
          message: '',
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
