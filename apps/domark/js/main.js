// Application entry point: wires DOM events and boots the app.

import { state, saveProjects, loadProjects, restoreProfile, currentProject } from './store.js';
import { showToast, setLoginStatus, clearLoginStatus, showBusy, hideBusy, setBusyMessage } from './feedback.js';
import { byId, escapeHtml } from './utils.js';
import { signIn, signOut, trySilentSignIn } from './auth.js';
import { createArtifact, syncProjectArtifacts, saveProjectStatus, saveProjectDetails, createRecordingArtifact, createLinkArtifact, hydrateProjects, loadProjectMetadata, deleteProject, resetProfileCaches, loadProfilesList, saveProfilesList, deleteProfileFolder, resetProfileData } from './drive.js';
import { refreshAllSources, refreshActiveSource, ensureActiveSourceLoaded, fetchYouTubePlaylists, removeInboxItem } from './sources.js';
import { SOURCES, YOUTUBE_PLAYLIST_TITLE, STORAGE_KEYS } from './config.js';
import {
  loadSettings,
  resetSettingsCache,
  isSourceEnabled,
  setSourceEnabled,
  getYouTubePlaylistIds,
  setYouTubePlaylistIds,
} from './settings.js';
import { setActiveView } from './shell.js';
import {
  getActiveProfile,
  setActiveProfileLocal,
  listProfilesLocal,
  saveProfilesLocal,
  normalizeProfiles,
  sanitizeProfileName,
  DEFAULT_PROFILE,
} from './profiles.js';
import { ovTagRowHtml } from './projects.js';
import { openRecorder, closeRecorder, isRecorderOpen, wireRecorder } from './recorder.js';
import {
  openProjectModal,
  closeProjectModal,
  handleProjectSubmit,
  addTagRow,
  openArtifactModal,
  closeArtifactModal,
  submitArtifactModal,
  syncArtifactName,
  openLinkModal,
  closeLinkModal,
  submitLinkModal,
} from './modals.js';
import { render } from './render.js';
import { refreshInsights, resetInsights, showInsights } from './insights.js';
import { loadAnnouncements, markAnnouncementsSeen } from './announcements.js';
import { createTimebox, deleteTimebox } from './calendar.js';
import { refreshTimeboxes, resetTimeboxes } from './timebox.js';
import { addCustomCategory, categoryOptionsHtml, allCategories, ADD_CATEGORY_VALUE } from './categories.js';

// Handle the "+ Add new category…" entry in a category <select>: prompt, persist, then reselect.
function handleCategoryAdd(select) {
  if (!select) return;
  if (select.value !== ADD_CATEGORY_VALUE) {
    select.dataset.current = select.value;
    return;
  }
  const name = addCustomCategory(window.prompt('New category name') || '');
  const selected = name || select.dataset.current || allCategories()[0];
  select.innerHTML = categoryOptionsHtml(selected);
  select.value = selected;
  select.dataset.current = selected;
  if (name) showToast('Category "' + name + '" added.');
}

// Reconcile the Drive-stored profiles list with the local cache after sign-in.
async function syncProfilesList() {
  try {
    const remote = await loadProfilesList();
    const merged = normalizeProfiles([...(remote || []), ...listProfilesLocal()]);
    saveProfilesLocal(merged);
    if (state.token && (!remote || remote.length !== merged.length)) {
      try { await saveProfilesList(merged); } catch { /* non-fatal */ }
    }
  } catch {
    /* offline or no access yet */
  }
  render();
}

// Load per-profile settings from Drive, then reflect source enablement in the UI.
async function syncSettingsFromDrive() {
  await loadSettings();
  render();
  if (state.profile && state.token) refreshAllSources();
}

async function switchProfile(name) {
  byId('user-menu')?.classList.remove('is-open');
  if (!name || name === getActiveProfile()) return;
  const label = name === DEFAULT_PROFILE ? 'Default' : name;
  showBusy('Switching to ' + label + '…');
  try {
    setActiveProfileLocal(name);
    resetProfileCaches();
    resetInsights();
    resetSettingsCache();
    resetTimeboxes();
    state.projects = loadProjects();
    state.selectedProjectId = null;
    state.selectedProjectCategory = null;
    state.selectedProjectStatus = 'all';
    state.selectedProjectTab = 'overview';
    Object.values(state.sources).forEach((slice) => {
      slice.items = [];
      slice.status = 'idle';
      slice.error = '';
      slice.fetchedAt = null;
    });
    render();
    if (state.profile && state.token) {
      await loadSettings();
      await loadProjectsFromDrive();
      await refreshAllSources({ force: true });
      await refreshInsights();
    }
  } finally {
    hideBusy();
  }
  showToast('Switched to ' + label + ' profile.');
}

async function addProfileFlow() {
  const name = sanitizeProfileName(window.prompt('Name your new profile') || '');
  if (!name) return;
  if (name === DEFAULT_PROFILE) {
    showToast('That name is reserved.');
    return;
  }
  if (listProfilesLocal().includes(name)) {
    await switchProfile(name);
    return;
  }
  showBusy('Creating ' + name + ' profile…');
  try {
    const next = normalizeProfiles([...listProfilesLocal(), name]);
    saveProfilesLocal(next);
    if (state.token) {
      try { await saveProfilesList(next); } catch { /* non-fatal */ }
    }
    await switchProfile(name);
  } finally {
    hideBusy();
  }
}

let settingsYtPlaylists = null;
let settingsDirty = false;
let activeSettingsTab = 'sources';

function settingsSourceRow(source) {
  const on = isSourceEnabled(source.id);
  return (
    '<label class="set-row">' +
    '<span class="set-row__label">' + escapeHtml(source.label) + '</span>' +
    '<input type="checkbox" class="switch" data-source-toggle="' + source.id + '"' + (on ? ' checked' : '') + ' />' +
    '</label>'
  );
}

function settingsPlaylistSection() {
  if (!isSourceEnabled('youtube_review_later')) return '';
  const selected = new Set(getYouTubePlaylistIds());
  let body;
  if (settingsYtPlaylists === null) {
    body = '<p class="set-hint muted">Loading playlists…</p>';
  } else if (settingsYtPlaylists === 'error') {
    body = '<p class="set-hint muted">Could not load your playlists. Try again later.</p>';
  } else if (!settingsYtPlaylists.length) {
    body = '<p class="set-hint muted">No playlists found on this account.</p>';
  } else {
    body =
      '<div class="set-playlists">' +
      settingsYtPlaylists
        .map(
          (pl) =>
            '<label class="set-check"><input type="checkbox" data-playlist="' + escapeHtml(pl.id) + '"' +
            (selected.has(pl.id) ? ' checked' : '') + ' />' +
            '<span class="set-check__name">' + escapeHtml(pl.title) + '</span>' +
            (pl.count != null ? '<span class="set-check__count">' + pl.count + '</span>' : '') +
            '</label>'
        )
        .join('') +
      '</div>';
  }
  return (
    '<div class="set-section">' +
    '<h4 class="set-section__title">YouTube playlists</h4>' +
    '<p class="set-hint muted">Selected playlists are consolidated into the YouTube inbox. None selected uses your “' + escapeHtml(YOUTUBE_PLAYLIST_TITLE) + '” playlist.</p>' +
    body +
    '</div>'
  );
}

function settingsProfilesSection() {
  const active = getActiveProfile();
  const rows = listProfilesLocal()
    .map((name) => {
      const label = name === DEFAULT_PROFILE ? 'Default' : name;
      const badge = name === active ? ' <span class="set-profile__badge">active</span>' : '';
      const action = name === DEFAULT_PROFILE
        ? '<button class="btn btn--ghost btn--sm" type="button" data-reset-profile="' + escapeHtml(name) + '">Reset</button>'
        : '<button class="btn btn--ghost btn--sm" type="button" data-delete-profile="' + escapeHtml(name) + '">Delete</button>';
      return '<div class="set-profile"><span class="set-profile__name">' + escapeHtml(label) + badge + '</span>' + action + '</div>';
    })
    .join('');
  return (
    '<div class="set-section">' +
    '<h4 class="set-section__title">Profiles</h4>' +
    '<div class="set-profiles">' + rows + '</div>' +
    '<button class="btn btn--soft btn--sm" type="button" id="btn-settings-add-profile">+ Add profile</button>' +
    '</div>'
  );
}

function settingsTabs() {
  const tab = (id, label) =>
    '<button class="set-tab' + (activeSettingsTab === id ? ' is-active' : '') + '" type="button" role="tab" data-settings-tab="' + id + '">' + label + '</button>';
  return '<div class="set-tabs" role="tablist">' + tab('sources', 'Sources') + tab('profiles', 'Profiles') + '</div>';
}

function settingsSourcesTab() {
  return (
    '<div class="set-section">' +
    '<h4 class="set-section__title">Sources</h4>' +
    '<p class="set-hint muted">Turn a source on or off in your inbox.</p>' +
    SOURCES.map(settingsSourceRow).join('') +
    '</div>' +
    settingsPlaylistSection()
  );
}

function renderSettings() {
  const body = byId('settings-body');
  if (!body) return;
  const content = activeSettingsTab === 'profiles' ? settingsProfilesSection() : settingsSourcesTab();
  body.innerHTML = settingsTabs() + '<div class="set-tabpanel">' + content + '</div>';
}

async function loadSettingsPlaylists() {
  if (!isSourceEnabled('youtube_review_later') || !state.token) return;
  settingsYtPlaylists = null;
  renderSettings();
  try {
    settingsYtPlaylists = await fetchYouTubePlaylists(state.token);
    // Pre-select the "Review Later" playlist by default when nothing is configured yet.
    if (!getYouTubePlaylistIds().length && Array.isArray(settingsYtPlaylists)) {
      const preset = settingsYtPlaylists.find(
        (pl) => pl.title.trim().toLowerCase() === YOUTUBE_PLAYLIST_TITLE.toLowerCase()
      );
      if (preset) await setYouTubePlaylistIds([preset.id]);
    }
  } catch {
    settingsYtPlaylists = 'error';
  }
  renderSettings();
}

function openSettings() {
  byId('user-menu')?.classList.remove('is-open');
  const modal = byId('settings-modal');
  if (!modal) return;
  settingsDirty = false;
  settingsYtPlaylists = null;
  activeSettingsTab = 'sources';
  renderSettings();
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  loadSettingsPlaylists();
}

function closeSettings() {
  const modal = byId('settings-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  if (settingsDirty) {
    settingsDirty = false;
    render();
    if (state.profile && state.token) refreshAllSources({ force: true });
  }
}

// Permanently delete a profile: trash its Drive folder and clear its local data. Requires typed confirmation.
async function deleteProfileFlow(name) {
  if (!name || name === DEFAULT_PROFILE) return;
  const typed = window.prompt('This permanently deletes the "' + name + '" profile and all its data in Drive.\nType the profile name to confirm:');
  if (typed == null) return;
  if (typed.trim() !== name) {
    showToast('Name did not match — nothing was deleted.');
    return;
  }
  showBusy('Deleting ' + name + ' profile…');
  try {
    if (getActiveProfile() === name) {
      await switchProfile(DEFAULT_PROFILE);
    }
    const next = normalizeProfiles(listProfilesLocal().filter((entry) => entry !== name));
    saveProfilesLocal(next);
    if (state.token) {
      try { await saveProfilesList(next); } catch { /* non-fatal */ }
      try { await deleteProfileFolder(name); } catch { /* non-fatal */ }
    }
    clearProfileLocalData(name);
  } finally {
    hideBusy();
  }
  showToast('Deleted ' + name + ' profile.');
}

// Wipe a profile's data (keeping the profile itself) after confirmation. Offered for the default profile.
async function resetProfileFlow(name) {
  if (!name) return;
  const label = name === DEFAULT_PROFILE ? 'Default' : name;
  const ok = window.confirm(
    'Reset the "' + label + '" profile?\nThis permanently clears its projects, insights, and settings in Drive and cannot be undone.'
  );
  if (!ok) return;
  // Reset always operates on the active profile's Drive folders, so make it active first.
  if (getActiveProfile() !== name) setActiveProfileLocal(name);
  showBusy('Resetting ' + label + ' profile…');
  try {
    if (state.token) await resetProfileData();
    clearProfileLocalData(name);
    resetProfileCaches();
    resetInsights();
    resetSettingsCache();
    resetTimeboxes();
    state.projects = loadProjects();
    state.selectedProjectId = null;
    state.selectedProjectCategory = null;
    state.selectedProjectStatus = 'all';
    state.selectedProjectTab = 'overview';
    Object.values(state.sources).forEach((slice) => {
      slice.items = [];
      slice.status = 'idle';
      slice.error = '';
      slice.fetchedAt = null;
    });
    render();
    if (state.profile && state.token) {
      await loadSettings();
      await loadProjectsFromDrive();
      await refreshAllSources({ force: true });
      await refreshInsights();
    }
  } finally {
    hideBusy();
  }
  showToast('Reset ' + label + ' profile.');
}

// Remove a profile's local caches. Named profiles use suffixed keys; the default profile uses the base keys.
function clearProfileLocalData(name) {
  if (name === DEFAULT_PROFILE) {
    [
      STORAGE_KEYS.projects,
      STORAGE_KEYS.settings,
      STORAGE_KEYS.customCategories,
      STORAGE_KEYS.driveProjects,
    ].forEach((key) => localStorage.removeItem(key));
    return;
  }
  const suffix = '::' + name;
  Object.keys(localStorage).forEach((key) => {
    if (key.endsWith(suffix)) localStorage.removeItem(key);
  });
}

function wireSettings() {
  byId('btn-settings')?.addEventListener('click', openSettings);
  byId('btn-close-settings')?.addEventListener('click', closeSettings);
  byId('settings-modal')?.addEventListener('click', (event) => {
    if (event.target.dataset.closeSettings === 'true') closeSettings();
  });

  const body = byId('settings-body');
  if (!body) return;

  body.addEventListener('change', async (event) => {
    const toggle = event.target.closest('[data-source-toggle]');
    if (toggle) {
      await setSourceEnabled(toggle.dataset.sourceToggle, toggle.checked);
      settingsDirty = true;
      renderSettings();
      if (toggle.dataset.sourceToggle === 'youtube_review_later' && toggle.checked) loadSettingsPlaylists();
      return;
    }
    const playlist = event.target.closest('[data-playlist]');
    if (playlist) {
      const ids = new Set(getYouTubePlaylistIds());
      if (playlist.checked) ids.add(playlist.dataset.playlist);
      else ids.delete(playlist.dataset.playlist);
      await setYouTubePlaylistIds([...ids]);
      settingsDirty = true;
    }
  });

  body.addEventListener('click', async (event) => {
    const tab = event.target.closest('[data-settings-tab]');
    if (tab) {
      activeSettingsTab = tab.dataset.settingsTab;
      renderSettings();
      return;
    }
    if (event.target.closest('#btn-settings-add-profile')) {
      await addProfileFlow();
      renderSettings();
      return;
    }
    const reset = event.target.closest('[data-reset-profile]');
    if (reset) {
      await resetProfileFlow(reset.dataset.resetProfile);
      renderSettings();
      return;
    }
    const del = event.target.closest('[data-delete-profile]');
    if (del) {
      await deleteProfileFlow(del.dataset.deleteProfile);
      renderSettings();
    }
  });
}

function goToView(viewName) {
  if (viewName === 'projects') {
    state.selectedProjectId = null;
    state.selectedProjectCategory = null;
    state.selectedProjectStatus = 'all';
    state.selectedProjectTab = 'overview';
  }
  setActiveView(viewName);
  render();
  if (viewName === 'insights') showInsights();
  if (viewName === 'timebox') refreshTimeboxes();
}

function openProjectFromItem(item) {
  if (!item || !item.title) {
    showToast('This item has no title to turn into a project.');
    return;
  }
  openProjectModal(item);
}

// Jump to the project already created from an inbox item.
async function openExistingProjectFromInbox(projectId) {
  state.activeView = 'projects';
  await openProject(projectId);
}

async function loadProjectsFromDrive() {
  state.projectsLoading = true;
  render();
  try {
    await hydrateProjects();
  } finally {
    state.projectsLoading = false;
    render();
  }
}

async function openProject(projectId) {
  state.selectedProjectId = projectId;
  state.selectedProjectTab = 'overview';
  state.editingOverview = false;
  const project = currentProject();
  if (project) state.selectedProjectCategory = project.category || 'Others';
  render();

  if (project) {
    try {
      // Lazily restore the source bookmark for projects hydrated from the Drive index.
      if (project.bookmark === undefined) {
        const meta = await loadProjectMetadata(project);
        if (meta) {
          project.bookmark = meta.bookmark || null;
          saveProjects();
          render();
        }
      }
      await syncProjectArtifacts(project);
      render();
    } catch {
      /* keep locally cached artifacts */
    }
  }
}

async function addArtifactFlow(trigger) {
  const project = currentProject();
  if (!project) return;
  const result = await openArtifactModal(trigger);
  if (!result) return;
  const { type, name, label } = result;

  showBusy('Creating ' + String(label || 'file').toLowerCase() + '…');
  try {
    const artifact = await createArtifact(project, name, type);
    state.selectedProjectArtifactId = artifact.id;
    state.selectedProjectTab = 'docs';
    render();
    window.open(artifact.url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    showToast(error.message || 'Could not create the file.');
  } finally {
    hideBusy();
  }
}

async function updateProjectMeta(changes) {
  const project = currentProject();
  if (!project) return;
  const wasComplete = Number(project.progress) >= 100 || project.status === 'Complete';
  Object.assign(project, changes);
  const isComplete = Number(project.progress) >= 100 || project.status === 'Complete';
  // Stamp completion time on the transition; clear it when a project is reopened.
  if (isComplete && !wasComplete) project.completedAt = new Date().toISOString();
  else if (!isComplete && wasComplete) project.completedAt = null;
  saveProjects();
  render();
  try {
    await saveProjectStatus(project);
  } catch (error) {
    showToast(error.message || 'Saved locally. Google Drive sync failed.');
  }
}

function gatherOverviewTags() {
  const container = byId('ov-tags');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.tag-input-row'))
    .map((row) => {
      const inputs = row.querySelectorAll('input');
      const key = (inputs[0]?.value || '').trim();
      const value = (inputs[1]?.value || '').trim();
      return key || value ? { key, value } : null;
    })
    .filter(Boolean);
}

async function saveOverviewEdits() {
  const project = currentProject();
  if (!project) return;
  const name = (byId('ov-name')?.value || '').trim();
  if (!name) {
    showToast('Project name is required.');
    return;
  }
  const duplicate = state.projects.some(
    (other) => other.id !== project.id && other.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    showToast('Another project already uses this name.');
    return;
  }

  Object.assign(project, {
    name,
    title: name,
    category: byId('ov-category')?.value || project.category,
    description: byId('ov-description')?.value || '',
    tags: gatherOverviewTags(),
  });
  state.editingOverview = false;
  saveProjects();
  render();
  try {
    await saveProjectDetails(project);
  } catch (error) {
    showToast(error.message || 'Saved locally. Google Drive sync failed.');
  }
}

async function recordArtifactFlow() {
  const project = currentProject();
  if (!project) return;
  const result = await openRecorder();
  if (!result) return;

  showBusy('Saving recording…');
  try {
    const artifact = await createRecordingArtifact(project, result);
    state.selectedProjectArtifactId = artifact.id;
    state.selectedProjectTab = 'recordings';
    render();
    if (artifact.url) window.open(artifact.url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    showToast(error.message || 'Could not save the recording.');
  } finally {
    hideBusy();
  }
}

async function addLinkFlow() {
  const project = currentProject();
  if (!project) return;
  const result = await openLinkModal();
  if (!result) return;

  showBusy('Saving link…');
  try {
    const artifact = await createLinkArtifact(project, result);
    state.selectedProjectArtifactId = artifact.id;
    state.selectedProjectTab = 'links';
    render();
  } catch (error) {
    showToast(error.message || 'Could not save the link.');
  } finally {
    hideBusy();
  }
}

function openArtifact(artifactId) {
  const project = currentProject();
  if (!project) return;
  const artifact = (project.artifacts || []).find((entry) => String(entry.id) === String(artifactId));
  if (artifact && artifact.url) {
    state.selectedProjectArtifactId = artifact.id;
    render();
    window.open(artifact.url, '_blank', 'noopener,noreferrer');
  }
}

function removeProject(projectId) {
  const target = state.projects.find((project) => project.id === projectId) || null;
  const name = target ? target.name : 'this project';
  if (!window.confirm('Remove "' + name + '"?\nThis deletes the project and its Drive folder and cannot be undone.')) return;
  state.projects = state.projects.filter((project) => project.id !== projectId);
  if (state.selectedProjectId === projectId) {
    state.selectedProjectId = null;
    state.selectedProjectTab = 'overview';
  }
  const stillHasCategory = state.projects.some(
    (project) => (project.category || 'Others') === state.selectedProjectCategory
  );
  if (!stillHasCategory) state.selectedProjectCategory = null;
  saveProjects();
  render();
  showToast('Project removed.');
  if (target) {
    deleteProject(target).catch(() => showToast('Removed here, but Google Drive cleanup failed.'));
  }
}

function handleBreadcrumb(target, value) {
  if (target === 'root') {
    state.selectedProjectId = null;
    state.selectedProjectCategory = null;
    state.selectedProjectStatus = 'all';
  } else if (target === 'category') {
    state.selectedProjectId = null;
    state.selectedProjectCategory = value || null;
    state.selectedProjectStatus = 'all';
  } else if (target === 'project') {
    state.selectedProjectTab = 'overview';
  }
  render();
}

function wireAuth() {
  const signInButton = byId('btn-signin');
  if (signInButton) {
    signInButton.addEventListener('click', async () => {
      clearLoginStatus();
      const label = signInButton.textContent;
      signInButton.disabled = true;
      signInButton.textContent = 'Signing in…';
      try {
        await signIn();
        render();
        await syncProfilesList();
        await loadProjectsFromDrive();
        await refreshAllSources();
        showToast('Signed in.');
      } catch (error) {
        setLoginStatus(error.message || 'Sign-in failed.', true);
      } finally {
        signInButton.disabled = false;
        signInButton.textContent = label;
      }
    });
  }

  const signOutButton = byId('btn-signout');
  if (signOutButton) {
    signOutButton.addEventListener('click', () => {
      signOut();
      render();
      showToast('Signed out.');
    });
  }

  const avatarMenu = byId('user-menu-toggle');
  if (avatarMenu) {
    avatarMenu.addEventListener('click', () => {
      byId('user-menu')?.classList.toggle('is-open');
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.user-menu')) byId('user-menu')?.classList.remove('is-open');
    });
  }

  byId('profile-list')?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-profile]');
    if (item) switchProfile(item.dataset.profile);
  });
}

function wireNav() {
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.addEventListener('click', () => goToView(button.dataset.view));
  });

  const breadcrumbs = byId('breadcrumbs');
  if (breadcrumbs) {
    breadcrumbs.addEventListener('click', (event) => {
      const crumb = event.target.closest('[data-crumb]');
      if (crumb) handleBreadcrumb(crumb.dataset.crumb, crumb.dataset.crumbValue);
    });
  }

  byId('btn-insights-refresh')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (btn.classList.contains('is-loading')) return;
    btn.classList.add('is-loading');
    try {
      await refreshInsights();
    } finally {
      btn.classList.remove('is-loading');
    }
    showToast('Insights refreshed.');
  });
}

function wireInbox() {
  document.querySelectorAll('.source-tab').forEach((button) => {
    button.addEventListener('click', async () => {
      const nextSource = button.dataset.source;
      if (!nextSource || nextSource === state.activeSource) return;
      state.activeSource = nextSource;
      render();
      if (state.profile && state.token) {
        try {
          await ensureActiveSourceLoaded();
        } catch {
          showToast('Source sync failed.');
        }
      }
    });
  });

  byId('btn-inbox-refresh')?.addEventListener('click', async () => {
    if (!state.profile || !state.token) return;
    try {
      await refreshActiveSource({ force: true });
    } catch {
      showToast('Refresh failed.');
    }
  });

  // Revalidate stale items when the tab regains focus, without polling.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.profile && state.token) {
      ensureActiveSourceLoaded();
    }
  });

  const dateFilter = byId('date-filter');
  if (dateFilter) {
    dateFilter.addEventListener('change', () => {
      state.activeDateFilter = dateFilter.value || 'all';
      render();
    });
  }

  const linkFilter = byId('link-filter');
  if (linkFilter) {
    linkFilter.addEventListener('change', () => {
      state.activeLinkFilter = linkFilter.value || 'all';
      render();
    });
  }

  const playlistFilter = byId('playlist-filter');
  if (playlistFilter) {
    playlistFilter.addEventListener('change', () => {
      state.activePlaylist = playlistFilter.value || 'all';
      render();
    });
  }

  const listFilter = byId('list-filter');
  if (listFilter) {
    listFilter.addEventListener('change', () => {
      state.activeList = listFilter.value || 'all';
      render();
    });
  }

  const list = byId('inbox-list');
  if (list) {
    list.addEventListener('click', async (event) => {
      const removeBtn = event.target.closest('[data-inbox-remove]');
      if (removeBtn) {
        const row = removeBtn.closest('[data-inbox-item]');
        if (row) await handleInboxRemove(row);
        return;
      }
      const row = event.target.closest('[data-inbox-item]');
      if (!row) return;
      if (row.dataset.existingProject) {
        openExistingProjectFromInbox(row.dataset.existingProject);
        return;
      }
      try {
        openProjectFromItem(JSON.parse(row.dataset.inboxItem));
      } catch {
        showToast('Could not open this item.');
      }
    });
  }
}

// Delete an inbox item at its source (Google Tasks / YouTube) after confirmation.
async function handleInboxRemove(row) {
  let item;
  try {
    item = JSON.parse(row.dataset.inboxItem);
  } catch {
    showToast('Could not read this item.');
    return;
  }
  const sourceId = state.activeSource;
  const prompt = sourceId === 'youtube_review_later'
    ? 'Remove this video from your YouTube playlist?'
    : 'Delete this task from Google Tasks?';
  if (!window.confirm(prompt + '\nThis cannot be undone.')) return;
  showBusy('Removing…');
  try {
    await removeInboxItem(sourceId, item);
    showToast('Removed.');
  } catch (error) {
    showToast(error.message || 'Could not remove this item.');
  } finally {
    hideBusy();
  }
}

function wireProjects() {
  const list = byId('project-list');
  if (list) {
    list.addEventListener('click', (event) => {
      const crumb = event.target.closest('[data-crumb]');
      if (crumb) {
        handleBreadcrumb(crumb.dataset.crumb, crumb.dataset.crumbValue);
        return;
      }
      if (event.target.closest('[data-refresh-projects]')) {
        loadProjectsFromDrive();
        return;
      }
      if (event.target.closest('[data-new-project]')) {
        openProjectModal(null, { category: state.selectedProjectCategory });
        return;
      }
      const categoryCard = event.target.closest('[data-category]');
      if (categoryCard) {
        state.selectedProjectCategory = categoryCard.dataset.category;
        state.selectedProjectStatus = 'all';
        render();
        return;
      }
      const statusFilter = event.target.closest('[data-status-filter]');
      if (statusFilter) {
        state.selectedProjectStatus = statusFilter.dataset.statusFilter;
        render();
        return;
      }
      const openBtn = event.target.closest('[data-project-id]');
      if (openBtn) openProject(openBtn.dataset.projectId);
    });
  }

  const workspace = byId('project-workspace');
  if (workspace) {
    workspace.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-project-tab]');
      if (tab) {
        state.selectedProjectTab = tab.dataset.projectTab;
        state.selectedProjectArtifactId = null;
        state.editingOverview = false;
        render();
        return;
      }
      if (event.target.closest('[data-project-back]')) {
        state.selectedProjectId = null;
        state.editingOverview = false;
        render();
        return;
      }
      const removeInDetail = event.target.closest('[data-remove-project]');
      if (removeInDetail) {
        removeProject(removeInDetail.dataset.removeProject);
        return;
      }
      if (event.target.closest('[data-edit-overview]')) {
        state.editingOverview = true;
        render();
        return;
      }
      if (event.target.closest('[data-cancel-overview]')) {
        state.editingOverview = false;
        render();
        return;
      }
      if (event.target.closest('[data-save-overview]')) {
        saveOverviewEdits();
        return;
      }
      if (event.target.closest('[data-ov-add-tag]')) {
        byId('ov-tags')?.insertAdjacentHTML('beforeend', ovTagRowHtml());
        return;
      }
      if (event.target.closest('[data-ov-remove-tag]')) {
        event.target.closest('.tag-input-row')?.remove();
        return;
      }
      if (event.target.closest('[data-project-complete]')) {
        updateProjectMeta({ progress: 100, status: 'Complete' });
        return;
      }
      const add = event.target.closest('[data-add-artifact]');
      if (add) {
        addArtifactFlow(add.dataset.addArtifact);
        return;
      }
      if (event.target.closest('[data-record-artifact]')) {
        recordArtifactFlow();
        return;
      }
      if (event.target.closest('[data-add-link]')) {
        addLinkFlow();
        return;
      }
      const open = event.target.closest('[data-open-artifact]');
      if (open) openArtifact(open.dataset.openArtifact);
    });

    workspace.addEventListener('input', (event) => {
      const slider = event.target.closest('[data-project-progress]');
      if (!slider) return;
      const percent = Math.max(0, Math.min(100, Number(slider.value) || 0));
      const label = workspace.querySelector('[data-progress-label]');
      const fill = workspace.querySelector('[data-progress-fill]');
      if (label) label.textContent = percent + '%';
      if (fill) fill.style.width = percent + '%';
    });

    workspace.addEventListener('change', (event) => {
      if (event.target.id === 'ov-category') {
        handleCategoryAdd(event.target);
        return;
      }
      const slider = event.target.closest('[data-project-progress]');
      if (slider) {
        const percent = Math.max(0, Math.min(100, Number(slider.value) || 0));
        updateProjectMeta({ progress: percent, status: percent >= 100 ? 'Complete' : 'In progress' });
      }
    });
  }
}

function wireModals() {
  byId('project-form')?.addEventListener('submit', handleProjectSubmit);
  byId('project-category')?.addEventListener('change', (event) => handleCategoryAdd(event.target));
  byId('btn-add-tag')?.addEventListener('click', addTagRow);
  byId('btn-close-modal')?.addEventListener('click', closeProjectModal);
  byId('btn-cancel-modal')?.addEventListener('click', closeProjectModal);
  byId('project-modal')?.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') closeProjectModal();
  });

  byId('artifact-form')?.addEventListener('submit', submitArtifactModal);
  byId('artifact-type')?.addEventListener('change', syncArtifactName);
  byId('btn-artifact-cancel')?.addEventListener('click', () => closeArtifactModal(null));
  byId('btn-artifact-close')?.addEventListener('click', () => closeArtifactModal(null));
  byId('artifact-modal')?.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') closeArtifactModal(null);
  });

  byId('link-form')?.addEventListener('submit', submitLinkModal);
  byId('btn-link-cancel')?.addEventListener('click', () => closeLinkModal(null));
  byId('btn-link-close')?.addEventListener('click', () => closeLinkModal(null));
  byId('link-modal')?.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') closeLinkModal(null);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (isRecorderOpen()) closeRecorder();
    else if (byId('settings-modal')?.classList.contains('is-open')) closeSettings();
    else if (byId('link-modal')?.classList.contains('is-open')) closeLinkModal(null);
    else if (byId('artifact-modal')?.classList.contains('is-open')) closeArtifactModal(null);
    else if (byId('project-modal')?.classList.contains('is-open')) closeProjectModal();
  });
}

function wireEvents() {
  wireAuth();
  wireNav();
  wireInbox();
  wireProjects();
  wireModals();
  wireRecorder();
  wireNotifications();
  wireSettings();
  wireTimebox();
}

async function handleTimeboxSubmit(event) {
  event.preventDefault();
  const title = (byId('tb-title')?.value || '').trim();
  const date = byId('tb-date')?.value;
  const time = byId('tb-time')?.value;
  const duration = Number(byId('tb-duration')?.value || 60);
  const description = (byId('tb-description')?.value || '').trim();
  if (!title) {
    showToast('Add a title for your timebox.');
    return;
  }
  if (!date || !time) {
    showToast('Pick a date and start time.');
    return;
  }
  const start = new Date(date + 'T' + time);
  if (Number.isNaN(start.getTime())) {
    showToast('That date and time look invalid.');
    return;
  }
  const end = new Date(start.getTime() + duration * 60000);
  showBusy('Scheduling…');
  try {
    await createTimebox({ title, description, start: start.toISOString(), end: end.toISOString() });
    byId('timebox-form')?.reset();
    showToast('Timebox scheduled.');
    await refreshTimeboxes();
  } catch (error) {
    showToast(error.message || 'Could not schedule the timebox.');
  } finally {
    hideBusy();
  }
}

function wireTimebox() {
  byId('timebox-form')?.addEventListener('submit', handleTimeboxSubmit);
  byId('btn-timebox-refresh')?.addEventListener('click', () => refreshTimeboxes());
  byId('timebox-list')?.addEventListener('click', async (event) => {
    const cancel = event.target.closest('[data-cancel-timebox]');
    if (!cancel) return;
    if (!window.confirm('Cancel this timebox? It will be removed from your calendar.')) return;
    showBusy('Canceling…');
    try {
      await deleteTimebox(cancel.dataset.cancelTimebox);
      showToast('Timebox canceled.');
      await refreshTimeboxes();
    } catch (error) {
      showToast(error.message || 'Could not cancel this timebox.');
    } finally {
      hideBusy();
    }
  });
}

function wireNotifications() {  const bell = byId('notif-bell');
  if (bell) {
    bell.addEventListener('click', () => {
      const menu = byId('notif-menu');
      if (!menu) return;
      const willOpen = !menu.classList.contains('is-open');
      menu.classList.toggle('is-open');
      if (willOpen) markAnnouncementsSeen();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.notif')) byId('notif-menu')?.classList.remove('is-open');
    });
  }
}

async function init() {
  showBusy('Launching…');
  state.profile = restoreProfile();
  wireEvents();
  render();
  loadAnnouncements();

  try {
    setBusyMessage('Signing you in…');
    await trySilentSignIn();
    render();
  } finally {
    // Hide the splash as soon as auth resolves; data streams in behind inline loaders.
    hideBusy();
  }

  if (state.profile && state.token) {
    // Inbox sources fetch straight from Google APIs — start immediately; loadSource manages its own loading state.
    refreshAllSources().catch(() => {});
    // Drive-backed data: projects load creates/verifies the folder structure, then profiles sync reuses it.
    state.projectsLoading = true;
    render();
    loadProjectsFromDrive()
      .then(() => {
        syncProfilesList();
        refreshInsights();
        syncSettingsFromDrive();
      })
      .catch(() => {
        state.projectsLoading = false;
        render();
      });
  }
}

init().catch((error) => {
  hideBusy();
  setLoginStatus(error.message || 'App initialization failed.', true);
});
