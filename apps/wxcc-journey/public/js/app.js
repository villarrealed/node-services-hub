// js/app.js — top-level wiring: settings drawer, connection check, prefetch.

import { getSettings, setSettings } from "./settings.js";
import { pingProxy, listAllConfig } from "./api.js";
import { prefetchAll } from "./translate.js";
import { clearAll } from "./cache.js";
import { initSearch } from "./search.js";
import { toast } from "./util.js";
import { mdsIcon } from "./icons.js";

const $ = (id) => document.getElementById(id);

function openSettings() {
  const s = getSettings();
  $("settings-form").region.value  = s.region;
  $("settings-form").orgId.value   = s.orgId;
  $("settings-form").token.value   = s.token;
  $("settings-form").workspaceId.value = s.workspaceId || "";
  $("settings-overlay").classList.remove("hidden");
  $("settings-drawer").classList.remove("hidden");
}
function closeSettings() {
  $("settings-overlay").classList.add("hidden");
  $("settings-drawer").classList.add("hidden");
}

function setConnState(label, color) {
  const el = $("connection-state");
  el.textContent = label;
  el.className = `status-pill ${color}`;
}

async function testConnection() {
  const status = $("settings-status");
  status.textContent = "Pinging proxy…";
  if (!(await pingProxy())) {
    status.textContent = "✗ Hub proxy not reachable. Is node-services-hub running?";
    setConnState("proxy down", "status-pill-danger");
    return;
  }
  status.textContent = "Proxy OK. Testing token (queues endpoint)…";
  try {
    const queues = await listAllConfig("contact-service-queue");
    status.textContent = `✓ Token OK. ${queues.length} queues visible. Prefetching all lookups…`;
    setConnState("connected", "status-pill-success");
    const counts = await prefetchAll(({ resource, status: st, count }) => {
      if (st === "done") status.textContent = `Prefetched ${resource}: ${count}`;
    });
    const summary = Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(", ");
    status.textContent = `Done. ${summary}`;
    toast("Lookups prefetched.", "ok");
  } catch (e) {
    status.textContent = `✗ ${e.message}`;
    setConnState("auth error", "status-pill-danger");
  }
}

function init() {
  // Inject Momentum icons into static buttons
  const openSettingsBtn = $("open-settings");
  openSettingsBtn.innerHTML = `${mdsIcon("settings-regular", { size: 20, className: "icon-muted" })}Settings`;
  
  const closeSettingsBtn = $("close-settings");
  closeSettingsBtn.innerHTML = `${mdsIcon("cancel-regular", { size: 20, className: "icon-muted" })}Close`;
  
  $("open-settings").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", closeSettings);
  $("settings-overlay").addEventListener("click", closeSettings);

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setSettings({
      region: fd.get("region"),
      orgId:  (fd.get("orgId") || "").toString().trim(),
      token:  (fd.get("token") || "").toString().trim(),
      workspaceId: (fd.get("workspaceId") || "").toString().trim(),
    });
    toast("Settings saved.", "ok");
    closeSettings();
  });

  $("test-connection").addEventListener("click", testConnection);

  $("clear-cache").addEventListener("click", async () => {
    if (!confirm("Wipe all cached lookups, tasks, events, and legs?")) return;
    await clearAll();
    toast("Cache cleared.", "ok");
  });

  initSearch();

  // Prefill date inputs to last 24h
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24*60*60*1000);
  const f = (d) => d.toISOString().slice(0,16);
  document.querySelector('input[name="from"]').value = f(yesterday);
  document.querySelector('input[name="to"]').value   = f(now);

  // Initial connection probe (proxy only, no token needed)
  pingProxy().then(ok => setConnState(ok ? "proxy up" : "proxy down", ok ? "status-pill-warning" : "status-pill-danger"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
