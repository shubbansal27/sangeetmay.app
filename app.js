'use strict';

const NAV_STORAGE_KEY = 'pm_nav_collapsed';
const PROJ_STORAGE_KEY = 'pm_last_project_id';
const ORDER_KEY = 'pm_item_order';
const CLIPS_KEY = 'pm_clips';

let _noteSaveTimer = null;
let _noteDrag = null;

// ── YouTube IFrame Player API ───────────────────────────
let ytPlayer = null;
let ytApiReady = false;

// Called automatically by YouTube API script when loaded
window.onYouTubeIframeAPIReady = function () { ytApiReady = true; };

// Proxy that makes the YouTube player look like an HTMLMediaElement
// so all A/B loop logic works identically for all source types
const ytMediaProxy = {
  get currentTime() { return ytPlayer ? ytPlayer.getCurrentTime() : 0; },
  set currentTime(t) { if (ytPlayer) ytPlayer.seekTo(t, true); },
  pause() { if (ytPlayer) { try { ytPlayer.pauseVideo(); } catch (_) {} } },
};

function playYouTubeById(videoId) {
  function doInit() {
    if (ytPlayer) {
      ytPlayer.loadVideoById(videoId);
    } else {
      ytPlayer = new YT.Player('ref-youtube-frame', {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
        events: {
        onReady: (e) => e.target.playVideo(),
        onStateChange: () => updatePlayPauseBtn(),
      },
      });
    }
  }
  if (ytApiReady) {
    doInit();
  } else {
    const waitId = setInterval(() => {
      if (ytApiReady) { clearInterval(waitId); doInit(); }
    }, 100);
  }
}

const state = {
  currentProjectId: null,
  projects: [],
  references: [],
  recordings: [],
  uploadedTakes: {},   // map of takeId → youtubeUrl (from Drive JSON)
  playingRefId: null,
  playingRecId: null,
  webcamStream: null,
  micStream: null,
  mediaRecorder: null,
  recordMimeType: null,
  recordChunks: [],
  recordingStartedAt: null,
  timerInterval: null,
  navCollapsed: false,
  loop: { start: null, end: null, active: false, watcherId: null },
};

function byId(id) {
  return document.getElementById(id);
}

// (server API removed — data lives in Google Drive JSON + browser IndexedDB)

function showToast(message, isError = false) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2200);
}

let confirmCallback = null;

function showConfirm(message, onConfirm) {
  byId('confirm-message').textContent = message;
  confirmCallback = onConfirm;
  byId('confirm-modal').classList.remove('hidden');
  setTimeout(() => byId('btn-confirm-ok').focus(), 50);
}

function closeConfirm() {
  byId('confirm-modal').classList.add('hidden');
  confirmCallback = null;
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function extractYouTubeId(url) {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      return parsed.pathname.split('/').filter(Boolean)[0] || null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = parsed.searchParams.get('v');
      if (id) return id;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed') return parts[1] || null;
    }
  } catch (_) {
    return null;
  }
  return null;
}

// ── Play / Pause from loop bar ───────────────────────────────
function togglePlayPause() {
  const el = getLoopMediaEl();
  if (!el) return;
  if (el === ytMediaProxy) {
    try {
      const s = ytPlayer.getPlayerState();
      if (s === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
      else ytPlayer.playVideo();
    } catch {}
  } else {
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }
}

function updatePlayPauseBtn() {
  const btn = byId('btn-loop-play');
  if (!btn) return;
  const el = getLoopMediaEl();
  let isPlaying = false;
  if (el === ytMediaProxy) {
    try { isPlaying = ytPlayer && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING; } catch {}
  } else if (el) {
    isPlaying = !el.paused;
  }
  btn.textContent = isPlaying ? '⏸' : '▶';
  btn.title = isPlaying ? 'Pause' : 'Play';
  btn.classList.toggle('playing', isPlaying);
}

// ── Clips ────────────────────────────────────────────────────
function clipsStorageKey(refId) {
  return `${CLIPS_KEY}_${state.currentProjectId}_${refId}`;
}
function getClips(refId) {
  try { return JSON.parse(localStorage.getItem(clipsStorageKey(refId)) || '[]'); } catch { return []; }
}
function persistClips(refId, clips) {
  localStorage.setItem(clipsStorageKey(refId), JSON.stringify(clips));
}

function updateClipSelect(refId) {
  const sel = byId('clip-select');
  const delBtn = byId('btn-delete-clip');
  sel.innerHTML = '<option value="">— load clip —</option>';
  if (!refId) { if (delBtn) delBtn.disabled = true; return; }
  const clips = getClips(refId);
  for (const c of clips) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.label}  ${formatDuration(c.start)} → ${formatDuration(c.end)}`;
    sel.appendChild(opt);
  }
  if (delBtn) delBtn.disabled = true;
}

function handleSaveClip() {
  const L = state.loop;
  if (L.start === null || L.end === null) { showToast('Set A and B points first.', true); return; }
  const refId = state.playingRefId;
  if (!refId) { showToast('No reference playing.', true); return; }
  const labelEl = byId('clip-label-input');
  const clips = getClips(refId);
  const label = labelEl.value.trim() || `Clip ${clips.length + 1}`;
  clips.push({ id: Date.now().toString(36), label, start: L.start, end: L.end });
  persistClips(refId, clips);
  labelEl.value = '';
  updateClipSelect(refId);
  showToast(`"${label}" saved.`);
}

function handleLoadClip(id) {
  const refId = state.playingRefId;
  if (!refId || !id) return;
  const clip = getClips(refId).find((c) => c.id === id);
  if (!clip) return;
  state.loop.start = clip.start;
  state.loop.end = clip.end;
  state.loop.active = true;
  const el = getLoopMediaEl();
  if (el) { el.currentTime = clip.start; }
  updateLoopUI();
  // enable delete btn
  const delBtn = byId('btn-delete-clip');
  if (delBtn) delBtn.disabled = false;
}

function handleDeleteClip() {
  const id = byId('clip-select').value;
  const refId = state.playingRefId;
  if (!refId || !id) return;
  showConfirm('Delete this clip?', () => {
    const clips = getClips(refId).filter((c) => c.id !== id);
    persistClips(refId, clips);
    updateClipSelect(refId);
    showToast('Clip deleted.');
  });
}

function getLoopMediaEl() {
  const v = byId('ref-video');
  const a = byId('ref-audio');
  if (!v.classList.contains('hidden')) return v;
  if (!a.classList.contains('hidden')) return a;
  if (!byId('ref-youtube-wrap').classList.contains('hidden') && ytPlayer) return ytMediaProxy;
  return null;
}

function updateLoopUI() {
  const L = state.loop;
  const aBtn = byId('btn-loop-a'), bBtn = byId('btn-loop-b');
  const aPt  = byId('loop-a-time'), bPt  = byId('loop-b-time');
  const tog  = byId('btn-loop-toggle');
  aPt.textContent  = L.start !== null ? formatDuration(L.start) : '-:--';
  bPt.textContent  = L.end   !== null ? formatDuration(L.end)   : '-:--';
  aPt.classList.toggle('set', L.start !== null);
  bPt.classList.toggle('set', L.end   !== null);
  aBtn.classList.toggle('set', L.start !== null);
  bBtn.classList.toggle('set', L.end   !== null);
  tog.classList.toggle('active', L.active);
  tog.textContent = L.active ? 'Looping' : 'Loop';
}

function startLoopWatcher(el) {
  if (state.loop.watcherId) clearInterval(state.loop.watcherId);
  state.loop.watcherId = setInterval(() => {
    const L = state.loop;
    if (!L.active || L.start === null || L.end === null) return;
    if (el.currentTime >= L.end) el.currentTime = L.start;
  }, 80);
}

function setLoopStart() {
  const el = getLoopMediaEl();
  if (!el) return;
  state.loop.start = el.currentTime;
  if (state.loop.end !== null && state.loop.start >= state.loop.end) state.loop.end = null;
  updateLoopUI();
}

function setLoopEnd() {
  const el = getLoopMediaEl();
  if (!el) return;
  state.loop.end = el.currentTime;
  if (state.loop.start !== null && state.loop.end <= state.loop.start) state.loop.start = null;
  updateLoopUI();
}

function toggleLoop() {
  if (state.loop.start === null || state.loop.end === null) {
    showToast('Set A and B points first.', true);
    return;
  }
  state.loop.active = !state.loop.active;
  if (state.loop.active) {
    const el = getLoopMediaEl();
    if (el) el.currentTime = state.loop.start;
  }
  updateLoopUI();
}

function resetLoop() {
  if (state.loop.watcherId) { clearInterval(state.loop.watcherId); state.loop.watcherId = null; }
  state.loop = { start: null, end: null, active: false, watcherId: null };
  updateLoopUI();
}

function setPlayingRef(id) {
  state.playingRefId = id;
  document.querySelectorAll('#reference-list .item-row').forEach((li) => {
    li.classList.toggle('ref-playing', id !== null && parseInt(li.dataset.id, 10) === id);
  });
}

function playRefInline(title, type, src) {
  byId('ref-player-idle').classList.add('hidden');
  byId('ref-now-playing').textContent = title;
  const video = byId('ref-video');
  const audio = byId('ref-audio');
  byId('ref-youtube-wrap').classList.add('hidden');
  video.classList.add('hidden');
  audio.classList.add('hidden');
  resetLoop();
  const loopBar = byId('loop-bar');
  loopBar.classList.remove('hidden');
  if (type === 'youtube') {
    byId('ref-youtube-wrap').classList.remove('hidden');
    playYouTubeById(src);
    startLoopWatcher(ytMediaProxy);
    byId('btn-maximize-ref').classList.add('visible');
  } else if (type === 'audio') {
    audio.src = src;
    audio.classList.remove('hidden');
    audio.play().catch(() => {});
    startLoopWatcher(audio);
  } else {
    video.src = src;
    video.classList.remove('hidden');
    video.play().catch(() => {});
    startLoopWatcher(video);
    byId('btn-maximize-ref').classList.add('visible');
  }
  // Update clip selector and play button for the newly loaded reference
  updateClipSelect(state.playingRefId);
  setTimeout(updatePlayPauseBtn, 200);
}

function clearRefPlayer() {
  setPlayingRef(null);
  updateClipSelect(null);
  const video = byId('ref-video');
  const audio = byId('ref-audio');
  video.pause(); video.removeAttribute('src'); video.classList.add('hidden');
  audio.pause(); audio.removeAttribute('src'); audio.classList.add('hidden');
  byId('btn-maximize-ref').classList.remove('visible');
  byId('ref-youtube-wrap').classList.add('hidden');
  if (ytPlayer) { try { ytPlayer.pauseVideo(); } catch (_) {} }
  byId('ref-player-idle').classList.remove('hidden');
  byId('ref-now-playing').textContent = '';
  byId('loop-bar').classList.add('hidden');
  resetLoop();
}

function openRecPopup(id, title, src) {
  // Clear previous highlight
  document.querySelectorAll('#recording-list .item-row.rec-playing').forEach((el) => el.classList.remove('rec-playing'));
  state.playingRecId = id;
  // Highlight the active take
  const li = document.querySelector(`#recording-list [data-id="${id}"]`);
  if (li) li.classList.add('rec-playing');
  // Show rec-video inside the camera wrap
  const recVideo = byId('rec-video');
  recVideo.src = src;
  recVideo.classList.remove('hidden');
  byId('webcam-preview').classList.add('hidden');
  byId('webcam-placeholder').style.display = 'none';
  // Swap controls
  byId('btn-close-rec-playback').classList.remove('hidden');
  byId('btn-toggle-camera').classList.add('hidden');
  byId('btn-start-recording').classList.add('hidden');
  byId('btn-stop-recording').classList.add('hidden');
  recVideo.play().catch(() => {});
  byId('btn-maximize-rec').classList.add('visible');
}

function closeRecPopup() {
  state.playingRecId = null;
  document.querySelectorAll('#recording-list .item-row.rec-playing').forEach((el) => el.classList.remove('rec-playing'));
  const recVideo = byId('rec-video');
  recVideo.pause();
  recVideo.removeAttribute('src');
  recVideo.classList.add('hidden');
  byId('btn-maximize-rec').classList.remove('visible');
  closeVideoMaximize();
  // Restore placeholder view
  byId('webcam-preview').classList.remove('hidden');
  if (!state.webcamStream) {
    byId('webcam-placeholder').style.display = '';
  }
  // Restore controls
  byId('btn-close-rec-playback').classList.add('hidden');
  byId('btn-toggle-camera').classList.remove('hidden');
  byId('btn-start-recording').classList.remove('hidden');
  byId('btn-stop-recording').classList.remove('hidden');
}

function setReferencePreviewEmpty() {
  clearRefPlayer();
}

async function playReference(item) {
  setPlayingRef(item.id);
  if (item.sourceType === 'youtube') {
    const ytId = extractYouTubeId(item.youtubeUrl || '');
    if (!ytId) { showToast('Invalid YouTube URL.', true); return; }
    playRefInline(item.title || 'YouTube Reference', 'youtube', ytId);
    return;
  }
  if (item.driveFileId) {
    try {
      const blobUrl = await YTUpload.downloadFileRef(item.driveFileId);
      playRefInline(item.title || 'File', item.mediaKind === 'audio' ? 'audio' : 'video', blobUrl);
    } catch (err) { showToast('Could not load file: ' + err.message, true); }
    return;
  }
  showToast('No playable source for this reference.', true);
}

function setNavCollapsed(isCollapsed) {
  state.navCollapsed = isCollapsed;
  byId('project-nav').classList.toggle('visible', !isCollapsed);
  byId('sidebar-overlay').classList.toggle('show', !isCollapsed);
  localStorage.setItem(NAV_STORAGE_KEY, isCollapsed ? '1' : '0');
}

function initNavState() {
  const saved = localStorage.getItem(NAV_STORAGE_KEY);
  // Default to open (false) if no saved preference so the songs list is visible
  setNavCollapsed(saved === '1');
}

async function loadProjects() {
  state.projects = await YTUpload.listProjects();
  const navList = byId('project-nav-list');
  navList.innerHTML = '';

  if (state.projects.length === 0) {
    navList.innerHTML = '<li class="item-empty">No projects yet.</li>';
    state.currentProjectId = null;
    byId('project-folder-label').textContent = '';
    updateRecordBtn();
    updateProjectTopbar();
    setReferencePreviewEmpty();
    renderReferenceList();
    renderRecordingList();
    return;
  }

  const savedId = localStorage.getItem(PROJ_STORAGE_KEY);
  if (savedId && state.projects.some((p) => p.id === savedId)) {
    state.currentProjectId = savedId;
  } else if (!state.currentProjectId || !state.projects.some((p) => p.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0].id;
  }
  localStorage.setItem(PROJ_STORAGE_KEY, state.currentProjectId);

  updateRecordBtn();
  renderProjectNav();

  const selected = state.projects.find((p) => p.id === state.currentProjectId);
  byId('project-folder-label').textContent = '';
  byId('active-project-badge').textContent = selected ? selected.name : '';
  updateProjectTopbar();

  await Promise.all([loadReferences(), loadRecordings()]);
  loadNote();
}

function renderProjectNav() {
  const navList = byId('project-nav-list');
  navList.innerHTML = '';
  for (const project of state.projects) {
    const li = document.createElement('li');
    li.className = 'project-nav-item';

    const btn = document.createElement('button');
    btn.className = `project-nav-btn${project.id === state.currentProjectId ? ' active' : ''}`;
    btn.type = 'button';
    btn.textContent = project.name;
    btn.title = project.name;
    btn.addEventListener('click', async () => {
      // Flush any pending note save for the current project before switching
      if (_noteSaveTimer !== null) {
        clearTimeout(_noteSaveTimer);
        _noteSaveTimer = null;
        if (_quill && state.currentProjectId) saveNote();
      }
      state.currentProjectId = project.id;
      localStorage.setItem(PROJ_STORAGE_KEY, project.id);
      updateRecordBtn();
      renderProjectNav();
      byId('project-folder-label').textContent = '';
      byId('active-project-badge').textContent = project.name;
      updateProjectTopbar();
      setReferencePreviewEmpty();
      setNavCollapsed(true);
      await Promise.all([loadReferences(), loadRecordings()]);
      await loadNote();
    });

    li.appendChild(btn);
    navList.appendChild(li);
  }
}

function updateProjectTopbar() {
  const has = state.currentProjectId !== null;
  const r = byId('btn-rename-project'), d = byId('btn-delete-project');
  if (r) r.classList.toggle('hidden', !has);
  if (d) d.classList.toggle('hidden', !has);
}

function startTopbarRename() {
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  if (!proj) return;
  const badge = byId('active-project-badge');
  const group = byId('project-title-group');
  const input = document.createElement('input');
  input.className = 'topbar-rename-input';
  input.type = 'text';
  input.value = proj.name;
  const restore = () => {
    badge.classList.remove('hidden');
    byId('btn-rename-project').classList.remove('hidden');
    byId('btn-delete-project').classList.remove('hidden');
    input.remove();
  };
  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === proj.name) { restore(); return; }
    try {
      const updated = await YTUpload.updateProject(proj.id, { name: newName });
      proj.name = updated.name;
      badge.textContent = updated.name;
      renderProjectNav();
      showToast('Project renamed.');
    } catch (err) { showToast(err.message, true); }
    restore();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.stopPropagation(); restore(); }
  });
  input.addEventListener('blur', commit);
  badge.classList.add('hidden');
  byId('btn-rename-project').classList.add('hidden');
  byId('btn-delete-project').classList.add('hidden');
  group.insertBefore(input, badge.nextSibling);
  input.focus();
  input.select();
}

function deleteCurrentProject() {
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  if (!proj) return;
  showConfirm(
    `Delete “${proj.name}”? All references and recordings will be permanently removed.`,
    async () => {
      try {
        await YTUpload.deleteProject(proj.id);
        state.currentProjectId = null;
        await loadProjects();
        showToast('Project deleted.');
      } catch (err) { showToast(err.message, true); }
    }
  );
}

async function createProject() {
  const input = byId('project-name-input');
  const name = input.value.trim();
  if (!name) {
    showToast('Enter a project name first.', true);
    return;
  }

  try {
    const created = await YTUpload.createProject(name);
    input.value = '';
    state.currentProjectId = created.id;
    localStorage.setItem(PROJ_STORAGE_KEY, created.id);
    await loadProjects();
    showToast('Project created.');
  } catch (error) {
    showToast(error.message, true);
  }
}

// ── Add-reference popup ──────────────────────────────────────
function toggleAddRefPopup(forceClose = false) {
  const popup = byId('add-ref-popup');
  const isOpen = !popup.classList.contains('hidden');
  if (forceClose || isOpen) {
    popup.classList.add('hidden');
    byId('yt-search-results').classList.add('hidden');
    byId('yt-search-results').innerHTML = '';
    byId('yt-search-input').value = '';
  } else {
    popup.classList.remove('hidden');
    byId('add-ref-url').focus();
  }
}

// (ensureGoogleSignedIn removed — Drive functions auto-popup on 401)

async function addRefFromUrl() {
  if (!state.currentProjectId) { showToast('Create or choose a project first.', true); return; }
  const urlEl = byId('add-ref-url');
  const url = urlEl.value.trim();
  if (!url) { showToast('Paste a URL first.', true); return; }

  const ytId = extractYouTubeId(url);
  if (ytId) {
    try {
      let title = '';
      try {
        const oembed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (oembed.ok) { const d = await oembed.json(); title = d.title || ''; }
      } catch (_) {}
      await YTUpload.addYouTubeRef(state.currentProjectId, url, title);
      urlEl.value = '';
      await loadReferences();
      showToast('YouTube reference added.');
      toggleAddRefPopup(true);
    } catch (err) { showToast(err.message, true); }
    return;
  }
  showToast('Only YouTube URLs are supported. Use "Choose file" for local files.', true);
}

async function addRefFromFiles() {
  if (!state.currentProjectId) { showToast('Create or choose a project first.', true); return; }
  const fileEl = byId('add-ref-file');
  if (!fileEl.files || fileEl.files.length === 0) return;
  try {
    for (const file of fileEl.files) {
      await YTUpload.uploadFileRef(state.currentProjectId, file);
    }
    fileEl.value = '';
    await loadReferences();
    showToast('File uploaded to Google Drive.');
    toggleAddRefPopup(true);
  } catch (err) { showToast(err.message, true); }
}

async function searchYouTube() {
  const query = byId('yt-search-input').value.trim();
  if (!query) { showToast('Enter a search term.', true); return; }
  const resultsEl = byId('yt-search-results');
  resultsEl.innerHTML = '<div class="yt-search-loading">Searching…</div>';
  resultsEl.classList.remove('hidden');
  try {
    const results = await YTUpload.searchVideos(query, 8);
    if (results.length === 0) {
      resultsEl.innerHTML = '<div class="yt-search-loading">No results found.</div>';
      return;
    }
    resultsEl.innerHTML = '';
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'yt-search-item';
      item.innerHTML = `
        <img class="yt-search-thumb" src="${r.thumbnail}" alt="" />
        <div class="yt-search-info">
          <div class="yt-search-title">${r.title}</div>
          <div class="yt-search-channel">${r.channel}</div>
        </div>`;
      item.addEventListener('click', () => addRefFromYtSearchResult(r));
      resultsEl.appendChild(item);
    }
  } catch (err) {
    resultsEl.innerHTML = `<div class="yt-search-loading">Error: ${err.message}</div>`;
  }
}

async function addRefFromYtSearchResult(result) {
  if (!state.currentProjectId) { showToast('Create or choose a project first.', true); return; }
  const url = `https://www.youtube.com/watch?v=${result.videoId}`;
  try {
    await YTUpload.addYouTubeRef(state.currentProjectId, url, result.title);
    await loadReferences();
    showToast(`Added: ${result.title}`);
    toggleAddRefPopup(true);
  } catch (err) { showToast(err.message, true); }
}

async function loadReferences() {
  if (!state.currentProjectId) {
    state.references = [];
    renderReferenceList();
    return;
  }
  state.references = await YTUpload.listReferences(state.currentProjectId);
  renderReferenceList();
}

async function loadRecordings() {
  if (!state.currentProjectId) {
    state.recordings = [];
    state.uploadedTakes = {};
    renderRecordingList();
    return;
  }
  state.recordings = await YTUpload.listTakes(state.currentProjectId);
  // Load uploaded take URLs from project.json
  state.uploadedTakes = {};
  for (const t of await YTUpload.listUploadedTakes(state.currentProjectId)) {
    state.uploadedTakes[t.id] = t.youtubeUrl;
  }
  renderRecordingList();
}

// ── Order persistence (drag-drop) ───────────────────────────
function getOrder(type, projectId) {
  try {
    const d = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
    return d[`${type}_${projectId}`] || null;
  } catch { return null; }
}
function saveOrder(type, projectId, ids) {
  try {
    const d = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
    d[`${type}_${projectId}`] = ids;
    localStorage.setItem(ORDER_KEY, JSON.stringify(d));
  } catch {}
}

// ── Inline rename ────────────────────────────────────────────
function startRename(nameEl, id, type) {
  const original = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'item-name-input';
  input.value = original;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newTitle = input.value.trim() || original;
    nameEl.textContent = newTitle;
    input.replaceWith(nameEl);
    if (newTitle === original) return;
    try {
      if (type === 'reference') {
        await YTUpload.updateRef(state.currentProjectId, id, { title: newTitle });
        const ref = state.references.find((r) => r.id === id);
        if (ref) ref.title = newTitle;
      } else {
        await YTUpload.updateTake(id, { title: newTitle });
        const rec = state.recordings.find((r) => r.id === id);
        if (rec) rec.title = newTitle;
      }
    } catch (e) { showToast(e.message, true); nameEl.textContent = original; }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = original; input.replaceWith(nameEl); }
  });
  input.addEventListener('blur', commit);
}

// ── Delete ───────────────────────────────────────────────────
function deleteReference(id) {
  showConfirm('Delete this reference?', async () => {
    try {
      await YTUpload.deleteRef(state.currentProjectId, id);
      await loadReferences();
      showToast('Reference deleted.');
    } catch (e) { showToast(e.message, true); }
  });
}

function deleteRecording(id) {
  showConfirm('Delete this take?', async () => {
    try {
      await YTUpload.deleteTake(id);
      await loadRecordings();
      showToast('Take deleted.');
    } catch (e) { showToast(e.message, true); }
  });
}

// ── Drag-and-drop reorder ────────────────────────────────────
function initDragDrop(list, type) {
  let dragSrc = null;
  list.querySelectorAll('li[data-id]').forEach((li) => {
    const handle = li.querySelector('.item-drag');
    if (handle) {
      handle.addEventListener('mousedown', () => { li.draggable = true; });
    }
    li.addEventListener('dragstart', (e) => {
      dragSrc = li;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.draggable = false;
      li.classList.remove('dragging');
      list.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      const ids = [...list.querySelectorAll('li[data-id]')].map((el) => parseInt(el.dataset.id, 10));
      saveOrder(type, state.currentProjectId, ids);
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (li !== dragSrc) {
        list.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
        li.classList.add('drag-over');
      }
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (dragSrc && dragSrc !== li) {
        const all = [...list.querySelectorAll('li[data-id]')];
        list.insertBefore(dragSrc, all.indexOf(dragSrc) < all.indexOf(li) ? li.nextSibling : li);
      }
    });
  });
}

// ── Render reference list ────────────────────────────────────
function renderReferenceList() {
  const list = byId('reference-list');
  list.innerHTML = '';
  if (state.references.length === 0) {
    list.innerHTML = '<li class="item-empty">No references yet — click ＋ Add above.</li>';
    return;
  }

  let items = [...state.references];
  const saved = getOrder('ref', state.currentProjectId);
  if (saved) {
    const map = Object.fromEntries(items.map((i) => [i.id, i]));
    items = [...saved.map((id) => map[id]).filter(Boolean), ...items.filter((i) => !saved.includes(i.id))];
  }

  for (const item of items) {
    const isYt    = item.sourceType === 'youtube';
    const isAudio = item.mediaKind  === 'audio';
    const li = document.createElement('li');
    li.className = 'item-row';
    li.dataset.id = item.id;

    const drag = document.createElement('span');
    drag.className = 'item-drag';
    drag.textContent = '⠿';
    drag.title = 'Drag to reorder';

    const badge = document.createElement('span');
    badge.className = `track-type ${isYt ? 'yt' : isAudio ? 'aud' : 'vid'}`;
    badge.textContent = isYt ? 'YT' : isAudio ? 'Aud' : 'Vid';

    const playBtn = document.createElement('button');
    playBtn.className = 'item-play-btn';
    playBtn.textContent = '▶';
    playBtn.title = 'Play';
    playBtn.addEventListener('click', (e) => { e.stopPropagation(); playReference(item).catch(() => {}); });

    const nameEl = document.createElement('span');
    nameEl.className = 'item-name';
    const displayName = item.title || (isYt ? 'YouTube' : 'File Reference');
    nameEl.textContent = displayName;
    nameEl.title = 'Click to rename  ·  Double-click to play';
    nameEl.addEventListener('click', (e) => { if (!e.defaultPrevented) startRename(nameEl, item.id, 'reference'); });
    nameEl.addEventListener('dblclick', (e) => { e.preventDefault(); playReference(item).catch(() => {}); });

    const delBtn = document.createElement('button');
    delBtn.className = 'item-delete-btn';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete (click twice to confirm)';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteReference(item.id); });

    li.append(drag, badge, playBtn, nameEl, delBtn);
    list.appendChild(li);
  }
  initDragDrop(list, 'ref');
  // Restore now-playing highlight after re-render
  if (state.playingRefId !== null) setPlayingRef(state.playingRefId);
}

// ── Render recording list ────────────────────────────────────
function renderRecordingList() {
  const list = byId('recording-list');
  list.innerHTML = '';
  if (state.recordings.length === 0) {
    list.innerHTML = '<li class="item-empty">No recordings yet.</li>';
    return;
  }

  let items = [...state.recordings];
  const saved = getOrder('rec', state.currentProjectId);
  if (saved) {
    const map = Object.fromEntries(items.map((i) => [i.id, i]));
    items = [...saved.map((id) => map[id]).filter(Boolean), ...items.filter((i) => !saved.includes(i.id))];
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'item-row';
    li.dataset.id = item.id;

    const drag = document.createElement('span');
    drag.className = 'item-drag';
    drag.textContent = '⠿';
    drag.title = 'Drag to reorder';

    const playBtn2 = document.createElement('button');
    playBtn2.className = 'item-play-btn';
    playBtn2.textContent = '▶';
    playBtn2.title = 'Play';
    playBtn2.addEventListener('click', async (e) => {
      e.stopPropagation();
      const blob = await YTUpload.getTakeBlob(item.id);
      if (!blob) { showToast('Take not found in local storage.', true); return; }
      openRecPopup(item.id, item.title, URL.createObjectURL(blob));
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'item-name';
    nameEl.textContent = item.title;
    nameEl.title = 'Click to rename  ·  Double-click to play';
    nameEl.addEventListener('click', (e) => { if (!e.defaultPrevented) startRename(nameEl, item.id, 'recording'); });
    nameEl.addEventListener('dblclick', async (e) => {
      e.preventDefault();
      const blob = await YTUpload.getTakeBlob(item.id);
      if (!blob) { showToast('Take not found in local storage.', true); return; }
      openRecPopup(item.id, item.title, URL.createObjectURL(blob));
    });

    const dur = document.createElement('span');
    dur.className = 'item-duration';
    dur.textContent = formatDuration(item.duration);

    // ── Action buttons group ──────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const savedYtUrl = state.uploadedTakes[item.id] || null;
    if (savedYtUrl) {
      const ytLink = document.createElement('a');
      ytLink.className = 'item-yt-link';
      ytLink.href = savedYtUrl;
      ytLink.target = '_blank';
      ytLink.rel = 'noopener noreferrer';
      ytLink.textContent = '▶ YouTube';
      ytLink.title = 'View on YouTube';
      ytLink.addEventListener('click', (e) => e.stopPropagation());
      actions.appendChild(ytLink);
    }

    const dlBtn = document.createElement('button');
    dlBtn.className = 'item-dl';
    dlBtn.textContent = '↓';
    dlBtn.title = 'Download';
    dlBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const blob = await YTUpload.getTakeBlob(item.id);
      if (!blob) { showToast('Take not found.', true); return; }
      const bUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = bUrl; a.download = item.title || 'take';
      a.click();
      setTimeout(() => URL.revokeObjectURL(bUrl), 5000);
    });

    const ytBtn = document.createElement('button');
    ytBtn.className = 'item-yt-btn';
    ytBtn.textContent = savedYtUrl ? '↑ Re-upload' : '↑ YouTube';
    ytBtn.title = savedYtUrl ? 'Re-upload to YouTube' : 'Upload to YouTube';
    ytBtn.addEventListener('click', (e) => { e.stopPropagation(); openYtUploadModal(item); });

    const delBtn = document.createElement('button');
    delBtn.className = 'item-delete-btn';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete (click twice to confirm)';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteRecording(item.id); });

    actions.append(dlBtn, ytBtn, delBtn);
    li.append(drag, playBtn2, nameEl, dur, actions);
    list.appendChild(li);
  }
  initDragDrop(list, 'rec');
  // Restore now-playing highlight after re-render
  if (state.playingRecId !== null) {
    const li = list.querySelector(`[data-id="${state.playingRecId}"]`);
    if (li) li.classList.add('rec-playing');
  }
}

// ── YouTube Upload Modal ─────────────────────────────────────────────────────
let _ytUploadItem = null;

function updateGoogleUserUI(user) {
  const signinBtn = byId('btn-google-signin');
  const chip = byId('google-user-chip');
  const dropdown = byId('google-dropdown');
  if (user) {
    signinBtn.classList.add('hidden');
    chip.classList.remove('hidden');
    dropdown.classList.add('hidden'); // close if open
    // Small chip
    const avatar = byId('google-user-avatar');
    if (user.picture) { avatar.src = user.picture; avatar.classList.remove('hidden'); }
    else { avatar.classList.add('hidden'); }
    byId('google-user-name').textContent = user.name || user.email || '';
    // Dropdown content
    const avatarLg = byId('google-avatar-lg');
    if (user.picture) { avatarLg.src = user.picture; avatarLg.classList.remove('hidden'); }
    else { avatarLg.classList.add('hidden'); }
    byId('google-dropdown-name').textContent = user.name || '';
    byId('google-dropdown-email').textContent = user.email || '';
    // Channel
    const channelSection = byId('google-dropdown-channel');
    if (user.channelThumb || user.channelName) {
      const thumb = byId('yt-channel-thumb');
      if (user.channelThumb) { thumb.src = user.channelThumb; thumb.classList.remove('hidden'); }
      else { thumb.classList.add('hidden'); }
      byId('yt-channel-name').textContent = user.channelName || '';
      const channelLink = byId('yt-channel-link');
      if (channelLink) {
        // Build the best available YouTube channel URL
        let channelUrl = null;
        if (user.channelId) {
          channelUrl = `https://www.youtube.com/channel/${user.channelId}`;
        } else if (user.channelCustomUrl) {
          // customUrl from API is already prefixed with '@' (e.g. "@myhandle")
          channelUrl = `https://www.youtube.com/${user.channelCustomUrl}`;
        }
        if (channelUrl) {
          channelLink.href = channelUrl;
          channelLink.style.pointerEvents = '';
          channelLink.style.cursor = '';
        } else {
          // Stale cached profile — make it non-navigable until user re-signs in
          channelLink.removeAttribute('href');
          channelLink.style.pointerEvents = 'none';
          channelLink.style.cursor = 'default';
        }
      }
      channelSection.classList.remove('hidden');
    } else {
      channelSection.classList.add('hidden');
    }
    // Drive folder link
    const folderLink = byId('btn-drive-folder');
    if (folderLink) {
      const url = YTUpload.getFolderUrl();
      if (url) { folderLink.href = url; folderLink.classList.remove('hidden'); }
      else { folderLink.classList.add('hidden'); }
    }
  } else {
    signinBtn.classList.remove('hidden');
    chip.classList.add('hidden');
    dropdown.classList.add('hidden');
  }
}

// ── Video Maximize Overlay ────────────────────────────────────────────────────
function openVideoMaximize(src, currentTime) {
  if (!src) return;
  const overlay = byId('video-maximize-overlay');
  const vid = byId('maximize-video');
  vid.src = src;
  vid.currentTime = currentTime || 0;
  overlay.classList.remove('hidden');
  vid.play().catch(() => {});
}

function closeVideoMaximize() {
  const overlay = byId('video-maximize-overlay');
  const vid = byId('maximize-video');
  const iframe = byId('maximize-iframe');
  vid.pause();
  vid.src = '';
  vid.classList.remove('hidden');
  iframe.src = '';
  iframe.classList.add('hidden');
  overlay.classList.add('hidden');
}

function openYtUploadModal(item) {
  _ytUploadItem = item;
  byId('yt-title').value = item.title || '';
  byId('yt-desc').value = '';
  document.querySelector('input[name="yt-privacy"][value="private"]').checked = true;
  byId('yt-progress-wrap').classList.add('hidden');
  byId('yt-progress-fill').style.width = '0%';
  byId('yt-progress-label').textContent = 'Preparing…';
  byId('yt-result').classList.add('hidden');
  byId('yt-error').classList.add('hidden');
  const notSignedIn = YTUpload.isConfigured() && !YTUpload.isSignedIn();
  byId('btn-yt-upload').disabled = notSignedIn;
  byId('btn-yt-upload').textContent = '📤 Upload';
  if (notSignedIn) {
    byId('yt-error').textContent = 'Sign in with Google first — use the button in the top-right corner.';
    byId('yt-error').classList.remove('hidden');
  }
  byId('yt-upload-modal').classList.remove('hidden');
}

function closeYtUploadModal() {
  byId('yt-upload-modal').classList.add('hidden');
  _ytUploadItem = null;
}

async function startYtUpload() {
  if (!_ytUploadItem) return;
  if (!YTUpload.isConfigured()) {
    byId('yt-error').textContent = 'YouTube Client ID not set. Edit src/yt-config.js and add your Google OAuth Client ID.';
    byId('yt-error').classList.remove('hidden');
    return;
  }
  const blob = await YTUpload.getTakeBlob(_ytUploadItem.id);
  if (!blob) {
    byId('yt-error').textContent = 'Recording not found in local storage. It may have been cleared by the browser.';
    byId('yt-error').classList.remove('hidden');
    return;
  }
  const title = byId('yt-title').value.trim() || _ytUploadItem.title;
  const description = byId('yt-desc').value.trim();
  const privacyStatus = document.querySelector('input[name="yt-privacy"]:checked')?.value || 'private';

  byId('yt-error').classList.add('hidden');
  byId('yt-result').classList.add('hidden');
  byId('yt-progress-wrap').classList.remove('hidden');
  byId('btn-yt-upload').disabled = true;
  byId('btn-yt-upload').textContent = 'Uploading\u2026';

  try {
    const ytUrl = await YTUpload.upload(
      blob,
      title,
      description,
      privacyStatus,
      ({ pct }) => {
        byId('yt-progress-fill').style.width = pct + '%';
        byId('yt-progress-label').textContent = `Uploading\u2026 ${pct}%`;
      }
    );
    byId('yt-progress-fill').style.width = '100%';
    byId('yt-progress-label').textContent = 'Done!';
    byId('yt-result-link').href = ytUrl;
    byId('yt-result').classList.remove('hidden');
    byId('btn-yt-upload').textContent = '\u2713 Done';
    // Persist uploaded take URL to Drive JSON
    await YTUpload.addUploadedTake(state.currentProjectId, {
      id: _ytUploadItem.id, title: _ytUploadItem.title, youtubeUrl: ytUrl,
    });
    state.uploadedTakes[_ytUploadItem.id] = ytUrl;
    renderRecordingList();
    showToast('\ud83d\udce4 Uploaded to YouTube!');
  } catch (err) {
    byId('yt-progress-wrap').classList.add('hidden');
    byId('yt-error').textContent = err.message;
    byId('yt-error').classList.remove('hidden');
    byId('btn-yt-upload').disabled = false;
    byId('btn-yt-upload').textContent = '\ud83d\udce4 Upload';
    if (!YTUpload.isSignedIn()) updateGoogleUserUI(null);
  }
}

function updateRecordBtn() {
  byId('btn-start-recording').disabled = !state.webcamStream;
}

async function enableCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera not available. Open the app at http://localhost (not an IP address) and ensure camera permission is granted.');
    }
    state.webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    byId('webcam-preview').srcObject = state.webcamStream;
    byId('webcam-placeholder').style.display = 'none';
    byId('btn-start-recording').disabled = false;
    updateCameraBtn();
  } catch (error) {
    showToast(`Could not access camera: ${error.message}`, true);
    throw error;
  }
}

function disableCamera() {
  if (state.webcamStream) {
    state.webcamStream.getTracks().forEach((t) => t.stop());
    state.webcamStream = null;
  }
  byId('webcam-preview').srcObject = null;
  byId('webcam-placeholder').style.display = '';
  byId('btn-start-recording').disabled = true;
  updateCameraBtn();
}

async function toggleCamera() {
  if (state.webcamStream) { disableCamera(); } else { await enableCamera(); }
}

function updateCameraBtn() {
  const btn = byId('btn-toggle-camera');
  if (!btn) return;
  if (state.webcamStream) {
    btn.textContent = '\ud83d\udcf7 On';
    btn.classList.add('cam-active');
  } else {
    btn.textContent = '\ud83d\udcf7 Camera';
    btn.classList.remove('cam-active');
  }
}

function startRecordingTimer() {
  byId('recording-indicator').classList.add('show');
  state.recordingStartedAt = Date.now();
  state.timerInterval = window.setInterval(() => {
    const elapsed = (Date.now() - state.recordingStartedAt) / 1000;
    byId('recording-time').textContent = formatDuration(elapsed);
  }, 200);
}

function stopRecordingTimer() {
  if (state.timerInterval) {
    window.clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  byId('recording-indicator').classList.remove('show');
  byId('recording-time').textContent = '0:00';
}

async function startRecording() {
  if (!state.currentProjectId) {
    showToast('Choose a project first.', true);
    return;
  }
  if (!state.webcamStream) {
    showToast('Enable camera first.', true);
    return;
  }
  const stream = state.webcamStream;

  // WebKit (PyWebView/Safari) does not support video/webm — pick the best supported format
  const mimeType = _getSupportedMimeType();
  state.recordChunks = [];
  state.recordMimeType = mimeType;
  state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) state.recordChunks.push(event.data);
  };
  state.mediaRecorder.onstop = uploadRecording;
  state.mediaRecorder.start();
  byId('btn-start-recording').disabled = true;
  byId('btn-stop-recording').disabled = false;
  startRecordingTimer();
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
  state.mediaRecorder.stop();
  // Compositor keeps running so preview stays alive for next take
  // Release mic and audio context; screen stream stays alive for next take
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close();
    state.audioCtx = null;
  }
  updateRecordBtn();
  byId('btn-stop-recording').disabled = true;
  stopRecordingTimer();
}

function _getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',      // WebKit/Safari/PyWebView on macOS
    'audio/webm',
    'audio/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function uploadRecording() {
  try {
    const elapsed = Math.max(1, Math.round((Date.now() - state.recordingStartedAt) / 1000));
    const mimeType = state.recordMimeType || 'video/webm';
    const blob = new Blob(state.recordChunks, { type: mimeType });
    const title = `Take ${new Date().toLocaleTimeString()}`;
    await YTUpload.saveTake(state.currentProjectId, blob, title, elapsed);
    await loadRecordings();
    showToast('Take saved locally.');
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindEvents() {
  byId('btn-toggle-nav').addEventListener('click', () => setNavCollapsed(!state.navCollapsed));
  byId('btn-close-nav').addEventListener('click', () => setNavCollapsed(true));
  byId('sidebar-overlay').addEventListener('click', () => setNavCollapsed(true));
  byId('btn-close-rec-playback').addEventListener('click', closeRecPopup);
  byId('btn-rename-project').addEventListener('click', startTopbarRename);
  byId('btn-delete-project').addEventListener('click', deleteCurrentProject);
  byId('btn-confirm-cancel').addEventListener('click', closeConfirm);
  byId('btn-confirm-ok').addEventListener('click', () => { const cb = confirmCallback; closeConfirm(); if (cb) cb(); });
  byId('confirm-modal').addEventListener('click', (e) => { if (e.target === byId('confirm-modal')) closeConfirm(); });
  document.addEventListener('keydown', (e) => {
    if (!byId('confirm-modal').classList.contains('hidden')) {
      if (e.key === 'Escape') { closeConfirm(); return; }
    }
    if (e.key === 'Escape') { closeRecPopup(); toggleAddRefPopup(true); }
  });
  // Loop controls
  byId('btn-loop-play').addEventListener('click', togglePlayPause);
  byId('btn-loop-a').addEventListener('click', setLoopStart);
  byId('btn-loop-b').addEventListener('click', setLoopEnd);
  byId('btn-loop-toggle').addEventListener('click', toggleLoop);
  byId('btn-loop-reset').addEventListener('click', resetLoop);
  byId('btn-save-clip').addEventListener('click', handleSaveClip);
  byId('btn-delete-clip').addEventListener('click', handleDeleteClip);
  byId('clip-select').addEventListener('change', (e) => { handleLoadClip(e.target.value); });
  byId('clip-label-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSaveClip(); });
  // Update play/pause button when video/audio play state changes
  const rv = byId('ref-video'), ra = byId('ref-audio');
  rv.addEventListener('play', updatePlayPauseBtn);
  rv.addEventListener('pause', updatePlayPauseBtn);
  ra.addEventListener('play', updatePlayPauseBtn);
  ra.addEventListener('pause', updatePlayPauseBtn);
  byId('btn-create-project').addEventListener('click', createProject);
  byId('project-name-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createProject();
  });

  // Add-reference popup
  byId('btn-add-reference').addEventListener('click', () => toggleAddRefPopup());
  byId('btn-add-ref-cancel').addEventListener('click', () => toggleAddRefPopup(true));
  byId('btn-add-ref-url').addEventListener('click', addRefFromUrl);
  byId('add-ref-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addRefFromUrl(); });
  byId('add-ref-file').addEventListener('change', addRefFromFiles);
  byId('btn-yt-search').addEventListener('click', searchYouTube);
  byId('yt-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchYouTube(); });

  byId('btn-toggle-camera').addEventListener('click', toggleCamera);
  byId('btn-start-recording').addEventListener('click', startRecording);
  byId('btn-stop-recording').addEventListener('click', stopRecording);

  // YouTube upload modal
  byId('btn-yt-modal-close').addEventListener('click', closeYtUploadModal);
  byId('btn-yt-cancel').addEventListener('click', closeYtUploadModal);
  byId('btn-yt-upload').addEventListener('click', startYtUpload);
  byId('yt-upload-modal').addEventListener('click', (e) => { if (e.target === byId('yt-upload-modal')) closeYtUploadModal(); });

  // Video maximize overlay
  byId('btn-maximize-ref').addEventListener('click', () => {
    const vid = byId('ref-video');
    if (!vid.classList.contains('hidden') && vid.src) {
      openVideoMaximize(vid.src, vid.currentTime);
      return;
    }
    // YouTube: open in iframe inside overlay
    const ytWrap = byId('ref-youtube-wrap');
    if (!ytWrap.classList.contains('hidden')) {
      const ref = state.references.find((r) => r.id === state.playingRefId);
      const videoId = ref ? extractYouTubeId(ref.youtubeUrl || '') : null;
      if (videoId) {
        const overlay = byId('video-maximize-overlay');
        const vid2 = byId('maximize-video');
        const iframe = byId('maximize-iframe');
        vid2.classList.add('hidden');
        iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
        iframe.classList.remove('hidden');
        overlay.classList.remove('hidden');
      }
    }
  });
  byId('btn-maximize-rec').addEventListener('click', () => {
    const vid = byId('rec-video');
    if (!vid.classList.contains('hidden') && vid.src) {
      openVideoMaximize(vid.src, vid.currentTime);
    }
  });
  byId('btn-maximize-close').addEventListener('click', closeVideoMaximize);
  byId('video-maximize-overlay').addEventListener('click', (e) => {
    if (e.target === byId('video-maximize-overlay')) closeVideoMaximize();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeVideoMaximize();
  });

  // Login gate sign-in button
  byId('btn-gate-signin').addEventListener('click', async () => {
    const btn = byId('btn-gate-signin');
    const errEl = byId('login-gate-error');
    const hintEl = byId('login-gate-hint');
    btn.disabled = true;
    btn.textContent = 'Signing in\u2026';
    errEl.classList.add('hidden');
    errEl.textContent = '';
    hintEl.classList.add('hidden');
    hintEl.textContent = '';
    // After 3 s, prompt the user to complete sign-in in the browser window that opened
    const hintTimer = setTimeout(() => {
      if (btn.disabled) {
        hintEl.textContent = 'A browser window opened — complete sign-in there, then return here.';
        hintEl.classList.remove('hidden');
      }
    }, 3000);
    try {
      const user = await YTUpload.signIn();
      clearTimeout(hintTimer);
      updateGoogleUserUI(user);
      hideLoginGate();
      await loadProjects();
      updateGoogleUserUI(YTUpload.getUser()); // refresh folder link
    } catch (err) {
      clearTimeout(hintTimer);
      hintEl.classList.add('hidden');
      hintEl.textContent = '';
      let msg = err.message || 'Sign-in failed. Please try again.';
      if (msg === 'access_denied' || msg.includes('access_denied')) {
        msg = 'Sign-in was cancelled or a permission was denied. Please try again and accept all requested permissions.';
      } else if (msg.includes('timed out')) {
        // Pass through the full message — it contains Drive API guidance when relevant
        msg = err.message;
      }
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Sign in with Google';
      showLoginGate(); // ensure app-locked class stays on body
    }
  });

  // Google sign-in / sign-out (topbar button)
  byId('btn-google-signin').addEventListener('click', async () => {
    const btn = byId('btn-google-signin');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const user = await YTUpload.signIn();
      updateGoogleUserUI(user);
      showToast(`Signed in as ${user.name || user.email}`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in with Google';
    }
  });
  byId('google-user-chip').addEventListener('click', (e) => {
    e.stopPropagation();
    byId('google-dropdown').classList.toggle('hidden');
  });
  byId('btn-google-signout').addEventListener('click', () => {
    YTUpload.signOut();
    updateGoogleUserUI(null);
    showLoginGate();
  });
  document.addEventListener('click', (e) => {
    const area = byId('google-user-area');
    if (area && !area.contains(e.target)) {
      byId('google-dropdown').classList.add('hidden');
    }
  });

  // Toolbox
  byId('btn-toolbox').addEventListener('click', openToolbox);
  byId('btn-toolbox-close').addEventListener('click', closeToolbox);
  byId('toolbox-backdrop').addEventListener('click', closeToolbox);
  byId('btn-tuner-toggle').addEventListener('click', () => {
    if (_tunerActive) stopTuner(); else startTuner();
  });
  document.querySelectorAll('.toolbox-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toolbox-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tool-pane').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      const pane = byId('tool-' + btn.dataset.tool);
      if (pane) pane.classList.remove('hidden');
    });
  });

  // Metronome
  _metroBuildBeats();
  _metroSetBpm(120);
  byId('btn-metro-toggle').addEventListener('click', () => {
    if (_metroRunning) stopMetronome(); else startMetronome();
  });
  byId('btn-metro-tap').addEventListener('click', _metroTap);
  byId('btn-metro-minus').addEventListener('mousedown', () => _startHold(() => _metroSetBpm(_metroBpm - 1)));
  byId('btn-metro-plus').addEventListener('mousedown',  () => _startHold(() => _metroSetBpm(_metroBpm + 1)));
  ['mouseup','mouseleave'].forEach(ev => {
    byId('btn-metro-minus').addEventListener(ev, _stopHold);
    byId('btn-metro-plus').addEventListener(ev, _stopHold);
  });
  byId('metro-bpm-slider').addEventListener('input', (e) => _metroSetBpm(+e.target.value));
  document.querySelectorAll('.metro-sig-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.metro-sig-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _metroBeats = +btn.dataset.beats;
      _metroBuildBeats();
      if (_metroRunning) { stopMetronome(); startMetronome(); }
    });
  });

  // Notes popup
  byId('btn-note').addEventListener('click', async (e) => {
    e.stopPropagation();
    const popup = byId('note-popup');
    const isHidden = popup.classList.toggle('hidden');
    if (!isHidden) {
      initQuillEditor();
      await loadNote();
      setTimeout(() => _quill && _quill.focus(), 0);
    }
  });
  byId('btn-note-close').addEventListener('click', () => byId('note-popup').classList.add('hidden'));
  // Drag to reposition
  byId('note-popup-hd').addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const popup = byId('note-popup');
    const rect = popup.getBoundingClientRect();
    _noteDrag = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!_noteDrag) return;
    const popup = byId('note-popup');
    const dx = e.clientX - _noteDrag.startX;
    const dy = e.clientY - _noteDrag.startY;
    popup.style.left  = Math.max(0, Math.min(_noteDrag.origLeft + dx, window.innerWidth  - popup.offsetWidth))  + 'px';
    popup.style.top   = Math.max(0, Math.min(_noteDrag.origTop  + dy, window.innerHeight - popup.offsetHeight)) + 'px';
    popup.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => { _noteDrag = null; });
  document.addEventListener('click', (e) => {
    const popup = byId('note-popup');
    const btn = byId('btn-note');
    if (!popup.classList.contains('hidden') && !popup.contains(e.target) && e.target !== btn) {
      popup.classList.add('hidden');
    }
  });
}

let _quill = null;

// ── Notes (Quill editor) ──────────────────────────────────────

function _quillInsertImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const range = _quill.getSelection(true);
      _quill.insertEmbed(range ? range.index : 0, 'image', e.target.result);
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function initQuillEditor() {
  if (_quill || typeof Quill === 'undefined') return;
  _quill = new Quill('#notes-editor', {
    theme: 'snow',
    modules: {
      toolbar: {
        container: [
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          [{ header: [1, 2, 3, false] }],
          ['link', 'image'],
          ['clean'],
        ],
        handlers: { image: _quillInsertImage },
      },
      clipboard: { matchVisual: false },
    },
    placeholder: 'Notes for this project…',
  });
  // Support paste-from-clipboard images
  _quill.root.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (imgItem) {
      e.stopPropagation();
      const blob = imgItem.getAsFile();
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const range = _quill.getSelection(true);
        _quill.insertEmbed(range ? range.index : 0, 'image', ev.target.result);
      };
      reader.readAsDataURL(blob);
    }
  });
  _quill.on('text-change', (_delta, _old, source) => {
    if (source === 'user') scheduleNoteSave();
  });
}

async function loadNote() {
  if (!_quill || !state.currentProjectId) return;
  const projectId = state.currentProjectId;
  const autosave = byId('notes-autosave');
  if (!YTUpload.isSignedIn()) {
    if (autosave) autosave.textContent = 'Sign in to use notes';
    return;
  }
  if (autosave) autosave.textContent = 'Loading…';
  let content = '';
  try {
    content = await YTUpload.loadNote(projectId) || '';
  } catch (err) {
    console.warn('[Notes] Could not load from Drive:', err?.message);
    if (autosave) autosave.textContent = 'Could not load note';
    return;
  }
  if (projectId !== state.currentProjectId) return;
  _quill.setContents([]);
  if (content) _quill.clipboard.dangerouslyPasteHTML(0, content);
  if (autosave) autosave.textContent = content ? 'Loaded' : '';
}

async function saveNote() {
  if (!state.currentProjectId || !_quill) return;
  const html = _quill.root.innerHTML;
  await _syncNoteToGoogleDoc(html);
}

function scheduleNoteSave() {
  const autosave = byId('notes-autosave');
  if (autosave) autosave.textContent = 'Saving…';
  clearTimeout(_noteSaveTimer);
  _noteSaveTimer = setTimeout(saveNote, 800);
}

async function _syncNoteToGoogleDoc(html) {
  const autosave = byId('notes-autosave');
  if (!YTUpload.isSignedIn() || !state.currentProjectId) {
    if (autosave) autosave.textContent = 'Sign in to save notes';
    return;
  }
  try {
    await YTUpload.saveNote(state.currentProjectId, html);
    if (autosave) autosave.textContent = 'Saved';
  } catch (err) {
    console.warn('[Notes] Save failed:', err?.message || err);
    if (autosave) autosave.textContent = 'Save failed';
    showToast('Could not save note: ' + (err?.message || 'unknown error'), true);
  }
}

function updateNoteGdocLink() {} // kept for compat, no-op

// ── Toolbox ───────────────────────────────────────────────────

function openToolbox() {
  byId('toolbox-drawer').classList.add('open');
  byId('toolbox-backdrop').classList.remove('hidden');
}

function closeToolbox() {
  byId('toolbox-drawer').classList.remove('open');
  byId('toolbox-backdrop').classList.add('hidden');
  stopTuner();
  stopMetronome();
}

// ── Pitch Tuner ───────────────────────────────────────────────

const _TUNER_NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
let _tunerActive   = false;
let _tunerAudioCtx = null;
let _tunerAnalyser = null;
let _tunerStream   = null;
let _tunerRafId    = null;
let _tunerBuf      = null;

/** Autocorrelation-based pitch detection. Returns frequency in Hz or -1 if no pitch. */
function _autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return -1; // silence / too quiet

  // Trim leading / trailing silence to reduce octave errors
  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) { if (Math.abs(buf[i]) < thres) { r1 = i; break; } }
  for (let i = 1; i < SIZE / 2; i++) { if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; } }
  buf = buf.slice(r1, r2);
  const len = buf.length;

  // Unnormalised autocorrelation
  const c = new Float32Array(len).fill(0);
  for (let i = 0; i < len; i++)
    for (let j = 0; j + i < len; j++)
      c[i] += buf[j] * buf[j + i];

  // Find first local minimum (skip the zero-lag peak)
  let d = 0;
  while (d < len - 1 && c[d] > c[d + 1]) d++;

  // Find the maximum correlation peak after that minimum
  let maxval = -1, maxpos = -1;
  for (let i = d; i < len; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  if (maxpos <= 0 || maxpos >= len - 1) return -1;

  // Parabolic interpolation for sub-sample accuracy
  const T0 = maxpos - (c[maxpos + 1] - c[maxpos - 1]) /
    (2 * (2 * c[maxpos] - c[maxpos - 1] - c[maxpos + 1]));
  return sampleRate / T0;
}

/** Convert a frequency to note name, octave, and cents deviation. */
function _freqToNote(freq) {
  const noteNum  = 12 * Math.log2(freq / 440) + 69;
  const rounded  = Math.round(noteNum);
  const name     = _TUNER_NOTES[((rounded % 12) + 12) % 12];
  const octave   = Math.floor(rounded / 12) - 1;
  const target   = 440 * Math.pow(2, (rounded - 69) / 12);
  const cents    = Math.round(1200 * Math.log2(freq / target));
  return { name, octave, freq, cents };
}

/** Single animation frame: read audio buffer → detect pitch → update UI. */
function _tunerTick() {
  if (!_tunerActive) return;
  _tunerAnalyser.getFloatTimeDomainData(_tunerBuf);
  const freq = _autoCorrelate(_tunerBuf, _tunerAudioCtx.sampleRate);

  const ring   = byId('tuner-ring');
  const badge  = byId('tuner-status-badge');
  const needle = byId('tuner-needle');

  if (freq > 0) {
    const info = _freqToNote(freq);
    byId('tuner-note').textContent   = info.name;
    byId('tuner-octave').textContent = info.octave;
    byId('tuner-freq').textContent   = info.freq.toFixed(1) + ' Hz';

    const cents    = Math.max(-50, Math.min(50, info.cents));
    const pct      = (cents + 50) / 100; // 0 = far flat, 0.5 = in tune, 1 = far sharp
    needle.style.left = (pct * 100) + '%';
    byId('tuner-cents-label').textContent = (cents >= 0 ? '+' : '') + cents + '¢';

    const absCents = Math.abs(cents);
    const cls = absCents <= 5 ? 'in-tune' : absCents <= 18 ? 'close' : 'off';
    ring.className  = 'tuner-ring '  + cls;
    badge.className = 'tuner-status-badge ' + cls;
    badge.textContent = absCents <= 5 ? '✓ In Tune' : cents < 0 ? '♭ Flat' : '♯ Sharp';
  } else {
    // No signal — reset to idle
    byId('tuner-note').textContent   = '—';
    byId('tuner-octave').textContent = '';
    byId('tuner-freq').textContent   = '— Hz';
    byId('tuner-cents-label').textContent = '0¢';
    needle.style.left = '50%';
    ring.className  = 'tuner-ring';
    badge.className = 'tuner-status-badge';
    badge.textContent = '—';
  }
  _tunerRafId = requestAnimationFrame(_tunerTick);
}

function _tunerMicIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 1a3 3 0 013 3v8a3 3 0 01-6 0V4a3 3 0 013-3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

async function startTuner() {
  try {
    _tunerStream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    _tunerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source   = _tunerAudioCtx.createMediaStreamSource(_tunerStream);
    _tunerAnalyser = _tunerAudioCtx.createAnalyser();
    _tunerAnalyser.fftSize = 2048;
    _tunerBuf = new Float32Array(_tunerAnalyser.fftSize);
    source.connect(_tunerAnalyser);

    _tunerActive = true;
    const btn = byId('btn-tuner-toggle');
    btn.classList.add('active');
    btn.innerHTML = _tunerMicIcon() + ' Stop Tuner';
    _tunerRafId = requestAnimationFrame(_tunerTick);
  } catch (_err) {
    showToast('Microphone access denied — please allow mic access and try again.', true);
  }
}

function stopTuner() {
  _tunerActive = false;
  if (_tunerRafId)    { cancelAnimationFrame(_tunerRafId); _tunerRafId = null; }
  if (_tunerStream)   { _tunerStream.getTracks().forEach(t => t.stop()); _tunerStream = null; }
  if (_tunerAudioCtx) { _tunerAudioCtx.close(); _tunerAudioCtx = null; }
  const btn = byId('btn-tuner-toggle');
  if (btn) {
    btn.classList.remove('active');
    btn.innerHTML = _tunerMicIcon() + ' Start Tuner';
  }
  // Reset display to idle
  const ring = byId('tuner-ring');
  if (ring) {
    ring.className  = 'tuner-ring';
    byId('tuner-note').textContent        = '—';
    byId('tuner-octave').textContent      = '';
    byId('tuner-freq').textContent        = '— Hz';
    byId('tuner-cents-label').textContent = '0¢';
    byId('tuner-needle').style.left       = '50%';
    byId('tuner-status-badge').className  = 'tuner-status-badge';
    byId('tuner-status-badge').textContent = '—';
  }
}

// ── Metronome ─────────────────────────────────────────────────

let _metroRunning  = false;
let _metroCtx      = null;
let _metroBpm      = 120;
let _metroBeats    = 4;
let _metroCurrent  = 0;       // beat index 0-indexed
let _metroNextTime = 0;       // AudioContext time of next scheduled click
let _metroTimer    = null;    // setInterval scheduler ID
let _tapTimes      = [];      // wall-clock timestamps for tap-tempo
let _holdTimer     = null;    // for hold-to-repeat on +/-

const _METRO_LOOKAHEAD = 0.1; // seconds ahead to pre-schedule
const _METRO_INTERVAL  = 25;  // ms scheduler poll rate

/** Synthesise a short click at a precise AudioContext time. */
function _metroClick(time, isAccent) {
  const ctx  = _metroCtx;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = isAccent ? 1100 : 660;
  gain.gain.setValueAtTime(isAccent ? 0.9 : 0.55, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
  osc.start(time);
  osc.stop(time + 0.06);
}

/** Light up the correct beat dot. Pass -1 to clear all. */
function _metroUpdateVisual(beat) {
  document.querySelectorAll('.metro-beat').forEach((dot, i) => {
    dot.classList.toggle('active', i === beat);
  });
}

/** Lookahead scheduler — called every _METRO_INTERVAL ms. */
function _metroScheduler() {
  while (_metroNextTime < _metroCtx.currentTime + _METRO_LOOKAHEAD) {
    const beat = _metroCurrent;
    _metroClick(_metroNextTime, beat === 0);
    // Schedule visual update at the right wall-clock time
    const msUntil = (_metroNextTime - _metroCtx.currentTime) * 1000;
    setTimeout(() => _metroUpdateVisual(beat), Math.max(0, msUntil));
    _metroCurrent  = (beat + 1) % _metroBeats;
    _metroNextTime += 60 / _metroBpm;
  }
}

/** Build/rebuild the beat-dot row for the current time-signature. */
function _metroBuildBeats() {
  const container = byId('metro-beats');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < _metroBeats; i++) {
    const dot = document.createElement('div');
    dot.className = 'metro-beat' + (i === 0 ? ' accent' : '');
    container.appendChild(dot);
  }
}

/** Set BPM and sync all controls. */
function _metroSetBpm(bpm) {
  _metroBpm = Math.max(20, Math.min(300, Math.round(bpm)));
  const valueEl = byId('metro-bpm-value');
  if (valueEl) valueEl.textContent = _metroBpm;
  const slider = byId('metro-bpm-slider');
  if (slider) {
    slider.value = _metroBpm;
    const pct = ((_metroBpm - 20) / 280 * 100).toFixed(2);
    slider.style.setProperty('--pct', pct + '%');
  }
}

function startMetronome() {
  _metroCtx      = new (window.AudioContext || window.webkitAudioContext)();
  _metroCurrent  = 0;
  _metroNextTime = _metroCtx.currentTime + 0.05;
  _metroRunning  = true;
  _metroTimer    = setInterval(_metroScheduler, _METRO_INTERVAL);
  const btn = byId('btn-metro-toggle');
  if (btn) {
    btn.classList.add('active');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg> Stop';
  }
}

function stopMetronome() {
  _metroRunning = false;
  if (_metroTimer) { clearInterval(_metroTimer); _metroTimer = null; }
  if (_metroCtx)   { _metroCtx.close(); _metroCtx = null; }
  _metroUpdateVisual(-1);
  const btn = byId('btn-metro-toggle');
  if (btn) {
    btn.classList.remove('active');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Start';
  }
}

/** Tap-tempo: compute average BPM from recent taps. */
function _metroTap() {
  const now = performance.now();
  // Discard stale sequence (gap > 2.5 s)
  if (_tapTimes.length > 0 && now - _tapTimes[_tapTimes.length - 1] > 2500) {
    _tapTimes = [];
  }
  _tapTimes.push(now);
  if (_tapTimes.length > 8) _tapTimes.shift(); // keep last 8 taps
  if (_tapTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < _tapTimes.length; i++) {
      intervals.push(_tapTimes[i] - _tapTimes[i - 1]);
    }
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    _metroSetBpm(Math.round(60000 / avg));
  }
}

/** Hold-to-repeat helper for +/- buttons. */
function _startHold(fn) {
  fn();
  _holdTimer = setTimeout(() => {
    _holdTimer = setInterval(fn, 80);
  }, 400);
}
function _stopHold() {
  clearTimeout(_holdTimer);
  clearInterval(_holdTimer);
  _holdTimer = null;
}

// ── Panel resizer ────────────────────────────────────────────────────────────
const SPLIT_KEY = 'pm_panel_split';

function initPanelResizer() {
  const resizer = byId('panel-resizer');
  const workspace = byId('layout-root');
  const leftPanel = byId('panel-reference');
  const rightPanel = byId('panel-record');

  function applyPanelSplit(leftPct) {
    leftPct = Math.max(15, Math.min(85, leftPct));
    leftPanel.style.flex = `0 0 ${leftPct}%`;
    rightPanel.style.flex = '1 1 0';
  }

  // Restore saved or default 50/50
  applyPanelSplit(parseFloat(localStorage.getItem(SPLIT_KEY) || '50'));

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('resizing');
    const startX = e.clientX;
    const startLeftW = leftPanel.getBoundingClientRect().width;
    const totalW = workspace.getBoundingClientRect().width - resizer.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const newLeftW = startLeftW + (e.clientX - startX);
      applyPanelSplit(newLeftW / totalW * 100);
    }
    function onUp() {
      resizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const savedPct = leftPanel.getBoundingClientRect().width /
        (workspace.getBoundingClientRect().width - resizer.offsetWidth) * 100;
      localStorage.setItem(SPLIT_KEY, savedPct.toFixed(2));
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function showLoginGate() {
  byId('login-gate').classList.remove('hidden');
  document.body.classList.add('app-locked');
}

function hideLoginGate() {
  byId('login-gate').classList.add('hidden');
  document.body.classList.remove('app-locked');
}

async function bootstrap() {
  initNavState();
  initPanelResizer();
  bindEvents();
  setReferencePreviewEmpty();

  // If a profile exists in localStorage but no live token yet, try a silent
  // token refresh (prompt=none). Google grants the token immediately if the
  // user's Google session is still alive — no popup visible to the user.
  if (YTUpload.getUser() && !YTUpload.isSignedIn()) {
    await YTUpload.silentSignIn();
  }

  if (YTUpload.isSignedIn()) {
    // Token is live (either freshly signed in or silently restored)
    updateGoogleUserUI(YTUpload.getUser());
    hideLoginGate();
    try {
      await loadProjects();
      // Refresh folder link now that the Drive folder ID is known
      updateGoogleUserUI(YTUpload.getUser());
    } catch (e) { showToast(`Could not load projects: ${e.message}`, true); }
  } else {
    // No live token — show full-screen gate
    showLoginGate();
  }
}

bootstrap();
