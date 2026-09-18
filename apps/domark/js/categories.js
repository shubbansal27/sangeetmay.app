// Project categories: fixed defaults plus user-added ones (persisted per profile) and any used by existing projects.

import { PROJECT_CATEGORIES, STORAGE_KEYS } from './config.js';
import { profileKey } from './profiles.js';
import { state } from './store.js';
import { escapeHtml } from './utils.js';

export const ADD_CATEGORY_VALUE = '__add_category__';

export function sanitizeCategory(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function readCustom() {
  try {
    const arr = JSON.parse(localStorage.getItem(profileKey(STORAGE_KEYS.customCategories)) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeCustom(list) {
  try {
    localStorage.setItem(profileKey(STORAGE_KEYS.customCategories), JSON.stringify(list));
  } catch {
    /* ignore quota errors */
  }
}

// Defaults, then saved custom ones, then any category already on a project — deduped, order preserved.
export function allCategories() {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    const clean = sanitizeCategory(name);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  PROJECT_CATEGORIES.forEach(add);
  readCustom().forEach(add);
  state.projects.forEach((project) => add(project.category || 'Others'));
  return out;
}

// Persist a new category if it isn't already known. Returns the sanitized name, or null if invalid.
export function addCustomCategory(name) {
  const clean = sanitizeCategory(name);
  if (!clean) return null;
  if (!allCategories().includes(clean)) {
    const custom = readCustom();
    custom.push(clean);
    writeCustom(custom);
  }
  return clean;
}

// Option markup for a category <select>, with the "add new" entry appended.
export function categoryOptionsHtml(selected) {
  const options = allCategories()
    .map(
      (name) =>
        '<option value="' + escapeHtml(name) + '"' + (name === selected ? ' selected' : '') + '>' +
        escapeHtml(name) + '</option>'
    )
    .join('');
  return options + '<option value="' + ADD_CATEGORY_VALUE + '">+ Add new category…</option>';
}
