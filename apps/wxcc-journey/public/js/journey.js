// js/journey.js — render a single interaction's full timeline.

import { getAllByIndex, get } from "./cache.js";
import { loadMap } from "./translate.js";
import { fmtTime, fmtDuration } from "./util.js";
import { fetchFlowTrace, fetchCaptures, fetchPersonByAlias, fetchEventsByIdentity, fetchVATranscript, fetchVASummary } from "./api.js";
import { mdsIcon } from "./icons.js";
import { getSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

// Helper to extract a global variable by name from task.globalVariables array
function getGlobalVar(vars, name) {
  if (!Array.isArray(vars)) return "";
  const v = vars.find(x => x?.name === name);
  return (v?.strVal || "").trim();
}

// Helper to linkify URLs in text (escapes HTML first, then wraps URLs)
function linkifyValue(value) {
  const escaped = escapeHtml(value);
  if (/^https?:\/\//i.test(value)) {
    return `<a href="${escaped}" target="_blank" rel="noopener" class="text-info underline">${escaped}</a>`;
  }
  return escaped;
}

export async function renderJourney(taskId) {
  $("journey-task-id").textContent = taskId;
  $("journey-summary").innerHTML = `<div class="journey-loading">Loading…</div>`;

  const task = await get("tasks", taskId);
  if (!task) {
    $("journey-summary").innerHTML = `<div class="journey-error">Task not in cache. Re-run search.</div>`;
    return;
  }

  // Fetch captures for recordings panel
  const captures = await fetchCaptures(taskId);

  const [eps, queues, users, audio, codes] = await Promise.all([
    loadMap("entry-point"),
    loadMap("contact-service-queue"),
    loadMap("user"),
    loadMap("audio-file"),
    loadMap("auxiliary-code"),
  ]);

  // ========== CUSTOMER CONTEXT (renders to #customer-content) ==========
  const customerContentEl = $("customer-content");
  const { workspaceId } = getSettings();
  const customerIdentity = task.origin || task.customer?.phoneNumber || task.customer?.email || "";
  
  if (!workspaceId) {
    // Show hint to configure workspace ID
    customerContentEl.innerHTML = `
      <div class="text-xs text-ink-muted p-2 bg-surface-subtle border border-outline rounded">
        Configure CJDS Workspace ID in <button id="open-settings-from-context" class="text-info underline cursor-pointer">settings</button> to see customer context
      </div>`;
    
    // Attach click handler to open settings
    setTimeout(() => {
      const settingsBtn = customerContentEl.querySelector("#open-settings-from-context");
      if (settingsBtn) {
        settingsBtn.addEventListener("click", () => {
          document.getElementById("open-settings")?.click();
        });
      }
    }, 0);
  } else if (customerIdentity) {
    // Fetch and render compact customer context immediately
    customerContentEl.innerHTML = `<div class="text-xs text-ink-muted p-2">Loading customer context...</div>`;
    
    try {
      const [profile, events] = await Promise.all([
        fetchPersonByAlias(customerIdentity),
        fetchEventsByIdentity(customerIdentity, { limit: 200 }),
      ]);
      
      customerContentEl.innerHTML = renderCompactCustomerContext(profile, events, customerIdentity, task);
    } catch (err) {
      console.warn("Failed to load customer context:", err);
      customerContentEl.innerHTML = `<div class="text-xs text-danger p-2">Failed to load customer data</div>`;
    }
  } else {
    customerContentEl.innerHTML = `<div class="text-xs text-ink-muted p-2">No customer identity available</div>`;
  }

  // ========== RECORDINGS & TRANSCRIPTS (renders to #recordings-content) ==========
  // Create a container for all recordings-related content
  const recordingsContentEl = $("recordings-content");
  recordingsContentEl.innerHTML = ""; // Clear previous content
  
  // Create a wrapper div for dynamic elements
  const recordingsWrapper = document.createElement("div");
  recordingsWrapper.id = "recordings-wrapper";
  recordingsContentEl.appendChild(recordingsWrapper);

  // Detect digital channel (chat, email, social)
  const channelType = (task.channelType || "").toLowerCase();
  const isDigital = ["chat", "email", "social"].includes(channelType);

  // ========== JOURNEY DATA (renders to #journey-content in #journey-left) ==========
  // Header summary
  $("journey-summary").innerHTML = `
    ${kv("Started",       fmtTime(task.createdTime))}
    ${kv("Ended",         fmtTime(task.endedTime))}
    ${kv("Channel",       task.channelType ? `${task.channelType}${task.channelSubType?` · ${task.channelSubType}`:""}` : "")}
    ${kv("Direction",     task.direction || "")}
    ${kv("Origin",        task.origin || "")}
    ${kv("Destination",   task.destination || "")}
    ${kv("Entry point",   eps.get(task.lastEntryPoint?.id) || task.lastEntryPoint?.name || "")}
    ${kv("First queue",   task.firstQueueName || "")}
    ${kv("Last queue",    queues.get(task.lastQueue?.id) || task.lastQueue?.name || "")}
    ${kv("Last agent",    users.get(task.lastAgent?.id) || task.lastAgent?.name || "")}
    ${kv("Wrap-up code",  task.lastWrapupCodeName || "")}
    ${kv("Total",         fmtDuration(task.totalDuration))}
    ${kv("Connected",     fmtDuration(task.connectedDuration))}
    ${kv("Queue time",    fmtDuration(task.queueDuration))}
    ${kv("Wrap-up time",  fmtDuration(task.wrapupDuration))}
    ${kv("Hold time",     fmtDuration(task.holdDuration))}
    <div class="summary-card col-span-2 md:col-span-4"><div class="summary-key">Termination</div><div class="summary-value">${[task.terminationReason, task.terminationType, task.terminatingEnd && `(end: ${task.terminatingEnd})`].filter(Boolean).join(" · ") || "—"}</div></div>
  `;

  // AI / Quality strip (only if anything is populated)
  const aiBits = [
    task.contactReason   && kv("Contact reason",   task.contactReason),
    task.contactDriver   && kv("Contact driver",   task.contactDriver),
    task.topicName       && kv("Topic",            `${task.topicName}${task.topicSource?` (${task.topicSource})`:""}`),
    task.botName         && kv("Bot",              task.botName),
    (task.csatScore > 0)              && kv("CSAT",                task.csatScore),
    (task.autoCsat > 0)               && kv("Auto-CSAT",           task.autoCsat),
    (task.customerSentimentScore > 0 || task.customerSentimentScore < 0) && kv("Customer sentiment",  task.customerSentimentScore),
    task.sentiment       && kv("Sentiment (raw)",  `<code class="text-xs">${escapeHtml(JSON.stringify(task.sentiment).slice(0,80))}</code>`),
    (task.postCallSummaryCount > 0) && kvWithTitle("Post-call summaries", task.postCallSummaryCount, "AI-generated summary text is not exposed by the WxCC public API. View in Agent Desktop or Analyzer."),
    (task.midCallSummaryCount  > 0) && kvWithTitle("Mid-call summaries",  task.midCallSummaryCount, "AI-generated summary text is not exposed by the WxCC public API. View in Agent Desktop or Analyzer."),
    task.isTranscriptionAvailable && kv("Transcription", "available"),
    task.isRealtimeTranscriptionEnabled && kv("Real-time transcription", "enabled"),
    task.recordingLocation && kv("Recording", "available (see download below)"),
    task.matchedSkillsProfile && kv("Skill profile", task.matchedSkillsProfile),
    task.matchedSkills && Array.isArray(task.matchedSkills) && task.matchedSkills.length && kv("Matched skills", task.matchedSkills.map(s => s?.name || s).filter(Boolean).join(", ")),
    task.campaignName && kv("Campaign", task.campaignName),
  ].filter(Boolean);
  let aiStripEl = document.getElementById("journey-ai");
  if (!aiStripEl) {
    aiStripEl = document.createElement("div");
    aiStripEl.id = "journey-ai";
    aiStripEl.className = "journey-ai-strip text-sm";
    $("journey-summary").after(aiStripEl);
  }
  if (aiBits.length) {
    aiStripEl.innerHTML = aiBits.join("");
    aiStripEl.classList.remove("hidden");
  } else {
    aiStripEl.innerHTML = "";
    aiStripEl.classList.add("hidden");
  }

  // ========== DIGITAL TRANSCRIPT (for chat/email/SMS) ==========
  if (isDigital) {
    let digitalTranscriptEl = document.getElementById("journey-digital-transcript");
    if (!digitalTranscriptEl) {
      digitalTranscriptEl = document.createElement("div");
      digitalTranscriptEl.id = "journey-digital-transcript";
      digitalTranscriptEl.className = "mb-4";
      recordingsWrapper.appendChild(digitalTranscriptEl);
    }
    
    const digitalId = `digital-transcript-${Math.random().toString(36).substr(2, 9)}`;
    digitalTranscriptEl.innerHTML = `
      <div class="digital-transcript-section">
        <button class="customer-context-toggle btn-secondary w-full text-left flex items-center justify-between" data-expanded="false" data-target="${digitalId}">
          <span class="flex items-center gap-2">
            ${mdsIcon("chat-regular", { size: 16, className: "icon-success" })}
            <span class="font-medium">Digital Transcript</span>
            <span class="text-xs text-ink-muted">${channelType.charAt(0).toUpperCase() + channelType.slice(1)} conversation</span>
          </span>
          <span class="digital-transcript-chevron">${mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" })}</span>
        </button>
        <div id="${digitalId}" class="digital-transcript-content hidden mt-3">
          <div class="digital-transcript-loading text-sm text-ink-muted p-3">Loading digital transcript...</div>
        </div>
      </div>`;
    digitalTranscriptEl.classList.remove("hidden");
    
    // Attach toggle handler
    const toggleBtn = digitalTranscriptEl.querySelector(".customer-context-toggle");
    toggleBtn.addEventListener("click", async () => {
      const targetId = toggleBtn.dataset.target;
      const content = document.getElementById(targetId);
      const chevron = toggleBtn.querySelector(".digital-transcript-chevron");
      const isExpanded = toggleBtn.dataset.expanded === "true";
      
      if (isExpanded) {
        // Collapse
        content.classList.add("hidden");
        chevron.innerHTML = mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" });
        toggleBtn.dataset.expanded = "false";
      } else {
        // Expand and lazy-load
        toggleBtn.dataset.expanded = "true";
        chevron.innerHTML = mdsIcon("arrow-up-regular", { size: 16, className: "icon-muted" });
        content.classList.remove("hidden");
        
        // Only fetch if not already loaded
        if (content.querySelector(".digital-transcript-loading")) {
          // Refresh captures to get fresh presigned URLs
          const freshCaptures = await fetchCaptures(task.id);
          const html = await renderDigitalTranscript(freshCaptures, task);
          content.innerHTML = html;
        }
      }
    });
  }

  // ========== VOICE-ONLY SECTIONS (hidden for digital channels) ==========
  if (!isDigital) {
    // Virtual Agent Transcript (gRPC-based, via sidecar)
    // Always render - fetch attempts regardless of global variables
    // This goes FIRST in recordings panel
    let vaTranscriptGrpcEl = document.getElementById("journey-va-transcript-grpc");
    if (!vaTranscriptGrpcEl) {
      vaTranscriptGrpcEl = document.createElement("div");
      vaTranscriptGrpcEl.id = "journey-va-transcript-grpc";
      vaTranscriptGrpcEl.className = "mb-4";
      recordingsWrapper.appendChild(vaTranscriptGrpcEl);
    }
    
    // Render collapsible VA transcript section
    const uniqueId = `va-transcript-grpc-${Math.random().toString(36).substr(2, 9)}`;
    vaTranscriptGrpcEl.innerHTML = `
    <div class="va-transcript-grpc-section">
      <button class="customer-context-toggle btn-secondary w-full text-left flex items-center justify-between" data-expanded="false" data-target="${uniqueId}">
        <span class="flex items-center gap-2">
          ${mdsIcon("chat-regular", { size: 16, className: "icon-info" })}
          <span class="font-medium">Virtual Agent Transcript</span>
          <span class="text-xs text-ink-muted">Full conversation history</span>
        </span>
        <span class="va-transcript-chevron">${mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" })}</span>
      </button>
      <div id="${uniqueId}" class="va-transcript-grpc-content hidden mt-3">
        <div class="va-transcript-loading text-sm text-ink-muted p-3">Loading VA transcript...</div>
      </div>
    </div>`;
  vaTranscriptGrpcEl.classList.remove("hidden");
  
  // Attach toggle handler
  const toggleBtn = vaTranscriptGrpcEl.querySelector(".customer-context-toggle");
  toggleBtn.addEventListener("click", async () => {
    const targetId = toggleBtn.dataset.target;
    const content = document.getElementById(targetId);
    const chevron = toggleBtn.querySelector(".va-transcript-chevron");
    const isExpanded = toggleBtn.dataset.expanded === "true";
    
    if (isExpanded) {
      // Collapse
      content.classList.add("hidden");
      chevron.innerHTML = mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" });
      toggleBtn.dataset.expanded = "false";
    } else {
      // Expand and lazy-load
      toggleBtn.dataset.expanded = "true";
      chevron.innerHTML = mdsIcon("arrow-up-regular", { size: 16, className: "icon-muted" });
      content.classList.remove("hidden");
      
      // Only fetch if not already loaded
      if (content.querySelector(".va-transcript-loading")) {
        try {
          const transcript = await fetchVATranscript(taskId);
          
          if (transcript === null) {
            // Sidecar unreachable
            content.innerHTML = `
              <div class="p-3 bg-surface-subtle border border-outline rounded text-sm">
                <div class="text-ink-muted mb-2">VA transcript sidecar is not running.</div>
                <div class="text-xs text-ink-muted">Start the sidecar to see virtual agent transcripts:</div>
                <div class="mt-2 p-2 bg-surface rounded border border-outline font-mono text-xs">
                  cd ${escapeHtml(window.location.pathname.replace(/\/[^/]*$/, ""))}/../sidecar && ./start.sh
                </div>
                <div class="text-xs text-ink-muted mt-2">Or run <code class="bg-surface px-1 rounded">./start.sh</code> from project root to start all services.</div>
              </div>`;
          } else if (!transcript || transcript.length === 0) {
            // Empty result
            content.innerHTML = `
              <div class="p-3 bg-surface-subtle border border-outline rounded text-sm text-ink-muted">
                No virtual agent transcript available for this interaction.
              </div>`;
          } else {
            // Render chat-style transcript
            content.innerHTML = renderVATranscriptChat(transcript);
          }
        } catch (err) {
          console.error("Failed to load VA transcript:", err);
          content.innerHTML = `
            <div class="p-3 bg-surface-subtle border border-danger rounded text-sm text-danger">
              Failed to load VA transcript: ${escapeHtml(err.message)}
            </div>`;
        }
      }
    }
  });

  // ========== VOICE TRANSCRIPT (second in recordings panel) ==========
  let voiceTranscriptEl = document.getElementById("journey-voice-transcript");
  if (!voiceTranscriptEl) {
    voiceTranscriptEl = document.createElement("div");
    voiceTranscriptEl.id = "journey-voice-transcript";
    voiceTranscriptEl.className = "mb-4";
    vaTranscriptGrpcEl.after(voiceTranscriptEl);
  }
  
  // Find voice transcript capture
  const transcriptCapture = captures?.find(c => 
    c.captureType === "TRANSCRIPTION" || 
    c.captureType === "TEXT" ||
    (c.fileName && c.fileName.toLowerCase().includes("transcript"))
  );
  
  if (transcriptCapture && transcriptCapture.filePath) {
    const uniqueId = `voice-transcript-${Math.random().toString(36).substr(2, 9)}`;
    voiceTranscriptEl.innerHTML = `
      <div class="voice-transcript-section">
        <button class="customer-context-toggle btn-secondary w-full text-left flex items-center justify-between" data-expanded="false" data-target="${uniqueId}">
          <span class="flex items-center gap-2">
            ${mdsIcon("chat-regular", { size: 16, className: "icon-info" })}
            <span class="font-medium">Voice Transcript</span>
            <span class="text-xs text-ink-muted">Human-agent conversation</span>
          </span>
          <span class="voice-transcript-chevron">${mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" })}</span>
        </button>
        <div id="${uniqueId}" class="voice-transcript-content hidden mt-3">
          <div class="voice-transcript-loading text-sm text-ink-muted p-3">Loading voice transcript...</div>
        </div>
      </div>`;
    voiceTranscriptEl.classList.remove("hidden");
    
    // Attach toggle handler
    const toggleBtn = voiceTranscriptEl.querySelector(".customer-context-toggle");
    toggleBtn.addEventListener("click", async () => {
      const targetId = toggleBtn.dataset.target;
      const content = document.getElementById(targetId);
      const chevron = toggleBtn.querySelector(".voice-transcript-chevron");
      const isExpanded = toggleBtn.dataset.expanded === "true";
      
      if (isExpanded) {
        // Collapse
        content.classList.add("hidden");
        chevron.innerHTML = mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" });
        toggleBtn.dataset.expanded = "false";
      } else {
        // Expand and lazy-load
        toggleBtn.dataset.expanded = "true";
        chevron.innerHTML = mdsIcon("arrow-up-regular", { size: 16, className: "icon-muted" });
        content.classList.remove("hidden");
        
        // Only fetch if not already loaded
        if (content.querySelector(".voice-transcript-loading")) {
          try {
            // Refresh captures to get a fresh presigned URL (expires after 1h)
            const freshCaptures = await fetchCaptures(task.id);
            const freshTranscript = freshCaptures?.find(c => 
              c.captureType === "TRANSCRIPTION" || 
              (c.fileName && c.fileName.toLowerCase().includes("transcript"))
            );
            
            if (!freshTranscript || !freshTranscript.filePath) {
              throw new Error("Transcript not available");
            }
            
            // Route through Caddy /s3/ proxy
            const fetchUrl = freshTranscript.filePath.replace(/^https:\/\/cjp-ccone-produs1-media-storage-recording\.s3\.amazonaws\.com/, "/journey/s3");
            const response = await fetch(fetchUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            
            const transcript = parseTranscript(data);
            if (!transcript || transcript.length === 0) {
              throw new Error("No transcript entries found");
            }
            
            // Render in VA transcript style (chat bubbles)
            content.innerHTML = renderVoiceTranscriptChat(transcript);
          } catch (err) {
            console.warn("Failed to load voice transcript:", err);
            content.innerHTML = `
              <div class="p-3 bg-surface-subtle border border-danger rounded text-sm text-danger">
                Failed to load voice transcript: ${escapeHtml(err.message)}
              </div>`;
          }
        }
      }
    });
  } else {
    voiceTranscriptEl.innerHTML = "";
    voiceTranscriptEl.classList.add("hidden");
  }

  // ========== VA WRAP-UP SUMMARY (third in recordings panel) ==========
  let vaSummaryEl = document.getElementById("journey-va-summary");
  if (!vaSummaryEl) {
    vaSummaryEl = document.createElement("div");
    vaSummaryEl.id = "journey-va-summary";
    vaSummaryEl.className = "mb-4";
    voiceTranscriptEl.after(vaSummaryEl);
  }
  
  // Render collapsible VA summary section - always attempt fetch
  const summaryId = `va-summary-${Math.random().toString(36).substr(2, 9)}`;
  vaSummaryEl.innerHTML = `
    <div class="va-summary-section">
      <button class="customer-context-toggle btn-secondary w-full text-left flex items-center justify-between" data-expanded="false" data-target="${summaryId}">
        <span class="flex items-center gap-2">
          ${mdsIcon("document-regular", { size: 16, className: "icon-info" })}
          <span class="font-medium">Wrap-up Summary</span>
          <span class="text-xs text-ink-muted">AI-generated call summary</span>
        </span>
        <span class="va-summary-chevron">${mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" })}</span>
      </button>
      <div id="${summaryId}" class="va-summary-content hidden mt-3">
        <div class="va-summary-loading text-sm text-ink-muted p-3">Loading wrap-up summary...</div>
      </div>
    </div>`;
  vaSummaryEl.classList.remove("hidden");
  
  // Attach toggle handler
  const toggleBtnSummary = vaSummaryEl.querySelector(".customer-context-toggle");
  toggleBtnSummary.addEventListener("click", async () => {
    const targetId = toggleBtnSummary.dataset.target;
    const content = document.getElementById(targetId);
    const chevron = toggleBtnSummary.querySelector(".va-summary-chevron");
    const isExpanded = toggleBtnSummary.dataset.expanded === "true";
    
    if (isExpanded) {
      // Collapse
      content.classList.add("hidden");
      chevron.innerHTML = mdsIcon("arrow-down-regular", { size: 16, className: "icon-muted" });
      toggleBtnSummary.dataset.expanded = "false";
    } else {
      // Expand and lazy-load
      toggleBtnSummary.dataset.expanded = "true";
      chevron.innerHTML = mdsIcon("arrow-up-regular", { size: 16, className: "icon-muted" });
      content.classList.remove("hidden");
      
      // Only fetch if not already loaded
      if (content.querySelector(".va-summary-loading")) {
        try {
          const result = await fetchVASummary(taskId);
          
          if (result === null) {
            // Sidecar unreachable
            content.innerHTML = `
              <div class="p-3 bg-surface-subtle border border-outline rounded text-sm">
                <div class="text-ink-muted mb-2">VA summary sidecar is not running.</div>
                <div class="text-xs text-ink-muted">Start the sidecar to see wrap-up summaries:</div>
                <div class="mt-2 p-2 bg-surface rounded border border-outline font-mono text-xs">
                  cd ${escapeHtml(window.location.pathname.replace(/\/[^/]*$/, ""))}/../sidecar && ./start.sh
                </div>
                <div class="text-xs text-ink-muted mt-2">Or run <code class="bg-surface px-1 rounded">./start.sh</code> from project root to start all services.</div>
              </div>`;
          } else if (result.error) {
            // Error
            content.innerHTML = `
              <div class="p-3 bg-surface-subtle border border-danger rounded text-sm text-danger">
                Failed to load wrap-up summary: ${escapeHtml(result.error)}
              </div>`;
          } else if (!result.summary) {
            // No summary available
            content.innerHTML = `
              <div class="p-3 bg-surface-subtle border border-outline rounded text-sm text-ink-muted">
                No wrap-up summary available for this interaction.
              </div>`;
          } else {
            // Render summary
            content.innerHTML = renderVASummary(result.summary, result.callInsightType);
          }
        } catch (err) {
          console.error("Failed to load VA summary:", err);
          content.innerHTML = `
            <div class="p-3 bg-surface-subtle border border-danger rounded text-sm text-danger">
              Failed to load wrap-up summary: ${escapeHtml(err.message)}
            </div>`;
        }
      }
    }
  });

  // ========== CALL RECORDINGS (last in recordings panel) ==========
  let recordingsEl = document.getElementById("journey-recordings");
  if (!recordingsEl) {
    recordingsEl = document.createElement("div");
    recordingsEl.id = "journey-recordings";
    recordingsEl.className = "mb-4";
    vaSummaryEl.after(recordingsEl);
  }
  
  // Find audio recordings
  const audioCaptures = captures?.filter(c => {
    const isRecording = c.captureType === "RECORDING";
    const mediaType = (c.mediaType || "").toLowerCase();
    const fileName = (c.fileName || "").toLowerCase();
    const isAudio = isRecording || mediaType.includes("audio") || /\.(wav|mp3|ogg|m4a)$/i.test(fileName);
    return isAudio && c.filePath;
  }) || [];
  
  if (audioCaptures.length > 0) {
    const recordingBoxes = audioCaptures.map(c => {
      const fileName = c.fileName || "";
      const size = c.fileSize ? ` (${(c.fileSize / 1024 / 1024).toFixed(1)} MB)` : "";
      const href = c.filePath;
      const filename = fileName || `recording-${task.id}.wav`;
      
      return `
        <div class="recording-box p-4 bg-surface border border-outline rounded-md">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-2">
              ${mdsIcon("microphone-on-regular", { size: 16, className: "icon-accent" })}
              <span class="font-medium">Call Recording</span>
              ${size ? `<span class="text-xs text-ink-muted">${size}</span>` : ""}
            </div>
            <div class="flex-1 flex justify-end">
              <audio controls preload="none" src="${escapeHtml(href)}" class="max-w-md" style="height: 32px;"></audio>
            </div>
          </div>
        </div>`;
    }).join("");
    
    recordingsEl.innerHTML = recordingBoxes;
    recordingsEl.classList.remove("hidden");
  } else {
    recordingsEl.innerHTML = "";
    recordingsEl.classList.add("hidden");
  }
  } // End voice-only sections

  // Desktop / global variables
  const vars = normalizeGlobalVars(task.globalVariables);
  let varsEl = document.getElementById("journey-vars");
  if (!varsEl) {
    varsEl = document.createElement("div");
    varsEl.id = "journey-vars";
    varsEl.className = "mb-4 text-sm";
    aiStripEl.after(varsEl);
  }
  varsEl.innerHTML = vars.length ? `
    <div class="journey-group-label">Desktop / global variables</div>
    <table class="journey-vars-table">
      <tbody>${vars.map(([k,v]) => `<tr><td class="journey-vars-key px-2 py-1 font-mono">${escapeHtml(k)}</td><td class="px-2 py-1 font-mono">${linkifyValue(v)}</td></tr>`).join("")}</tbody>
    </table>` : "";

  // Close button handler
  $("close-journey").onclick = () => {
    $("customer-panel").classList.add("hidden");
    $("recordings-panel").classList.add("hidden");
    $("journey-panel").classList.add("hidden");
  };
  
  // Return task for timeline rendering
  return task;
}

function kv(k, v) {
  return `<div class="summary-card"><div class="summary-key">${k}</div><div class="summary-value">${v || "—"}</div></div>`;
}

function kvWithTitle(k, v, title) {
  return `<div class="summary-card" title="${escapeHtml(title)}"><div class="summary-key">${k}</div><div class="summary-value">${v || "—"}</div></div>`;
}


function normalizeGlobalVars(gv) {
  // gv is JSON: array of {name, strVal|intVal|boolVal|...} or object map
  if (!gv) return [];
  const out = [];
  if (Array.isArray(gv)) {
    for (const v of gv) {
      if (!v?.name) continue;
      const val = v.strVal ?? v.intVal ?? v.longVal ?? v.boolVal ?? v.doubleVal ?? v.value;
      if (val === undefined || val === null || val === "") continue;
      out.push([v.name, String(val)]);
    }
  } else if (typeof gv === "object") {
    for (const [k, v] of Object.entries(gv)) {
      if (v === null || v === "" || v === undefined) continue;
      out.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    }
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function parseTranscript(data) {
  // WxCC voice transcript JSON shape:
  // {
  //   interactionId, languageCode,
  //   responseContents: [
  //     { recognitionResult: { role: "AGENT"|"CALLER", language_code,
  //         alternatives: [{ transcript, confidence,
  //           words: [{ word, start_time:{seconds,nanos}, end_time:{...} }, ...]
  //         }]
  //     }}, ...
  //   ]
  // }
  // Each responseContents entry is one speaker turn. Interleave by first-word timestamp.
  // Also tolerate older shapes (top-level array, {transcript:[]}, etc.) as fallback.

  const turns = [];

  // Shape 1: WxCC voice transcript
  if (data && Array.isArray(data.responseContents)) {
    for (const rc of data.responseContents) {
      const rec = rc?.recognitionResult;
      if (!rec) continue;
      const alt = (rec.alternatives || [])[0];
      if (!alt) continue;
      const text = (alt.transcript || "").trim();
      if (!text) continue;
      const role = rec.role || rec.speaker || "Unknown";
      const words = alt.words || [];
      const firstWord = words[0];
      const startSec = firstWord
        ? (firstWord.start_time?.seconds || 0) + (firstWord.start_time?.nanos || 0) / 1e9
        : 0;
      turns.push({ speaker: role, text, time: startSec * 1000 });
    }
    turns.sort((a, b) => a.time - b.time);
    return turns;
  }

  // Shape 2: legacy / generic shapes
  let entries = [];
  if (Array.isArray(data)) {
    entries = data;
  } else if (data && typeof data === "object") {
    entries = data.transcript || data.entries || data.messages || data.turns || [];
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    console.warn("Unrecognized transcript shape:", data);
    return null;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const speaker = entry.speaker || entry.role || entry.participant || entry.from || "Unknown";
    const text = entry.text || entry.content || entry.message || entry.utterance || "";
    const time = entry.startTime || entry.timestamp || entry.time || 0;
    if (!String(text).trim()) continue;
    turns.push({ speaker, text: String(text).trim(), time });
  }
  return turns;
}

function humanizeEventType(type) {
  // Humanize CJDS event types
  const typeMap = {
    "task:new": "Call started",
    "task:ended": "Call ended",
    "task:parked": "Call parked",
    "task:connected": "Call connected",
    "task:queued": "Call queued",
    "task:wrapup": "Wrap-up started",
  };
  return typeMap[type] || type;
}

function renderCompactCustomerContext(profile, events, identity, task) {
  // NEW COMPACT VERSION per user spec:
  // 1. Profile header (one-line chip with avatar + name + profileId + phone/email pills)
  // 2. Last interaction (single most recent event before current task)
  // 3. Today's other contacts (grouped by taskId, same calendar day as current task)
  
  const parts = [];
  
  if (!profile) {
    parts.push(`<div class="text-xs text-ink-muted p-2">No customer profile found for ${escapeHtml(identity)}</div>`);
    return parts.join("");
  }
  
  // 1. Profile header chip
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Unknown";
  const initials = name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
  const primaryPhone = (profile.phone || [])[0] || "";
  const primaryEmail = (profile.email || [])[0] || "";
  const profileId = profile.id || "";
  
  parts.push(`
    <div class="customer-header-chip">
      <div class="customer-avatar">${escapeHtml(initials)}</div>
      <div class="customer-header-info">
        <div class="customer-name">${escapeHtml(name)}</div>
        <div class="customer-meta">
          ${profileId ? `<span class="customer-profile-id">${escapeHtml(profileId.slice(0, 12))}...</span>` : ''}
          ${primaryPhone ? `<span class="customer-pill">${mdsIcon("handset-regular", { size: 10, className: "icon-muted" })}${escapeHtml(primaryPhone)}</span>` : ''}
          ${primaryEmail ? `<span class="customer-pill">${mdsIcon("email-regular", { size: 10, className: "icon-muted" })}${escapeHtml(primaryEmail)}</span>` : ''}
        </div>
      </div>
    </div>`);
  
  // Filter events: exclude current task
  const otherEvents = (events || []).filter(e => e.data?.taskId !== task.id);
  
  if (otherEvents.length === 0) {
    parts.push(`<div class="text-xs text-ink-muted p-2 mt-2">No prior WxCC interactions on record.</div>`);
    return parts.join("");
  }
  
  // 2. Last interaction (most recent event before current task)
  const lastEvent = otherEvents[0]; // Already sorted desc by API
  if (lastEvent) {
    const channelIcon = getChannelIconForEvent(lastEvent);
    const eventType = humanizeEventType(lastEvent.type);
    const channelType = lastEvent.data?.channelType || "";
    const direction = lastEvent.data?.direction || "";
    const reason = lastEvent.data?.terminationReason || "";
    const queueName = lastEvent.data?.queueName || "";
    const relativeTime = lastEvent.eventTime ? formatRelativeTime(lastEvent.eventTime) : "";
    const lastTaskId = lastEvent.data?.taskId || "";
    
    const summary = [
      channelType,
      direction,
      eventType,
      reason ? `(${reason})` : ""
    ].filter(Boolean).join(" · ");
    
    parts.push(`
      <div class="customer-last-interaction">
        <div class="customer-last-label">Last interaction</div>
        <div class="customer-last-content">
          ${channelIcon}
          <div class="customer-last-summary">
            <div class="customer-last-text">${escapeHtml(summary)}</div>
            ${queueName ? `<div class="customer-last-queue">Queue: ${escapeHtml(queueName)}</div>` : ''}
          </div>
          <div class="customer-last-time">${escapeHtml(relativeTime)}</div>
        </div>
        ${lastTaskId ? `<button class="customer-load-task" data-task-id="${escapeHtml(lastTaskId)}">Load task ${escapeHtml(lastTaskId.slice(0, 8))}...</button>` : ''}
      </div>`);
  }
  
  // 3. Today's other contacts (same calendar day as current task)
  const currentTaskDate = new Date(task.createdTime);
  const currentDay = currentTaskDate.toLocaleDateString(); // Local date string
  
  // Filter events from today (same calendar day)
  const todayEvents = otherEvents.filter(e => {
    if (!e.eventTime) return false;
    const eventDate = new Date(e.eventTime);
    return eventDate.toLocaleDateString() === currentDay;
  });
  
  if (todayEvents.length > 0) {
    // Group by taskId
    const taskGroups = new Map();
    for (const event of todayEvents) {
      const tid = event.data?.taskId;
      if (!tid) continue;
      if (!taskGroups.has(tid)) {
        taskGroups.set(tid, []);
      }
      taskGroups.get(tid).push(event);
    }
    
    parts.push(`
      <div class="customer-today-contacts">
        <div class="customer-today-label">Earlier today (${taskGroups.size} contact${taskGroups.size > 1 ? 's' : ''})</div>
        <div class="customer-today-list">`);
    
    for (const [tid, eventsForTask] of taskGroups) {
      // Sort events by time
      eventsForTask.sort((a, b) => (a.eventTime || 0) - (b.eventTime || 0));
      
      const firstEvent = eventsForTask[0];
      const lastEvent = eventsForTask[eventsForTask.length - 1];
      
      const channelIcon = getChannelIconForEvent(firstEvent);
      const startTime = firstEvent.eventTime ? new Date(firstEvent.eventTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "";
      const outcome = humanizeEventType(lastEvent.type);
      const reason = lastEvent.data?.terminationReason || "";
      const outcomeText = reason ? `${outcome} — ${reason}` : outcome;
      
      parts.push(`
        <div class="customer-today-row">
          ${channelIcon}
          <div class="customer-today-time">${escapeHtml(startTime)}</div>
          <div class="customer-today-outcome">${escapeHtml(outcomeText)}</div>
          <button class="customer-load-task" data-task-id="${escapeHtml(tid)}">Load</button>
        </div>`);
    }
    
    parts.push(`</div></div>`);
  }
  
  // Attach click handlers for task loading
  setTimeout(() => {
    document.querySelectorAll(".customer-load-task").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const taskId = e.currentTarget.dataset.taskId;
        if (taskId) {
          await renderJourney(taskId);
        }
      });
    });
  }, 0);
  
  return parts.join("");
}

function getChannelIconForEvent(event) {
  const channelType = event.data?.channelType?.toLowerCase() || "";
  if (channelType.includes("telephony") || channelType.includes("voice")) {
    return mdsIcon("handset-regular", { size: 14, className: "icon-info" });
  } else if (channelType.includes("chat")) {
    return mdsIcon("chat-regular", { size: 14, className: "icon-info" });
  } else if (channelType.includes("email")) {
    return mdsIcon("email-regular", { size: 14, className: "icon-info" });
  }
  return mdsIcon("info-circle-regular", { size: 14, className: "icon-muted" });
}

function formatRelativeTime(epochMs) {
  const now = Date.now();
  const diff = now - epochMs;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function renderVATranscriptChat(transcript) {
  // Render VA transcript in chat-style bubbles
  // transcript is array of {ts, role, insightType, text, languageCode, utteranceId, isFinal, raw}
  
  if (!transcript || transcript.length === 0) {
    return `<div class="text-xs text-ink-muted p-3">No transcript entries</div>`;
  }
  
  const bubbles = transcript.map((entry, idx) => {
    const role = entry.role || "UNKNOWN";
    const text = entry.text || "";
    const languageCode = entry.languageCode || "";
    const insightType = entry.insightType || "";
    
    // Determine bubble alignment and styling based on role
    let alignClass = "justify-start"; // Default left
    let bubbleClass = "bg-surface-subtle text-ink"; // Default neutral
    let roleLabel = role;
    let roleIcon = "user-regular";
    
    if (role === "VA" || insightType === "VIRTUAL_AGENT") {
      alignClass = "justify-start";
      bubbleClass = "bg-info-subtle text-ink";
      roleLabel = "Virtual Agent";
      roleIcon = "bot-regular";
    } else if (role === "CALLER") {
      alignClass = "justify-end";
      bubbleClass = "bg-success-subtle text-ink";
      roleLabel = "Caller";
      roleIcon = "user-regular";
    } else if (role === "AGENT") {
      alignClass = "justify-start";
      bubbleClass = "bg-accent-subtle text-ink";
      roleLabel = "Agent";
      roleIcon = "user-regular";
    } else if (role === "IVR") {
      alignClass = "justify-start";
      bubbleClass = "bg-surface-subtle text-ink-muted";
      roleLabel = "IVR";
      roleIcon = "phone-regular";
    }
    
    // Format timestamp
    const timestamp = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "";
    
    // Language badge (only if non-default)
    const langBadge = languageCode && languageCode !== "en-US" 
      ? `<span class="badge badge-neutral text-xs ml-2">${escapeHtml(languageCode)}</span>` 
      : "";
    
    return `
      <div class="flex ${alignClass} mb-3">
        <div class="max-w-[75%]">
          <div class="flex items-center gap-2 mb-1 text-xs text-ink-muted">
            ${mdsIcon(roleIcon, { size: 12, className: "icon-muted" })}
            <span class="font-semibold">${escapeHtml(roleLabel)}</span>
            ${langBadge}
            ${timestamp ? `<span class="text-xs">${escapeHtml(timestamp)}</span>` : ""}
          </div>
          <div class="${bubbleClass} rounded-lg px-3 py-2 text-sm">
            ${escapeHtml(text)}
          </div>
        </div>
      </div>`;
  }).join("");
  
  return `
    <div class="va-transcript-chat max-h-96 overflow-y-auto bg-surface rounded-md p-3 border border-outline">
      ${bubbles}
    </div>`;
}

function renderVoiceTranscriptChat(transcript) {
  // Render voice transcript in chat-style bubbles (matching VA transcript style)
  // transcript is array of {speaker, text, time}
  
  if (!transcript || transcript.length === 0) {
    return `<div class="text-xs text-ink-muted p-3">No transcript entries</div>`;
  }
  
  const bubbles = transcript.map((entry, idx) => {
    const speaker = entry.speaker || "UNKNOWN";
    const text = entry.text || "";
    const time = entry.time || 0;
    
    // Determine bubble alignment and styling based on speaker
    let alignClass = "justify-start"; // Default left
    let bubbleClass = "bg-surface-subtle text-ink"; // Default neutral
    let roleLabel = speaker;
    let roleIcon = "user-regular";
    
    const speakerLower = speaker.toLowerCase();
    if (speakerLower.includes("agent") || speakerLower.includes("representative")) {
      alignClass = "justify-start";
      bubbleClass = "bg-accent-subtle text-ink";
      roleLabel = "Agent";
      roleIcon = "user-regular";
    } else if (speakerLower.includes("customer") || speakerLower.includes("caller") || speakerLower.includes("user")) {
      alignClass = "justify-end";
      bubbleClass = "bg-success-subtle text-ink";
      roleLabel = "Customer";
      roleIcon = "user-regular";
    } else if (speakerLower.includes("system") || speakerLower.includes("bot") || speakerLower.includes("ivr")) {
      alignClass = "justify-start";
      bubbleClass = "bg-surface-subtle text-ink-muted";
      roleLabel = "IVR";
      roleIcon = "phone-regular";
    }
    
    // Format timestamp (relative from start)
    const t0 = transcript[0].time || 0;
    const elapsed = time - t0;
    const mm = Math.floor(elapsed / 60000);
    const ss = Math.floor((elapsed % 60000) / 1000);
    const timestamp = time ? `${mm}:${ss.toString().padStart(2, "0")}` : "";
    
    return `
      <div class="flex ${alignClass} mb-3">
        <div class="max-w-[75%]">
          <div class="flex items-center gap-2 mb-1 text-xs text-ink-muted">
            ${mdsIcon(roleIcon, { size: 12, className: "icon-muted" })}
            <span class="font-semibold">${escapeHtml(roleLabel)}</span>
            ${timestamp ? `<span class="text-xs">${escapeHtml(timestamp)}</span>` : ""}
          </div>
          <div class="${bubbleClass} rounded-lg px-3 py-2 text-sm">
            ${escapeHtml(text)}
          </div>
        </div>
      </div>`;
  }).join("");
  
  return `
    <div class="va-transcript-chat max-h-96 overflow-y-auto bg-surface rounded-md p-3 border border-outline">
      ${bubbles}
    </div>`;
}

function renderVASummary(summary, callInsightType) {
  // Render VA wrap-up summary as a structured card
  // summary is a JSON object with fields like initialContactReason, resolution, etc.
  
  if (!summary || typeof summary !== "object") {
    return `<div class="text-xs text-ink-muted p-3">Invalid summary data</div>`;
  }
  
  const parts = [];
  
  // Initial Contact Reason (primary field)
  if (summary.initialContactReason) {
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Initial Contact Reason</div>
        <div class="va-summary-value-primary">${escapeHtml(summary.initialContactReason)}</div>
      </div>`);
  }
  
  // Reason for Transfer/Consult
  if (summary.reasonForTransferOrConsult) {
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Reason for Transfer/Consult</div>
        <div class="va-summary-value">${escapeHtml(summary.reasonForTransferOrConsult)}</div>
      </div>`);
  }
  
  // Additional Context
  if (summary.additionalContext) {
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Additional Context</div>
        <div class="va-summary-value">${escapeHtml(summary.additionalContext)}</div>
      </div>`);
  }
  
  // Resolution (as pill/badge)
  if (summary.resolution) {
    const resolutionText = summary.resolution === "RESOLUTION_UNSPECIFIED" 
      ? "Unspecified" 
      : summary.resolution.replace(/_/g, " ");
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Resolution</div>
        <div class="va-summary-value">
          <span class="badge badge-neutral">${escapeHtml(resolutionText)}</span>
        </div>
      </div>`);
  }
  
  // Additional Contact Reasons (bullet list)
  if (summary.additionalContactReasons && Array.isArray(summary.additionalContactReasons) && summary.additionalContactReasons.length > 0) {
    const items = summary.additionalContactReasons.map(r => `<li>${escapeHtml(r)}</li>`).join("");
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Additional Contact Reasons</div>
        <ul class="va-summary-list">${items}</ul>
      </div>`);
  }
  
  // Next Steps (checkbox-style list)
  if (summary.nextSteps && Array.isArray(summary.nextSteps) && summary.nextSteps.length > 0) {
    const items = summary.nextSteps.map(step => `
      <li class="va-summary-step">
        ${mdsIcon("checkbox-regular", { size: 14, className: "icon-muted" })}
        <span>${escapeHtml(step)}</span>
      </li>`).join("");
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Next Steps</div>
        <ul class="va-summary-steps">${items}</ul>
      </div>`);
  }
  
  // Key Actions Taken (bullet list)
  if (summary.keyActionsTaken && Array.isArray(summary.keyActionsTaken) && summary.keyActionsTaken.length > 0) {
    const items = summary.keyActionsTaken.map(action => `<li>${escapeHtml(action)}</li>`).join("");
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Key Actions Taken</div>
        <ul class="va-summary-list">${items}</ul>
      </div>`);
  }
  
  // Suggested Wrap-up Codes (pills)
  if (summary.suggestedWrapUpCodes && Array.isArray(summary.suggestedWrapUpCodes) && summary.suggestedWrapUpCodes.length > 0) {
    const pills = summary.suggestedWrapUpCodes.map(code => 
      `<span class="badge badge-info">${escapeHtml(code)}</span>`
    ).join(" ");
    parts.push(`
      <div class="va-summary-field">
        <div class="va-summary-label">Suggested Wrap-up Codes</div>
        <div class="va-summary-pills">${pills}</div>
      </div>`);
  }
  
  // Footer with version info
  let footer = `<div class="va-summary-footer">Generated by Cisco VA`;
  if (summary.vahversion) {
    footer += ` · v${escapeHtml(summary.vahversion)}`;
  }
  footer += `</div>`;
  
  return `
    <div class="va-summary-card">
      ${parts.join("")}
      ${footer}
    </div>`;
}

async function renderDigitalTranscript(captures, task) {
  // Render digital channel transcript (chat/email/SMS)
  // Find the digital transcript capture
  const digitalCapture = captures?.find(c => 
    c.captureType === "TRANSCRIPTION" && 
    c.source && 
    ["chat", "email", "sms"].includes(c.source.toLowerCase())
  );
  
  if (!digitalCapture || !digitalCapture.filePath) {
    return `
      <div class="p-3 bg-surface-subtle border border-outline rounded text-sm text-ink-muted">
        No digital transcript available — task may still be active or transcript not captured.
      </div>`;
  }
  
  try {
    // Fetch the transcript JSON from presigned S3 URL
    // CRITICAL: Do NOT add Authorization header - it's a presigned URL
    const response = await fetch(digitalCapture.filePath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const messages = await response.json();
    
    if (!Array.isArray(messages) || messages.length === 0) {
      return `
        <div class="p-3 bg-surface-subtle border border-outline rounded text-sm text-ink-muted">
          No messages found in transcript.
        </div>`;
    }
    
    // Sort by timestamp ascending
    const sortedMessages = messages.slice().sort((a, b) => {
      const tsA = new Date(a.timestamp || 0).getTime();
      const tsB = new Date(b.timestamp || 0).getTime();
      return tsA - tsB;
    });
    
    // Render chat bubbles
    const bubbles = sortedMessages.map((msg, idx) => {
      const role = msg.participant?.role?.toLowerCase() || "unknown";
      const direction = msg.direction?.toLowerCase() || "";
      const name = msg.participant?.name || "Unknown";
      const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : "";
      
      // Strip HTML and preserve line breaks
      const rawMessage = msg.message || "";
      const cleanText = escapeHtml(rawMessage.replace(/<[^>]*>/g, '')).replace(/\n/g, "<br>");
      
      // System messages / announcements - centered divider
      if (role === "system" || direction === "announcement") {
        return `
          <div class="flex justify-center mb-3">
            <div class="text-xs italic text-ink-muted px-3 py-1 bg-surface-subtle rounded-full border border-outline">
              ${cleanText}
            </div>
          </div>`;
      }
      
      // Customer messages - left bubble (green)
      if (role === "customer") {
        return `
          <div class="flex justify-start mb-3">
            <div class="max-w-[75%]">
              <div class="flex items-center gap-2 mb-1 text-xs text-ink-muted">
                ${mdsIcon("user-regular", { size: 12, className: "icon-muted" })}
                <span class="font-semibold">${escapeHtml(name)}</span>
                ${timestamp ? `<span class="text-xs">${escapeHtml(timestamp)}</span>` : ""}
              </div>
              <div class="bg-success-subtle rounded-lg px-3 py-2 text-sm">
                ${cleanText}
              </div>
            </div>
          </div>`;
      }
      
      // Agent messages - right bubble (blue)
      if (role === "agent") {
        return `
          <div class="flex justify-end mb-3">
            <div class="max-w-[75%]">
              <div class="flex items-center gap-2 mb-1 text-xs text-ink-muted justify-end">
                ${timestamp ? `<span class="text-xs">${escapeHtml(timestamp)}</span>` : ""}
                <span class="font-semibold">${escapeHtml(name)}</span>
                ${mdsIcon("user-regular", { size: 12, className: "icon-muted" })}
              </div>
              <div class="bg-accent-subtle rounded-lg px-3 py-2 text-sm">
                ${cleanText}
              </div>
            </div>
          </div>`;
      }
      
      // Unknown role - neutral left bubble
      return `
        <div class="flex justify-start mb-3">
          <div class="max-w-[75%]">
            <div class="flex items-center gap-2 mb-1 text-xs text-ink-muted">
              ${mdsIcon("info-circle-regular", { size: 12, className: "icon-muted" })}
              <span class="font-semibold">${escapeHtml(name)}</span>
              ${timestamp ? `<span class="text-xs">${escapeHtml(timestamp)}</span>` : ""}
            </div>
            <div class="bg-surface-subtle rounded-lg px-3 py-2 text-sm text-ink-muted">
              ${cleanText}
            </div>
          </div>
        </div>`;
    }).join("");
    
    return `
      <div class="va-transcript-chat max-h-96 overflow-y-auto bg-surface rounded-md p-3 border border-outline">
        ${bubbles}
      </div>`;
  } catch (err) {
    console.warn("Failed to load digital transcript:", err);
    return `
      <div class="p-3 bg-surface-subtle border border-danger rounded text-sm text-danger">
        Failed to load digital transcript: ${escapeHtml(err.message)}
      </div>`;
  }
}

