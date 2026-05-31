// js/settings.js — read/write user settings from localStorage.

const KEY = "wxcc-explorer:settings";

const DEFAULTS = {
  region: "us1",
  orgId: "",
  token: "",
  workspaceId: "",
};

export function getSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(partial) {
  const next = { ...getSettings(), ...partial };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearSettings() {
  localStorage.removeItem(KEY);
}
