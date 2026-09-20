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
  return { version: 1, sources, youtube: { playlistIds: [] }, categories: [] };
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
  if (raw && Array.isArray(raw.categories)) {
    base.categories = raw.categories.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim());
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

// Drive is the source of truth: adopt remote settings, or reset to defaults when Drive has none.
export async function loadSettings() {
  getSettings();
  if (!state.token) return cache;
  try {
    const remote = await loadSettingsFile();
    cache = remote ? normalize(remote) : defaults();
    persistLocal();
  } catch {
    /* Drive unreachable (offline): keep the local cache */
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

export function getCustomCategories() {
  return getSettings().categories.slice();
}

export async function addCustomCategory(name) {
  const current = getSettings().categories;
  if (current.includes(name)) return cache;
  const next = { ...getSettings(), categories: [...current, name] };
  return save(next);
}
