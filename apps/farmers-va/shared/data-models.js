/**
 * data-models.js
 * 
 * JSDoc type definitions for Farmers VA Demo data structures.
 * These are documentation-only (no runtime code) to provide IDE support
 * and type hints across the monorepo.
 */

/**
 * @typedef {Object} AgencyProfile
 * @property {string} AgencyName
 * @property {string} FSAEnrolled
 * @property {string} ClaimsToAgent
 * @property {string} ATT - Agency Transfer Type (1-5)
 * @property {string} AgPhNum - Agency phone number
 * @property {string} AOR - Agent of Record
 * @property {string} PaymentToPaymentus
 * @property {string} AgencyTransferNumber
 * @property {string} AgencySETN - Spanish Entry Transfer Number
 * @property {string} AgencySATN - Spanish Agent Transfer Number
 * @property {string} AgencyOTN - Other Transfer Number
 * @property {string} ClaimsDestination
 * @property {string} RetentionDestination
 * @property {string} BU - Business Unit
 * @property {string} TransferPrompts
 * @property {string} AltGreeting
 * @property {string} GreetWav - Greeting audio file name
 */

/**
 * @typedef {Object} CustomerProfile
 * @property {string} RetFlag - Retention flag
 * @property {string} Multiline - Multiple policies
 * @property {string} BU - Business Unit
 * @property {string} PRD - Product type
 * @property {string} AOR - Agent of Record
 * @property {string} OpenClaim - Has open claim
 * @property {string} VaRetBu - VA Retention Business Unit
 * @property {string} PNI - Primary Named Insured
 * @property {string} VAPayElig - VA Payment Eligible
 * @property {string} P1 - Policy 1 identifier
 * @property {string} [P2] - Policy 2 identifier (optional)
 */

/**
 * @typedef {Object} DestinationLookup
 * @property {string} value - Raw destination string (e.g., "PQ:...|BU:...")
 */

/**
 * @typedef {Object} SessionData
 * @property {string} sessionId
 * @property {string} [ani] - Caller's phone number
 * @property {string} [dnis] - Dialed number
 * @property {string} [intent] - Detected intent
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

// Export empty object to make this a valid ES module
export const __unused = null;
