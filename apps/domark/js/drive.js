// Google Drive integration: folder structure, project index, metadata and artifacts.

import { STORAGE_KEYS, DRIVE, ARTIFACT_TYPES } from './config.js';
import { state, saveProjects } from './store.js';
import { uid, slugify } from './utils.js';
import { authScope, openAuthPopup } from './auth.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

async function driveFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', 'Bearer ' + state.token);

  let response = await fetch(url, { ...options, headers });
  if (response.status === 401 && state.token) {
    try {
      state.token = await openAuthPopup(authScope(), 'domark_drive_refresh', { prompt: 'consent' });
      const retryHeaders = new Headers(options.headers || {});
      retryHeaders.set('Authorization', 'Bearer ' + state.token);
      response = await fetch(url, { ...options, headers: retryHeaders });
    } catch {
      return response;
    }
  }
  return response;
}

function driveQuery(clauses) {
  return encodeURIComponent(clauses.join(' and '));
}

async function findFile(name, parentId, extraClauses = []) {
  const clauses = ["name='" + name.replace(/'/g, "\\'") + "'", "'" + parentId + "' in parents", 'trashed=false', ...extraClauses];
  const url = DRIVE_FILES + '?q=' + driveQuery(clauses) + '&spaces=drive&fields=files(id,name,webViewLink)';
  const response = await driveFetch(url);
  if (!response.ok) return null;
  const payload = await response.json();
  return (payload.files && payload.files[0]) || null;
}

async function readJsonFile(fileId) {
  const response = await driveFetch(DRIVE_FILES + '/' + fileId + '?alt=media');
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function multipartBody(boundary, metadata, contentType, content) {
  return (
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    '\r\n--' + boundary + '\r\nContent-Type: ' + contentType + '; charset=UTF-8\r\n\r\n' +
    content +
    '\r\n--' + boundary + '--'
  );
}

async function writeJsonFile({ name, parentId, existingId, data, errorLabel }) {
  const body = JSON.stringify(data, null, 2);
  if (existingId) {
    const response = await driveFetch(DRIVE_UPLOAD + '/' + existingId + '?uploadType=media', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error(errorLabel);
    return;
  }
  const boundary = 'domark_boundary';
  const response = await driveFetch(DRIVE_UPLOAD + '?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
    body: multipartBody(boundary, { name, mimeType: 'application/json', parents: [parentId] }, 'application/json', body),
  });
  if (!response.ok) throw new Error(errorLabel);
}

async function ensureFolder(name, parentId = null) {
  const clauses = ["name='" + name.replace(/'/g, "\\'") + "'", "mimeType='application/vnd.google-apps.folder'", 'trashed=false'];
  if (parentId) clauses.push("'" + parentId + "' in parents");
  const listResponse = await driveFetch(DRIVE_FILES + '?q=' + driveQuery(clauses) + '&spaces=drive&fields=files(id,name)');
  if (!listResponse.ok) throw new Error('Could not access Google Drive for project storage.');

  const payload = await listResponse.json();
  if (payload.files && payload.files[0]) return payload.files[0].id;

  const createResponse = await driveFetch(DRIVE_FILES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!createResponse.ok) throw new Error('Could not create the required Google Drive folder.');
  return (await createResponse.json()).id;
}

let structureVerified = false;

// True only when the folder id still points to a live (non-trashed) Drive folder.
async function folderExists(id) {
  if (!id) return false;
  const res = await driveFetch(DRIVE_FILES + '/' + encodeURIComponent(id) + '?fields=id,trashed');
  if (!res.ok) return false;
  const data = await res.json().catch(() => null);
  return Boolean(data && data.trashed !== true);
}

async function ensureStructure() {
  let rootFolderId = localStorage.getItem(STORAGE_KEYS.driveRoot);
  let projectsFolderId = localStorage.getItem(STORAGE_KEYS.driveProjects);
  // Once per session, verify cached ids so we never read/write into folders deleted in Drive.
  if (!structureVerified && state.token) {
    const rootOk = rootFolderId ? await folderExists(rootFolderId) : false;
    if (!rootOk) {
      rootFolderId = null;
      projectsFolderId = null;
    } else if (projectsFolderId && !(await folderExists(projectsFolderId))) {
      projectsFolderId = null;
    }
    structureVerified = true;
  }
  if (!rootFolderId) {
    rootFolderId = await ensureFolder(DRIVE.rootFolder);
    localStorage.setItem(STORAGE_KEYS.driveRoot, rootFolderId);
  }
  if (!projectsFolderId) {
    projectsFolderId = await ensureFolder(DRIVE.projectsFolder, rootFolderId);
    localStorage.setItem(STORAGE_KEYS.driveProjects, projectsFolderId);
  }
  return { rootFolderId, projectsFolderId };
}

async function loadProjectIndex() {
  const { rootFolderId } = await ensureStructure();
  const existing = await findFile(DRIVE.indexFile, rootFolderId);
  if (!existing) {
    const emptyIndex = { version: 1, projects: [] };
    await saveProjectIndex(emptyIndex);
    return emptyIndex;
  }
  const data = await readJsonFile(existing.id);
  return data && Array.isArray(data.projects) ? data : { version: 1, projects: [] };
}

async function saveProjectIndex(index) {
  const { rootFolderId } = await ensureStructure();
  const existing = await findFile(DRIVE.indexFile, rootFolderId);
  await writeJsonFile({
    name: DRIVE.indexFile,
    parentId: rootFolderId,
    existingId: existing ? existing.id : null,
    data: index,
    errorLabel: 'Could not save the Domark project index to Google Drive.',
  });
}

async function saveProjectMetadata(project) {
  const existing = await findFile(DRIVE.projectFile, project.folderId);
  // Artifacts are the responsibility of artifacts.json; keep them out of project.json to avoid divergence.
  const rest = { ...project };
  delete rest.artifacts;
  await writeJsonFile({
    name: DRIVE.projectFile,
    parentId: project.folderId,
    existingId: existing ? existing.id : null,
    data: rest,
    errorLabel: 'Could not save project metadata in Google Drive.',
  });
}

export async function saveProjectStatus(project) {
  if (!state.token) throw new Error('Please sign in to sync project status to Google Drive.');

  const index = await loadProjectIndex();
  const entry = index.projects.find((item) => item.id === project.id);
  if (entry) {
    entry.status = project.status;
    entry.progress = project.progress;
    await saveProjectIndex(index);
  }
  await saveProjectMetadata(project);
}

// Persist edited overview fields (name, category, description, tags) to the index and project file.
export async function saveProjectDetails(project) {
  if (!state.token) throw new Error('Please sign in to sync project changes to Google Drive.');

  const index = await loadProjectIndex();
  const entry = index.projects.find((item) => item.id === project.id);
  if (entry) {
    entry.name = project.name;
    entry.slug = project.slug;
    entry.description = project.description;
    entry.category = project.category;
    entry.tags = project.tags;
    entry.status = project.status;
    entry.progress = project.progress;
    await saveProjectIndex(index);
  }
  await saveProjectMetadata(project);
}

// Read a project's full record (project.json) — used to lazily restore its source bookmark.
export async function loadProjectMetadata(project) {
  if (!state.token || !project || !project.folderId) return null;
  const existing = await findFile(DRIVE.projectFile, project.folderId);
  if (!existing) return null;
  return readJsonFile(existing.id);
}

// Rebuild state.projects from the Drive index so projects survive across devices / cleared storage.
export async function hydrateProjects() {
  if (!state.token) return state.projects;
  let index;
  try {
    index = await loadProjectIndex();
  } catch {
    return state.projects;
  }
  const byId = new Map(state.projects.map((project) => [project.id, project]));
  state.projects = index.projects.map((entry) => {
    const local = byId.get(entry.id);
    return {
      id: entry.id,
      title: entry.name,
      name: entry.name,
      slug: entry.slug,
      folderId: entry.folderId,
      description: entry.description || '',
      category: entry.category || 'Others',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      status: entry.status || 'In progress',
      progress: Number.isFinite(entry.progress) ? entry.progress : local?.progress ?? 0,
      createdAt: entry.createdAt || local?.createdAt || new Date().toISOString(),
      bookmarkRef: entry.bookmarkRef || (local && local.bookmarkRef) || null,
      // undefined = not yet loaded (lazy-load project.json on open); null = confirmed no bookmark.
      bookmark: local ? local.bookmark : undefined,
      artifacts: (local && local.artifacts) || [],
    };
  });
  saveProjects();
  return state.projects;
}

// Remove a project from Drive: drop its index entry and trash its folder (reversible).
export async function deleteProject(project) {
  if (!state.token || !project) return;
  const index = await loadProjectIndex();
  index.projects = index.projects.filter((entry) => entry.id !== project.id);
  await saveProjectIndex(index);
  if (project.folderId) {
    await driveFetch(DRIVE_FILES + '/' + project.folderId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }
}

export function normalizeArtifact(artifact, project, fallbackName = 'Design board') {
  const rawType = String(artifact?.type || 'drawio').toLowerCase();
  const type = ARTIFACT_TYPES[rawType] ? rawType : 'drawio';
  const spec = ARTIFACT_TYPES[type];
  const title = String(artifact?.title || artifact?.name || fallbackName).trim() || spec.label;
  const fileId = artifact?.fileId || '';
  // URLs are derived from the file id so every artifact opens its own file in its editor.
  let url = artifact?.url || '';
  if (type === 'drawio') {
    url = fileId ? diagramEditorUrl(fileId) : url;
  } else if (spec.drivePath && fileId) {
    url = 'https://docs.google.com/' + spec.drivePath + '/d/' + fileId + '/edit';
  }
  return {
    ...artifact,
    id: artifact?.id || uid(),
    title,
    name: title,
    type,
    provider: artifact?.provider || spec.provider,
    status: artifact?.status || 'draft',
    fileId,
    fileName: artifact?.fileName || artifact?.path || '',
    url,
    driveUrl: artifact?.driveUrl || '',
    projectId: artifact?.projectId || project?.id || '',
    projectTitle: String(project?.title || project?.name || 'Project').trim() || 'Project',
    createdAt: artifact?.createdAt || new Date().toISOString(),
  };
}

async function loadArtifacts(project) {
  const existing = await findFile(DRIVE.artifactsFile, project.folderId);
  if (!existing) return [];
  const data = await readJsonFile(existing.id);
  const artifacts = data && Array.isArray(data.artifacts) ? data.artifacts : [];
  return artifacts.map((artifact) => normalizeArtifact(artifact, project));
}

async function saveArtifacts(project, artifacts) {
  const normalized = artifacts.map((artifact) => normalizeArtifact(artifact, project));
  const existing = await findFile(DRIVE.artifactsFile, project.folderId);
  await writeJsonFile({
    name: DRIVE.artifactsFile,
    parentId: project.folderId,
    existingId: existing ? existing.id : null,
    data: {
      version: 1,
      projectId: project.id,
      projectName: project.name,
      updatedAt: new Date().toISOString(),
      artifacts: normalized,
    },
    errorLabel: 'Could not save the project artifact index in Google Drive.',
  });
  return normalized;
}

async function createDiagramFile(project, title, artifactId) {
  const slug = slugify(title) || 'design-board';
  const fileName = slug + '-' + artifactId.slice(0, 8) + '.drawio';
  const existing = await findFile(fileName, project.folderId, ["mimeType='application/vnd.jgraph.mxfile'"]);
  if (existing) {
    return {
      fileId: existing.id,
      fileName: existing.name || fileName,
      driveUrl: existing.webViewLink || DRIVE_FILES + '/' + existing.id,
      editorUrl: diagramEditorUrl(existing.id),
    };
  }

  const diagramXml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" modified="${new Date().toISOString()}" agent="Mozilla/5.0" version="24.7.17">
  <diagram id="${artifactId}" name="${title}">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="root"/>
        <mxCell id="board" parent="root"/>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

  const boundary = 'domark_design';
  const response = await driveFetch(DRIVE_UPLOAD + '?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
    body: multipartBody(
      boundary,
      { name: fileName, mimeType: 'application/vnd.jgraph.mxfile', parents: [project.folderId] },
      'application/xml',
      diagramXml
    ),
  });
  if (!response.ok) throw new Error('Could not create the design-board file in the project folder.');

  const created = await response.json();
  return {
    fileId: created.id,
    fileName: created.name || fileName,
    driveUrl: created.webViewLink || DRIVE_FILES + '/' + created.id,
    editorUrl: diagramEditorUrl(created.id),
  };
}

// Opens the specific Drive file for in-place editing (draw.io Google Drive mode).
// Each file has a unique id, so every board opens and saves to its own file.
function diagramEditorUrl(fileId) {
  return 'https://app.diagrams.net/#G' + fileId;
}

async function createGoogleFile(project, title, artifactId, type) {
  const spec = ARTIFACT_TYPES[type] || ARTIFACT_TYPES.gdoc;
  const fileName = slugify(title) + '-' + artifactId.slice(0, 8);
  // Deterministic editor URL for the file's own app (Docs/Sheets/Slides).
  const editorUrlFor = (id) => 'https://docs.google.com/' + spec.drivePath + '/d/' + id + '/edit';
  const existing = await findFile(fileName, project.folderId, ["mimeType='" + spec.mimeType + "'"]);
  if (existing) {
    return {
      fileId: existing.id,
      fileName: existing.name || fileName,
      driveUrl: existing.webViewLink || editorUrlFor(existing.id),
      editorUrl: editorUrlFor(existing.id),
    };
  }

  const response = await driveFetch(DRIVE_FILES + '?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: fileName,
      mimeType: spec.mimeType,
      parents: [project.folderId],
    }),
  });
  if (!response.ok) throw new Error('Could not create the ' + spec.label + ' in the project folder.');

  const created = await response.json();
  return {
    fileId: created.id,
    fileName: created.name || fileName,
    driveUrl: created.webViewLink || editorUrlFor(created.id),
    editorUrl: editorUrlFor(created.id),
  };
}

/* ---------- Insights ledger (Phase 1: capture behaviour events) ---------- */

let insightsCache = null;

function insightsMonthKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function insightsDayKey(iso) {
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function insightsDayDiff(aKey, bKey) {
  const [ay, am, ad] = aKey.split('-').map(Number);
  const [by, bm, bd] = bKey.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

function emptyInsights() {
  return {
    version: 1,
    seen: {},
    completed: {},
    totals: { bookmarksAdded: 0, projectsCreated: 0, projectsCompleted: 0 },
    streak: { current: 0, longest: 0, lastActiveDate: null },
    lastSync: null,
  };
}

async function ensureInsightsFolder() {
  const { rootFolderId } = await ensureStructure();
  let id = localStorage.getItem(STORAGE_KEYS.driveInsights);
  if (id && !(await folderExists(id))) {
    // Insights folder was deleted in Drive -> drop the stale local snapshot so no phantom counts remain.
    id = null;
    insightsCache = null;
    try {
      localStorage.removeItem(STORAGE_KEYS.insightsCache);
    } catch {
      /* ignore */
    }
  }
  if (!id) {
    id = await ensureFolder(DRIVE.insightsFolder, rootFolderId);
    localStorage.setItem(STORAGE_KEYS.driveInsights, id);
  }
  return id;
}

async function loadInsightsState() {
  if (insightsCache) return insightsCache;
  try {
    const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.insightsCache) || 'null');
    if (local && local.version) insightsCache = local;
  } catch {
    /* ignore corrupt local cache */
  }
  if (state.token) {
    const folderId = await ensureInsightsFolder();
    const existing = await findFile(DRIVE.insightsState, folderId);
    if (existing) {
      const data = await readJsonFile(existing.id);
      if (data && data.version) insightsCache = data;
    }
  }
  if (!insightsCache) insightsCache = emptyInsights();
  return insightsCache;
}

async function saveInsightsState(data) {
  insightsCache = data;
  try {
    localStorage.setItem(STORAGE_KEYS.insightsCache, JSON.stringify(data));
  } catch {
    /* ignore quota errors */
  }
  if (!state.token) return;
  const folderId = await ensureInsightsFolder();
  const existing = await findFile(DRIVE.insightsState, folderId);
  await writeJsonFile({
    name: DRIVE.insightsState,
    parentId: folderId,
    existingId: existing ? existing.id : null,
    data,
    errorLabel: 'Could not save insights state to Google Drive.',
  });
}

// Append events into monthly partition files so each stays small and cheap to load.
async function appendInsightEvents(events) {
  if (!events.length || !state.token) return;
  const folderId = await ensureInsightsFolder();
  const byMonth = new Map();
  events.forEach((event) => {
    const key = insightsMonthKey(new Date(event.at));
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(event);
  });
  for (const [key, monthEvents] of byMonth) {
    const name = 'events-' + key + '.json';
    const existing = await findFile(name, folderId);
    const current = existing ? await readJsonFile(existing.id) : null;
    const list = current && Array.isArray(current.events) ? current.events : [];
    list.push(...monthEvents);
    await writeJsonFile({
      name,
      parentId: folderId,
      existingId: existing ? existing.id : null,
      data: { version: 1, month: key, events: list },
      errorLabel: 'Could not save insights events to Google Drive.',
    });
  }
}

// Streak rewards action; count each active day once, reset if a day is missed.
function bumpStreak(insights, atISO) {
  const day = insightsDayKey(atISO);
  const last = insights.streak.lastActiveDate;
  if (last === day) return;
  insights.streak.current = last && insightsDayDiff(last, day) === 1 ? insights.streak.current + 1 : 1;
  insights.streak.lastActiveDate = day;
  insights.streak.longest = Math.max(insights.streak.longest, insights.streak.current);
}

// New inbox items become bookmark_added events, timestamped by their source-added time.
export async function recordBookmarksSeen(sourceId, items) {
  if (!sourceId || !Array.isArray(items) || items.length === 0) return;
  const insights = await loadInsightsState();
  const seen = insights.seen[sourceId] || (insights.seen[sourceId] = {});
  const nowISO = new Date().toISOString();
  const newEvents = [];
  items.forEach((item) => {
    const refId = item && item.refId;
    if (!refId || seen[refId]) return;
    seen[refId] = nowISO;
    insights.totals.bookmarksAdded += 1;
    newEvents.push({
      id: uid(),
      type: 'bookmark_added',
      at: item.addedAt || nowISO,
      source: sourceId,
      refId,
      title: item.title || '',
    });
  });
  if (newEvents.length === 0) return;
  insights.lastSync = nowISO;
  if (newEvents.length) await appendInsightEvents(newEvents);
  await saveInsightsState(insights);
}

export async function recordProjectCreated(project) {
  const insights = await loadInsightsState();
  const at = project.createdAt || new Date().toISOString();
  insights.totals.projectsCreated += 1;
  bumpStreak(insights, at);
  await appendInsightEvents([
    {
      id: uid(),
      type: 'project_created',
      at,
      projectId: project.id,
      refId: project.bookmark && project.bookmark.refId ? project.bookmark.refId : null,
      source: project.bookmark && project.bookmark.source ? project.bookmark.source : null,
      title: project.name,
    },
  ]);
  await saveInsightsState(insights);
}

export async function recordProjectCompleted(project) {
  const insights = await loadInsightsState();
  insights.completed = insights.completed || {};
  if (insights.completed[project.id]) return;
  const at = new Date().toISOString();
  insights.completed[project.id] = at;
  insights.totals.projectsCompleted += 1;
  bumpStreak(insights, at);
  await appendInsightEvents([{ id: uid(), type: 'project_completed', at, projectId: project.id, title: project.name }]);
  await saveInsightsState(insights);
}

export async function loadInsights() {
  return loadInsightsState();
}

// Read the last `months` monthly partitions and return a merged, chronological event list.
export async function loadInsightEvents(months = 6) {
  if (!state.token) return [];
  const folderId = await ensureInsightsFolder();
  const now = new Date();
  const events = [];
  for (let i = 0; i < months; i += 1) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const name = 'events-' + insightsMonthKey(monthDate) + '.json';
    const existing = await findFile(name, folderId);
    if (!existing) continue;
    const data = await readJsonFile(existing.id);
    if (data && Array.isArray(data.events)) events.push(...data.events);
  }
  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

export async function createProjectFromItem(item, formData) {
  const name = String(formData.name || item?.title || '').trim();
  if (!name) throw new Error('Project name is required.');
  if (!state.token) throw new Error('Please sign in before creating a Google Drive project.');

  const index = await loadProjectIndex();
  const nameExists =
    state.projects.some((project) => project.name.toLowerCase() === name.toLowerCase()) ||
    index.projects.some((entry) => String(entry.name).toLowerCase() === name.toLowerCase());
  if (nameExists) throw new Error('A project with this name already exists.');

  const id = uid();
  const { projectsFolderId } = await ensureStructure();
  const slug = slugify(name);
  // Unique folder name so different names that slugify identically never share a folder.
  const folderId = await ensureFolder(slug + '-' + id.slice(0, 8), projectsFolderId);

  const project = {
    id,
    title: name,
    name,
    slug,
    folderId,
    bookmark: item || null,
    bookmarkRef: (item && item.refId) || null,
    description: String(formData.description || ''),
    category: formData.category || 'Others',
    tags: Array.isArray(formData.tags) ? formData.tags : [],
    status: 'In progress',
    progress: 0,
    createdAt: new Date().toISOString(),
    artifacts: [],
  };

  index.projects.unshift({
    id: project.id,
    name,
    slug,
    folderId,
    bookmarkRef: project.bookmarkRef,
    createdAt: project.createdAt,
    description: project.description,
    category: project.category,
    tags: project.tags,
    status: project.status,
    progress: project.progress,
  });

  await saveProjectIndex(index);
  await saveProjectMetadata(project);
  await saveArtifacts(project, []);

  state.projects.unshift(project);
  saveProjects();
  try {
    await recordProjectCreated(project);
  } catch {
    /* insights are best-effort */
  }
  return project;
}

export async function createArtifact(project, requestedTitle, requestedType) {
  const type = ARTIFACT_TYPES[String(requestedType).toLowerCase()] ? String(requestedType).toLowerCase() : 'drawio';
  const spec = ARTIFACT_TYPES[type];
  const title = String(requestedTitle || spec.label).trim() || spec.label;
  const artifactId = uid();

  const fileData =
    type === 'drawio'
      ? await createDiagramFile(project, title, artifactId)
      : await createGoogleFile(project, title, artifactId, type);

  const artifact = normalizeArtifact(
    {
      id: artifactId,
      title,
      type,
      provider: spec.provider,
      status: 'draft',
      fileId: fileData.fileId,
      fileName: fileData.fileName,
      url: fileData.editorUrl,
      driveUrl: fileData.driveUrl,
      createdAt: new Date().toISOString(),
    },
    project,
    title
  );

  const existing = Array.isArray(project.artifacts) ? project.artifacts : [];
  const merged = await saveArtifacts(project, [...existing, artifact]);
  project.artifacts = merged;
  saveProjects();
  return artifact;
}

export async function createRecordingArtifact(project, details = {}) {
  const videoId = details.videoId || '';
  const url = details.url || (videoId ? 'https://www.youtube.com/watch?v=' + videoId : '');
  const artifact = normalizeArtifact(
    {
      id: uid(),
      title: String(details.title || 'Recording').trim() || 'Recording',
      type: 'recording',
      provider: 'youtube',
      status: 'uploaded',
      fileId: videoId,
      fileName: 'YouTube video',
      url,
      driveUrl: url,
      createdAt: new Date().toISOString(),
    },
    project,
    'Recording'
  );

  const existing = Array.isArray(project.artifacts) ? project.artifacts : [];
  const merged = await saveArtifacts(project, [...existing, artifact]);
  project.artifacts = merged;
  saveProjects();
  return artifact;
}

export async function createLinkArtifact(project, details = {}) {
  const url = String(details.url || '').trim();
  if (!url) throw new Error('A link URL is required.');
  let title = String(details.title || '').trim();
  if (!title) {
    try {
      title = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      title = 'Link';
    }
  }
  const artifact = normalizeArtifact(
    {
      id: uid(),
      title,
      type: 'link',
      provider: 'web',
      status: 'saved',
      fileId: '',
      fileName: url,
      url,
      driveUrl: url,
      createdAt: new Date().toISOString(),
    },
    project,
    'Link'
  );

  const existing = Array.isArray(project.artifacts) ? project.artifacts : [];
  const merged = await saveArtifacts(project, [...existing, artifact]);
  project.artifacts = merged;
  saveProjects();
  return artifact;
}

export async function syncProjectArtifacts(project) {
  const artifacts = await loadArtifacts(project);
  project.artifacts = artifacts;
  saveProjects();
  return artifacts;
}
