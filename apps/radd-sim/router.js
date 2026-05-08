/**
 * radd-sim — mounted as a sub-router under /radd in node-services-hub.
 *
 * Simulates the Farmers RADD (Routing And Data Distribution) web service for
 * the Voice Advantage IVR Phase 2 demo. RADD is the central lookup service
 * the WxCC + Webex AI Agent flow depends on for every routing decision.
 *
 * Reference docs (in the farmers-voice-advantage-ivr repo):
 *   - requirements/voice-advantage-ivr-phase2-requirements-v1.2.md  (FR-5, FR-6)
 *   - architecture/demo-build-outline.md                             (§3a)
 *
 * v1 (this file) implements the minimum needed for first-week milestone:
 *   - lookup_agency_by_dnis     (RADD lookupCode: EAAgentLookup)
 *   - lookup_customer_by_ani    (RADD lookupCode: EACustLookup2)
 *
 * v2 (this commit) completes the RADD surface:
 *   - lookup_customer_by_phone  (EACustLookup2 via manual-entry path)
 *   - check_webex_available     (RADD lookupCode: WebexAvailable)
 *   - lookup_destination        (RADD lookupCode: DestinationLookup)
 *   - upsert_session_data       (RADD upsert for VACustSessionData — Paymentus preserve)
 *   - get_session_data          (RADD lookupCode: VACustSessionData — Paymentus return)
 *
 * Pattern: mirrors apps/farmers-insurance-mcp/router.js — custom JSON-RPC,
 * in-memory hardcoded fixtures, per-app CORS, request log, manifest endpoint.
 *
 * Endpoints exposed under /radd:
 *   GET  /radd/             — JSON manifest
 *   GET  /radd/health
 *   POST /radd/mcp          — JSON-RPC (plain JSON, not SSE)
 *   GET  /radd/mcp          — 405
 *   DELETE /radd/mcp        — 405
 *   ALL  /radd/mcp-debug    — echo back request
 *   GET  /radd/mcp-log      — last 20 requests
 */

import express from "express";

// ============================================================
// HELPERS — phone / DNIS normalization
// ============================================================

/**
 * Strip a phone number to bare digits and, for US numbers, drop a leading "1".
 * Lookups are tolerant of "+1 555 010 1234", "(555) 010-1234", "5550101234",
 * "15550101234", etc. — all collapse to "5550101234".
 */
function normalizePhone(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

// ============================================================
// STATIC DATA — Hardcoded agencies + customers for demo purposes
// ============================================================

/**
 * AGENCIES — keyed lookup by DNIS (the toll-free number the customer dialed).
 *
 * Field shapes match the RADD EAAgentLookup response (FR-5 in requirements).
 * Each agency entry stores the parsed values; the `tools/call` handler
 * assembles them into the pipe-delimited returnValue1 / returnValue2 strings
 * that match production RADD output exactly.
 *
 * v1 fixture set covers two contrasting profiles:
 *   - DNIS 8005550101 → Aspen Ridge (ATT=1, FSA on, claims-to-agent on,
 *                       Paymentus off, no alternate greeting) — happy path
 *   - DNIS 8005550102 → Mesa Valley (ATT=2, FSA off, claims-to-agent off,
 *                       Paymentus on, alternate greeting on) — exercises
 *                       the SETN/SATN/OTN branch and the GreetWav prompt
 */
const AGENCIES = {
  "8005550101": {
    AgencyName: "Aspen Ridge Insurance Agency",
    FSAEnrolled: "Y",
    ClaimsToAgent: "Y",
    ATT: "1",
    AgPhNum: "5036821583",
    AOR: "73247J",
    PaymentToPaymentus: "N",
    AgencyTransferNumber: "5036821583",
    ClaimsDestination: "8664557827",
    AgencySETN: "",
    AgencySATN: "",
    AgencyOTN: "",
    TransferPrompts: "Y",
    AltGreeting: "N",
    GreetWav: "",
  },
  "8005550102": {
    AgencyName: "Mesa Valley Insurance Agency",
    FSAEnrolled: "N",
    ClaimsToAgent: "N",
    ATT: "2",
    AgPhNum: "6025550199",
    AOR: "84518K",
    PaymentToPaymentus: "Y",
    AgencyTransferNumber: "6025550199",
    ClaimsDestination: "8664557827",
    AgencySETN: "6025550201",
    AgencySATN: "6025550202",
    AgencyOTN: "6025550203",
    TransferPrompts: "Y",
    AltGreeting: "Y",
    GreetWav: "va_84518k.wav",
  },
};

/**
 * CUSTOMERS — keyed lookup by ANI (caller's phone number).
 *
 * Field shapes match the RADD EACustLookup2 response (FR-6).
 * Same string-assembly pattern as agencies.
 *
 * v1 fixture set:
 *   - ANI 6235550111 → John Smith — RetFlag Y, OpenClaim Y, multiline,
 *                       VaRetBu 1 → exercises retention + open-claim branches
 *   - ANI 6235550112 → Maria Garcia — VAPayElig Y, multiline, no open claim →
 *                       exercises Paymentus-eligible payment flow
 *   - ANI 6235550113 → Bristol West Auto customer (single-line) — minimal,
 *                       exercises the "everyday Auto policy" path
 *
 * Any ANI not in this map returns a not-found result so the agent flow can
 * exercise its manual phone-entry fallback.
 */
const CUSTOMERS = {
  "6235550111": {
    RetFlag: "Y",
    Multiline: "Y",
    BUs: "PLA_FWS-ARS",
    PRD: "AUTO",
    CAOR: "",
    OpenClaim: "Y",
    VaRetBu: "1",
    PNI: "John Smith",
  },
  "6235550112": {
    RetFlag: "N",
    Multiline: "Y",
    BUs: "PLA_FWS",
    PRD: "AUTO",
    CAOR: "",
    OpenClaim: "N",
    VaRetBu: "0",
    PNI: "Maria Garcia",
    VAPayElig: "Y",
  },
  "6235550113": {
    RetFlag: "N",
    Multiline: "N",
    BUs: "BWA",
    PRD: "AUTO",
    CAOR: "",
    OpenClaim: "N",
    VaRetBu: "0",
    PNI: "Robert Chen",
  },
};

/**
 * DESTINATIONS — keyed lookup by RADD DestinationLookup `lookupValue`.
 *
 * The destination_type values come straight from the requirements doc:
 *   - VARetEligibleDestination  (FR 7.2 & 8.2.2 — retention-eligible transfer)
 *   - VA_FSA_Destination        (FR 7.4 — unlicensed FSA transfer)
 *   - VA_FSA_LicDestination     (FR 7.4 — licensed FSA transfer)
 *
 * Each entry stores the parsed PQ (PrincipalQueue / transfer destination) and
 * BU (BusinessUnit). The handler assembles them into the production-shape
 * returnValue1 string `PQ : xxx | BU : xxx`.
 */
const DESTINATIONS = {
  VARetEligibleDestination: { PQ: "RetentionQ_TF", BU: "Retention" },
  VA_FSA_Destination: { PQ: "FSA_Unlicensed_TF", BU: "FSAUnlicensed" },
  VA_FSA_LicDestination: { PQ: "FSA_Licensed_TF", BU: "FSALicensed" },
};

/**
 * SESSION_STORE — in-memory Paymentus-preserve session data.
 *
 * Keyed by ANI (digits only). Holds the most recent upsert per customer.
 * Used by the Paymentus preserve/retrieve flow (FR 6.4 / 6.5):
 *   - Before transferring to Paymentus, the IVR upserts session data
 *     (ATT, AgencyTransferNumber, AgencySETN) so it can resume routing
 *     when the customer returns from the payment portal.
 *   - On return, the IVR looks up by ANI and checks the timestamp diff —
 *     if < 10 minutes, it plays the "payment success" prompt and routes
 *     using the preserved ATT/transfer-number values.
 *
 * Resets on every Render redeploy. Acceptable for a demo — for production
 * persistence the existing Upstash Redis pattern in apps/jds-web-manager
 * could be reused.
 */
const SESSION_STORE = new Map();
const SESSION_WINDOW_SECONDS = 600; // 10 minutes per FR 6.5.2

/**
 * WebexAvailable toggle — env-driven so a presenter can flip it on stage
 * to demo the "Webex unavailable" fallback path. Default Y (available).
 * Set RADD_SIM_WEBEX_AVAILABLE=N before starting the server to flip.
 */
function getWebexAvailable() {
  const env = (process.env.RADD_SIM_WEBEX_AVAILABLE || "Y").toUpperCase();
  return env === "N" ? "N" : "Y";
}

// ============================================================
// RADD RESPONSE BUILDERS — produce the pipe-delimited strings
// that match production RADD output verbatim.
// ============================================================

/**
 * Assemble the EAAgentLookup returnValue1 string.
 * Format (from FR-5 sample):
 *   "AgencyName: xxxx| FSAEnrolled : Y | ClaimsToAgent : Y | ATT : 1 | AgPhNum : 5036821583 | AOR : 73247J | PaymentToPaymentus : N"
 */
function buildAgencyReturnValue1(a) {
  return [
    `AgencyName: ${a.AgencyName}`,
    `FSAEnrolled : ${a.FSAEnrolled}`,
    `ClaimsToAgent : ${a.ClaimsToAgent}`,
    `ATT : ${a.ATT}`,
    `AgPhNum : ${a.AgPhNum}`,
    `AOR : ${a.AOR}`,
    `PaymentToPaymentus : ${a.PaymentToPaymentus}`,
  ].join(" | ");
}

/**
 * Assemble the EAAgentLookup returnValue2 string.
 * Format (from FR-5 sample):
 *   "AgencyTransferNumber : xxxxxxxxx | ClaimsDestination :xxxxx | AgencySETN : xxxxxxxxx | AgencySATN : xxxxxxxxx | AgencyOTN : xxxxxxxxx | TransferPrompts : Y | AltGreeting = Y | GreetWav = va_73247j.wav"
 */
function buildAgencyReturnValue2(a) {
  return [
    `AgencyTransferNumber : ${a.AgencyTransferNumber}`,
    `ClaimsDestination :${a.ClaimsDestination}`,
    `AgencySETN : ${a.AgencySETN}`,
    `AgencySATN : ${a.AgencySATN}`,
    `AgencyOTN : ${a.AgencyOTN}`,
    `TransferPrompts : ${a.TransferPrompts}`,
    `AltGreeting = ${a.AltGreeting}`,
    `GreetWav = ${a.GreetWav}`,
  ].join(" | ");
}

/**
 * Assemble the EACustLookup2 returnValue1 string.
 * Format (from FR-6 sample):
 *   "RetFlag : Y | Multiline : Y | BUs : PLA_FWS-ARS | PRD : AUTO | CAOR : | OpenClaim : Y | VaRetBu : 1 | PNI : John Smith"
 *
 * VAPayElig is included only when the customer record carries it (the
 * production RADD response includes it on multi-line customers).
 */
function buildCustomerReturnValue1(c) {
  const parts = [
    `RetFlag : ${c.RetFlag}`,
    `Multiline : ${c.Multiline}`,
    `BUs : ${c.BUs}`,
    `PRD : ${c.PRD}`,
    `CAOR : ${c.CAOR}`,
    `OpenClaim : ${c.OpenClaim}`,
    `VaRetBu : ${c.VaRetBu}`,
    `PNI : ${c.PNI}`,
  ];
  if (c.VAPayElig) parts.push(`VAPayElig : ${c.VAPayElig}`);
  return parts.join(" | ");
}

/**
 * Assemble the DestinationLookup returnValue1 string.
 * Format inferred from FR 7.2 and 7.4: name/value pairs PQ and BU.
 *   "PQ : xxxx | BU : xxxx"
 */
function buildDestinationReturnValue1(d) {
  return `PQ : ${d.PQ} | BU : ${d.BU}`;
}

/**
 * Assemble the VACustSessionData returnValue1 string.
 * Format (from FR 6.4 / 6.5):
 *   "InsertTime : Timestamp | ATT = [att value] | AgencyTransferNumber : xxx | AgencySETN : xxx"
 *
 * Note the inconsistent separators in the spec (`InsertTime :` with colon,
 * `ATT =` with equals) — preserved verbatim so consumers parsing the string
 * see exactly what production RADD returns.
 */
function buildSessionReturnValue1(s) {
  return [
    `InsertTime : ${s.InsertTime}`,
    `ATT = ${s.ATT}`,
    `AgencyTransferNumber : ${s.AgencyTransferNumber}`,
    `AgencySETN : ${s.AgencySETN || ""}`,
  ].join(" | ");
}

// ============================================================
// TOOL SCHEMAS
// ============================================================

const TOOL_SCHEMAS = [
  {
    name: "lookup_agency_by_dnis",
    description:
      "Looks up Farmers agency configuration by the dialed toll-free number (DNIS). Equivalent to the RADD EAAgentLookup web service call. Returns agency routing details including Agency Transfer Type (ATT 1–5), FSA enrollment, claims-to-agent flag, Paymentus eligibility, transfer numbers (Agency, SETN, SATN, OTN), Claims IVR destination, and alternate greeting configuration. Both the parsed object and the production-shape returnValue1/returnValue2 pipe-delimited strings are returned for compatibility with existing IVR flow logic.",
    inputSchema: {
      type: "object",
      properties: {
        dnis: {
          type: "string",
          description:
            "Dialed Number Identification Service — the toll-free number the customer called. Accepts any common format (with/without country code, spaces, dashes, parens). Demo agencies: 8005550101 (Aspen Ridge, ATT=1), 8005550102 (Mesa Valley, ATT=2 with alternate greeting).",
        },
      },
      required: ["dnis"],
    },
  },
  {
    name: "lookup_customer_by_ani",
    description:
      "Looks up Farmers customer record by the caller's automatic number identification (ANI). Equivalent to the RADD EACustLookup2 web service call. Returns retention flag, multi-line indicator, business units, primary product, open-claim status, retention business unit (VaRetBu), and primary named insured (PNI). Multi-line customers may also carry a VAPayElig flag for Paymentus eligibility. Both the parsed object and the production-shape returnValue1 pipe-delimited string are returned. If the ANI is not in the demo customer database, returns found=false so the calling flow can fall back to manual phone-number entry.",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description:
            "Automatic Number Identification — the caller's phone number. Accepts any common format. Demo customers: 6235550111 (John Smith, retention+open-claim), 6235550112 (Maria Garcia, Paymentus-eligible multiline), 6235550113 (Robert Chen, Bristol West Auto). Other ANIs return found=false.",
        },
      },
      required: ["ani"],
    },
  },
  {
    name: "lookup_customer_by_phone",
    description:
      "Looks up Farmers customer record by a phone number the caller manually entered (because their ANI was not recognized or they pressed a key to enter a different number). Functionally equivalent to lookup_customer_by_ani but the response is annotated with manualEntry=true so downstream flow logic can branch on it (e.g. play different prompts, log differently). Equivalent to the RADD EACustLookup2 web service call invoked from the manual-entry path (FR 2.6.1).",
    inputSchema: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description:
            "The phone number the caller entered manually. Accepts any common format. Same demo customer set as lookup_customer_by_ani.",
        },
      },
      required: ["phone"],
    },
  },
  {
    name: "check_webex_available",
    description:
      "Checks whether Webex Calling is available for inbound routing. Equivalent to the RADD WebexAvailable web service call (FR 2.2). Returns WebexAvail = Y or N. If WebexAvail = N, the IVR flow should fall back to the legacy touch-tone IVR path (simulated in this demo). Per spec, if the lookup itself fails the variable is treated as Y (fail-open). For demo purposes the returned value is controlled by the RADD_SIM_WEBEX_AVAILABLE environment variable on the server (default Y) so a presenter can toggle the unavailability path on stage by restarting with N.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_destination",
    description:
      "Looks up a transfer destination by destination type. Equivalent to the RADD DestinationLookup web service call (FR 7.2, FR 7.4, FR 8.2.2). Returns the PQ (Principal Queue / transfer destination) and BU (Business Unit) for the requested destination type. The returnValue1 string follows the production format `PQ : xxx | BU : xxx`.",
    inputSchema: {
      type: "object",
      properties: {
        destination_type: {
          type: "string",
          enum: ["VARetEligibleDestination", "VA_FSA_Destination", "VA_FSA_LicDestination"],
          description:
            "Which destination to look up. VARetEligibleDestination = Customer Retention Team transfer (used by Retention Risk and Retention Eligible flows). VA_FSA_Destination = Farmers Service Advantage Unlicensed queue (used when intent is billing or documents). VA_FSA_LicDestination = Farmers Service Advantage Licensed queue (used for all other FSA-eligible intents).",
        },
      },
      required: ["destination_type"],
    },
  },
  {
    name: "upsert_session_data",
    description:
      "Preserves IVR session data so it can be retrieved when the caller returns from Paymentus. Equivalent to the RADD VACustSessionData upsert web service call (FR 6.4). Stores the caller's ANI together with the agency routing values (ATT, AgencyTransferNumber, AgencySETN) and an InsertTime timestamp. The agent should call this immediately before transferring the customer out to the Paymentus toll-free number, so that get_session_data on return can resume routing using the preserved values within the 10-minute window.",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description: "The caller's ANI (phone number) — used as the lookup key. Required.",
        },
        att: {
          type: "string",
          description:
            "Agency Transfer Type (1–5) from the EAAgentLookup result. Required so resume routing knows which transfer logic to follow.",
        },
        agency_transfer_number: {
          type: "string",
          description:
            "AgencyTransferNumber from the EAAgentLookup result. Required — this is where the call returns to after Paymentus.",
        },
        agency_setn: {
          type: "string",
          description:
            "AgencySETN (Agency Service Transfer Number) from the EAAgentLookup result. Optional — only relevant for ATT=2 routing.",
        },
      },
      required: ["ani", "att", "agency_transfer_number"],
    },
  },
  {
    name: "get_session_data",
    description:
      "Retrieves preserved IVR session data for a returning Paymentus caller. Equivalent to the RADD VACustSessionData lookup (FR 6.5). Returns the previously upserted ATT, AgencyTransferNumber, and AgencySETN along with the InsertTime, age in seconds, and a within_10_min_window convenience flag. If no session record exists for the ANI, returns found=false so the flow can play the FR 6.5.2 'no record found' error prompt.",
    inputSchema: {
      type: "object",
      properties: {
        ani: {
          type: "string",
          description: "The returning caller's ANI (phone number) — used as the lookup key.",
        },
      },
      required: ["ani"],
    },
  },
];

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleLookupAgencyByDnis({ dnis }) {
  const normalizedDnis = normalizePhone(dnis);
  const agency = AGENCIES[normalizedDnis];

  if (!agency) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              lookupCode: "EAAgentLookup",
              lookupValue: dnis,
              lookupValueNormalized: normalizedDnis,
              message: `No agency configured for DNIS ${normalizedDnis}. Demo agencies: 8005550101, 8005550102.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            found: true,
            lookupCode: "EAAgentLookup",
            lookupValue: normalizedDnis,
            returnValue1: buildAgencyReturnValue1(agency),
            returnValue2: buildAgencyReturnValue2(agency),
            parsed: agency,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleLookupCustomerByAni({ ani }) {
  const normalizedAni = normalizePhone(ani);
  const customer = CUSTOMERS[normalizedAni];

  if (!customer) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              lookupCode: "EACustLookup2",
              lookupValue: ani,
              lookupValueNormalized: normalizedAni,
              message: `No customer record for ANI ${normalizedAni}. Flow should fall back to manual phone entry. Demo customers: 6235550111, 6235550112, 6235550113.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            found: true,
            lookupCode: "EACustLookup2",
            lookupValue: normalizedAni,
            returnValue1: buildCustomerReturnValue1(customer),
            parsed: customer,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const TOOL_HANDLERS = {
  lookup_agency_by_dnis: handleLookupAgencyByDnis,
  lookup_customer_by_ani: handleLookupCustomerByAni,
  lookup_customer_by_phone: handleLookupCustomerByPhone,
  check_webex_available: handleCheckWebexAvailable,
  lookup_destination: handleLookupDestination,
  upsert_session_data: handleUpsertSessionData,
  get_session_data: handleGetSessionData,
};

// ----- v2 handlers -----

/**
 * Manual-entry path (FR 2.6.1). Same lookup as ANI but the response is
 * annotated with manualEntry=true so downstream flow logic can branch.
 */
async function handleLookupCustomerByPhone({ phone }) {
  const result = await handleLookupCustomerByAni({ ani: phone });
  // Re-parse, inject manualEntry flag, re-serialize.
  const parsed = JSON.parse(result.content[0].text);
  parsed.manualEntry = true;
  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
  };
}

async function handleCheckWebexAvailable() {
  const webexAvail = getWebexAvailable();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            lookupCode: "WebexAvailable",
            lookupValue: "1",
            returnValue1: `WebexAvail : ${webexAvail}`,
            parsed: { WebexAvail: webexAvail },
            note:
              webexAvail === "Y"
                ? "Webex Calling is available — proceed with normal routing."
                : "Webex Calling is unavailable — flow should fall back to legacy touch-tone IVR (simulated). Toggle by restarting server with RADD_SIM_WEBEX_AVAILABLE=Y.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleLookupDestination({ destination_type }) {
  const dest = DESTINATIONS[destination_type];

  if (!dest) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              lookupCode: "DestinationLookup",
              lookupValue: destination_type,
              message: `Unknown destination_type '${destination_type}'. Valid types: ${Object.keys(
                DESTINATIONS,
              ).join(", ")}.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            found: true,
            lookupCode: "DestinationLookup",
            lookupValue: destination_type,
            returnValue1: buildDestinationReturnValue1(dest),
            parsed: dest,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleUpsertSessionData({ ani, att, agency_transfer_number, agency_setn }) {
  const normalizedAni = normalizePhone(ani);
  if (!normalizedAni) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: false, message: "ani is required and must contain digits." },
            null,
            2,
          ),
        },
      ],
    };
  }

  const insertTime = new Date().toISOString();
  const record = {
    InsertTime: insertTime,
    ATT: att,
    AgencyTransferNumber: agency_transfer_number,
    AgencySETN: agency_setn || "",
  };
  SESSION_STORE.set(normalizedAni, { timestamp: Date.now(), record });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: true,
            lookupCode: "VACustSessionData",
            lookupValue: normalizedAni,
            action: "upsert",
            returnValue1: buildSessionReturnValue1(record),
            parsed: record,
            message: `Session data preserved for ANI ${normalizedAni}. Window: ${SESSION_WINDOW_SECONDS}s.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleGetSessionData({ ani }) {
  const normalizedAni = normalizePhone(ani);
  const entry = SESSION_STORE.get(normalizedAni);

  if (!entry) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              found: false,
              lookupCode: "VACustSessionData",
              lookupValue: normalizedAni,
              message:
                "No session record found. Per FR 6.5.2, set no_cust_Pmnts_error=Yes and play prompt 33 ('There seems to be a problem with the automated system…').",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const ageSeconds = Math.round((Date.now() - entry.timestamp) / 1000);
  const withinWindow = ageSeconds < SESSION_WINDOW_SECONDS;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            found: true,
            lookupCode: "VACustSessionData",
            lookupValue: normalizedAni,
            returnValue1: buildSessionReturnValue1(entry.record),
            parsed: entry.record,
            age_seconds: ageSeconds,
            within_10_min_window: withinWindow,
            note: withinWindow
              ? "Within 10-minute window — set TransferReason=Pay_Success_Return and resume routing using preserved ATT/AgencyTransferNumber (FR 6.5.3)."
              : "Outside 10-minute window — treat as expired; route through standard flow.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ============================================================
// JSON-RPC HANDLER (mirrors farmers-insurance-mcp pattern)
// ============================================================

async function handleJsonRpc(body) {
  const { method, params, id } = body;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          result: {
            protocolVersion: params?.protocolVersion || "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "RADD Simulator", version: "0.2.0" },
          },
          id,
        };

      case "notifications/initialized":
        return { jsonrpc: "2.0", result: {}, id };

      case "ping":
        return { jsonrpc: "2.0", result: {}, id };

      case "tools/list":
        return { jsonrpc: "2.0", result: { tools: TOOL_SCHEMAS }, id };

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const handler = TOOL_HANDLERS[toolName];

        if (!handler) {
          return {
            jsonrpc: "2.0",
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
            id,
          };
        }

        const result = await handler(toolArgs);
        console.log(`[radd][MCP] Result: ${result.content[0].text.substring(0, 100)}...`);
        return { jsonrpc: "2.0", result, id };
      }

      default:
        console.log(`[radd][MCP] Unhandled method: ${method} — returning empty result`);
        return { jsonrpc: "2.0", result: {}, id: id || null };
    }
  } catch (err) {
    console.error("[radd][MCP] Error:", err);
    return {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: id || null,
    };
  }
}

// ============================================================
// REQUEST LOG
// ============================================================

const REQUEST_LOG = [];
const MAX_LOG_ENTRIES = 50;

// ============================================================
// ROUTER
// ============================================================

const router = express.Router();

// Per-app CORS — same allowlist as farmers-insurance-mcp so the Webex AI
// Agent Studio MCP client can send Mcp-Session-Id without preflight failure.
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id",
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Request logging for /mcp — captures into REQUEST_LOG ring buffer.
router.use("/mcp", (req, res, next) => {
  if (req.method === "POST") {
    const logEntry = {
      timestamp: new Date().toISOString(),
      method: req.body?.method || "(no method)",
      headers: { ...req.headers },
      body: req.body,
      response: null,
    };

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      logEntry.response = data;
      REQUEST_LOG.push(logEntry);
      if (REQUEST_LOG.length > MAX_LOG_ENTRIES) REQUEST_LOG.shift();
      return originalJson(data);
    };

    const accept = req.headers["accept"] || "(none)";
    const contentType = req.headers["content-type"] || "(none)";
    console.log(
      `[radd][MCP] POST /radd/mcp | Accept: ${accept} | Content-Type: ${contentType} | JSON-RPC method: ${logEntry.method}`,
    );
    if (req.body?.method === "tools/call") {
      console.log(
        `[radd][MCP]   Tool: ${req.body?.params?.name} | Args: ${JSON.stringify(
          req.body?.params?.arguments,
        )}`,
      );
    }
  }
  next();
});

router.get("/mcp-log", (_req, res) => {
  res.json({
    total_requests: REQUEST_LOG.length,
    requests: REQUEST_LOG.slice(-20).reverse(),
  });
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "RADD Simulator",
    version: "0.2.0",
    tools: TOOL_SCHEMAS.length,
    fixtures: {
      agencies: Object.keys(AGENCIES).length,
      customers: Object.keys(CUSTOMERS).length,
      destinations: Object.keys(DESTINATIONS).length,
      session_records: SESSION_STORE.size,
    },
    webex_available: getWebexAvailable(),
  });
});

router.all("/mcp-debug", (req, res) => {
  res.json({ method: req.method, headers: req.headers, body: req.body });
});

router.get("/", (_req, res) => {
  res.json({
    name: "RADD Simulator",
    description:
      "Simulates the Farmers RADD (Routing And Data Distribution) web service for the Voice Advantage IVR Phase 2 demo. Provides agency lookup, customer lookup, Webex availability, destination lookup, and Paymentus session-data preserve/retrieve MCP tools for the Webex AI Agent.",
    version: "0.2.0",
    tools: TOOL_SCHEMAS.map((t) => t.name),
    health: "/radd/health",
    mcp_endpoint: "/radd/mcp",
    mcp_log: "/radd/mcp-log",
    demo_fixtures: {
      agencies: Object.keys(AGENCIES),
      customers: Object.keys(CUSTOMERS),
      destinations: Object.keys(DESTINATIONS),
    },
    webex_available: getWebexAvailable(),
    session_window_seconds: SESSION_WINDOW_SECONDS,
  });
});

router.post("/mcp", async (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) {
      const r = await handleJsonRpc(item);
      if (r) results.push(r);
    }
    return res.json(results);
  }
  return res.json(await handleJsonRpc(body));
});

router.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});

router.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Session management not supported in stateless mode." });
});

export default router;
