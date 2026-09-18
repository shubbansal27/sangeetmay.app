// Profile management: isolates all app data under domark/<profile>/ in Drive.
// The default profile keeps writing to the domark root so existing data stays intact.

import { STORAGE_KEYS, DRIVE } from './config.js';

export const DEFAULT_PROFILE = DRIVE.defaultProfile;

export function getActiveProfile() {
  return localStorage.getItem(STORAGE_KEYS.activeProfile) || DEFAULT_PROFILE;
}

export function setActiveProfileLocal(name) {
  localStorage.setItem(STORAGE_KEYS.activeProfile, name);
}

// Default profile keeps the original keys so existing data stays intact; named profiles get a suffix.
export function profileKey(baseKey) {
  const name = getActiveProfile();
  return name === DEFAULT_PROFILE ? baseKey : baseKey + '::' + name;
}

// Keep 'default' first, drop blanks and duplicates, always include the active profile.
export function normalizeProfiles(list) {
  const seen = new Set([DEFAULT_PROFILE]);
  const out = [DEFAULT_PROFILE];
  [...list, getActiveProfile()].forEach((name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  });
  return out;
}

export function listProfilesLocal() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEYS.profiles) || 'null');
    if (Array.isArray(arr) && arr.length) return normalizeProfiles(arr);
  } catch {
    /* ignore corrupt cache */
  }
  return normalizeProfiles([]);
}

export function saveProfilesLocal(list) {
  localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify(normalizeProfiles(list)));
}

// A profile name becomes a Drive folder, so strip characters that are unsafe in folder names.
export function sanitizeProfileName(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 40);
}
