// Inbox source adapters. Each adapter maps a provider into the shared item model.

import { SOURCES, YOUTUBE_PLAYLIST_TITLE } from './config.js';
import { state } from './store.js';
import { formatRelative } from './utils.js';
import { renderInbox } from './inbox.js';
import { isSourceEnabled, getYouTubePlaylistIds } from './settings.js';

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

// Walk every task list, following pagination so nothing is silently dropped.
async function fetchAllTaskLists(headers) {
  const lists = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(TASKS_API + '/users/@me/lists?' + params.toString(), { headers });
    if (!response.ok) {
      if (lists.length) break;
      throw new Error('Could not read your Google Task lists. Please sign in again and retry.');
    }
    const data = await response.json();
    lists.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return lists;
}

async function fetchTasksForList(headers, list) {
  const encodedListId = encodeURIComponent(list.id);
  const tasks = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(TASKS_API + '/lists/' + encodedListId + '/tasks?' + params.toString(), { headers });
    if (!response.ok) return [];
    const data = await response.json();
    tasks.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return tasks;
}

// Only surface real web links so a task's stored URL can be opened safely.
function safeLink(url) {
  return /^https?:\/\//i.test(String(url || '')) ? url : '';
}

function mapTask(task, list) {
  const notes = typeof task.notes === 'string' ? task.notes.trim() : '';
  const notesSnippet = notes.length > 140 ? notes.slice(0, 137) + '…' : notes;
  const addedAt = task.updated || task.due || null;
  const listTitle = list.title || 'Task list';
  // webViewLink isn't always returned by tasks.list; fall back to the Tasks web app so Open always works.
  const openLink = safeLink(task.webViewLink) || 'https://tasks.google.com/';

  const meta = [
    { label: 'Title', value: task.title || '(Untitled task)' },
    { label: 'Added', value: addedAt ? formatRelative(addedAt) : 'Not set' },
    { label: 'List', value: listTitle },
    { label: 'Notes', value: notes || 'No notes' },
    { label: 'Open', value: 'Open in Google Tasks', href: openLink },
  ];

  return {
    source: 'Google Tasks',
    tag: listTitle,
    list: listTitle,
    listId: list.id,
    taskId: task.id,
    title: task.title || '(Untitled task)',
    body: notesSnippet,
    addedAt,
    refId: 'gtask:' + task.id,
    link: openLink,
    meta,
  };
}

async function fetchGoogleTasks(token) {
  const headers = { Authorization: 'Bearer ' + token };
  const lists = await fetchAllTaskLists(headers);
  if (lists.length === 0) return [];

  const perList = await Promise.all(
    lists.map(async (list) => {
      const tasks = await fetchTasksForList(headers, list);
      return tasks
        .filter((task) => task && task.title && task.status !== 'completed')
        .map((task) => mapTask(task, list));
    })
  );

  return perList
    .flat()
    .sort((a, b) => new Date(b.addedAt || 0).getTime() - new Date(a.addedAt || 0).getTime())
    .slice(0, 100);
}

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

async function findReviewLaterPlaylist(headers) {
  const target = YOUTUBE_PLAYLIST_TITLE.toLowerCase();
  let pageToken = null;
  do {
    const params = new URLSearchParams({ part: 'id,snippet', mine: 'true', maxResults: '50' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(YOUTUBE_API + '/playlists?' + params.toString(), { headers });
    if (!response.ok) {
      throw new Error('Could not read your YouTube playlists. Please sign in again and retry.');
    }
    const data = await response.json();
    const match = (Array.isArray(data.items) ? data.items : []).find(
      (entry) => String(entry?.snippet?.title || '').trim().toLowerCase() === target
    );
    if (match?.id) return match.id;
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return null;
}

function mapPlaylistItem(item, playlistTitle) {
  const snippet = item?.snippet || {};
  const videoId = item?.contentDetails?.videoId || snippet?.resourceId?.videoId || '';
  const title = snippet.title || 'Untitled video';
  const channel = snippet.videoOwnerChannelTitle || snippet.channelTitle || 'Unknown channel';
  const description = typeof snippet.description === 'string' ? snippet.description.trim() : '';
  const descSnippet = description.length > 140 ? description.slice(0, 137) + '…' : description;
  // snippet.publishedAt is when the item was added to the playlist; videoPublishedAt is the channel's upload date, so never use it here.
  const addedAt = snippet.publishedAt || null;
  const watchUrl = videoId ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) : '';
  const listName = playlistTitle || 'YouTube';

  const meta = [
    { label: 'Title', value: title },
    { label: 'Added', value: addedAt ? formatRelative(addedAt) : 'Not set' },
    { label: 'Playlist', value: listName },
    { label: 'Channel', value: channel },
    { label: 'Description', value: description || 'No description' },
  ];
  if (watchUrl) meta.push({ label: 'Open', value: 'Watch on YouTube', href: watchUrl });

  return {
    source: 'YouTube',
    tag: listName,
    playlist: listName,
    playlistItemId: item?.id || '',
    title,
    body: descSnippet || channel,
    addedAt,
    refId: 'yt:' + (videoId || item?.id || ''),
    link: watchUrl,
    meta,
  };
}

async function fetchPlaylistItems(headers, playlistId, playlistTitle) {
  const raw = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ part: 'snippet,contentDetails', playlistId, maxResults: '50' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(YOUTUBE_API + '/playlistItems?' + params.toString(), { headers });
    if (!response.ok) {
      if (raw.length) break;
      throw new Error('Could not read items from your YouTube playlist.');
    }
    const data = await response.json();
    raw.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && raw.length < 100);
  return raw.map((item) => mapPlaylistItem(item, playlistTitle));
}

// List the account's playlists for the Settings picker.
export async function fetchYouTubePlaylists(token) {
  const headers = { Authorization: 'Bearer ' + token };
  const out = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ part: 'id,snippet,contentDetails', mine: 'true', maxResults: '50' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(YOUTUBE_API + '/playlists?' + params.toString(), { headers });
    if (!response.ok) throw new Error('Could not read your YouTube playlists. Please sign in again and retry.');
    const data = await response.json();
    (Array.isArray(data.items) ? data.items : []).forEach((p) => {
      out.push({ id: p.id, title: String(p?.snippet?.title || 'Untitled playlist'), count: p?.contentDetails?.itemCount ?? null });
    });
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return out;
}

// Consolidate items from all selected playlists (defaults to the "Review Later" playlist).
async function fetchYouTube(token) {
  const headers = { Authorization: 'Bearer ' + token };
  let ids = getYouTubePlaylistIds();
  const titleById = new Map();
  let playlists = [];
  try {
    playlists = await fetchYouTubePlaylists(token);
  } catch {
    playlists = [];
  }
  playlists.forEach((pl) => titleById.set(pl.id, pl.title));
  if (!ids.length) {
    const preset = playlists.find((pl) => pl.title.trim().toLowerCase() === YOUTUBE_PLAYLIST_TITLE.toLowerCase());
    if (preset) {
      ids = [preset.id];
    } else {
      const legacy = await findReviewLaterPlaylist(headers);
      if (legacy) {
        ids = [legacy];
        titleById.set(legacy, YOUTUBE_PLAYLIST_TITLE);
      }
    }
  }
  if (!ids.length) {
    throw new Error('No YouTube playlist selected. Pick one in Settings, or create a "' + YOUTUBE_PLAYLIST_TITLE + '" playlist.');
  }
  const collected = [];
  for (const playlistId of ids) {
    const title = titleById.get(playlistId) || 'YouTube';
    try {
      collected.push(...(await fetchPlaylistItems(headers, playlistId, title)));
    } catch {
      /* skip a failing playlist, keep the rest */
    }
  }
  const seen = new Set();
  const items = [];
  collected.forEach((item) => {
    if (seen.has(item.refId)) return;
    seen.add(item.refId);
    items.push(item);
  });
  return items
    .sort((a, b) => new Date(b.addedAt || 0).getTime() - new Date(a.addedAt || 0).getTime())
    .slice(0, 100);
}

const LOADERS = {
  google_tasks: fetchGoogleTasks,
  youtube_review_later: fetchYouTube,
};

// Permanently remove an inbox item at its source (Google Tasks task or YouTube playlist item), then drop it from the cache.
export async function removeInboxItem(sourceId, item) {
  if (!state.token || !item) return;
  const headers = { Authorization: 'Bearer ' + state.token };
  if (sourceId === 'google_tasks') {
    if (!item.listId || !item.taskId) throw new Error('This task is missing the ids needed to delete it.');
    const res = await fetch(
      TASKS_API + '/lists/' + encodeURIComponent(item.listId) + '/tasks/' + encodeURIComponent(item.taskId),
      { method: 'DELETE', headers }
    );
    if (!res.ok && res.status !== 404) throw new Error('Could not delete this task from Google Tasks.');
  } else if (sourceId === 'youtube_review_later') {
    if (!item.playlistItemId) throw new Error('This video is missing the id needed to remove it.');
    const res = await fetch(YOUTUBE_API + '/playlistItems?id=' + encodeURIComponent(item.playlistItemId), {
      method: 'DELETE',
      headers,
    });
    if (!res.ok && res.status !== 404) throw new Error('Could not remove this video from your YouTube playlist.');
  } else {
    return;
  }
  const slice = sourceState(sourceId);
  slice.items = slice.items.filter((entry) => {
    if (sourceId === 'google_tasks') return entry.taskId !== item.taskId;
    if (sourceId === 'youtube_review_later') return entry.playlistItemId !== item.playlistItemId;
    return entry.refId !== item.refId;
  });
  renderInbox();
}

export function activeSource() {
  return SOURCES.find((source) => source.id === state.activeSource) || SOURCES[0];
}

const STALE_MS = 5 * 60 * 1000;

export function sourceState(id) {
  return (
    state.sources[id] ||
    (state.sources[id] = { items: [], status: 'idle', error: '', fetchedAt: null })
  );
}

export function currentSourceState() {
  return sourceState(state.activeSource);
}

function isStale(slice) {
  return !slice.fetchedAt || Date.now() - slice.fetchedAt > STALE_MS;
}

// Fetch one source into its own cache slice; keeps stale items visible on refresh failures.
async function loadSource(sourceId, { force = false } = {}) {
  if (!state.profile || !state.token) return;
  const slice = sourceState(sourceId);
  if (slice.status === 'loading' || slice.status === 'refreshing') return;
  if (!force && slice.status === 'ready' && !isStale(slice)) return;

  const loader = LOADERS[sourceId] || LOADERS.google_tasks;
  slice.status = slice.items.length ? 'refreshing' : 'loading';
  slice.error = '';
  renderInbox();

  try {
    const items = await loader(state.token);
    slice.items = items;
    slice.status = 'ready';
    slice.error = '';
    slice.fetchedAt = Date.now();
  } catch (error) {
    slice.status = slice.items.length ? 'ready' : 'error';
    slice.error = error.message || 'Could not sync this source.';
  }
  renderInbox();
}

// Fetch every enabled source in parallel (used on sign-in / boot).
export async function refreshAllSources(options = {}) {
  await Promise.all(
    SOURCES.filter((source) => isSourceEnabled(source.id)).map((source) => loadSource(source.id, options))
  );
}

export async function refreshActiveSource(options = {}) {
  await loadSource(state.activeSource, options);
}

// Show cached items instantly; revalidate in the background only if idle or stale.
export async function ensureActiveSourceLoaded() {
  const slice = currentSourceState();
  if (slice.status === 'idle' || isStale(slice)) {
    await loadSource(state.activeSource);
  } else {
    renderInbox();
  }
}
