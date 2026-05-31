// js/api.js — fetch wrapper for the Webex CC API (via the local Caddy proxy).

import { getSettings } from "./settings.js";
import { toast, sleep } from "./util.js";

// All requests go through the hub's Express proxy at /journey/api/.
// The proxy reads X-WxCC-Region and forwards to https://api.wxcc-{region}.cisco.com/...
const PROXY_BASE = "/journey/api";

class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
export { ApiError };

function authHeaders() {
  const { token, region } = getSettings();
  if (!token) throw new ApiError("Missing access token. Open Settings and paste a token.", { status: 0 });
  return {
    Authorization: `Bearer ${token}`,
    "X-WxCC-Region": region || "us1",
  };
}

/**
 * Low-level request with 429 retry-after handling.
 * @param {string} path  — path AFTER the /api/ prefix, e.g. "/v1/organization/abc/queues"
 * @param {object} init  — fetch init object
 */
export async function apiFetch(path, init = {}) {
  const url = PROXY_BASE + path;
  const headers = {
    Accept: "application/json",
    ...authHeaders(),
    ...(init.headers || {}),
  };
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  let attempt = 0;
  while (true) {
    attempt++;
    let res;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (e) {
      throw new ApiError(`Network error calling ${path}. Is Caddy running?  (${e.message})`, { status: 0 });
    }

    if (res.status === 429 && attempt <= 3) {
      const retry = parseInt(res.headers.get("Retry-After") || "1", 10);
      toast(`Rate-limited. Retrying in ${retry}s…`, "warn");
      await sleep(retry * 1000);
      continue;
    }

    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }

    if (!res.ok) {
      if (res.status === 401) {
        toast("Token expired or unauthorized. Refresh in Settings.", "error", 8000);
      } else if (res.status === 403) {
        toast("Forbidden. Check token scopes (cjp:config_read).", "error", 8000);
      }
      throw new ApiError(`HTTP ${res.status} on ${path}`, { status: res.status, body });
    }
    return body;
  }
}

/** GET helper. */
export const apiGet = (path) => apiFetch(path, { method: "GET" });

/** POST helper. */
export const apiPost = (path, body) => apiFetch(path, { method: "POST", body: JSON.stringify(body) });

/** Lookup endpoint paginator — returns full list across pages. */
export async function listAllConfig(resource) {
  const { orgId } = getSettings();
  if (!orgId) throw new ApiError("Missing Org ID. Open Settings.", { status: 0 });
  const out = [];
  const PAGE = 100;
  let page = 0;
  while (true) {
    const path = `/organization/${orgId}/${resource}?page=${page}&pageSize=${PAGE}`;
    const body = await apiGet(path);
    const items = body.data ?? body.items ?? body ?? [];
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < PAGE) break;
    page++;
    if (page > 200) break; // safety stop at 20k records
  }
  return out;
}

/** Search past interactions via GraphQL. */
export async function searchTaskDetails({ fromMs, toMs, field, value, matchMode = "equals", includeCar = true }) {
  const { orgId } = getSettings();
  if (!orgId) throw new ApiError("Missing Org ID. Open Settings.", { status: 0 });

  // Build filter based on field/value/matchMode
  let filter = null;
  if (field && value) {
    if (field === "origin") {
      filter = { origin: { [matchMode]: value } };
    } else if (field === "destination") {
      filter = { destination: { [matchMode]: value } };
  } else if (field === "customerEmail") {
    filter = { customer: { email: { [matchMode]: value } } };
  } else if (field === "agentName") {
    filter = { lastAgent: { name: { [matchMode]: value } } };
  }
  }

  const carFragment = includeCar ? `
    activities {
      totalCount
      nodes {
        id
        eventName
        activityName
        activityType
        createdTime
        endedTime
        duration
        previousState
        nextState
        agentId
        agentName
        queueId
        queueName
        entrypointId
        entrypointName
        siteId
        siteName
        teamId
        teamName
        ivrScriptId
        ivrScriptName
        ivrScriptTagName
        transferType
        destinationAgentId
        destinationAgentName
        destinationQueueId
        destinationQueueName
        consultEpName
        terminationReason
        actorId
        actorName
        actorRole
        chatType
        bnrMode
        skillsAssignedIn
      }
      pageInfo { hasNextPage endCursor }
    }` : "";

  const query = `
    query taskDetails($from: Long!, $to: Long!, $filter: TaskDetailsFilters, $cursor: String) {
      taskDetails(from: $from, to: $to, filter: $filter, pagination: { cursor: $cursor }) {
        tasks {
          id
          status
          channelType
          channelSubType
          direction
          origin
          destination
          createdTime
          endedTime
          totalDuration
          connectedDuration
          queueDuration
          wrapupDuration
          ringingDuration
          holdDuration
          queueCount
          transferCount
          conferenceCount
          holdCount
          terminationType
          terminationReason
          terminatingEnd
          abandonedType
          contactReason
          contactDriver
          topicName
          topicSource
          botName
          flowActivityName
          flowActivitySequence
          ivrScriptName
          firstQueueName
          lastEntryPoint { id name }
          lastQueue { id name duration }
          lastSite { id name }
          lastTeam { id name }
          lastAgent { id name }
          previousQueue { id name }
          lastWrapupCodeName
          customer { name phoneNumber email }
          csatScore
          autoCsat
          customerSentimentScore
          sentiment
          isTranscriptionAvailable
          vaTranscriptionAvailable
          isRealtimeTranscriptionEnabled
          recordingLocation
          recordingStereoBlobId
          postCallSummaryCount
          midCallSummaryCount
          globalVariables
          matchedSkills
          matchedSkillsProfile
          requiredSkills
          campaignName
          isCampaign
          isCallback
          isOutdial
          ${carFragment}
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

  const out = [];
  let cursor = null;
  while (true) {
    const variables = { from: fromMs, to: toMs };
    if (filter) variables.filter = filter;
    if (cursor) variables.cursor = cursor;

    const body = await apiPost(`/search?orgId=${orgId}`, {
      query,
      variables,
    });
    const conn = body?.data?.taskDetails;
    if (!conn || !conn.tasks) break;
    out.push(...conn.tasks);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (out.length > 5000) break; // UI safety cap
  }
  return out;
}

/** Fetch flow trace events for a task. */
export async function fetchFlowTrace(taskId, fromMs, toMs) {
  try {
    const { orgId } = getSettings();
    if (!orgId) return null;
    const query = `
      query($f:Long!,$t:Long!,$id:String!){
        flowTraceEvents(from:$f,to:$t,filter:{interactionId:{equals:$id}}){
          traces{
            activityName activityRegistrationId outcome
            activityInputs{name value isSecure}
            activityOutput{name type value isSecure}
            modifiedFlowVariables{name type value isSecure}
            flowStartTime flowEndTime nextTagName
          }
        }
      }`;
    const body = await apiPost(`/search?orgId=${orgId}`, {
      query,
      variables: { f: fromMs, t: toMs, id: taskId },
    });
    return body?.data?.flowTraceEvents?.traces || [];
  } catch (e) {
    console.warn("fetchFlowTrace failed:", e);
    return null;
  }
}

/** Fetch captures (recordings/transcriptions) for a task.
 *  API requires body wrapped in {"query": {...}}.
 *  Returns flattened array: [{taskId, captureType, fileName, filePath, ...}]
 */
export async function fetchCaptures(taskId) {
  try {
    const { orgId } = getSettings();
    if (!orgId) return null;
    const body = await apiPost("/v1/captures/query", {
      query: {
        taskIds: [taskId],
        orgId,
        urlExpiration: 3600,
      },
    });
    const out = [];
    for (const taskBlock of (body?.data || [])) {
      for (const r of (taskBlock.recording || [])) {
        const a = r.attributes || {};
        out.push({
          taskId: taskBlock.taskId,
          captureType: "RECORDING",
          mediaType: "AUDIO_WAV",
          fileName: a.fileName || r.fileName,
          filePath: a.filePath || r.filePath,
          startTime: a.startTime,
          stopTime: a.stopTime,
          participants: a.participants,
          channel1: a.channel1,
          channel2: a.channel2,
          callType: a.callType,
        });
      }
      for (const t of (taskBlock.transcription || [])) {
        out.push({
          taskId: taskBlock.taskId,
          captureType: "TRANSCRIPTION",
          mediaType: "TEXT",
          fileName: t.fileName,
          filePath: t.filePath,
          provider: t.provider,
          languageCode: t.languageCode,
          startTime: t.startTime,
          source: t.source,
          configId: t.configId,
          createTime: t.createTime,
        });
      }
    }
    return out;
  } catch (e) {
    console.warn("fetchCaptures failed:", e);
    return null;
  }
}

/** Health check the proxy. */
export async function pingProxy() {
  const r = await fetch("/journey/health");
  return r.ok;
}

/** Fetch person profile by alias (phone/email) from CJDS.
 *  Returns first matching profile or null.
 */
export async function fetchPersonByAlias(alias) {
  try {
    const { workspaceId } = getSettings();
    if (!workspaceId) return null;
    
    const encodedAlias = encodeURIComponent(alias);
    const path = `/admin/v1/api/person/workspace-id/${workspaceId}/aliases/${encodedAlias}`;
    const body = await apiGet(path);
    
    if (body?.data && Array.isArray(body.data) && body.data.length > 0) {
      return body.data[0];
    }
    return null;
  } catch (e) {
    console.warn("fetchPersonByAlias failed:", e);
    return null;
  }
}

/** Fetch events by identity (phone/email) from CJDS.
 *  Returns array of events sorted desc by time.
 */
export async function fetchEventsByIdentity(identity, { limit = 50 } = {}) {
  try {
    const { workspaceId } = getSettings();
    if (!workspaceId) return [];
    
    const encodedIdentity = encodeURIComponent(identity);
    const path = `/v1/api/events/workspace-id/${workspaceId}?identity=${encodedIdentity}&sort=desc`;
    const body = await apiGet(path);
    
    if (body?.data && Array.isArray(body.data)) {
      return body.data.slice(0, limit);
    }
    return [];
  } catch (e) {
    console.warn("fetchEventsByIdentity failed:", e);
    return [];
  }
}

/**
 * Fetch VA transcript via the Python gRPC sidecar.
 * @param {string} taskId - The conversation/task ID
 * @returns {Promise<Array|null>} - Array of normalized transcript entries, null if sidecar unreachable
 */
export async function fetchVATranscript(taskId) {
  try {
    const { orgId, token } = getSettings();
    if (!orgId || !token) {
      console.warn("fetchVATranscript: missing orgId or token");
      return [];
    }

    const url = "/journey/serving/va-transcript";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ taskId, orgId, token }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.warn(`fetchVATranscript HTTP ${response.status}:`, errorBody);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    // Network error likely means sidecar not running
    if (e.message?.includes("fetch") || e.message?.includes("NetworkError")) {
      console.warn("fetchVATranscript: sidecar unreachable (network error)");
      return null; // Signal sidecar unreachable
    }
    console.warn("fetchVATranscript failed:", e);
    return [];
  }
}

/**
 * Fetch VA call summary via the Python gRPC sidecar.
 * @param {string} taskId - The conversation/task ID
 * @returns {Promise<Object|null>} - Summary object {summary, callInsightType, raw}, null if sidecar unreachable, or {error} on failure
 */
export async function fetchVASummary(taskId) {
  try {
    const { orgId, token } = getSettings();
    if (!orgId || !token) {
      console.warn("fetchVASummary: missing orgId or token");
      return { summary: null, reason: "missing_credentials" };
    }

    const url = "/journey/serving/va-summary";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ taskId, orgId, token }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.warn(`fetchVASummary HTTP ${response.status}:`, errorBody);
      return errorBody.error ? { error: errorBody.error } : { summary: null, reason: "http_error" };
    }

    const data = await response.json();
    return data;
  } catch (e) {
    // Network error likely means sidecar not running
    if (e.message?.includes("fetch") || e.message?.includes("NetworkError")) {
      console.warn("fetchVASummary: sidecar unreachable (network error)");
      return null; // Signal sidecar unreachable
    }
    console.warn("fetchVASummary failed:", e);
    return { error: e.message };
  }
}
