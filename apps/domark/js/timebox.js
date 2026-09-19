// Timebox view: renders scheduled calendar timeboxes (the create form lives in index.html).

import { state } from './store.js';
import { byId, escapeHtml } from './utils.js';
import { listTimeboxes } from './calendar.js';

let timeboxes = [];
let loading = false;

function formatWhen(event) {
  const startRaw = event?.start?.dateTime || event?.start?.date;
  const endRaw = event?.end?.dateTime || event?.end?.date;
  const start = startRaw ? new Date(startRaw) : null;
  const end = endRaw ? new Date(endRaw) : null;
  if (!start) return '';
  const dateStr = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!end) return dateStr + ' · ' + timeStr;
  const endStr = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  return dateStr + ' · ' + timeStr + '–' + endStr + ' (' + mins + ' min)';
}

function timeboxRow(event) {
  const link = event.htmlLink
    ? '<a class="timebox-card__open" href="' + escapeHtml(event.htmlLink) + '" target="_blank" rel="noopener">Open in Calendar</a>'
    : '';
  const desc = event.description ? '<p class="timebox-card__desc">' + escapeHtml(event.description) + '</p>' : '';
  return (
    '<article class="timebox-card">' +
    '<div class="timebox-card__main">' +
    '<h4 class="timebox-card__title">' + escapeHtml(event.summary || 'Untitled') + '</h4>' +
    '<p class="timebox-card__when">' + escapeHtml(formatWhen(event)) + '</p>' +
    desc +
    '</div>' +
    '<div class="timebox-card__actions">' +
    link +
    '<button class="btn btn--ghost btn--sm" type="button" data-cancel-timebox="' + escapeHtml(event.id) + '">Cancel</button>' +
    '</div>' +
    '</article>'
  );
}

function stateCard(title, copy) {
  return '<div class="inbox-state"><div class="inbox-state__icon">🗓</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(copy) + '</p></div>';
}

export function renderTimebox() {
  const list = byId('timebox-list');
  if (!list) return;
  if (!state.profile) {
    list.innerHTML = stateCard('Sign in to schedule', 'Your scheduled timeboxes will appear here.');
    return;
  }
  if (loading && timeboxes.length === 0) {
    list.innerHTML = '<div class="inbox-row inbox-row--skeleton"><span></span><span></span></div>'.repeat(3);
    return;
  }
  if (timeboxes.length === 0) {
    list.innerHTML = stateCard('No timeboxes yet', 'Schedule focused time above and it will show up here.');
    return;
  }
  list.innerHTML = timeboxes.map(timeboxRow).join('');
}

export async function refreshTimeboxes() {
  if (!state.profile || !state.token) {
    renderTimebox();
    return;
  }
  loading = true;
  renderTimebox();
  try {
    timeboxes = await listTimeboxes();
  } catch {
    timeboxes = [];
  }
  loading = false;
  renderTimebox();
}

export function resetTimeboxes() {
  timeboxes = [];
  loading = false;
}
