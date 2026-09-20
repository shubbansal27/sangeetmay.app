// Project categories: fixed defaults plus user-added ones (synced to Drive via settings) and any used by existing projects.

import { PROJECT_CATEGORIES } from './config.js';
import { state } from './store.js';
import { escapeHtml } from './utils.js';
import { getCustomCategories, addCustomCategory as saveCustomCategory } from './settings.js';

export const ADD_CATEGORY_VALUE = '__add_category__';

export function sanitizeCategory(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
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
  getCustomCategories().forEach(add);
  state.projects.forEach((project) => add(project.category || 'Others'));
  return out;
}

// Persist a new category (to Drive-backed settings) if it isn't already known. Returns the sanitized name, or null if invalid.
export function addCustomCategory(name) {
  const clean = sanitizeCategory(name);
  if (!clean) return null;
  if (!allCategories().includes(clean)) {
    saveCustomCategory(clean).catch(() => {});
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
