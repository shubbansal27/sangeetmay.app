// Inbox source adapters. Each adapter maps a provider into the shared item model.

import { SOURCES, YOUTUBE_PLAYLIST_TITLE } from './config.js';
import { state } from './store.js';
import { formatRelative } from './utils.js';
import { renderInbox } from './inbox.js';
import { recordBookmarksSeen } from './drive.js';

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

function mapPlaylistItem(item) {
  const snippet = item?.snippet || {};
  const videoId = item?.contentDetails?.videoId || snippet?.resourceId?.videoId || '';
  const title = snippet.title || 'Untitled video';
  const channel = snippet.videoOwnerChannelTitle || snippet.channelTitle || 'Unknown channel';
  const description = typeof snippet.description === 'string' ? snippet.description.trim() : '';
  const descSnippet = description.length > 140 ? description.slice(0, 137) + '…' : description;
  const addedAt = snippet.publishedAt || item?.contentDetails?.videoPublishedAt || null;
  const watchUrl = videoId ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) : '';

  const meta = [
    { label: 'Title', value: title },
    { label: 'Added', value: addedAt ? formatRelative(addedAt) : 'Not set' },
    { label: 'Channel', value: channel },
    { label: 'Description', value: description || 'No description' },
  ];
  if (watchUrl) meta.push({ label: 'Open', value: 'Watch on YouTube', href: watchUrl });

  return {
    source: 'YouTube: ' + YOUTUBE_PLAYLIST_TITLE,
    tag: channel,
    title,
    body: descSnippet || channel,
    addedAt,
    refId: 'yt:' + (videoId || item?.id || ''),
    link: watchUrl,
    meta,
  };
}

async function fetchYouTubeReviewLater(token) {
  const headers = { Authorization: 'Bearer ' + token };
  const playlistId = await findReviewLaterPlaylist(headers);
  if (!playlistId) {
    throw new Error('Could not find a playlist named "' + YOUTUBE_PLAYLIST_TITLE + '" in this account.');
  }

  const items = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(YOUTUBE_API + '/playlistItems?' + params.toString(), { headers });
    if (!response.ok) {
      if (items.length) break;
      throw new Error('Could not read items from your YouTube playlist.');
    }
    const data = await response.json();
    items.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && items.length < 100);

  return items
    .map(mapPlaylistItem)
    .sort((a, b) => new Date(b.addedAt || 0).getTime() - new Date(a.addedAt || 0).getTime())
    .slice(0, 100);
}

const LOADERS = {
  google_tasks: fetchGoogleTasks,
  youtube_review_later: fetchYouTubeReviewLater,
};

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
    if (items.length) recordBookmarksSeen(sourceId, items).catch(() => {});
  } catch (error) {
    slice.status = slice.items.length ? 'ready' : 'error';
    slice.error = error.message || 'Could not sync this source.';
  }
  renderInbox();
}

// Fetch every source in parallel (used on sign-in / boot).
export async function refreshAllSources(options = {}) {
  await Promise.all(SOURCES.map((source) => loadSource(source.id, options)));
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
