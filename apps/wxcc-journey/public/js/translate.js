// js/translate.js — prefetch & lookup of config tables (entry points, queues, etc.)

import { listAllConfig } from "./api.js";
import { getAllByIndex, putMany, get, clearStore } from "./cache.js";
import { toast } from "./util.js";

const RESOURCES = [
  "entry-point",
  "contact-service-queue",
  "team",
  "site",
  "user",
  "skill-profile",
  "skill",
  "auxiliary-code",
  "work-type",
  "audio-file",
  "outdial-ani",
];

/** Prefetch every lookup table. Resolves with counts per resource. */
export async function prefetchAll(progressCb = () => {}) {
  const counts = {};
  for (const resource of RESOURCES) {
    progressCb({ resource, status: "fetching" });
    try {
      const items = await listAllConfig(resource);
      const rows = items.map(it => ({
        key: `${resource}:${it.id}`,
        resource,
        id: it.id,
        name: it.name ?? it.displayName ?? (it.firstName && it.lastName ? `${it.firstName} ${it.lastName}` : null) ?? it.email ?? it.id,
        raw: it,
      }));
      await putMany("lookups", rows);
      counts[resource] = rows.length;
      progressCb({ resource, status: "done", count: rows.length });
    } catch (e) {
      counts[resource] = `error: ${e.message}`;
      progressCb({ resource, status: "error", error: e.message });
    }
  }
  return counts;
}

/** Translate a single id within a resource. Returns the human name (or the id if not cached). */
export async function nameOf(resource, id) {
  if (!id) return "";
  const row = await get("lookups", `${resource}:${id}`);
  return row?.name || id;
}

/** Bulk in-memory map for fast template rendering. */
export async function loadMap(resource) {
  const rows = await getAllByIndex("lookups", "resource", resource);
  const map = new Map();
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

/** Drop only the lookups store (e.g. "Refresh lookups" button). */
export async function clearLookups() {
  await clearStore("lookups");
  toast("Lookup cache cleared.", "ok");
}

export { RESOURCES };
