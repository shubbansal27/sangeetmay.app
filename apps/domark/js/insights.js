// Insights view: aggregates the Drive event ledger into streaks, a funnel and trends.

import { state } from './store.js';
import { byId, escapeHtml } from './utils.js';
import { loadInsights, loadInsightEvents } from './drive.js';

let insightsData = null;
let loading = false;

function dayKey(iso) {
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function countToday(list) {
  const today = dayKey(new Date().toISOString());
  return list.filter((event) => dayKey(event.at) === today).length;
}

function countLastDays(list, days) {
  const cutoff = Date.now() - days * 86400000;
  return list.filter((event) => new Date(event.at).getTime() >= cutoff).length;
}

function tallyByDay(list) {
  const map = Object.create(null);
  list.forEach((event) => {
    const key = dayKey(event.at);
    map[key] = (map[key] || 0) + 1;
  });
  return map;
}

function statCard(label, value, sub) {
  return (
    '<div class="insight-card">' +
    '<span class="insight-card__value">' + escapeHtml(String(value)) + '</span>' +
    '<span class="insight-card__label">' + escapeHtml(label) + '</span>' +
    (sub ? '<span class="insight-card__sub">' + escapeHtml(sub) + '</span>' : '') +
    '</div>'
  );
}

function funnelBlock(totals) {
  const actionRate = totals.bookmarksAdded ? Math.round((totals.projectsCreated / totals.bookmarksAdded) * 100) : 0;
  const completeRate = totals.projectsCreated ? Math.round((totals.projectsCompleted / totals.projectsCreated) * 100) : 0;
  const step = (label, value, pct) =>
    '<div class="funnel__step">' +
    '<span class="funnel__value">' + escapeHtml(String(value)) + '</span>' +
    '<span class="funnel__label">' + escapeHtml(label) + '</span>' +
    (pct != null ? '<span class="funnel__pct">' + pct + '%</span>' : '') +
    '</div>';
  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><h3>Action funnel</h3></div>' +
    '<div class="funnel">' +
    step('Saved', totals.bookmarksAdded, null) +
    '<span class="funnel__arrow">→</span>' +
    step('Acted', totals.projectsCreated, actionRate) +
    '<span class="funnel__arrow">→</span>' +
    step('Completed', totals.projectsCompleted, completeRate) +
    '</div>' +
    '<p class="funnel__hint">' +
    escapeHtml(actionRate + '% of saved bookmarks became projects · ' + completeRate + '% of those are done') +
    '</p>' +
    '</div>'
  );
}

function trendChart(added, created, days) {
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(dayKey(d.toISOString()));
  }
  const addMap = tallyByDay(added);
  const crMap = tallyByDay(created);
  const max = Math.max(1, ...keys.map((key) => addMap[key] || 0));

  const columns = keys
    .map((key) => {
      const saved = addMap[key] || 0;
      const acted = crMap[key] || 0;
      const h = Math.round((saved / max) * 100);
      const label = key.slice(5);
      return (
        '<div class="ins-col" title="' + escapeHtml(key + ': ' + saved + ' saved, ' + acted + ' acted') + '">' +
        '<div class="ins-col__track"><div class="ins-col__bar" style="height:' + h + '%"></div>' +
        (acted ? '<span class="ins-col__dot"></span>' : '') + '</div>' +
        '<span class="ins-col__x">' + escapeHtml(label) + '</span>' +
        '</div>'
      );
    })
    .join('');

  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><h3>Last ' + days + ' days</h3>' +
    '<span class="muted">bars = saved · dot = acted</span></div>' +
    '<div class="ins-chart">' + columns + '</div>' +
    '</div>'
  );
}

function dashboard(data) {
  const events = Array.isArray(data.events) ? data.events : [];
  const added = events.filter((event) => event.type === 'bookmark_added');
  const created = events.filter((event) => event.type === 'project_created');
  const completed = events.filter((event) => event.type === 'project_completed');

  const totals = (data.state && data.state.totals) || {
    bookmarksAdded: added.length,
    projectsCreated: created.length,
    projectsCompleted: completed.length,
  };
  const streak = (data.state && data.state.streak) || { current: 0, longest: 0 };

  const cards =
    '<div class="insights-cards">' +
    statCard('Day streak', streak.current || 0, 'Longest ' + (streak.longest || 0)) +
    statCard('Saved today', countToday(added), null) +
    statCard('Saved this week', countLastDays(added, 7), null) +
    statCard('Acted this week', countLastDays(created, 7), null) +
    statCard('Completed this week', countLastDays(completed, 7), null) +
    '</div>';

  const empty = added.length === 0 && created.length === 0;

  return (
    cards +
    funnelBlock(totals) +
    trendChart(added, created, 14) +
    (empty ? '<p class="muted insights-note">Save bookmarks and turn them into projects to grow your streak.</p>' : '')
  );
}

function skeleton() {
  return '<div class="insights-cards">' + Array.from({ length: 5 }).map(() => '<div class="insight-card insight-card--skeleton"></div>').join('') + '</div>';
}

function stateCard(title, copy) {
  return '<div class="inbox-state"><div class="inbox-state__icon">📊</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(copy) + '</p></div>';
}

export function renderInsights() {
  const root = byId('insights-body');
  if (!root) return;
  if (!state.profile) {
    root.innerHTML = stateCard('Sign in to see insights', 'Your streaks and action funnel appear here once you sign in.');
    return;
  }
  if (loading && !insightsData) {
    root.innerHTML = skeleton();
    return;
  }
  if (!insightsData) {
    root.innerHTML = stateCard('No insights yet', 'Sync your inbox and take action to start tracking momentum.');
    return;
  }
  root.innerHTML = dashboard(insightsData);
}

// Reload the ledger from Drive, then re-render the view.
export async function refreshInsights() {
  if (!state.profile || !state.token) {
    renderInsights();
    return;
  }
  loading = true;
  renderInsights();
  try {
    const [stateObj, events] = await Promise.all([loadInsights(), loadInsightEvents(6)]);
    insightsData = { state: stateObj, events };
  } catch {
    insightsData = { state: null, events: [] };
  }
  loading = false;
  renderInsights();
}
