// Google Drive integration: folder structure, project index, metadata and artifacts.

import { STORAGE_KEYS, DRIVE, ARTIFACT_TYPES } from './config.js';
import { state, saveProjects } from './store.js';
import { getActiveProfile, profileKey } from './profiles.js';
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
    const response = await driveFetch(DRIVE_UPLOAD + '/' + existingId + '?uploadType=media&fields=id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error(errorLabel);
    return existingId;
  }
  const boundary = 'domark_boundary';
  const response = await driveFetch(DRIVE_UPLOAD + '?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
    body: multipartBody(boundary, { name, mimeType: 'application/json', parents: [parentId] }, 'application/json', body),
  });
  if (!response.ok) throw new Error(errorLabel);
  const created = await response.json().catch(() => null);
  return created ? created.id : null;
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

// In-flight structure resolution, shared by concurrent callers so folders are never created twice.
let structurePromise = null;

// Layout: domark/profiles/<profile>/projects/ and .../insights/ — uniform for every profile, default included.
async function resolveStructure() {
  const profile = getActiveProfile();
  let rootFolderId = localStorage.getItem(STORAGE_KEYS.driveRoot);
  let profilesFolderId = localStorage.getItem(STORAGE_KEYS.driveProfilesFolder);
  let profileFolderId = localStorage.getItem(profileKey(STORAGE_KEYS.driveProfile));
  let projectsFolderId = localStorage.getItem(profileKey(STORAGE_KEYS.driveProjects));

  // Once per session, verify cached ids top-down so we never read/write into folders deleted in Drive.
  if (!structureVerified && state.token) {
    if (rootFolderId && !(await folderExists(rootFolderId))) {
      rootFolderId = profilesFolderId = profileFolderId = projectsFolderId = null;
    }
    if (profilesFolderId && !(await folderExists(profilesFolderId))) {
      profilesFolderId = profileFolderId = projectsFolderId = null;
    }
    if (profileFolderId && !(await folderExists(profileFolderId))) {
      profileFolderId = projectsFolderId = null;
    }
    if (projectsFolderId && !(await folderExists(projectsFolderId))) {
      projectsFolderId = null;
    }
    structureVerified = true;
  }

  if (!rootFolderId) {
    rootFolderId = await ensureFolder(DRIVE.rootFolder);
    localStorage.setItem(STORAGE_KEYS.driveRoot, rootFolderId);
  }
  if (!profilesFolderId) {
    profilesFolderId = await ensureFolder(DRIVE.profilesFolder, rootFolderId);
    localStorage.setItem(STORAGE_KEYS.driveProfilesFolder, profilesFolderId);
  }
  if (!profileFolderId) {
    profileFolderId = await ensureFolder(profile, profilesFolderId);
    localStorage.setItem(profileKey(STORAGE_KEYS.driveProfile), profileFolderId);
  }
  if (!projectsFolderId) {
    projectsFolderId = await ensureFolder(DRIVE.projectsFolder, profileFolderId);
    localStorage.setItem(profileKey(STORAGE_KEYS.driveProjects), projectsFolderId);
  }
  return { rootFolderId, profilesFolderId, profileFolderId, projectsFolderId };
}

// Memoized: concurrent boot tasks await the same resolution instead of each creating folders.
function ensureStructure() {
  if (!structurePromise) {
    structurePromise = resolveStructure().catch((error) => {
      structurePromise = null; // allow a retry after a transient failure
      throw error;
    });
  }
  return structurePromise;
}

// Drop in-memory caches so the next Drive access re-resolves folders for the newly active profile.
export function resetProfileCaches() {
  structureVerified = false;
  structurePromise = null;
}

// The profiles registry lives at the domark root (outside the profiles/ folder).
async function domarkRootId() {
  await ensureStructure();
  return localStorage.getItem(STORAGE_KEYS.driveRoot);
}

// Resolve the shared domark/profiles folder (where each profile folder lives).
async function profilesFolderId() {
  await ensureStructure();
  return localStorage.getItem(STORAGE_KEYS.driveProfilesFolder);
}

export async function loadProfilesList() {
  const rootId = await domarkRootId();
  if (!rootId) return null;
  const existing = await findFile(DRIVE.profilesFile, rootId);
  if (!existing) return null;
  const data = await readJsonFile(existing.id);
  return data && Array.isArray(data.profiles) ? data.profiles : null;
}

export async function saveProfilesList(profiles) {
  const rootId = await domarkRootId();
  const existing = await findFile(DRIVE.profilesFile, rootId);
  await writeJsonFile({
    name: DRIVE.profilesFile,
    parentId: rootId,
    existingId: existing ? existing.id : null,
    data: { version: 1, profiles },
    errorLabel: 'Could not save profiles to Google Drive.',
  });
}

// Per-profile settings.json lives in the active profile folder.
export async function loadSettingsFile() {
  const { profileFolderId } = await ensureStructure();
  const existing = await findFile(DRIVE.settingsFile, profileFolderId);
  if (!existing) return null;
  return readJsonFile(existing.id);
}

export async function saveSettingsFile(data) {
  const { profileFolderId } = await ensureStructure();
  const existing = await findFile(DRIVE.settingsFile, profileFolderId);
  await writeJsonFile({
    name: DRIVE.settingsFile,
    parentId: profileFolderId,
    existingId: existing ? existing.id : null,
    data,
    errorLabel: 'Could not save settings to Google Drive.',
  });
}

async function findFolder(name, parentId) {
  const clauses = [
    "name='" + name.replace(/'/g, "\\'") + "'",
    "mimeType='application/vnd.google-apps.folder'",
    "'" + parentId + "' in parents",
    'trashed=false',
  ];
  const res = await driveFetch(DRIVE_FILES + '?q=' + driveQuery(clauses) + '&spaces=drive&fields=files(id,name)');
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && data.files && data.files[0] ? data.files[0] : null;
}

// Trash a named profile's Drive folder (domark/profiles/<name>).
export async function deleteProfileFolder(name) {
  if (!state.token || !name || name === DRIVE.defaultProfile) return;
  const parentId = await profilesFolderId();
  if (!parentId) return;
  const folder = await findFolder(name, parentId);
  if (!folder) return;
  await driveFetch(DRIVE_FILES + '/' + folder.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

// Wipe the active profile's data in place (projects folder + index, insights, settings) while keeping the profile itself.
export async function resetProfileData() {
  if (!state.token) return;
  const { profileFolderId } = await ensureStructure();
  if (!profileFolderId) return;
  const trash = (id) =>
    driveFetch(DRIVE_FILES + '/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  // The projects folder holds both the index and every project folder, so trashing it clears them together.
  const projects = await findFolder(DRIVE.projectsFolder, profileFolderId);
  if (projects) await trash(projects.id);
  const settings = await findFile(DRIVE.settingsFile, profileFolderId);
  if (settings) await trash(settings.id);
  // Drop cached folder ids so the next Drive access recreates a fresh, empty structure.
  localStorage.removeItem(profileKey(STORAGE_KEYS.driveProjects));
  resetProfileCaches();
}

async function loadProjectIndex() {
  const { projectsFolderId } = await ensureStructure();
  const existing = await findFile(DRIVE.indexFile, projectsFolderId);
  if (!existing) {
    const emptyIndex = { version: 1, projects: [] };
    await saveProjectIndex(emptyIndex);
    return emptyIndex;
  }
  const data = await readJsonFile(existing.id);
  return data && Array.isArray(data.projects) ? data : { version: 1, projects: [] };
}

async function saveProjectIndex(index) {
  const { projectsFolderId } = await ensureStructure();
  const existing = await findFile(DRIVE.indexFile, projectsFolderId);
  await writeJsonFile({
    name: DRIVE.indexFile,
    parentId: projectsFolderId,
    existingId: existing ? existing.id : null,
    data: index,
    errorLabel: 'Could not save the Domark project index to Google Drive.',
  });
}

// One file per project holds both its metadata and artifacts, so opening a project is a single read.
async function saveProjectMetadata(project) {
  let existingId = project.fileId || null;
  // Resolve the existing file once (by id if known, else by name) so we never create a duplicate project.json.
  if (!existingId) {
    const existing = await findFile(DRIVE.projectFile, project.folderId);
    if (existing) existingId = existing.id;
  }
  const record = { ...project };
  delete record.fileId;
  const fileId = await writeJsonFile({
    name: DRIVE.projectFile,
    parentId: project.folderId,
    existingId,
    data: record,
    errorLabel: 'Could not save project metadata in Google Drive.',
  });
  if (fileId) project.fileId = fileId;
  return fileId;
}

export async function saveProjectStatus(project) {
  if (!state.token) throw new Error('Please sign in to sync project status to Google Drive.');

  // Write project.json first so project.fileId is known, then mirror it into the index entry.
  await saveProjectMetadata(project);
  const index = await loadProjectIndex();
  const entry = index.projects.find((item) => item.id === project.id);
  if (entry) {
    entry.status = project.status;
    entry.progress = project.progress;
    entry.completedAt = project.completedAt;
    entry.fileId = project.fileId;
    await saveProjectIndex(index);
  }
}

// Persist edited overview fields (name, category, description, tags) to the index and project file.
export async function saveProjectDetails(project) {
  if (!state.token) throw new Error('Please sign in to sync project changes to Google Drive.');

  await saveProjectMetadata(project);
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
    entry.completedAt = project.completedAt;
    entry.fileId = project.fileId;
    await saveProjectIndex(index);
  }
}

// Read a project's full record (project.json) — used to lazily restore its source bookmark.
export async function loadProjectMetadata(project) {
  return readProjectFile(project);
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
      fileId: entry.fileId || (local && local.fileId) || null,
      description: entry.description || '',
      category: entry.category || 'Others',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      status: entry.status || 'In progress',
      progress: Number.isFinite(entry.progress) ? entry.progress : local?.progress ?? 0,
      completedAt: entry.completedAt || (local && local.completedAt) || null,
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

/* ---------- Drive-native project sharing ---------- */

// Grant a user edit access to a project by sharing its Drive folder; contents inherit the permission.
export async function shareProject(project, email) {
  if (!state.token) throw new Error('Please sign in to share a project.');
  if (!project || !project.folderId) throw new Error('This project cannot be shared yet.');
  const address = String(email || '').trim();
  if (!address) throw new Error('Enter an email address to share with.');

  const response = await driveFetch(
    DRIVE_FILES + '/' + project.folderId + '/permissions?sendNotificationEmail=true&fields=id',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: address }),
    }
  );
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error((detail && detail.error && detail.error.message) || 'Could not share this project.');
  }
  return response.json().catch(() => null);
}

// Revoke a previously granted permission on the project folder.
export async function unshareProject(project, permissionId) {
  if (!state.token) throw new Error('Please sign in to update sharing.');
  if (!project || !project.folderId || !permissionId) return;
  const response = await driveFetch(DRIVE_FILES + '/' + project.folderId + '/permissions/' + permissionId, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) throw new Error('Could not remove this person from the project.');
}

// List everyone with access to a project folder (excludes the owner) so the UI can show/manage sharing.
export async function listProjectPermissions(project) {
  if (!state.token || !project || !project.folderId) return [];
  const url =
    DRIVE_FILES + '/' + project.folderId +
    '/permissions?fields=permissions(id,type,role,emailAddress,displayName)';
  const response = await driveFetch(url);
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  const permissions = (payload && Array.isArray(payload.permissions) && payload.permissions) || [];
  return permissions.filter((permission) => permission.role !== 'owner' && permission.type === 'user');
}

// ::: Code Generated by Copilot 7b3f1a9c-2d6e-4c81-9f42-8e5a0b1c3d77. This comment will be removed automatically after the file is saved :::
// Rebuild state.sharedProjects from Drive's "shared with me" — account-global, independent of the active profile.
// Sharing grants access to the project FOLDER, so the folder (not project.json) is what carries sharedWithMe;
// we list shared folders, then read the project.json each one contains.
export async function hydrateSharedProjects() {
  if (!state.token) return state.sharedProjects;
  const clauses = ["mimeType='application/vnd.google-apps.folder'", 'sharedWithMe=true', 'trashed=false'];
  const url =
    DRIVE_FILES + '?q=' + driveQuery(clauses) +
    '&spaces=drive&fields=files(id,name,owners(displayName,emailAddress))';
  const response = await driveFetch(url);
  if (!response.ok) return state.sharedProjects;
  const payload = await response.json().catch(() => null);
  const folders = (payload && Array.isArray(payload.files) && payload.files) || [];

  const projects = await Promise.all(
    folders.map(async (folder) => {
      const projectFile = await findFile(DRIVE.projectFile, folder.id);
      if (!projectFile) return null;
      const data = await readJsonFile(projectFile.id);
      if (!data || !data.id) return null;
      const owner = (Array.isArray(folder.owners) && folder.owners[0]) || {};
      const project = {
        id: data.id,
        title: data.name || data.title || 'Project',
        name: data.name || data.title || 'Project',
        slug: data.slug || '',
        folderId: folder.id,
        fileId: projectFile.id,
        description: data.description || '',
        category: data.category || 'Others',
        tags: Array.isArray(data.tags) ? data.tags : [],
        status: data.status || 'In progress',
        progress: Number.isFinite(data.progress) ? data.progress : 0,
        completedAt: data.completedAt || null,
        createdAt: data.createdAt || new Date().toISOString(),
        bookmarkRef: data.bookmarkRef || null,
        bookmark: data.bookmark ?? undefined,
        // Read-only in-app: shared users open artifacts but cannot edit the project or add/delete artifacts.
        ownership: 'shared',
        readOnly: true,
        owner: { name: owner.displayName || '', email: owner.emailAddress || '' },
        artifacts: [],
      };
      project.artifacts = (Array.isArray(data.artifacts) ? data.artifacts : []).map((artifact) =>
        normalizeArtifact(artifact, project)
      );
      return project;
    })
  );

  state.sharedProjects = projects.filter(Boolean);
  state.sharedProjectsLoaded = true;
  return state.sharedProjects;
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

// Read a project's project.json directly by its cached file id, falling back to a one-time name lookup.
async function readProjectFile(project) {
  if (!project || !project.folderId) return null;
  let fileId = project.fileId;
  if (!fileId) {
    const existing = await findFile(DRIVE.projectFile, project.folderId);
    if (!existing) return null;
    fileId = existing.id;
    project.fileId = fileId;
  }
  return readJsonFile(fileId);
}

async function loadArtifacts(project) {
  const data = await readProjectFile(project);
  const artifacts = data && Array.isArray(data.artifacts) ? data.artifacts : [];
  return artifacts.map((artifact) => normalizeArtifact(artifact, project));
}

// Artifacts live inside project.json, so saving them rewrites the single project record.
async function saveArtifacts(project, artifacts) {
  const normalized = artifacts.map((artifact) => normalizeArtifact(artifact, project));
  project.artifacts = normalized;
  await saveProjectMetadata(project);
  return normalized;
}

// Remove one artifact from a project; trash its backing Drive file for Docs/diagrams (recordings/links have none).
export async function deleteArtifact(project, artifactId) {
  const artifacts = Array.isArray(project.artifacts) ? project.artifacts : [];
  const target = artifacts.find((entry) => String(entry.id) === String(artifactId));
  const remaining = artifacts.filter((entry) => String(entry.id) !== String(artifactId));
  await saveArtifacts(project, remaining);
  const hasDriveFile = target && target.fileId && (target.type === 'drawio' || ARTIFACT_TYPES[target.type]?.mimeType);
  if (hasDriveFile && state.token) {
    try {
      await driveFetch(DRIVE_FILES + '/' + target.fileId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
    } catch {
      /* non-fatal; the artifact is already gone from the project */
    }
  }
  return project.artifacts;
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

// Open the draw.io file via its Google Drive link so it launches under the owning account (then "Open with diagrams.net").
function diagramEditorUrl(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view?usp=drive_link';
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

/* ---------- Project creation ---------- */

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
    completedAt: null,
    createdAt: new Date().toISOString(),
    artifacts: [],
  };

  // Write project.json first so its file id can be stored in the index entry.
  await saveProjectMetadata(project);

  index.projects.unshift({
    id: project.id,
    name,
    slug,
    folderId,
    fileId: project.fileId,
    bookmarkRef: project.bookmarkRef,
    createdAt: project.createdAt,
    completedAt: project.completedAt,
    description: project.description,
    category: project.category,
    tags: project.tags,
    status: project.status,
    progress: project.progress,
  });

  await saveProjectIndex(index);

  state.projects.unshift(project);
  saveProjects();
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
