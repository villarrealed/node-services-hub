// js/search.js — search form handling + results table rendering.

import { searchTaskDetails } from "./api.js";
import { put, getAllByIndex, putMany } from "./cache.js";
import { loadMap } from "./translate.js";
import { fmtTime, fmtDuration, fmtRelativeTime, fmtShortDateTime, localInputToMs, toast } from "./util.js";
import { renderJourney } from "./journey.js";
import { renderTimeline } from "./timeline.js";
import { mdsIcon } from "./icons.js";

const $ = (id) => document.getElementById(id);

export function initSearch() {
  $("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const fromMs = localInputToMs(fd.get("from"));
    const toMs   = localInputToMs(fd.get("to"));
    const field  = fd.get("field");
    const value  = (fd.get("value") || "").toString().trim();
    const matchMode = fd.get("matchMode") || "equals";

    if (!fromMs || !toMs || toMs <= fromMs) {
      toast("Pick a valid date range.", "error");
      return;
    }
    const days = (toMs - fromMs) / 86400000;
    if (days > 30) {
      toast(`Range > 30 days: CAR (activity) detail will be missing.`, "warn", 6000);
    }

    $("results-panel").classList.remove("hidden");
    $("results-body").innerHTML = `<tr><td colspan="8" class="py-6 text-center results-loading">Searching…</td></tr>`;
    $("results-empty").classList.add("hidden");

    try {
      const tasks = await searchTaskDetails({ fromMs, toMs, field, value, matchMode, includeCar: days <= 30 });
      // Cache CSR + CARs for journey view.
      if (tasks.length) {
        await putMany("tasks", tasks.map(t => ({ ...t })));
        const events = [];
        for (const t of tasks) {
          const activityNodes = t.activities?.nodes || [];
          activityNodes.forEach((a, i) => {
            events.push({ key: `${t.id}:${String(i).padStart(5,"0")}`, taskId: t.id, ...a });
          });
        }
        if (events.length) await putMany("events", events);
      }
      await renderResults(tasks);
    } catch (err) {
      $("results-body").innerHTML = `<tr><td colspan="8" class="py-6 text-center results-error">${err.message}</td></tr>`;
    }
  });

  $("export-results").addEventListener("click", exportResults);
}

let _lastResults = [];

async function renderResults(tasks) {
  _lastResults = tasks;
  $("results-count").textContent = `(${tasks.length})`;
  const tbody = $("results-body");
  tbody.innerHTML = "";

  if (!tasks.length) {
    $("results-empty").classList.remove("hidden");
    return;
  }

  // Translation maps loaded once per render.
  const [eps, queues, users] = await Promise.all([
    loadMap("entry-point"),
    loadMap("contact-service-queue"),
    loadMap("user"),
  ]);

  for (const t of tasks) {
    const tr = document.createElement("tr");
    tr.className = "cursor-pointer";
    tr.dataset.task = t.id;
    
    // Col 1: Time (two lines: short date+time, then relative)
    const timeShort = fmtShortDateTime(t.createdTime);
    const timeRel = fmtRelativeTime(t.createdTime);
    const timeFull = fmtTime(t.createdTime);
    
    // Col 2: Channel icon
    const channelIcon = getChannelIcon(t);
    
    // Col 3: Direction arrow
    const dirIcon = getDirectionIcon(t.direction);
    const dirTitle = t.direction || "";
    
    // Col 4: Origin → Destination
    const origin = escapeHtml(t.origin || "—");
    const dest = escapeHtml(t.destination || "—");
    const originDest = `${origin} → ${dest}`;
    
    // Col 5: Routing (EP › Queue › Agent)
    const epName = eps.get(t.lastEntryPoint?.id) || t.lastEntryPoint?.name || "";
    const queueName = queues.get(t.lastQueue?.id) || t.lastQueue?.name || "";
    const agentName = users.get(t.lastAgent?.id) || t.lastAgent?.name || "";
    const routing = [epName, queueName, agentName]
      .filter(Boolean)
      .map(s => truncate(s, 15))
      .join(" › ");
    
    // Col 6: Duration
    const duration = fmtDuration(t.totalDuration);
    
    // Col 7: Status icons
    const statusIcons = buildStatusIcons(t);
    
    // Col 8: Termination icon
    const termIcon = getTerminationIcon(t);
    const termTitle = [t.terminationReason, t.terminationType, t.terminatingEnd]
      .filter(Boolean)
      .join(" · ");
    
    tr.innerHTML = `
      <td class="py-2 pr-3 text-xs" title="${escapeHtml(timeFull)}">
        <div class="leading-tight">${escapeHtml(timeShort)}</div>
        <div class="text-ink-disabled text-[0.65rem]">${escapeHtml(timeRel)}</div>
      </td>
      <td class="py-2 pr-2 text-center" title="${escapeHtml(t.channelType || "")}">${channelIcon}</td>
      <td class="py-2 pr-2 text-center" title="${escapeHtml(dirTitle)}">${dirIcon}</td>
      <td class="py-2 pr-3 font-mono text-xs truncate max-w-xs">${originDest}</td>
      <td class="py-2 pr-3 text-xs truncate max-w-xs">${escapeHtml(routing)}</td>
      <td class="py-2 pr-3 text-right font-mono text-xs">${escapeHtml(duration)}</td>
      <td class="py-2 pr-3 text-xs whitespace-nowrap">${statusIcons}</td>
      <td class="py-2 pr-3 text-center" title="${escapeHtml(termTitle)}">${termIcon}</td>`;
    
    tr.addEventListener("click", async () => {
      tbody.querySelectorAll("tr.is-selected").forEach((row) => row.classList.remove("is-selected"));
      tr.classList.add("is-selected");
      
      // Show all three detail panels
      $("customer-panel").classList.remove("hidden");
      $("recordings-panel").classList.remove("hidden");
      $("journey-panel").classList.remove("hidden");
      
      // Render journey (which internally calls customer, recordings, and journey-left renderers)
      const task = await renderJourney(t.id);
      if (task) {
        renderTimeline(t.id, task);
      }
    });
    tbody.appendChild(tr);
  }
}

function getChannelIcon(task) {
  const ch = task.channelType?.toLowerCase() || "";
  let iconName = "cancel-regular"; // fallback
  let colorClass = "icon-subtle";
  
  if (task.botName) {
    iconName = "bot-regular";
    colorClass = "icon-info";
  } else if (ch.includes("telephony") || ch.includes("voice")) {
    iconName = "handset-regular";
    colorClass = "icon-accent";
  } else if (ch.includes("chat")) {
    iconName = "chat-regular";
    colorClass = "icon-success";
  } else if (ch.includes("email")) {
    iconName = "email-regular";
    colorClass = "icon-warning";
  } else if (ch.includes("social")) {
    iconName = "share-screen-regular";
    colorClass = "icon-info";
  }
  
  return mdsIcon(iconName, { size: 16, className: colorClass, title: task.channelType || "" });
}

function getDirectionIcon(direction) {
  const d = direction?.toLowerCase() || "";
  let iconName = "arrow-circle-right-regular"; // fallback for bidirectional
  
  if (d.includes("outbound")) iconName = "arrow-right-regular";
  else if (d.includes("inbound")) iconName = "arrow-left-regular";
  
  return mdsIcon(iconName, { size: 16, className: "icon-muted", title: direction || "" });
}

function getTerminationIcon(task) {
  const reason = task.terminationReason?.toLowerCase() || "";
  const type = task.terminationType?.toLowerCase() || "";
  const end = task.terminatingEnd?.toLowerCase() || "";
  
  let iconName = "cancel-regular";
  let colorClass = "icon-subtle";
  
  // Completed/handled
  if (reason.includes("handled") || reason.includes("completed") || type.includes("completed")) {
    iconName = "check-circle-regular";
    colorClass = "icon-success";
  }
  // Customer left
  else if (end.includes("customer") || reason.includes("customer") || reason.includes("abandon")) {
    iconName = "phone-private-regular";
    colorClass = "icon-warning";
  }
  // Error/abandoned
  else if (reason.includes("error") || reason.includes("fail") || type.includes("abandon")) {
    iconName = "cancel-regular";
    colorClass = "icon-danger";
  }
  
  const termTitle = [task.terminationReason, task.terminationType, task.terminatingEnd]
    .filter(Boolean)
    .join(" · ");
  
  return mdsIcon(iconName, { size: 16, className: colorClass, title: termTitle });
}

function buildStatusIcons(task) {
  const icons = [];
  
  // Transcription
  if (task.isTranscriptionAvailable || task.vaTranscriptionAvailable) {
    icons.push(mdsIcon("files-regular", { size: 16, className: "icon-info", title: "Transcription available" }));
  }
  
  // Recording
  if (task.recordingLocation) {
    icons.push(mdsIcon("microphone-on-regular", { size: 16, className: "icon-accent", title: "Recording available" }));
  }
  
  // AI summary
  if ((task.postCallSummaryCount || 0) > 0 || (task.midCallSummaryCount || 0) > 0) {
    const parts = [];
    if (task.postCallSummaryCount) parts.push(`${task.postCallSummaryCount} post-call`);
    if (task.midCallSummaryCount) parts.push(`${task.midCallSummaryCount} mid-call`);
    icons.push(mdsIcon("sparkle-regular", { size: 16, className: "icon-warning", title: `AI summary: ${parts.join(", ")}` }));
  }
  
  // CSAT
  const csat = task.csatScore || task.autoCsat;
  if (csat) {
    const src = task.csatScore ? "CSAT" : "Auto-CSAT";
    const starIcon = mdsIcon("favorite-regular", { size: 14, className: "icon-warning", title: `${src}: ${csat}` });
    icons.push(`<span class="inline-flex items-center gap-0.5">${starIcon}<span class="text-[0.7rem] font-semibold">${csat}</span></span>`);
  }
  
  // Sentiment (use generic icons as fallbacks)
  const sentiment = task.customerSentimentScore;
  if (sentiment != null) {
    let iconName = "info-circle-regular"; // neutral fallback
    let colorClass = "icon-subtle";
    let label = "neutral";
    
    if (sentiment < -0.3) {
      iconName = "cancel-regular"; // negative fallback
      colorClass = "icon-danger";
      label = "negative";
    } else if (sentiment < 0) {
      iconName = "cancel-regular";
      colorClass = "icon-warning";
      label = "slightly negative";
    } else if (sentiment > 0.3) {
      iconName = "check-circle-regular"; // positive fallback
      colorClass = "icon-success";
      label = "positive";
    }
    
    icons.push(mdsIcon(iconName, { size: 16, className: colorClass, title: `Customer sentiment: ${label} (${sentiment.toFixed(2)})` }));
  }
  
  // Transfer
  if ((task.transferCount || 0) > 0) {
    icons.push(mdsIcon("blind-transfer-regular", { size: 16, className: "icon-info", title: `Transferred ${task.transferCount} time(s)` }));
  }
  
  return icons.join(" ");
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function exportResults() {
  if (!_lastResults.length) return;
  const blob = new Blob([JSON.stringify(_lastResults, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wxcc-results-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
