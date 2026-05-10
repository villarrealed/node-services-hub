/**
 * event-bus.js
 * 
 * In-memory pub/sub for SSE clients.
 * Broadcasts analytics events to all connected dashboard clients.
 */

const clients = new Set();
let heartbeatInterval = null;

/**
 * Add an SSE client
 * @param {Response} res - Express response object
 */
export function addClient(res) {
  clients.add(res);
  
  // Start heartbeat if this is the first client
  if (clients.size === 1 && !heartbeatInterval) {
    heartbeatInterval = setInterval(() => {
      broadcast('heartbeat', null, true);
    }, 15000);
  }
}

/**
 * Remove an SSE client
 * @param {Response} res - Express response object
 */
export function removeClient(res) {
  clients.delete(res);
  
  // Stop heartbeat if no clients remain
  if (clients.size === 0 && heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Broadcast an event to all connected clients
 * @param {string} eventName - SSE event name
 * @param {Object} payload - Event payload (will be JSON stringified)
 * @param {boolean} isComment - If true, send as SSE comment (: keep-alive)
 */
export function broadcast(eventName, payload, isComment = false) {
  const deadClients = [];
  
  for (const client of clients) {
    try {
      if (isComment) {
        // Heartbeat comment
        client.write(': keep-alive\n\n');
      } else {
        // Event with data
        client.write(`event: ${eventName}\n`);
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } catch (err) {
      // Client connection failed, mark for removal
      deadClients.push(client);
    }
  }
  
  // Clean up dead clients
  for (const client of deadClients) {
    removeClient(client);
  }
}

/**
 * Get current client count
 * @returns {number}
 */
export function clientCount() {
  return clients.size;
}
