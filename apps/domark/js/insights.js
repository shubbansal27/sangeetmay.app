// Insights view: aggregates the Drive event ledger into saved/completed metrics across a timeline range.

import { state } from './store.js';
import { byId, escapeHtml } from './utils.js';
import { loadInsights, loadInsightEvents } from './drive.js';
import { SOURCES, DATE_FILTERS } from './config.js';
import { allCategories } from './categories.js';

let insightsData = null;
let loading = false;
let selectedRange = '7d';
let activePie = null;
let wired = false;

const DAY_MS = 86400000;

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  const offset = (d.getDay() + 6) % 7; // Monday-based week
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

function rangeCutoff(rangeId) {
  const today = startOfDay(Date.now());
  switch (rangeId) {
    case '1d': return today;
    case '7d': return today - 6 * DAY_MS;
    case '30d': return today - 29 * DAY_MS;
    case '90d': return today - 89 * DAY_MS;
    default: return 0;
  }
}

function inRange(event, rangeId) {
  return new Date(event.at).getTime() >= rangeCutoff(rangeId);
}

function rangeLabel(rangeId) {
  const filter = DATE_FILTERS.find((item) => item.id === rangeId);
  return filter ? filter.label.toLowerCase() : 'all time';
}

function rangeBar(rangeId) {
  const order = ['1d', '7d', '30d', '90d', 'all'];
  const buttons = order
    .map((id) => {
      const filter = DATE_FILTERS.find((item) => item.id === id);
      if (!filter) return '';
      const active = id === rangeId;
      return (
        '<button class="ins-range__btn' + (active ? ' is-active' : '') + '" type="button" data-range="' + id + '"' +
        (active ? ' aria-current="true"' : '') + '>' + escapeHtml(filter.label) + '</button>'
      );
    })
    .join('');
  return '<div class="ins-range" role="tablist" aria-label="Timeline range">' + buttons + '</div>';
}

const CATEGORY_COLORS = ['#bb4f35', '#1e6b64', '#c98a2b', '#7d5ba6', '#9a9188'];

// Join project events to their current category via state (no category is stored on the event itself).
function projectCategoryMap() {
  const map = new Map();
  state.projects.forEach((project) => map.set(project.id, project.category || 'Others'));
  return map;
}

function categoryCounts(events, catMap) {
  const counts = new Map(allCategories().map((name) => [name, 0]));
  events.forEach((event) => {
    const cat = catMap.get(event.projectId) || 'Others';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  });
  return [...counts.keys()].map((name, i) => ({
    name,
    count: counts.get(name) || 0,
    color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
  }));
}

const SERIES_COLORS = CATEGORY_COLORS;

function sourceCounts(added) {
  return SOURCES.map((source, i) => ({
    name: source.label,
    count: added.filter((event) => event.source === source.id).length,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
  }));
}

// Live snapshot: unique saved bookmarks that never became a project. Not tied to the selected range.
function computeWaiting(added, created) {
  const mapped = new Set();
  state.projects.forEach((project) => {
    const ref = (project.bookmark && project.bookmark.refId) || project.bookmarkRef;
    if (ref) mapped.add(ref);
  });
  created.forEach((event) => {
    if (event.refId) mapped.add(event.refId);
  });
  const seen = new Set();
  let waiting = 0;
  added.forEach((event) => {
    const ref = event.refId;
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    if (!mapped.has(ref)) waiting += 1;
  });
  const total = seen.size;
  return { waiting, total, pct: total ? Math.round((waiting / total) * 100) : 0 };
}

function donut(segments) {
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  const r = 30;
  const circ = 2 * Math.PI * r;
  let cumulative = 0;
  let arcs = '';
  if (total) {
    segments.forEach((seg) => {
      if (!seg.count) return;
      const dash = (seg.count / total) * circ;
      arcs +=
        '<circle class="ins-donut__seg" cx="40" cy="40" r="' + r + '" stroke="' + seg.color + '" ' +
        'stroke-dasharray="' + dash.toFixed(2) + ' ' + (circ - dash).toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-cumulative).toFixed(2) + '" transform="rotate(-90 40 40)"></circle>';
      cumulative += dash;
    });
  } else {
    arcs = '<circle class="ins-donut__empty" cx="40" cy="40" r="' + r + '"></circle>';
  }
  return (
    '<svg class="ins-donut__svg" viewBox="0 0 80 80" role="img" aria-label="Category distribution">' +
    arcs +
    '<text class="ins-donut__total" x="40" y="40" text-anchor="middle" dominant-baseline="central">' + total + '</text>' +
    '</svg>'
  );
}

function piePanel(segments) {
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  const legend = segments
    .filter((seg) => seg.count > 0)
    .map((seg) =>
      '<li class="ins-cat"><span class="ins-cat__key" style="background:' + seg.color + '"></span>' +
      '<span class="ins-cat__name">' + escapeHtml(seg.name) + '</span>' +
      '<span class="ins-cat__val">' + seg.count + '</span></li>'
    )
    .join('');
  return (
    '<div class="ins-pie">' +
    '<div class="ins-pie__inner">' +
    donut(segments) +
    '<ul class="ins-cat-list">' + (total ? legend : '<li class="ins-cat__empty muted">Nothing yet</li>') + '</ul>' +
    '</div>' +
    '</div>'
  );
}

function statButton(id, value, title, sub, open) {
  return (
    '<button class="ins-stat ins-stat--btn' + (open ? ' is-open' : '') + '" type="button" data-pie="' + id + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    '<span class="ins-stat__caret" aria-hidden="true">▾</span>' +
    '<span class="ins-stat__value">' + escapeHtml(String(value)) + '</span>' +
    '<span class="ins-stat__label">' + escapeHtml(title) + '</span>' +
    '<span class="ins-stat__sub">' + escapeHtml(sub) + '</span>' +
    '</button>'
  );
}

function waitingStat(w) {
  const note = 'Not yet a project' + (w.total ? ' · ' + w.pct + '% of saved' : '');
  return (
    '<div class="ins-stat ins-stat--wait">' +
    '<span class="ins-stat__value">' + w.waiting + '</span>' +
    '<span class="ins-stat__label">Bookmarks waiting</span>' +
    '<span class="ins-stat__sub">' + escapeHtml(note) + '</span>' +
    '</div>'
  );
}

function bookmarksSection(addedInRange, added, created, rangeId, active) {
  const label = 'in ' + rangeLabel(rangeId);
  const waiting = computeWaiting(added, created);
  const cards =
    '<div class="ins-hero ins-hero--2">' +
    statButton('saved', addedInRange.length, 'Bookmarks saved', label, active === 'saved') +
    waitingStat(waiting) +
    '</div>';
  const pie = active === 'saved' ? piePanel(sourceCounts(addedInRange)) : '';
  return (
    '<section class="ins-group">' +
    '<h3 class="ins-group__title">Bookmarks</h3>' +
    cards + pie +
    '</section>'
  );
}

function projectsSection(createdInRange, completedInRange, created, completed, catMap, rangeId, active) {
  const label = 'in ' + rangeLabel(rangeId);
  const cards =
    '<div class="ins-hero ins-hero--2">' +
    statButton('created', createdInRange.length, 'Projects created', label, active === 'created') +
    statButton('completed', completedInRange.length, 'Completed', label, active === 'completed') +
    '</div>';
  let pie = '';
  if (active === 'created') pie = piePanel(categoryCounts(createdInRange, catMap));
  else if (active === 'completed') pie = piePanel(categoryCounts(completedInRange, catMap));
  return (
    '<section class="ins-group ins-group--projects">' +
    '<h3 class="ins-group__title">Projects</h3>' +
    cards + pie +
    trendBlock(created, completed, rangeId) +
    '</section>'
  );
}

// Choose daily buckets for short ranges and weekly buckets for long ones.
function trendPlan(rangeId, events) {
  const todayStart = startOfDay(Date.now());
  if (rangeId === '1d') return { start: todayStart, step: DAY_MS, count: 1, unit: 'day' };
  if (rangeId === '7d') return { start: todayStart - 6 * DAY_MS, step: DAY_MS, count: 7, unit: 'day' };
  if (rangeId === '30d') return { start: todayStart - 29 * DAY_MS, step: DAY_MS, count: 30, unit: 'day' };
  if (rangeId === '90d') {
    const thisWeek = startOfWeek(Date.now());
    return { start: thisWeek - 12 * 7 * DAY_MS, step: 7 * DAY_MS, count: 13, unit: 'week' };
  }
  const times = events.map((event) => new Date(event.at).getTime()).filter((t) => !Number.isNaN(t));
  const earliest = times.length ? Math.min(...times) : Date.now();
  const spanDays = Math.floor((todayStart - startOfDay(earliest)) / DAY_MS);
  if (spanDays <= 30) {
    const count = Math.max(1, spanDays + 1);
    return { start: todayStart - (count - 1) * DAY_MS, step: DAY_MS, count, unit: 'day' };
  }
  const thisWeek = startOfWeek(Date.now());
  const weeks = Math.min(25, Math.floor((thisWeek - startOfWeek(earliest)) / (7 * DAY_MS)));
  return { start: thisWeek - weeks * 7 * DAY_MS, step: 7 * DAY_MS, count: weeks + 1, unit: 'week' };
}

function bucketize(events, plan) {
  const buckets = new Array(plan.count).fill(0);
  events.forEach((event) => {
    const idx = Math.floor((new Date(event.at).getTime() - plan.start) / plan.step);
    if (idx >= 0 && idx < plan.count) buckets[idx] += 1;
  });
  return buckets;
}

function bucketLabel(startTs, unit) {
  const d = new Date(startTs);
  if (unit === 'week') return (d.getMonth() + 1) + '/' + d.getDate();
  return String(d.getDate());
}

function trendBlock(created, completed, rangeId) {
  const plan = trendPlan(rangeId, created.concat(completed));
  const createdByBucket = bucketize(created, plan);
  const doneByBucket = bucketize(completed, plan);
  const max = Math.max(1, ...createdByBucket, ...doneByBucket);
  let columns = '';
  for (let i = 0; i < plan.count; i += 1) {
    const createdCount = createdByBucket[i];
    const done = doneByBucket[i];
    const createdH = Math.round((createdCount / max) * 100);
    const doneH = Math.round((done / max) * 100);
    const label = bucketLabel(plan.start + i * plan.step, plan.unit);
    const title = label + ': ' + createdCount + ' created, ' + done + ' completed';
    columns +=
      '<div class="ins-col" title="' + escapeHtml(title) + '">' +
      '<div class="ins-col__track">' +
      '<div class="ins-col__bar ins-col__bar--saved" style="height:' + createdH + '%"></div>' +
      '<div class="ins-col__bar ins-col__bar--done" style="height:' + doneH + '%"></div>' +
      '</div>' +
      '<span class="ins-col__x">' + escapeHtml(label) + '</span>' +
      '</div>';
  }
  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><h3>Project timeline</h3>' +
    '<span class="ins-legend">' +
    '<span class="ins-legend__key ins-legend__key--saved"></span>Created' +
    '<span class="ins-legend__key ins-legend__key--done"></span>Completed</span></div>' +
    '<div class="ins-chart">' + columns + '</div>' +
    '</div>'
  );
}

function emptyState() {
  return '<p class="muted insights-note">Save bookmarks and complete projects to start tracking your progress.</p>';
}

function dashboard(data, rangeId) {
  const events = Array.isArray(data.events) ? data.events : [];
  const added = events.filter((event) => event.type === 'bookmark_added');
  const created = events.filter((event) => event.type === 'project_created');
  const completed = events.filter((event) => event.type === 'project_completed');
  if (added.length === 0 && created.length === 0 && completed.length === 0) {
    return rangeBar(rangeId) + emptyState();
  }
  const addedInRange = added.filter((event) => inRange(event, rangeId));
  const createdInRange = created.filter((event) => inRange(event, rangeId));
  const completedInRange = completed.filter((event) => inRange(event, rangeId));
  const catMap = projectCategoryMap();
  return (
    rangeBar(rangeId) +
    bookmarksSection(addedInRange, added, created, rangeId, activePie) +
    projectsSection(createdInRange, completedInRange, created, completed, catMap, rangeId, activePie)
  );
}

function skeleton() {
  return '<div class="insights-cards">' + Array.from({ length: 5 }).map(() => '<div class="insight-card insight-card--skeleton"></div>').join('') + '</div>';
}

function stateCard(title, copy) {
  return '<div class="inbox-state"><div class="inbox-state__icon">📊</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(copy) + '</p></div>';
}

// Switch the active timeline range via event delegation; the node persists across re-renders.
function wire(root) {
  if (wired) return;
  wired = true;
  root.addEventListener('click', (event) => {
    const rangeBtn = event.target.closest('[data-range]');
    if (rangeBtn) {
      selectedRange = rangeBtn.dataset.range;
      renderInsights();
      return;
    }
    const pieBtn = event.target.closest('[data-pie]');
    if (pieBtn) {
      const id = pieBtn.dataset.pie;
      activePie = activePie === id ? null : id;
      renderInsights();
    }
  });
}

export function renderInsights() {
  const root = byId('insights-body');
  if (!root) return;
  wire(root);
  if (!state.profile) {
    root.innerHTML = stateCard('Sign in to see insights', 'Your saved and completed metrics appear here once you sign in.');
    return;
  }
  if (loading && !insightsData) {
    root.innerHTML = skeleton();
    return;
  }
  if (!insightsData) {
    root.innerHTML = stateCard('No insights yet', 'Sync your inbox and complete projects to start tracking momentum.');
    return;
  }
  root.innerHTML = dashboard(insightsData, selectedRange);
}

// Clear cached ledger/view state so the next render reflects a freshly switched profile.
export function resetInsights() {
  insightsData = null;
  activePie = null;
  loading = false;
}

// Show insights from cached data (no fetch/popup); load once if nothing is cached yet.
export function showInsights() {
  if (insightsData || !state.profile || !state.token) {
    renderInsights();
    return;
  }
  refreshInsights();
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
  } finally {
    loading = false;
    renderInsights();
  }
}
