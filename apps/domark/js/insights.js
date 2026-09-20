// Insights view: live snapshot of the follow-through funnel, derived entirely from current state (no Drive ledger).

import { state } from './store.js';
import { byId, escapeHtml } from './utils.js';
import { sourceState } from './sources.js';
import { enabledSourceIds } from './settings.js';
import { DATE_FILTERS } from './config.js';
import { allCategories } from './categories.js';

let selectedRange = 'all';
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

function completedProject(project) {
  return Number(project.progress) >= 100 || project.status === 'Complete';
}

// Synthesise created/completed "events" from current projects so the range/trend/donut code stays unchanged.
function projectCreatedEvents() {
  return state.projects
    .filter((project) => project.createdAt)
    .map((project) => ({ at: project.createdAt, projectId: project.id }));
}

function projectCompletedEvents() {
  return state.projects
    .filter((project) => completedProject(project) && (project.completedAt || project.createdAt))
    .map((project) => ({ at: project.completedAt || project.createdAt, projectId: project.id }));
}

// Unique current inbox items across enabled sources (carry source + list/playlist tag + addedAt).
function bookmarkItems() {
  const seen = new Set();
  const items = [];
  enabledSourceIds().forEach((id) => {
    const slice = sourceState(id);
    (slice.items || []).forEach((item) => {
      const ref = item.refId;
      if (!ref || seen.has(ref)) return;
      seen.add(ref);
      items.push(item);
    });
  });
  return items;
}

// Bookmarks not yet turned into a project.
function waitingItems() {
  const mapped = new Set();
  state.projects.forEach((project) => {
    const ref = (project.bookmark && project.bookmark.refId) || project.bookmarkRef;
    if (ref) mapped.add(ref);
  });
  return bookmarkItems().filter((item) => !mapped.has(item.refId));
}

// Waiting-now count + how many have been sitting over 30 days. Pure live snapshot.
function computeWaitingLive() {
  const STALE_MS = 30 * DAY_MS;
  const items = waitingItems();
  let stale = 0;
  items.forEach((item) => {
    const t = item.addedAt ? new Date(item.addedAt).getTime() : NaN;
    if (!Number.isNaN(t) && Date.now() - t > STALE_MS) stale += 1;
  });
  return { waiting: items.length, stale };
}

// Timeline events: when current bookmarks were saved, tagged by source for stacking.
function bookmarkEvents() {
  return bookmarkItems()
    .filter((item) => item.addedAt)
    .map((item) => ({ at: item.addedAt, source: item.source || 'Other' }));
}

// Age (days from today) of each unassigned bookmark, bucketed to show how long saves are piling up.
const AGE_BUCKETS = [
  { label: '0–1d', max: 1 },
  { label: '2–7d', max: 7 },
  { label: '8–30d', max: 30 },
  { label: '31–90d', max: 90 },
  { label: '90d+', max: Infinity },
];

function waitingAges() {
  return waitingItems().map((item) => {
    const t = item.addedAt ? new Date(item.addedAt).getTime() : NaN;
    return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
  });
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
    '<span class="ins-stat__value">' + escapeHtml(String(value)) + '</span>' +
    '<span class="ins-stat__label">' + escapeHtml(title) + '</span>' +
    '<span class="ins-stat__sub">' + escapeHtml(sub) + '</span>' +
    '<span class="ins-stat__more">' + (open ? 'Hide breakdown' : 'By category') +
    ' <span class="ins-stat__morecaret" aria-hidden="true">▾</span></span>' +
    '</button>'
  );
}

function waitingStat(w) {
  const note = w.stale ? w.stale + ' waiting over 30 days' : 'Nothing piling up';
  return (
    '<div class="ins-stat ins-stat--wait">' +
    '<span class="ins-stat__value">' + w.waiting + '</span>' +
    '<span class="ins-stat__label">Bookmarks waiting</span>' +
    '<span class="ins-stat__sub">' + escapeHtml(note) + '</span>' +
    '</div>'
  );
}

function bookmarksSection(waiting, rangeId) {
  return (
    '<section class="ins-group">' +
    '<h3 class="ins-group__title">Bookmarks</h3>' +
    '<div class="ins-hero ins-hero--1">' + waitingStat(waiting) + '</div>' +
    bookmarkTimelineBlock(bookmarkEvents(), rangeId) +
    pendingAgeBlock(waitingAges()) +
    '</section>'
  );
}

// Distribution of how old the unassigned (waiting) bookmarks are, measured from today.
function pendingAgeBlock(ages) {
  const counts = AGE_BUCKETS.map(() => 0);
  ages.forEach((days) => {
    const idx = AGE_BUCKETS.findIndex((bucket) => days <= bucket.max);
    counts[idx >= 0 ? idx : AGE_BUCKETS.length - 1] += 1;
  });
  const max = Math.max(1, ...counts);
  let columns = '';
  AGE_BUCKETS.forEach((bucket, i) => {
    const count = counts[i];
    const h = Math.round((count / max) * 100);
    columns +=
      '<div class="ins-col" title="' + escapeHtml(bucket.label + ': ' + count + ' waiting') + '">' +
      '<div class="ins-col__track">' +
      '<div class="ins-col__bar ins-col__bar--saved" style="height:' + h + '%"></div>' +
      '</div>' +
      '<span class="ins-col__x">' + escapeHtml(bucket.label) + '</span>' +
      '</div>';
  });
  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><h3>Waiting time</h3>' +
    '<span class="ins-legend"><span class="ins-legend__key ins-legend__key--saved"></span>Waiting</span></div>' +
    '<div class="ins-chart">' + columns + '</div>' +
    '</div>'
  );
}

function projectsSection(createdInRange, completedInRange, created, completed, catMap, rangeId, active) {
  const label = 'in ' + rangeLabel(rangeId);
  const rate = created.length ? Math.round((completed.length / created.length) * 100) : 0;
  const cards =
    '<div class="ins-hero ins-hero--2">' +
    statButton('created', createdInRange.length, 'Projects created', label, active === 'created') +
    statButton('completed', completedInRange.length, 'Completed', rate + '% of all created', active === 'completed') +
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

// Single-series timeline of bookmarks saved over the selected range.
function bookmarkTimelineBlock(events, rangeId) {
  const plan = trendPlan(rangeId, events);
  const byBucket = bucketize(events, plan);
  const max = Math.max(1, ...byBucket);
  let columns = '';
  for (let i = 0; i < plan.count; i += 1) {
    const count = byBucket[i];
    const h = Math.round((count / max) * 100);
    const label = bucketLabel(plan.start + i * plan.step, plan.unit);
    columns +=
      '<div class="ins-col" title="' + escapeHtml(label + ': ' + count + ' saved') + '">' +
      '<div class="ins-col__track">' +
      '<div class="ins-col__bar ins-col__bar--saved" style="height:' + h + '%"></div>' +
      '</div>' +
      '<span class="ins-col__x">' + escapeHtml(label) + '</span>' +
      '</div>';
  }
  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><h3>Bookmark timeline</h3>' +
    '<span class="ins-legend"><span class="ins-legend__key ins-legend__key--saved"></span>Saved</span></div>' +
    '<div class="ins-chart">' + columns + '</div>' +
    '</div>'
  );
}

function emptyState() {
  return '<p class="muted insights-note">Save bookmarks and complete projects to start tracking your progress.</p>';
}

function dashboard(rangeId) {
  const created = projectCreatedEvents();
  const completed = projectCompletedEvents();
  const waiting = computeWaitingLive();
  if (created.length === 0 && completed.length === 0 && waiting.waiting === 0) {
    return rangeBar(rangeId) + emptyState();
  }
  const createdInRange = created.filter((event) => inRange(event, rangeId));
  const completedInRange = completed.filter((event) => inRange(event, rangeId));
  const catMap = projectCategoryMap();
  return (
    rangeBar(rangeId) +
    bookmarksSection(waiting, rangeId) +
    projectsSection(createdInRange, completedInRange, created, completed, catMap, rangeId, activePie)
  );
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
  root.innerHTML = dashboard(selectedRange);
}

// View-only reset when switching profiles; insights are always derived live from current state.
export function resetInsights() {
  activePie = null;
}

export function showInsights() {
  renderInsights();
}

export function refreshInsights() {
  renderInsights();
}
