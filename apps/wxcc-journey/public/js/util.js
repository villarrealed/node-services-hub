// js/util.js — small helpers used everywhere.

import { mdsIcon } from "./icons.js";

/** Show a transient toast in the bottom-right region. */
export function toast(message, kind = "info", ms = 4000) {
  const region = document.getElementById("toast-region");
  if (!region) { console.log(`[toast:${kind}]`, message); return; }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  const iconMap = {
    info: "info-circle-regular",
    ok: "check-circle-regular",
    warn: "info-circle-regular", // no triangle-alert in Momentum
    error: "cancel-regular",
  };
  const icon = mdsIcon(iconMap[kind] || iconMap.info, { size: 16, className: "shrink-0" });
  el.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  region.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Format epoch ms as a local-time string. */
export function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleString();
}

/** Format duration in ms as e.g. "2m 14s" or "1h 03m 12s". */
export function fmtDuration(ms) {
  if (ms == null) return "";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,"0")}m ${String(s).padStart(2,"0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2,"0")}s`;
  return `${s}s`;
}

/** Stable hash of an object (for cache keys). DJB2 over JSON. */
export function hash(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Convert a datetime-local input value to epoch ms. */
export function localInputToMs(value) {
  if (!value) return null;
  return new Date(value).getTime();
}

/** sleep(ms) for retry backoffs. */
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Format epoch ms as relative time ("5m ago", "2h ago", "yesterday", "3d ago", "5/14"). */
export function fmtRelativeTime(ms) {
  if (!ms) return "";
  const now = Date.now();
  const diff = now - ms;
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  
  if (sec < 60) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  
  // Older than 7 days: show M/D
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Format epoch ms as short date+time ("5/15 14:32" in 24h format). */
export function fmtShortDateTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${min}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
