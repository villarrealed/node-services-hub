/**
 * Helper functions for Salesforce record mapping and SOQL safety.
 * Port of helpers from server.py.
 */

/**
 * Safely extract a string field from a Salesforce record.
 */
export function s(record, key) {
  const val = record[key];
  return val != null ? String(val) : '';
}

/**
 * Safely extract a nested relationship field (e.g. Account.Name).
 */
export function nested(record, parent, child) {
  const obj = record[parent];
  if (obj && typeof obj === 'object') {
    const val = obj[child];
    return val != null ? String(val) : '';
  }
  return '';
}

/**
 * Map a Salesforce Contact record to a flat JS object.
 */
export function toContact(r) {
  return {
    id: s(r, 'Id'),
    first_name: s(r, 'FirstName'),
    last_name: s(r, 'LastName'),
    email: s(r, 'Email'),
    phone: s(r, 'Phone'),
    mobile_phone: s(r, 'MobilePhone'),
    title: s(r, 'Title'),
    department: s(r, 'Department'),
    account_name: nested(r, 'Account', 'Name'),
    mailing_city: s(r, 'MailingCity'),
    mailing_state: s(r, 'MailingState'),
    mailing_street: s(r, 'MailingStreet'),
    mailing_postal_code: s(r, 'MailingPostalCode'),
    created_date: s(r, 'CreatedDate'),
  };
}

/**
 * Map a Salesforce Account record to a flat JS object.
 */
export function toAccount(r) {
  const employees = r.NumberOfEmployees;
  const revenue = r.AnnualRevenue;
  return {
    id: s(r, 'Id'),
    name: s(r, 'Name'),
    account_type: s(r, 'Type'),
    industry: s(r, 'Industry'),
    phone: s(r, 'Phone'),
    website: s(r, 'Website'),
    number_of_employees: employees != null ? parseInt(employees, 10) : null,
    annual_revenue: revenue != null ? parseFloat(revenue) : null,
    billing_city: s(r, 'BillingCity'),
    billing_state: s(r, 'BillingState'),
    billing_street: s(r, 'BillingStreet'),
    billing_postal_code: s(r, 'BillingPostalCode'),
    owner_name: nested(r, 'Owner', 'Name'),
    description: s(r, 'Description'),
    created_date: s(r, 'CreatedDate'),
  };
}

/**
 * Map a Salesforce Case record to a flat JS object.
 */
export function toCase(r) {
  return {
    id: s(r, 'Id'),
    case_number: s(r, 'CaseNumber'),
    subject: s(r, 'Subject'),
    status: s(r, 'Status'),
    priority: s(r, 'Priority'),
    case_type: s(r, 'Type'),
    origin: s(r, 'Origin'),
    description: s(r, 'Description'),
    contact_name: nested(r, 'Contact', 'Name'),
    account_name: nested(r, 'Account', 'Name'),
    owner_name: nested(r, 'Owner', 'Name'),
    created_date: s(r, 'CreatedDate'),
    closed_date: s(r, 'ClosedDate'),
  };
}

/**
 * Escape special characters for safe SOQL interpolation.
 */
export function esc(value) {
  if (!value) return value;
  let escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return escaped.slice(0, 200);
}

/**
 * Strip a phone string down to digits only.
 */
export function digitsOnly(phone) {
  return phone.replace(/\D/g, '');
}

/**
 * Build a SOQL LIKE pattern that matches any phone formatting.
 * 
 * Given '5551234567', produces '%555%123%4567%' which matches:
 *   (555) 123-4567, 555.123.4567, 555-123-4567, +1 555 123 4567, etc.
 */
export function phoneLikePattern(digits) {
  // Remove US/CA country code
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }

  if (digits.length >= 10) {
    return `%${digits.slice(0, 3)}%${digits.slice(3, 6)}%${digits.slice(6)}%`;
  } else if (digits.length >= 7) {
    return `%${digits.slice(0, 3)}%${digits.slice(3)}%`;
  } else {
    return `%${digits}%`;
  }
}
