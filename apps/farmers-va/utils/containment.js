/**
 * containment.js
 * 
 * Containment KPI logic - determines if a call was contained within IVR
 * (resolved without agent transfer).
 */

/**
 * Destinations that count as "contained" (resolved in IVR)
 */
export const CONTAINED_DESTINATIONS = new Set([
  'Q_Paymentus_Sim',
  'Paymentus_Success',
]);

/**
 * Check if a call event was contained
 * @param {Object} event - Call event object
 * @returns {boolean}
 */
export function isContained(event) {
  if (!event.destination) {
    return false;
  }
  return CONTAINED_DESTINATIONS.has(event.destination);
}

/**
 * Compute containment rate from an array of call events
 * @param {Array} calls - Array of call event objects
 * @returns {number} Percentage 0-100 with 1 decimal place
 */
export function computeContainmentRate(calls) {
  if (!calls || calls.length === 0) {
    return 0;
  }
  
  const containedCount = calls.filter(isContained).length;
  const rate = (containedCount / calls.length) * 100;
  
  return Math.round(rate * 10) / 10; // Round to 1 decimal
}
