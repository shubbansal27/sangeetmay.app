'use strict';

// ── sa·re·ga·ma — Google API Module ──────────────────────────────────────────
// Handles: popup OAuth, Drive JSON data store, Google Docs notes,
//          IndexedDB recordings (local), YouTube search + upload.
//
// Requires window.PM_YT_CLIENT_ID (set in yt-config.js).
// auth-callback.html must exist alongside index.html (handles OAuth redirect).
// No server required — works on GitHub Pages and any static host.
// ─────────────────────────────────────────────────────────────────────────────

const YTUpload = (() => {
  const PROFILE_KEY  = 'pm_google_profile';
  const FOLDER_KEY   = 'pm_folder_id';
  const YT_TOKEN_KEY = 'pm_yt_token'; // sessionStorage — survives refresh, clears on tab close
  const FOLDER_NAME = 'sangeetmay';
  const INDEX_FILE  = 'projects.json';
  const PROJ_FILE   = 'project.json';
  const NOTES_FILE  = 'notes.html';

  // ── Token slots ───────────────────────────────────────────
  let _token       = null;  // openid profile email drive.file — sign-in
  let _ytToken     = null;  // youtube.readonly + youtube.upload — lazy, shared

  // ── In-memory state ───────────────────────────────────────
  let _profile      = null;
  let _folderId     = null;  // sangeetmay/ folder ID
  let _indexFileId  = null;  // projects.json file ID
  let _projectsIdx  = null;  // cached projects index array
  let _projCache    = {};    // projectId → {data, fileId, notesFileId}

  // Restore profile + folder ID from localStorage
  try { _profile  = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (_) {}
  try { _folderId = localStorage.getItem(FOLDER_KEY) || null; } catch (_) {}
  // Restore YouTube token from sessionStorage (survives refresh within the same tab)
  try { _ytToken = sessionStorage.getItem(YT_TOKEN_KEY) || null; } catch (_) {}

  // ── OAuth scopes ──────────────────────────────────────────
  // Sign-in covers Drive only. YouTube scopes are acquired lazily on first use
  // and stored in sessionStorage so refreshes within the same tab need no popup.
  const SCOPE_ALL = 'openid profile email https://www.googleapis.com/auth/drive.file';
  // Both YouTube scopes combined — one grant covers search AND upload.
  const SCOPE_YT  = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload';

  // ── Utilities ─────────────────────────────────────────────
  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function _slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  }

  // ── Configured? ───────────────────────────────────────────
  function isConfigured() {
    return typeof window.PM_YT_CLIENT_ID === 'string' && window.PM_YT_CLIENT_ID.trim() !== '';
  }

  // ── Auth: popup + postMessage ─────────────────────────────
  // auth-callback.html reads the hash token and posts it back to window.opener.
  // Works on localhost and any static host (GitHub Pages, Vercel, etc.).
  function _callbackUrl() {
    return new URL('auth-callback.html', window.location.href).href;
  }

  function _openAuthPopup(scope, state, extraParams = {}) {
    if (!isConfigured()) throw new Error('PM_YT_CLIENT_ID not set. Edit src/yt-config.js.');
    const params = new URLSearchParams({
      client_id:     window.PM_YT_CLIENT_ID.trim(),
      redirect_uri:  _callbackUrl(),
      response_type: 'token',
      scope,
      state,
      prompt:        'select_account',
      ...extraParams,
    });
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
    const w = 600, h = 700;
    const left = Math.max(0, Math.floor((screen.width  - w) / 2));
    const top  = Math.max(0, Math.floor((screen.height - h) / 2));
    return new Promise((resolve, reject) => {
      const popup = window.open(authUrl, 'sargama_auth',
        `width=${w},height=${h},left=${left},top=${top},resizable=yes`);
      if (!popup) {
        reject(new Error('Popup blocked. Please allow popups for this site and try again.'));
        return;
      }
      let settled = false;
      const closePoll = setInterval(() => {
        if (popup.closed) {
          clearInterval(closePoll);
          // Wait 600ms for any in-flight postMessage to arrive before giving up
          setTimeout(() => {
            if (!settled) {
              settled = true;
              window.removeEventListener('message', onMsg);
              reject(new Error('Sign-in window was closed. Please try again.'));
            }
          }, 600);
        }
      }, 500);
      function onMsg(e) {
        if (e.origin !== window.location.origin) return;
        if (!e.data || e.data.type !== 'sargama_auth_token') return;
        if (settled) return;
        settled = true;
        clearInterval(closePoll);
        window.removeEventListener('message', onMsg);
        try { popup.close(); } catch (_) {}
        if (e.data.error) reject(new Error(e.data.error));
        else              resolve(e.data.token);
      }
      window.addEventListener('message', onMsg);
    });
  }

  // ── Profile ───────────────────────────────────────────────
  async function _fetchProfile(token) {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
      { headers: { Authorization: 'Bearer ' + token } });
    if (!resp.ok) return null;
    const d = await resp.json();
    return { name: d.name || d.email, email: d.email, picture: d.picture };
  }

  // ── Sign in / out ─────────────────────────────────────────

  // Try to silently restore a token without any user interaction.
  // Uses prompt=none — Google grants immediately if session is alive, otherwise rejects.
  // Returns the profile on success, null on failure.
  async function silentSignIn() {
    if (!isConfigured() || !_profile || !_profile.email) return null;
    try {
      const token = await _openAuthPopup(SCOPE_ALL, 'silent', {
        prompt:     'none',
        login_hint: _profile.email,
      });
      _token = token;
      // Do NOT touch _ytToken here — it is a separate scope restored from sessionStorage
      return _profile;
    } catch (_) {
      return null; // interaction_required or session expired — user must sign in manually
    }
  }

  async function signIn() {
    const token = await _openAuthPopup(SCOPE_ALL, 'signin');
    _token = token;
    const profile = await _fetchProfile(token);
    if (!profile) { _token = null; throw new Error('Could not read your Google profile. Please try again.'); }
    _profile = { ...profile };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(_profile));
    return _profile;
  }

  function signOut() {
    [_token, _ytToken].forEach((t) => {
      if (t && typeof google !== 'undefined') {
        try { google.accounts.oauth2.revoke(t, () => {}); } catch (_) {}
      }
    });
    _token = _ytToken = null;
    _profile = null;
    _folderId = null;
    _indexFileId = null;
    _projectsIdx = null;
    _projCache = {};
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(FOLDER_KEY);
    try { sessionStorage.removeItem(YT_TOKEN_KEY); } catch (_) {}
  }

  // ── Authenticated fetch (auto-popup on 401) ───────────────
  async function _authedFetch(url, opts = {}) {
    if (!_token) _token = await _acquireToken(SCOPE_ALL, 'signin');
    const go = (tk) => fetch(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + tk } });
    let resp = await go(_token);
    if (resp.status === 401) {
      _token = await _openAuthPopup(SCOPE_ALL, 'signin');
      resp = await go(_token);
    }
    return resp;
  }

  // ── Drive folder structure ────────────────────────────────
  //
  //  sangeetmay/
  //  ├── projects.json          ← lightweight index of all projects
  //  └── <project-slug>/        ← one folder per project
  //      ├── project.json       ← references, uploadedTakes
  //      └── notes.html         ← rich-text notes (openable in Drive)
  //
  // ─────────────────────────────────────────────────────────

  // ── Root folder ───────────────────────────────────────────
  async function _ensureFolder() {
    if (_folderId) return _folderId;
    const q = encodeURIComponent(
      `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const sr = await _authedFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
    );
    if (!sr.ok) throw new Error('Could not access Google Drive.');
    const { files } = await sr.json();
    if (files && files.length > 0) {
      _folderId = files[0].id;
    } else {
      const r = await _authedFetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      });
      if (!r.ok) throw new Error('Could not create app folder in Google Drive.');
      _folderId = (await r.json()).id;
    }
    localStorage.setItem(FOLDER_KEY, _folderId);
    return _folderId;
  }

  function getFolderUrl() {
    return _folderId ? `https://drive.google.com/drive/folders/${_folderId}` : null;
  }

  // ── Helpers: JSON + HTML multipart upload ─────────────────
  async function _uploadJson(method, fileId, parentId, fileName, obj) {
    const body = JSON.stringify(obj);
    if (method === 'PATCH' && fileId) {
      const r = await _authedFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
      );
      if (!r.ok) throw new Error(`Could not update ${fileName}.`);
      return fileId;
    }
    const bnd  = 'srgm_' + Date.now();
    const meta = JSON.stringify({ name: fileName, mimeType: 'application/json', parents: [parentId] });
    const mp   = `--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}` +
                 `\r\n--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${bnd}--`;
    const r = await _authedFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary="${bnd}"` }, body: mp }
    );
    if (!r.ok) throw new Error(`Could not create ${fileName}.`);
    return (await r.json()).id;
  }

  async function _uploadHtml(method, fileId, parentId, fileName, html) {
    if (method === 'PATCH' && fileId) {
      const r = await _authedFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: html }
      );
      if (!r.ok) throw new Error(`Could not update ${fileName}.`);
      return fileId;
    }
    const bnd  = 'srgm_html_' + Date.now();
    const meta = JSON.stringify({ name: fileName, mimeType: 'text/html', parents: [parentId] });
    const enc  = new TextEncoder();
    const hdr  = enc.encode(
      `--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${bnd}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`
    );
    const body_bytes = enc.encode(html);
    const ftr  = enc.encode(`\r\n--${bnd}--`);
    const body = new Uint8Array(hdr.byteLength + body_bytes.byteLength + ftr.byteLength);
    body.set(hdr); body.set(body_bytes, hdr.byteLength); body.set(ftr, hdr.byteLength + body_bytes.byteLength);
    const r = await _authedFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary="${bnd}"` }, body }
    );
    if (!r.ok) throw new Error(`Could not create ${fileName}.`);
    return (await r.json()).id;
  }

  // ── Project index (projects.json in sangeetmay/) ──────────
  async function _loadIndex() {
    if (_projectsIdx) return _projectsIdx;
    const rootId = await _ensureFolder();
    const q = encodeURIComponent(
      `name='${INDEX_FILE}' and '${rootId}' in parents and trashed=false`
    );
    const sr = await _authedFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
    );
    if (!sr.ok) throw new Error('Could not access Google Drive.');
    const { files } = await sr.json();
    if (files && files.length > 0) {
      _indexFileId = files[0].id;
      const fr = await _authedFetch(
        `https://www.googleapis.com/drive/v3/files/${_indexFileId}?alt=media`
      );
      if (!fr.ok) throw new Error('Could not read project index.');
      _projectsIdx = await fr.json();
    } else {
      _projectsIdx = { version: 2, projects: [] };
      await _saveIndex();
    }
    return _projectsIdx;
  }

  async function _saveIndex() {
    const rootId = await _ensureFolder();
    _indexFileId = await _uploadJson('PATCH', _indexFileId, rootId, INDEX_FILE, _projectsIdx);
  }

  // ── Per-project folder ────────────────────────────────────
  async function _ensureProjectFolder(projectId, slug) {
    const idx   = await _loadIndex();
    const entry = idx.projects.find((p) => p.id === projectId);
    if (entry && entry.folderId) return entry.folderId;
    const rootId = await _ensureFolder();
    const r = await _authedFetch('https://www.googleapis.com/drive/v3/files', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: slug, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] }),
    });
    if (!r.ok) throw new Error('Could not create project folder.');
    const folderId = (await r.json()).id;
    if (entry) { entry.folderId = folderId; await _saveIndex(); }
    return folderId;
  }

  // ── Per-project data (project.json) ──────────────────────
  async function _loadProjData(projectId) {
    if (_projCache[projectId]) return _projCache[projectId];
    const idx   = await _loadIndex();
    const entry = idx.projects.find((p) => p.id === projectId);
    if (!entry) throw new Error('Project not found.');
    if (!entry.folderId) {
      _projCache[projectId] = { data: { id: projectId, references: [], uploadedTakes: [] }, fileId: null };
      return _projCache[projectId];
    }
    const q = encodeURIComponent(
      `name='${PROJ_FILE}' and '${entry.folderId}' in parents and trashed=false`
    );
    const sr = await _authedFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
    );
    if (!sr.ok) throw new Error('Could not access project folder.');
    const { files } = await sr.json();
    let data, fileId;
    if (files && files.length > 0) {
      fileId = files[0].id;
      const fr = await _authedFetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
      );
      if (!fr.ok) throw new Error('Could not read project data.');
      data = await fr.json();
    } else {
      data   = { id: projectId, references: [], uploadedTakes: [] };
      fileId = null;
    }
    _projCache[projectId] = { data, fileId };
    return _projCache[projectId];
  }

  async function _saveProjData(projectId) {
    const cached = _projCache[projectId];
    if (!cached) return;
    const idx    = await _loadIndex();
    const entry  = idx.projects.find((p) => p.id === projectId);
    if (!entry || !entry.folderId) throw new Error('Project folder not found — save failed.');
    cached.fileId = await _uploadJson('PATCH', cached.fileId, entry.folderId, PROJ_FILE, cached.data);
  }

  // ── Projects ──────────────────────────────────────────────
  async function listProjects() {
    const idx = await _loadIndex();
    return idx.projects.map((p) => ({
      id: p.id, name: p.name, slug: p.slug, createdAt: p.createdAt,
    }));
  }

  async function createProject(name) {
    const idx = await _loadIndex();
    if (idx.projects.some((p) => p.name === name))
      throw new Error('Project with this name already exists.');
    const base = _slugify(name);
    let slug = base, i = 2;
    while (idx.projects.some((p) => p.slug === slug)) slug = `${base}-${i++}`;
    const entry = { id: _uuid(), name, slug, createdAt: new Date().toISOString(), folderId: null };
    idx.projects.unshift(entry);
    await _saveIndex();
    // Eagerly create project folder + empty project.json
    const folderId = await _ensureProjectFolder(entry.id, entry.slug);
    _projCache[entry.id] = { data: { id: entry.id, references: [], uploadedTakes: [] }, fileId: null };
    await _saveProjData(entry.id);
    return { id: entry.id, name: entry.name, slug: entry.slug, createdAt: entry.createdAt };
  }

  async function updateProject(id, { name }) {
    const idx   = await _loadIndex();
    const entry = idx.projects.find((p) => p.id === id);
    if (!entry) throw new Error('Project not found.');
    entry.name = name;
    await _saveIndex();
    return { id: entry.id, name: entry.name, slug: entry.slug };
  }

  async function deleteProject(id) {
    const idx   = await _loadIndex();
    const entry = idx.projects.find((p) => p.id === id);
    if (!entry) throw new Error('Project not found.');
    // Trash the entire project folder (removes all files inside it)
    if (entry.folderId) {
      _authedFetch(
        `https://www.googleapis.com/drive/v3/files/${entry.folderId}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashed: true }) }
      ).catch(() => {});
    }
    idx.projects = idx.projects.filter((p) => p.id !== id);
    delete _projCache[id];
    await _saveIndex();
  }

  // ── References ────────────────────────────────────────────
  async function listReferences(projectId) {
    const { data } = await _loadProjData(projectId);
    return (data.references || []).map((r) => ({
      id: r.id, title: r.title, sourceType: r.sourceType,
      youtubeUrl: r.youtubeUrl || null, mediaKind: r.mediaKind || 'video',
      driveFileId: r.driveFileId || null, createdAt: r.createdAt,
    }));
  }

  async function addYouTubeRef(projectId, url, title) {
    const { data } = await _loadProjData(projectId);
    const ref = {
      id: _uuid(), title: title || 'YouTube Reference', sourceType: 'youtube',
      youtubeUrl: url, mediaKind: 'video', driveFileId: null,
      createdAt: new Date().toISOString(),
    };
    if (!data.references) data.references = [];
    data.references.unshift(ref);
    await _saveProjData(projectId);
    return ref;
  }

  async function uploadFileRef(projectId, file) {
    const idx      = await _loadIndex();
    const entry    = idx.projects.find((p) => p.id === projectId);
    const folderId = await _ensureProjectFolder(projectId, entry?.slug || projectId);
    const bnd  = 'srgm_ref_' + Date.now();
    const meta = JSON.stringify({
      name: file.name, mimeType: file.type || 'application/octet-stream', parents: [folderId],
    });
    const ab  = await file.arrayBuffer();
    const enc = new TextEncoder();
    const hdr = enc.encode(
      `--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${bnd}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    );
    const ftr  = enc.encode(`\r\n--${bnd}--`);
    const body = new Uint8Array(hdr.byteLength + ab.byteLength + ftr.byteLength);
    body.set(hdr); body.set(new Uint8Array(ab), hdr.byteLength);
    body.set(ftr, hdr.byteLength + ab.byteLength);
    const r = await _authedFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary="${bnd}"` }, body }
    );
    if (!r.ok) throw new Error('Could not upload file to Google Drive.');
    const driveFile = await r.json();
    const ext       = file.name.split('.').pop().toLowerCase();
    const audioExts = new Set(['mp3','wav','m4a','aac','ogg','flac','opus']);
    const mediaKind = (file.type.startsWith('audio/') || audioExts.has(ext)) ? 'audio' : 'video';
    const { data }  = await _loadProjData(projectId);
    const ref = {
      id: _uuid(), title: file.name.replace(/\.[^.]+$/, ''), sourceType: 'file',
      youtubeUrl: null, mediaKind, driveFileId: driveFile.id,
      createdAt: new Date().toISOString(),
    };
    if (!data.references) data.references = [];
    data.references.unshift(ref);
    await _saveProjData(projectId);
    return ref;
  }

  async function downloadFileRef(fileId) {
    const r = await _authedFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
    if (!r.ok) throw new Error('Could not load file from Google Drive.');
    return URL.createObjectURL(await r.blob());
  }

  async function updateRef(projectId, refId, updates) {
    const { data } = await _loadProjData(projectId);
    const ref = (data.references || []).find((r) => r.id === refId);
    if (!ref) throw new Error('Reference not found.');
    if (updates.title !== undefined) ref.title = updates.title;
    await _saveProjData(projectId);
    return ref;
  }

  async function deleteRef(projectId, refId) {
    const { data } = await _loadProjData(projectId);
    const ref = (data.references || []).find((r) => r.id === refId);
    if (!ref) throw new Error('Reference not found.');
    if (ref.driveFileId) {
      _authedFetch(
        `https://www.googleapis.com/drive/v3/files/${ref.driveFileId}`,
        { method: 'DELETE' }
      ).catch(() => {});
    }
    data.references = data.references.filter((r) => r.id !== refId);
    await _saveProjData(projectId);
  }

  // ── Uploaded take tracking (in project.json) ──────────────
  async function addUploadedTake(projectId, { id, title, youtubeUrl }) {
    const { data } = await _loadProjData(projectId);
    if (!data.uploadedTakes) data.uploadedTakes = [];
    data.uploadedTakes = data.uploadedTakes.filter((t) => t.id !== id);
    data.uploadedTakes.push({ id, title, youtubeUrl, uploadedAt: new Date().toISOString() });
    await _saveProjData(projectId);
  }

  async function listUploadedTakes(projectId) {
    const { data } = await _loadProjData(projectId);
    return (data.uploadedTakes || []);
  }


  // ── IndexedDB — local recordings (takes) ─────────────────
  // Blobs stay in browser storage only — not on any server.
  const IDB_NAME  = 'sargama';
  const IDB_STORE = 'takes';
  const IDB_VER   = 1;

  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function saveTake(projectId, blob, title, duration) {
    const db   = await _openDB();
    const take = { id: _uuid(), projectId, blob, title, duration, createdAt: new Date().toISOString() };
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(take);
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
    return { id: take.id, projectId, title, duration, createdAt: take.createdAt };
  }

  async function listTakes(projectId) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(
        req.result
          .filter((t) => t.projectId === projectId)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .map(({ id, projectId: pid, title, duration, createdAt }) =>
            ({ id, projectId: pid, title, duration, createdAt }))
      );
      req.onerror = () => reject(req.error);
    });
  }

  async function getTakeBlob(id) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function updateTake(id, updates) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const gr    = store.get(id);
      gr.onsuccess = () => {
        if (!gr.result) { reject(new Error('Take not found.')); return; }
        store.put({ ...gr.result, ...updates });
      };
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function deleteTake(id) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  // ── Token acquisition: silent first, popup fallback ───────
  // Tries prompt=none (no UI, instant) if the user already granted this scope.
  // Falls back to a regular popup only if silent fails.
  async function _acquireToken(scope, state) {
    const hint = _profile && _profile.email;
    try {
      return await _openAuthPopup(scope, state + '_silent', {
        prompt:     'none',
        ...(hint ? { login_hint: hint } : {}),
      });
    } catch (_) {
      // interaction_required — user must approve via popup
      return await _openAuthPopup(scope, state);
    }
  }

  // ── YouTube search ────────────────────────────────────────
  async function searchVideos(query, maxResults = 8) {
    if (!_ytToken) {
      _ytToken = await _acquireToken(SCOPE_YT, 'ytread');
      try { sessionStorage.setItem(YT_TOKEN_KEY, _ytToken); } catch (_) {}
    }
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(maxResults));
    const resp = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + _ytToken } });
    if (resp.status === 401) {
      _ytToken = null;
      try { sessionStorage.removeItem(YT_TOKEN_KEY); } catch (_) {}
      throw new Error('YouTube session expired — please try again.');
    }
    if (!resp.ok) {
      let msg = `Search failed (${resp.status})`;
      try { const j = await resp.json(); msg = j?.error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }
    return ((await resp.json()).items || []).map((item) => ({
      videoId:   item.id.videoId,
      title:     item.snippet.title,
      channel:   item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }));
  }

  // ── YouTube upload (accepts Blob directly) ────────────────
  async function upload(blob, title, description, privacyStatus, onProgress) {
    if (!_ytToken) {
      _ytToken = await _acquireToken(SCOPE_YT, 'ytupload');
      try { sessionStorage.setItem(YT_TOKEN_KEY, _ytToken); } catch (_) {}
    }
    const token = _ytToken;
    onProgress({ phase: 'upload', pct: 0 });
    const metadata = {
      snippet: {
        title:       title.trim().slice(0, 100) || 'Untitled',
        description: (description || '').trim().slice(0, 5000),
        categoryId:  '22',
      },
      status: { privacyStatus },
    };
    const initResp = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata) }
    );
    if (initResp.status === 401) {
      _ytToken = null;
      try { sessionStorage.removeItem(YT_TOKEN_KEY); } catch (_) {}
      throw new Error('YouTube session expired — please try uploading again.');
    }
    if (!initResp.ok) {
      let msg = `YouTube API error (${initResp.status})`;
      try { const j = await initResp.json(); msg = j?.error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }
    const uploadUri = initResp.headers.get('Location');
    if (!uploadUri) throw new Error('YouTube did not return an upload URI');
    const mimeType = (blob.type || 'video/webm').split(';')[0];
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUri);
      xhr.setRequestHeader('Content-Type', mimeType);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress({ phase: 'upload', pct: Math.round(e.loaded / e.total * 100) });
      });
      xhr.addEventListener('load', () => {
        if (xhr.status === 200 || xhr.status === 201) {
          try { resolve(`https://www.youtube.com/watch?v=${JSON.parse(xhr.responseText).id}`); }
          catch (_) { reject(new Error('Unexpected response from YouTube.')); }
        } else { reject(new Error(`Upload failed (HTTP ${xhr.status})`)); }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('abort',  () => reject(new Error('Upload cancelled')));
      xhr.send(blob);
    });
  }

  // ── Notes (stored in Drive JSON alongside projects) ───────
  // ── Notes (notes.html in per-project folder) ──────────────
  // Stored as a plain HTML file so the user can open/edit it directly in Drive.
  async function loadNote(projectId) {
    const { data } = await _loadProjData(projectId);
    if (!data.notesFileId) return '';
    const r = await _authedFetch(
      `https://www.googleapis.com/drive/v3/files/${data.notesFileId}?alt=media`
    );
    if (r.status === 404) { data.notesFileId = null; return ''; }
    if (!r.ok) throw new Error('Could not load notes from Drive.');
    return r.text();
  }

  async function saveNote(projectId, htmlContent) {
    const cached = await _loadProjData(projectId);
    const { data } = cached;
    const idx    = await _loadIndex();
    const entry  = idx.projects.find((p) => p.id === projectId);
    if (!entry || !entry.folderId) throw new Error('Project folder not found.');
    const newId = await _uploadHtml(
      data.notesFileId ? 'PATCH' : 'POST',
      data.notesFileId || null,
      entry.folderId,
      NOTES_FILE,
      htmlContent
    );
    if (!data.notesFileId) {
      data.notesFileId = newId;
      await _saveProjData(projectId); // persist the new notesFileId
    }
  }

  async function deleteNote(projectId) {
    const { data } = await _loadProjData(projectId);
    if (!data.notesFileId) return;
    _authedFetch(
      `https://www.googleapis.com/drive/v3/files/${data.notesFileId}`,
      { method: 'DELETE' }
    ).catch(() => {});
    data.notesFileId = null;
    await _saveProjData(projectId);
  }

  // ── Public API ────────────────────────────────────────────
  return {
    isConfigured,
    signIn,
    silentSignIn,
    signOut,
    isSignedIn: () => !!(_profile && _profile.email && _token),
    hasToken:   () => !!_token,
    getUser:    () => _profile,

    // Projects (Drive JSON)
    listProjects,
    createProject,
    updateProject,
    deleteProject,

    // References (Drive JSON + Drive files for uploaded audio/video)
    listReferences,
    addYouTubeRef,
    uploadFileRef,
    downloadFileRef,
    updateRef,
    deleteRef,

    // Uploaded take tracking (project.json)
    addUploadedTake,
    listUploadedTakes,

    // Local recordings (IndexedDB — device only, browser-managed)
    saveTake,
    listTakes,
    getTakeBlob,
    updateTake,
    deleteTake,

    // YouTube
    searchVideos,
    upload,

    // Notes (notes.html in per-project folder — openable directly in Drive)
    loadNote,
    saveNote,
    deleteNote,

    // Folder
    getFolderUrl,
  };
})();
