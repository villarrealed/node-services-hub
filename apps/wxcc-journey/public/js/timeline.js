// js/timeline.js — render the chronological flow timeline (activity events).

import { getAllByIndex } from "./cache.js";
import { fmtDuration } from "./util.js";
import { fetchFlowTrace } from "./api.js";
import { loadMap } from "./translate.js";
import { mdsIcon } from "./icons.js";

const $ = (id) => document.getElementById(id);

const EVENT_LABELS = {
  // Lifecycle
  "new":                       "Contact created",
  "queued":                    "Entered queue",
  "dequeued":                  "Left queue",
  "parked":                    "Parked",
  "connect":                   "Connecting",
  "connected":                 "Connected",
  "ended":                     "Contact ended",
  "primary-owner-left":        "Primary owner left",
  "WrapUp":                    "Wrap-up",
  "wrapup-completed":          "Wrap-up completed",
  "Transferred":               "Transferred",
  "blind-transfer":            "Blind transfer",
  "vt-transfer":               "Virtual transfer",
  "con-to-agent-error":        "Connect-to-agent error",
  // IVR / flow
  "flow-started":              "Flow started",
  "flow-activity":             "Flow activity",
  "flow-handoff":              "Flow handoff",
  "ivr-connected":             "IVR connected",
  "ivr-done":                  "IVR done",
  "treatment-activity":        "Treatment played",
  // Hold
  "on-hold":                   "On hold",
  "hold-done":                 "Hold ended",
  // Recording / transcription / AI
  "recording-started":         "Recording started",
  "recording-available":       "Recording available",
  "va-recording-available":    "Virtual-agent recording available",
  "rtt-enabled":               "Real-time transcription enabled",
  "bnr-started":               "Background-noise removal started",
  "bnr-ended":                 "Background-noise removal ended",
  "assistance-feature-usage":  "Agent assistance used",
  // Monitoring / supervision
  "monitoring-started":        "Supervisor monitoring started",
  "monitoring-ended":          "Supervisor monitoring ended",
  "skill-updated":             "Skills updated",
};

const HIGH_EVENTS = new Set([
  "connect",
  "connected",
  "assistance-feature-usage",
]);

const MEDIUM_EVENTS = new Set([
  "flow-started",
  "flow-activity",
  "flow-handoff",
  "ivr-connected",
  "ivr-done",
  "treatment-activity",
]);

const LOW_PASSIVE_EVENTS = new Set([
  "new",
  "recording-started",
  "recording-available",
  "va-recording-available",
  "bnr-started",
  "bnr-ended",
]);

const LOW_INDIRECT_EVENTS = new Set([
  "queued",
  "dequeued",
  "parked",
  "on-hold",
  "hold-done",
]);

const LOW_NOTABLE_EVENTS = new Set([
  "ended",
  "primary-owner-left",
  "WrapUp",
  "wrapup-completed",
  "Transferred",
  "blind-transfer",
  "vt-transfer",
  "con-to-agent-error",
  "rtt-enabled",
  "monitoring-started",
  "monitoring-ended",
  "skill-updated",
]);

export async function renderTimeline(taskId, task) {
  const panel = $("journey-right");
  const tl = $("timeline-list");
  
  if (!panel || !tl) {
    console.warn("Timeline panel elements not found in DOM");
    return;
  }
  
  // Clear previous content
  tl.innerHTML = `<li class="timeline-loading list-none text-sm text-ink-muted p-3">Loading timeline...</li>`;
  $("timeline-event-count").textContent = "";
  
  // Fetch events and flow trace data
  const events = await getAllByIndex("events", "taskId", taskId);
  events.sort((a,b) => (a.createdTime || 0) - (b.createdTime || 0));
  
  const [flowTraces, eps, queues, users, audio, codes] = await Promise.all([
    fetchFlowTrace(taskId, task.createdTime, task.endedTime),
    loadMap("entry-point"),
    loadMap("contact-service-queue"),
    loadMap("user"),
    loadMap("audio-file"),
    loadMap("auxiliary-code"),
  ]);
  
  const flowTraceByActivity = new Map((flowTraces || []).map(t => [t.activityName, t]));
  
  // Update event count
  $("timeline-event-count").textContent = events.length ? `(${events.length} events)` : "";
  
  // Render timeline
  if (!events.length) {
    tl.innerHTML = `<li class="timeline-empty list-none text-sm text-ink-muted p-3">No activity events for this task. (CAR data may be older than 30 days.)</li>`;
    return;
  }
  
  tl.innerHTML = ""; // Clear loading message
  
  const t0 = events[0].createdTime;
  const last = events.length - 1;
  
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const li = document.createElement("li");
    li.className = "list-none";
    const offset = ev.createdTime ? `+${fmtDuration(ev.createdTime - t0)}` : "";
    const label = EVENT_LABELS[ev.eventName] || ev.eventName;
    const dur = ev.duration ? fmtDuration(ev.duration) : "";
    const markerClass = getTimelineMarkerClass(ev);
    
    // Build tooltip content from event detail + flow trace
    const flowTrace = flowTraceByActivity.get(ev.activityName);
    const tooltipContent = buildTooltip(ev, flowTrace, { eps, queues, users, audio, codes });
    const hasTooltip = tooltipContent.trim().length > 0;
    
    // 3-col grid: [total | marker | event-dur  label  (ⓘ)]
    li.innerHTML = `
      <div class="grid grid-cols-[5rem_1.25rem_1fr] gap-x-3 items-start">
        <span class="timeline-offset font-mono text-right pt-0.5" title="Elapsed since start">${offset}</span>
        <span class="relative flex justify-center">
          <span class="timeline-marker ${markerClass} relative mt-0.5" aria-hidden="true"></span>
        </span>
        <div class="pb-1">
          <div class="flex items-baseline gap-2">
            <span class="timeline-duration font-mono" title="Event duration">${dur}</span>
            ${hasTooltip ? `<span class="relative inline-block" data-tooltip-trigger>
              <span class="timeline-label">${label}</span>
              <span class="timeline-info-icon">${mdsIcon("info-circle-regular", { size: 14, className: "timeline-info cursor-help" })}</span>
              <div class="timeline-tooltip tt-hidden pointer-events-auto" data-tooltip>${tooltipContent}</div>
            </span>` : `<span class="timeline-label">${label}</span>`}
          </div>
        </div>
      </div>`;
    tl.appendChild(li);
  }
  
  // Attach JS hover handlers for timeline tooltips (with fixed positioning)
  tl.querySelectorAll('[data-tooltip-trigger]').forEach(trigger => {
    const tooltip = trigger.querySelector('[data-tooltip]');
    if (!tooltip) return;
    
    let hideTimer;
    const show = () => {
      clearTimeout(hideTimer);
      
      // Calculate fixed position based on trigger's viewport position
      const rect = trigger.getBoundingClientRect();
      tooltip.style.left = `${rect.right + 8}px`; // 8px gap to the right
      tooltip.style.top = `${rect.top}px`;
      
      tooltip.classList.remove('tt-hidden');
      tooltip.classList.add('tt-visible');
    };
    const scheduleHide = () => {
      hideTimer = setTimeout(() => {
        tooltip.classList.add('tt-hidden');
        tooltip.classList.remove('tt-visible');
      }, 200);
    };
    
    trigger.addEventListener('mouseenter', show);
    trigger.addEventListener('mouseleave', scheduleHide);
    tooltip.addEventListener('mouseenter', show);
    tooltip.addEventListener('mouseleave', scheduleHide);
  });
}

function getTimelineMarkerClass(ev) {
  const classification = classifyTimelineIntensity(ev);
  return `timeline-marker--${classification}`;
}

function classifyTimelineIntensity(ev) {
  const eventName = String(ev.eventName || "");
  const haystack = [
    ev.eventName,
    ev.activityName,
    ev.activityType,
    ev.previousState,
    ev.nextState,
    ev.ivrScriptName,
    ev.chatType,
    ev.bnrMode,
  ].filter(Boolean).join(" ").toLowerCase();

  if (HIGH_EVENTS.has(eventName)) return "high";

  if (MEDIUM_EVENTS.has(eventName)) return "medium";

  if (includesAny(haystack, ["virtual agent", "virtual-agent", "va_", " va", "ivr", "bot", "menu", "prompt"])) {
    return "medium";
  }

  if (LOW_PASSIVE_EVENTS.has(eventName)) return "low-1";

  if (LOW_INDIRECT_EVENTS.has(eventName) || includesAny(haystack, ["queue", "queued", "hold", "park"])) {
    return "low-2";
  }

  if (
    LOW_NOTABLE_EVENTS.has(eventName) ||
    includesAny(haystack, ["transfer", "wrap", "recording", "monitor", "skill", "routing", "route", "owner", "error", "transcription"])
  ) {
    return "low-3";
  }

  return "low-2";
}

function includesAny(haystack, needles) {
  return needles.some((needle) => haystack.includes(needle));
}

function buildTooltip(ev, flowTrace, maps) {
  const parts = [];
  
  // Event detail
  if (ev.activityName) parts.push(`<strong>Activity:</strong> <code>${escapeHtml(ev.activityName)}</code>`);
  if (ev.activityType && ev.activityType !== ev.activityName) parts.push(`<strong>Type:</strong> ${escapeHtml(ev.activityType)}`);
  if (ev.previousState || ev.nextState) parts.push(`<strong>State:</strong> ${escapeHtml(ev.previousState || "—")} → ${escapeHtml(ev.nextState || "—")}`);
  if (ev.ivrScriptName) parts.push(`<strong>Script:</strong> ${escapeHtml(ev.ivrScriptName)}${ev.ivrScriptTagName?` (${escapeHtml(ev.ivrScriptTagName)})`:""}`);
  
  const queueName = maps.queues.get(ev.queueId) || ev.queueName;
  if (queueName) parts.push(`<strong>Queue:</strong> ${escapeHtml(queueName)}`);
  
  const epName = maps.eps.get(ev.entrypointId) || ev.entrypointName;
  if (epName) parts.push(`<strong>Entry point:</strong> ${escapeHtml(epName)}`);
  
  const agentName = maps.users.get(ev.agentId) || ev.agentName;
  if (agentName) parts.push(`<strong>Agent:</strong> ${escapeHtml(agentName)}`);
  
  if (ev.teamName) parts.push(`<strong>Team:</strong> ${escapeHtml(ev.teamName)}`);
  
  if (ev.transferType) {
    const dst = maps.users.get(ev.destinationAgentId) || ev.destinationAgentName ||
                maps.queues.get(ev.destinationQueueId) || ev.destinationQueueName ||
                ev.consultEpName;
    parts.push(`<strong>Transfer:</strong> ${escapeHtml(ev.transferType)}${dst ? ` → ${escapeHtml(dst)}` : ""}`);
  }
  
  if (ev.terminationReason) parts.push(`<strong>Reason:</strong> ${escapeHtml(ev.terminationReason)}`);
  if (ev.actorName && ev.actorName !== agentName) parts.push(`<strong>By:</strong> ${escapeHtml(ev.actorName)}${ev.actorRole?` (${escapeHtml(ev.actorRole)})`:""}`);
  if (ev.skillsAssignedIn) parts.push(`<strong>Skills:</strong> ${escapeHtml(ev.skillsAssignedIn)}`);
  if (ev.bnrMode) parts.push(`<strong>BNR mode:</strong> ${escapeHtml(ev.bnrMode)}`);
  if (ev.chatType) parts.push(`<strong>Chat:</strong> ${escapeHtml(ev.chatType)}`);
  
  // Flow trace data
  if (flowTrace) {
    if (flowTrace.activityInputs && flowTrace.activityInputs.length) {
      parts.push(`<div class="tooltip-divider"><strong>Flow inputs:</strong></div>`);
      for (const inp of flowTrace.activityInputs) {
        const val = inp.isSecure ? "🔒 (secure)" : escapeHtml(String(inp.value || "").slice(0, 100));
        parts.push(`<div class="ml-2">• <code>${escapeHtml(inp.name)}</code> = ${val}</div>`);
      }
    }
    if (flowTrace.activityOutput) {
      const out = flowTrace.activityOutput;
      const val = out.isSecure ? "🔒 (secure)" : escapeHtml(String(out.value || "").slice(0, 100));
      parts.push(`<div class="tooltip-divider"><strong>Flow output:</strong></div>`);
      parts.push(`<div class="ml-2"><code>${escapeHtml(out.name || out.type)}</code> = ${val}</div>`);
    }
    if (flowTrace.modifiedFlowVariables && flowTrace.modifiedFlowVariables.length) {
      parts.push(`<div class="tooltip-divider"><strong>Modified flow variables:</strong></div>`);
      for (const v of flowTrace.modifiedFlowVariables) {
        const val = v.isSecure ? "🔒 (secure)" : escapeHtml(String(v.value || "").slice(0, 100));
        parts.push(`<div class="ml-2">• <code>${escapeHtml(v.name)}</code> = ${val}</div>`);
      }
    }
    if (flowTrace.outcome) parts.push(`<div class="mt-2"><strong>Outcome:</strong> ${escapeHtml(flowTrace.outcome)}</div>`);
  }
  
  return parts.join("<br>");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
