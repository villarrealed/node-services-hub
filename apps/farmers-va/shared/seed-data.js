/**
 * seed-data.js
 * 
 * Seed data for Farmers VA Demo Upstash Redis database.
 * 
 * Key patterns:
 * - agency:{DNIS} → AgencyProfile JSON
 * - customer:{ANI} → CustomerProfile JSON
 * - destination:{lookupValue} → Raw destination string
 * - webex:available, system:chaos_mode → System flags (Y/N)
 */

export const AGENCIES = [
  {
    key: 'agency:7472574611',
    value: {
      AgencyName: 'Juan Test Agency',
      FSAEnrolled: 'Y',
      ClaimsToAgent: 'N',
      ATT: '1',
      AgPhNum: '7472574611',
      AOR: '73247J',
      PaymentToPaymentus: 'Y',
      AgencyTransferNumber: '17881110006',
      AgencySETN: '17881110007',
      AgencySATN: '17881110008',
      AgencyOTN: '17881110009',
      ClaimsDestination: '18664557827',
      RetentionDestination: 'SOFDSV_C_RET-ADVANTAGE_VA-2',
      BU: '022',
      TransferPrompts: 'N',
      AltGreeting: 'N',
      GreetWav: '',
    },
  },
  {
    key: 'agency:8135829862',
    value: {
      AgencyName: 'Dave Test Agency',
      FSAEnrolled: 'Y',
      ClaimsToAgent: 'Y',
      ATT: '2',
      AgPhNum: '8135829862',
      AOR: '73248J',
      PaymentToPaymentus: 'Y',
      AgencyTransferNumber: '18135829862',
      AgencySETN: '18135829863',
      AgencySATN: '18135829864',
      AgencyOTN: '18135829865',
      ClaimsDestination: '18664557827',
      RetentionDestination: 'SOFDSV_C_RET-ADVANTAGE_VA-2',
      BU: '022',
      TransferPrompts: 'N',
      AltGreeting: 'Y',
      GreetWav: 'va_dave_greeting.wav',
    },
  },
];

export const CUSTOMERS = [
  {
    key: 'customer:1000001000',
    value: {
      RetFlag: 'N',
      Multiline: 'N',
      BU: 'GWPC',
      PRD: 'HOME',
      AOR: '304403',
      OpenClaim: 'N',
      VaRetBu: '2',
      PNI: 'John Smith',
      VAPayElig: 'Y',
      P1: 'HOME_GWPC_961092622_304403',
    },
  },
  {
    key: 'customer:1011011010',
    value: {
      RetFlag: 'Y',
      Multiline: 'Y',
      BU: 'GWPC',
      PRD: 'AUTO_HOME',
      AOR: '76133F',
      OpenClaim: 'N',
      VaRetBu: '5',
      PNI: 'Maria Garcia',
      VAPayElig: 'N',
      P1: 'AUTO_GWPC_513232519_76133F',
      P2: 'HOME_GWPC_763846979_76133F',
    },
  },
  {
    key: 'customer:1016852710',
    value: {
      RetFlag: 'N',
      Multiline: 'N',
      BU: 'PLA',
      PRD: 'HOME',
      AOR: '66198A',
      OpenClaim: 'Y',
      VaRetBu: '2',
      PNI: 'Robert Chen',
      VAPayElig: 'Y',
      P1: 'HOME_PLA_911986224_66198A',
    },
  },
  {
    key: 'customer:1016293699',
    value: {
      RetFlag: 'N',
      Multiline: 'N',
      BU: 'FM',
      PRD: 'SP',
      AOR: '6627C1',
      OpenClaim: 'N',
      VaRetBu: '1',
      PNI: 'Linda Patel',
      VAPayElig: 'Y',
      P1: 'SP_FM_5012540514_6627C1',
    },
  },
  {
    key: 'customer:1002467890',
    value: {
      RetFlag: 'N',
      Multiline: 'N',
      BU: 'GWPC',
      PRD: 'HOME',
      AOR: '3520F5',
      OpenClaim: 'N',
      VaRetBu: '2',
      PNI: 'Tom Williams',
      VAPayElig: 'Y',
      P1: 'HOME_GWPC_302746310_3520F5',
    },
  },
];

export const DESTINATIONS = [
  {
    key: 'destination:VARetEligibleDestination',
    value: 'PQ:SOFDSV_C_RET-ADVANTAGE_VA-2|BU:022',
  },
  {
    key: 'destination:VARetNotEligibleDestination',
    value: 'PQ:WNS_C_RET-ADVANTAGE_VA-2|BU:022',
  },
  {
    key: 'destination:VA_FSA_Destination',
    value: 'PQ:FSA_UNLICENSED_VA-2|BU:022',
  },
  {
    key: 'destination:VA_FSA_LicDestination',
    value: 'PQ:FSA_LICENSED_VA-2|BU:022',
  },
];

export const SYSTEM_FLAGS = [
  {
    key: 'webex:available',
    value: 'Y',
  },
  {
    key: 'system:chaos_mode',
    value: 'N',
  },
];

export const ALL_SEED_ENTRIES = [
  ...AGENCIES,
  ...CUSTOMERS,
  ...DESTINATIONS,
  ...SYSTEM_FLAGS,
];
