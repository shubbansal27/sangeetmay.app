// Modal dialogs: create-project form and the artifact naming prompt.

import { state, currentProject } from './store.js';
import { ARTIFACT_TYPES } from './config.js';
import { byId, escapeHtml } from './utils.js';
import { showToast } from './feedback.js';
import { createProjectFromItem, shareProject, unshareProject, listProjectPermissions } from './drive.js';
import { allCategories, categoryOptionsHtml } from './categories.js';
import { itemMeta, metaFieldHtml } from './inbox.js';
import { render } from './render.js';

/* ---------- Project create modal ---------- */

function tagRow() {
  const row = document.createElement('div');
  row.className = 'tag-input-row';
  row.innerHTML =
    '<input type="text" placeholder="Key" aria-label="Tag key" />' +
    '<input type="text" placeholder="Value" aria-label="Tag value" />' +
    '<button type="button" class="tag-input-remove" aria-label="Remove tag">×</button>';
  row.querySelector('.tag-input-remove').addEventListener('click', () => row.remove());
  return row;
}

export function addTagRow() {
  const list = byId('project-tags');
  if (list) list.appendChild(tagRow());
}

function collectTags() {
  const list = byId('project-tags');
  if (!list) return [];
  return Array.from(list.querySelectorAll('.tag-input-row'))
    .map((row) => {
      const inputs = row.querySelectorAll('input');
      const key = (inputs[0]?.value || '').trim();
      const value = (inputs[1]?.value || '').trim();
      return key || value ? { key, value } : null;
    })
    .filter(Boolean);
}

function renderPreview(item) {
  const preview = byId('project-preview');
  const body = byId('project-preview-body');
  if (!preview || !body) return;
  if (!item) {
    preview.classList.add('hidden');
    body.innerHTML = '';
    return;
  }
  body.innerHTML = itemMeta(item)
    .map(metaFieldHtml)
    .join('');
  preview.classList.remove('hidden');
}

function setCreateLoading(isLoading) {
  state.isCreatingProject = isLoading;
  const submit = document.querySelector('#project-form [type="submit"]');
  const form = byId('project-form');
  if (submit) {
    submit.disabled = isLoading;
    submit.textContent = isLoading ? 'Creating…' : 'Create project';
  }
  if (form) form.classList.toggle('is-busy', isLoading);
}

export function openProjectModal(item = null, defaults = {}) {
  const modal = byId('project-modal');
  if (!modal) return;

  state.selectedItem = item;
  setCreateLoading(false);

  const name = byId('project-name');
  const description = byId('project-description');
  const category = byId('project-category');
  const tags = byId('project-tags');

  if (name) name.value = item ? String(item.title || '').trim() : '';
  if (description) description.value = '';
  if (category) {
    const known = allCategories();
    const preferred = defaults.category && known.includes(defaults.category) ? defaults.category : known[0];
    category.innerHTML = categoryOptionsHtml(preferred);
    category.value = preferred;
    category.dataset.current = preferred;
  }
  if (tags) {
    tags.innerHTML = '';
    tags.appendChild(tagRow());
  }
  renderPreview(item);

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => byId('project-name')?.focus(), 60);
}

export function closeProjectModal() {
  const modal = byId('project-modal');
  if (!modal) return;
  setCreateLoading(false);
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

export async function handleProjectSubmit(event) {
  event.preventDefault();
  if (state.isCreatingProject) return;

  const name = (byId('project-name')?.value || '').trim();
  if (!name) {
    showToast('Enter a project name first.');
    return;
  }

  setCreateLoading(true);
  try {
    const project = await createProjectFromItem(state.selectedItem, {
      name,
      description: (byId('project-description')?.value || '').trim(),
      category: byId('project-category')?.value || 'Others',
      tags: collectTags(),
    });
    state.selectedProjectId = project.id;
    state.selectedProjectCategory = project.category;
    state.selectedProjectTab = 'overview';
    state.activeView = 'projects';
    closeProjectModal();
    render();
    showToast('Project created in Google Drive: ' + project.name);
  } catch (error) {
    setCreateLoading(false);
    showToast(error.message || 'Could not create project.');
  }
}

/* ---------- Artifact naming modal ---------- */

let artifactResolver = null;

// Next default name for an artifact type in the current project: "<label> <n>".
export function nextArtifactName(label) {
  const project = currentProject();
  const artifacts = (project && project.artifacts) || [];
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '\\s+(\\d+)$', 'i');
  let max = 0;
  artifacts.forEach((artifact) => {
    const match = re.exec(String(artifact.name || artifact.title || '').trim());
    if (match) max = Math.max(max, Number(match[1]));
  });
  return label + ' ' + (max + 1);
}

// True while the field still holds an untouched auto name ("<label>" or "<label> <n>").
function isDefaultArtifactName(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return true;
  return Object.values(ARTIFACT_TYPES).some((spec) => {
    const escaped = spec.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped + '(\\s+\\d+)?$', 'i').test(trimmed);
  });
}

// trigger is 'drawio' for the design tab or 'docs' for the docs tab (Doc/Sheet/Slides).
export function openArtifactModal(trigger) {
  const modal = byId('artifact-modal');
  if (!modal) return Promise.resolve(null);

  const isDocs = trigger === 'docs';
  const typeField = byId('artifact-type-field');
  const typeSelect = byId('artifact-type');
  const titleEl = byId('artifact-modal-title');
  const input = byId('artifact-name');

  modal.dataset.trigger = trigger;
  if (typeField) typeField.classList.toggle('hidden', !isDocs);

  if (isDocs) {
    if (typeSelect) typeSelect.value = 'gdoc';
    if (titleEl) titleEl.textContent = 'New document';
    if (input) input.value = nextArtifactName(ARTIFACT_TYPES.gdoc.label);
  } else {
    if (titleEl) titleEl.textContent = 'New design board';
    if (input) input.value = nextArtifactName(ARTIFACT_TYPES.drawio.label);
  }

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => {
    input?.focus();
    input?.select();
  }, 60);

  return new Promise((resolve) => {
    artifactResolver = resolve;
  });
}

// Keeps the file name in sync with the chosen type while the user has not customised it.
export function syncArtifactName() {
  const typeSelect = byId('artifact-type');
  const input = byId('artifact-name');
  if (!typeSelect || !input) return;
  if (isDefaultArtifactName(input.value)) {
    input.value = nextArtifactName(ARTIFACT_TYPES[typeSelect.value]?.label || 'File');
  }
}

export function closeArtifactModal(value = null) {
  const modal = byId('artifact-modal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (artifactResolver) {
    artifactResolver(value);
    artifactResolver = null;
  }
}

export function submitArtifactModal(event) {
  event.preventDefault();
  const modal = byId('artifact-modal');
  const trigger = modal?.dataset.trigger || 'drawio';
  const type = trigger === 'docs' ? byId('artifact-type')?.value || 'gdoc' : 'drawio';
  const name = (byId('artifact-name')?.value || '').trim();
  if (!name) {
    closeArtifactModal(null);
    return;
  }
  closeArtifactModal({ type, name, label: ARTIFACT_TYPES[type]?.label || 'File' });
}

/* ---------- Link modal ---------- */

let linkResolver = null;

export function openLinkModal() {
  const modal = byId('link-modal');
  if (!modal) return Promise.resolve(null);

  const url = byId('link-url');
  const title = byId('link-title');
  if (url) url.value = '';
  if (title) title.value = nextArtifactName(ARTIFACT_TYPES.link.label);

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => url?.focus(), 60);

  return new Promise((resolve) => {
    linkResolver = resolve;
  });
}

export function closeLinkModal(value = null) {
  const modal = byId('link-modal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (linkResolver) {
    linkResolver(value);
    linkResolver = null;
  }
}

export function submitLinkModal(event) {
  event.preventDefault();
  let url = (byId('link-url')?.value || '').trim();
  if (!url) {
    showToast('Enter a URL first.');
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    // Validate the URL before saving.
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    showToast('That does not look like a valid URL.');
    return;
  }
  const title = (byId('link-title')?.value || '').trim();
  closeLinkModal({ url, title });
}

/* ---------- Share modal ---------- */

let shareProjectId = null;

function ownedProjectById(id) {
  return state.projects.find((project) => project.id === id) || null;
}

function renderSharePeople(people) {
  const list = byId('share-people-list');
  if (!list) return;
  if (!people.length) {
    list.innerHTML = '<p class="muted share-people__empty">Not shared with anyone yet.</p>';
    return;
  }
  list.innerHTML = people
    .map((person) => {
      const name = person.displayName || person.emailAddress || 'User';
      const email = person.emailAddress && person.emailAddress !== name ? person.emailAddress : '';
      return (
        '<div class="share-person">' +
        '<span class="share-person__text"><strong>' + escapeHtml(name) + '</strong>' +
        (email ? '<small>' + escapeHtml(email) + '</small>' : '') + '</span>' +
        '<button class="btn btn--ghost btn--sm" type="button" data-unshare="' + escapeHtml(person.id) + '">Remove</button>' +
        '</div>'
      );
    })
    .join('');
}

async function refreshSharePeople() {
  const project = ownedProjectById(shareProjectId);
  const list = byId('share-people-list');
  if (!project) return;
  if (list) list.innerHTML = '<p class="muted share-people__empty">Loading…</p>';
  const people = await listProjectPermissions(project);
  project.shared = people.length > 0;
  renderSharePeople(people);
}

export function openShareModal(projectId) {
  const modal = byId('share-modal');
  const project = ownedProjectById(projectId);
  if (!modal || !project) return;
  shareProjectId = projectId;

  const email = byId('share-email');
  if (email) email.value = '';

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => byId('share-email')?.focus(), 60);
  refreshSharePeople();
}

export function closeShareModal() {
  const modal = byId('share-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  shareProjectId = null;
  render();
}

export async function handleShareSubmit(event) {
  event.preventDefault();
  const project = ownedProjectById(shareProjectId);
  if (!project) return;
  const emailField = byId('share-email');
  const email = (emailField?.value || '').trim();
  if (!email) {
    showToast('Enter an email address to share with.');
    return;
  }
  const submit = document.querySelector('#share-form [type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await shareProject(project, email);
    if (emailField) emailField.value = '';
    project.shared = true;
    showToast('Shared with ' + email + '.');
    await refreshSharePeople();
  } catch (error) {
    showToast(error.message || 'Could not share this project.');
  } finally {
    if (submit) submit.disabled = false;
  }
}

export async function handleUnshare(permissionId) {
  const project = ownedProjectById(shareProjectId);
  if (!project || !permissionId) return;
  try {
    await unshareProject(project, permissionId);
    await refreshSharePeople();
  } catch (error) {
    showToast(error.message || 'Could not update sharing.');
  }
}
