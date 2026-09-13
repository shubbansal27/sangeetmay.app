// Central application state and its persistence to localStorage.

import { STORAGE_KEYS } from './config.js';

export const state = {
  activeView: 'inbox',
  activeSource: 'google_tasks',
  activeDateFilter: 'all',
  profile: null,
  token: null,
  projects: [],
  selectedProjectId: null,
  selectedProjectCategory: null,
  selectedProjectStatus: 'all',
  selectedProjectTab: 'overview',
  selectedProjectArtifactId: null,
  editingOverview: false,
  projectsLoading: false,
  selectedItem: null,
  sources: {
    google_tasks: { items: [], status: 'idle', error: '', fetchedAt: null },
    youtube_review_later: { items: [], status: 'idle', error: '', fetchedAt: null },
  },
  isCreatingProject: false,
};

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function loadProjects() {
  const saved = readJson(STORAGE_KEYS.projects, []);
  return Array.isArray(saved) ? saved : [];
}

export function saveProjects() {
  localStorage.setItem(STORAGE_KEYS.projects, JSON.stringify(state.projects));
}

export function restoreProfile() {
  return readJson(STORAGE_KEYS.profile, null);
}

export function saveProfile(profile) {
  localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(profile));
}

export function clearProfile() {
  localStorage.removeItem(STORAGE_KEYS.profile);
}

export function currentProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) || null;
}

state.projects = loadProjects();
