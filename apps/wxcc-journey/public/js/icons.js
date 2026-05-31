// js/icons.js — Momentum Design icon helper

export const MOMENTUM_BASE = "https://unpkg.com/@momentum-design/icons@0.54.0/dist/svg/";

/**
 * Render a Momentum Design icon using CSS mask technique for color control.
 * @param {string} name - Icon name (e.g., "handset-regular")
 * @param {object} options - { size: 16, className: "", title: "" }
 * @returns {string} HTML string
 */
export function mdsIcon(name, { size = 16, className = "", title = "" } = {}) {
  const url = `${MOMENTUM_BASE}${name}.svg`;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<span class="mds-icon ${className}" ${titleAttr} style="--mds-icon-url:url('${url}');width:${size}px;height:${size}px;"></span>`;
}

/**
 * Map Lucide icon names to Momentum Design equivalents.
 * Format: "lucide-name": "momentum-name"
 */
export const LUCIDE_TO_MDS = {
  // Channel icons
  "phone": "handset-regular",
  "message-square": "chat-regular",
  "mail": "email-regular",
  "share-2": "share-screen-regular",
  "bot": "bot-regular",
  "circle": "cancel-regular", // fallback for unknown
  
  // Direction arrows
  "arrow-right": "arrow-right-regular",
  "arrow-left": "arrow-left-regular",
  "arrow-left-right": "arrow-circle-right-regular", // fallback (no direct match)
  
  // Status icons
  "file-text": "files-regular",
  "mic": "microphone-on-regular",
  "sparkles": "sparkle-regular", // AI summary
  "star": "favorite-regular",
  
  // Sentiment (no direct matches - use generic icons)
  "frown": "cancel-regular", // fallback
  "meh": "info-circle-regular", // fallback
  "smile": "check-circle-regular", // fallback
  
  // Transfer
  "arrow-right-left": "blind-transfer-regular",
  
  // Termination
  "check-circle-2": "check-circle-regular",
  "check-circle": "check-circle-regular",
  "phone-off": "phone-private-regular",
  "x-circle": "cancel-regular",
  
  // UI elements
  "info": "info-circle-regular",
  "settings": "settings-regular",
  "clock": "recents-regular",
  "user": "user-regular",
  "users": "participant-list-regular",
  "download": "download-regular",
};

/**
 * Get Momentum icon name from Lucide name.
 * @param {string} lucideName - Lucide icon name
 * @returns {string} Momentum icon name
 */
export function getMomentumName(lucideName) {
  return LUCIDE_TO_MDS[lucideName] || "info-circle-regular";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
