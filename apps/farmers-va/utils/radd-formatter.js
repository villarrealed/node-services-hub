/**
 * radd-formatter.js
 * 
 * Pure formatting functions for RADD API responses.
 * Converts profile objects to pipe-delimited strings per RADD contract.
 */

// Field order constants for returnValue1 and returnValue2
export const AGENCY_RV1_FIELDS = [
  'AgencyName',
  'FSAEnrolled',
  'ClaimsToAgent',
  'ATT',
  'AgPhNum',
  'AOR',
  'PaymentToPaymentus',
];

export const AGENCY_RV2_FIELDS = [
  'AgencyTransferNumber',
  'ClaimsDestination',
  'AgencySETN',
  'AgencySATN',
  'AgencyOTN',
  'TransferPrompts',
  'AltGreeting',
  'GreetWav',
];

// Wire field names for customer returnValue1 (note BU→BUs, AOR→CAOR remapping)
export const CUSTOMER_RV1_FIELDS = [
  'RetFlag',
  'Multiline',
  'BUs',
  'PRD',
  'CAOR',
  'OpenClaim',
  'VaRetBu',
  'PNI',
  'VAPayElig',
];

/**
 * Format an object as a pipe-delimited string
 * @param {Object} obj - Source object
 * @param {string[]} fieldOrder - Field names in desired order
 * @returns {string} Formatted string like "key1 : v1 | key2 : v2"
 */
export function formatPipeString(obj, fieldOrder) {
  return fieldOrder
    .map((field) => `${field} : ${obj[field] || ''}`)
    .join(' | ');
}

/**
 * Format agency profile for EAAgentLookup response
 * @param {Object} agency - AgencyProfile from Redis
 * @returns {Object} {returnValue1, returnValue2, nsc}
 */
export function formatAgency(agency) {
  return {
    returnValue1: formatPipeString(agency, AGENCY_RV1_FIELDS),
    returnValue2: formatPipeString(agency, AGENCY_RV2_FIELDS),
    nsc: 'NULL',
  };
}

/**
 * Format customer profile for EACustLookup2 response
 * Handles BU→BUs and AOR→CAOR field remapping
 * Concatenates P1, P2, P3... policies into returnValue2
 * @param {Object} customer - CustomerProfile from Redis
 * @returns {Object} {returnValue1, returnValue2, nsc}
 */
export function formatCustomer(customer) {
  // Remap BU→BUs and AOR→CAOR for wire format
  const wireCustomer = {
    ...customer,
    BUs: customer.BU,
    CAOR: customer.AOR,
  };

  const returnValue1 = formatPipeString(wireCustomer, CUSTOMER_RV1_FIELDS);

  // Build returnValue2 from P1, P2, P3... fields
  const policies = [];
  let policyIndex = 1;
  while (customer[`P${policyIndex}`]) {
    policies.push(`P${policyIndex} : ${customer[`P${policyIndex}`]}`);
    policyIndex++;
  }

  const returnValue2 = policies.length > 0 ? policies.join(' | ') : 'NULL';

  return {
    returnValue1,
    returnValue2,
    nsc: 'NULL',
  };
}
