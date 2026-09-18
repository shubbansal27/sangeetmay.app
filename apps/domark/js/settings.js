// Per-profile settings (source toggles, YouTube playlist selection), synced to Drive with a localStorage cache.

import { state } from './store.js';
import { SOURCES, STORAGE_KEYS } from './config.js';
import { profileKey } from './profiles.js';
import { loadSettingsFile, saveSettingsFile } from './drive.js';

let cache = null;

function defaults() {
  const sources = {};
  SOURCES.forEach((source) => {
    sources[source.id] = true;
  });
  return { version: 1, sources, youtube: { playlistIds: [] } };
}

function normalize(raw) {
  const base = defaults();
  if (raw && raw.sources && typeof raw.sources === 'object') {
    SOURCES.forEach((source) => {
      if (typeof raw.sources[source.id] === 'boolean') base.sources[source.id] = raw.sources[source.id];
    });
  }
  if (raw && raw.youtube && Array.isArray(raw.youtube.playlistIds)) {
    base.youtube.playlistIds = raw.youtube.playlistIds.filter((id) => typeof id === 'string');
  }
  return base;
}

function localKey() {
  return profileKey(STORAGE_KEYS.settings);
}

function persistLocal() {
  try {
    localStorage.setItem(localKey(), JSON.stringify(cache));
  } catch {
    /* ignore quota errors */
  }
}

export function getSettings() {
  if (cache) return cache;
  try {
    const local = JSON.parse(localStorage.getItem(localKey()) || 'null');
    if (local && local.version) cache = normalize(local);
  } catch {
    /* ignore corrupt cache */
  }
  if (!cache) cache = defaults();
  return cache;
}

// Fetch settings from Drive (falls back to the local cache/defaults offline).
export async function loadSettings() {
  getSettings();
  if (!state.token) return cache;
  try {
    const remote = await loadSettingsFile();
    if (remote) {
      cache = normalize(remote);
      persistLocal();
    }
  } catch {
    /* keep local cache */
  }
  return cache;
}

async function save(next) {
  cache = normalize(next);
  persistLocal();
  if (state.token) {
    try {
      await saveSettingsFile(cache);
    } catch {
      /* non-fatal; local cache retains the change */
    }
  }
  return cache;
}

export function resetSettingsCache() {
  cache = null;
}

export function isSourceEnabled(id) {
  return getSettings().sources[id] !== false;
}

export function enabledSourceIds() {
  return SOURCES.filter((source) => isSourceEnabled(source.id)).map((source) => source.id);
}

export function getYouTubePlaylistIds() {
  return getSettings().youtube.playlistIds.slice();
}

export async function setSourceEnabled(id, enabled) {
  const next = { ...getSettings(), sources: { ...getSettings().sources, [id]: !!enabled } };
  return save(next);
}

export async function setYouTubePlaylistIds(ids) {
  const next = { ...getSettings(), youtube: { playlistIds: Array.isArray(ids) ? ids : [] } };
  return save(next);
}
