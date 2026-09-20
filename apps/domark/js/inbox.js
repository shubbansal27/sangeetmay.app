// Inbox view: source controls, item list with loading/empty/error states.

import { state } from './store.js';
import { byId, escapeHtml, formatRelative } from './utils.js';
import { activeSource, currentSourceState, sourceState } from './sources.js';
import { isSourceEnabled, enabledSourceIds } from './settings.js';

export function itemMeta(item) {
  if (Array.isArray(item?.meta) && item.meta.length) {
    return item.meta.filter((entry) => entry && entry.label && entry.value);
  }
  const fields = [
    { label: 'Source', value: item?.source || activeSource().label || 'Source' },
    { label: 'Title', value: item?.title || 'Untitled' },
    { label: 'Added', value: item?.addedAt ? formatRelative(item.addedAt) : 'Not set' },
    { label: 'Status', value: item?.status || 'Open' },
    { label: item?.detailLabel || 'Details', value: item?.detailValue || 'Not set' },
  ];
  if (Array.isArray(item?.extraMeta)) {
    return [...fields, ...item.extraMeta.filter((entry) => entry && entry.label && entry.value)];
  }
  return fields;
}

function safeHref(href) {
  return /^https?:\/\//i.test(String(href || '')) ? href : '';
}

// Render a single metadata field, turning entries with a safe href into a link.
export function metaFieldHtml(field) {
  const href = safeHref(field?.href);
  const value = escapeHtml(field?.value ?? '');
  const inner = href
    ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + value + ' ↗</a>'
    : '<strong>' + value + '</strong>';
  return '<div><span>' + escapeHtml(field?.label ?? '') + '</span>' + inner + '</div>';
}

function parseItemDate(item) {
  const value = item && (item.addedAt || item.createdAt || item.updatedAt || item.date);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function matchesDateFilter(item, filter) {
  if (!filter || filter === 'all') return true;
  const date = parseItemDate(item);
  if (!date) return false;
  const days = Number(String(filter).replace('d', '')) || 0;
  const diff = Date.now() - date.getTime();
  return diff <= days * 24 * 60 * 60 * 1000;
}

export function renderSourceControls() {
  const enabled = enabledSourceIds();
  if (enabled.length && !enabled.includes(state.activeSource)) {
    state.activeSource = enabled[0];
  }
  document.querySelectorAll('.source-tab').forEach((button) => {
    const id = button.dataset.source;
    button.classList.toggle('hidden', !isSourceEnabled(id));
    const isActive = id === state.activeSource;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    const slice = id ? sourceState(id) : null;
    button.classList.toggle('is-loading', Boolean(slice && (slice.status === 'loading' || slice.status === 'refreshing')));
    const countEl = button.querySelector('[data-source-count]');
    if (countEl) {
      const count = slice && state.profile ? slice.items.length : 0;
      countEl.textContent = count ? String(count) : '';
    }
  });
  const select = byId('date-filter');
  if (select) select.value = state.activeDateFilter;
}

function syncedLabel(slice) {
  if (slice.status === 'loading' || slice.status === 'refreshing') return 'Refreshing…';
  if (!slice.fetchedAt) return '';
  const mins = Math.floor((Date.now() - slice.fetchedAt) / 60000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return 'Synced ' + mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return 'Synced ' + hrs + 'h ago';
  return 'Synced ' + Math.floor(hrs / 24) + 'd ago';
}

function skeletonRows(count = 4) {
  return Array.from({ length: count })
    .map(() => '<div class="inbox-row inbox-row--skeleton"><span></span><span></span></div>')
    .join('');
}

function stateCard(icon, title, copy) {
  return (
    '<div class="inbox-state">' +
    '<div class="inbox-state__icon">' + icon + '</div>' +
    '<h3>' + escapeHtml(title) + '</h3>' +
    '<p>' + escapeHtml(copy) + '</p>' +
    '</div>'
  );
}

// Match an inbox item to an existing project via the stored bookmark reference.
function findProjectForItem(item) {
  const ref = item && item.refId;
  if (!ref) return null;
  return (
    state.projects.find((project) => (project.bookmark && project.bookmark.refId) === ref || project.bookmarkRef === ref) ||
    null
  );
}

function itemRow(item) {
  const meta = escapeHtml(item.body || '');
  const badge =
    item.badge && item.badge.label
      ? '<span class="inbox-badge inbox-badge--' + escapeHtml(item.badge.tone || 'none') + '">' +
        escapeHtml(item.badge.label) + '</span>'
      : '';
  const project = findProjectForItem(item);
  const actionLabel = project ? 'Open project' : 'Create project';
  const existingAttr = project ? ' data-existing-project="' + escapeHtml(String(project.id)) + '"' : '';
  // Tasks and YouTube items carry a source id, so they can be deleted at the source.
  const removable = item.taskId || item.playlistItemId;
  const removeBtn = removable
    ? '<button class="btn btn--ghost inbox-row__remove" type="button" data-inbox-remove>Remove</button>'
    : '';
  return (
    '<article class="inbox-row" data-inbox-item="' + escapeHtml(JSON.stringify(item)) + '"' + existingAttr + '>' +
    '  <div class="inbox-row__source">' + escapeHtml(item.tag || item.source || 'Item') + '</div>' +
    '  <div class="inbox-row__body">' +
    '    <div class="inbox-row__head"><h4>' + escapeHtml(item.title || 'Untitled') + '</h4>' + badge + '</div>' +
    (meta ? '    <p>' + meta + '</p>' : '') +
    '  </div>' +
    '  <div class="inbox-row__actions">' +
    '    <button class="btn btn--soft inbox-row__action" type="button" data-inbox-action>' + actionLabel + '</button>' +
    removeBtn +
    '  </div>' +
    '</article>'
  );
}

// Populate a source-specific group filter (YouTube playlists / Task lists) from the loaded items.
function renderGroupFilter(slice, visible, cfg) {
  const wrap = byId(cfg.wrapId);
  const select = byId(cfg.selectId);
  if (!wrap || !select) return;
  wrap.classList.toggle('hidden', !visible);
  if (!visible) return;
  const names = [...new Set(slice.items.map((item) => item[cfg.field]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state[cfg.stateKey] !== 'all' && !names.includes(state[cfg.stateKey])) state[cfg.stateKey] = 'all';
  select.innerHTML =
    '<option value="all">' + escapeHtml(cfg.allLabel) + '</option>' +
    names
      .map((name) => '<option value="' + escapeHtml(name) + '"' + (name === state[cfg.stateKey] ? ' selected' : '') + '>' + escapeHtml(name) + '</option>')
      .join('');
  select.value = state[cfg.stateKey];
}

export function renderInbox() {
  // Keep the source tab counts/spinners in sync whenever the inbox re-renders (e.g. a background source finishes loading).
  renderSourceControls();
  const title = byId('inbox-title');
  const copy = byId('inbox-copy');
  const list = byId('inbox-list');
  const source = activeSource();
  const slice = currentSourceState();
  const isYouTube = Boolean(state.profile) && source.id === 'youtube_review_later';
  const isTasks = Boolean(state.profile) && source.id === 'google_tasks';

  if (title) title.textContent = state.profile ? source.label : 'Waiting for sign-in';
  if (copy) {
    copy.textContent = state.profile
      ? 'Synced from ' + source.label + '. Turn any item into a project.'
      : 'Sign in to sync your bookmark sources.';
  }
  const synced = byId('inbox-synced');
  if (synced) synced.textContent = state.profile ? syncedLabel(slice) : '';
  const refreshBtn = byId('btn-inbox-refresh');
  if (refreshBtn) refreshBtn.disabled = !state.profile || slice.status === 'loading' || slice.status === 'refreshing';
  renderGroupFilter(slice, isTasks, { wrapId: 'list-filter-wrap', selectId: 'list-filter', field: 'list', stateKey: 'activeList', allLabel: 'All lists' });
  renderGroupFilter(slice, isYouTube, { wrapId: 'playlist-filter-wrap', selectId: 'playlist-filter', field: 'playlist', stateKey: 'activePlaylist', allLabel: 'All configured' });
  const linkFilter = byId('link-filter');
  if (linkFilter) linkFilter.value = state.activeLinkFilter;

  if (!list) return;

  if (!state.profile) {
    list.innerHTML = stateCard('◎', 'Sign in to begin', 'Connect Google to sync Tasks and YouTube Review Later into your inbox.');
    return;
  }
  if (slice.status === 'loading') {
    list.innerHTML = skeletonRows();
    return;
  }
  if (slice.status === 'error') {
    list.innerHTML = stateCard('!', 'Sync failed', slice.error || 'Could not load this source.');
    return;
  }

  const items = slice.items
    .filter((item) => matchesDateFilter(item, state.activeDateFilter))
    .filter((item) => !isYouTube || state.activePlaylist === 'all' || item.playlist === state.activePlaylist)
    .filter((item) => !isTasks || state.activeList === 'all' || item.list === state.activeList)
    // Assigned = already turned into a project; unassigned = still just a bookmark.
    .filter((item) => {
      if (state.activeLinkFilter === 'all') return true;
      const hasProject = Boolean(findProjectForItem(item));
      return state.activeLinkFilter === 'assigned' ? hasProject : !hasProject;
    });
  if (items.length === 0) {
    list.innerHTML = stateCard('◇', 'Nothing here yet', 'No items in this window. Try a wider date range or another source.');
    return;
  }

  list.innerHTML = items.map(itemRow).join('');
}
