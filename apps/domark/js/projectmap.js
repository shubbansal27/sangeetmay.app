// Project mind map: a Coggle-style canvas that is each project's main view, with project resources pinnable to items.

import { state, saveProjects } from './store.js';
import { STORAGE_KEYS, ARTIFACT_TYPES } from './config.js';
import { profileKey } from './profiles.js';
import { byId, escapeHtml, uid } from './utils.js';
import { showToast } from './feedback.js';
import { loadProjectMap, saveProjectMap, saveProjectResources } from './drive.js';

const PALETTE = ['#e0533d', '#ea9a2e', '#5aa84b', '#2f9e9a', '#3d7fd1', '#8a5cc7', '#d14f8f', '#7a6a58'];
const ROOT_COLOR = '#3a332c';
const H_GAP = 64;
const V_GAP = 12;
const HISTORY_LIMIT = 100;
const SAVE_DELAY = 1500;
const PIN_SAVE_DELAY = 800;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD = 4;
const MAX_BADGES = 4;
const ID_RE = /^[\w-]{1,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const RESOURCE_MIME = 'text/x-domark-resource';
const SHAPES = [
  { id: 'underline', label: 'Underline', icon: '<path d="M2 11.5h12" stroke-width="2.4"/>' },
  { id: 'rect', label: 'Rectangle', icon: '<rect x="1.5" y="4" width="13" height="8"/>' },
  { id: 'rounded', label: 'Rounded', icon: '<rect x="1.5" y="4" width="13" height="8" rx="2.5"/>' },
  { id: 'pill', label: 'Pill', icon: '<rect x="1.5" y="4" width="13" height="8" rx="4"/>' },
  { id: 'oval', label: 'Oval', icon: '<ellipse cx="8" cy="8" rx="6.5" ry="4.5"/>' },
  { id: 'square', label: 'Square', icon: '<rect x="3" y="3" width="10" height="10"/>' },
  { id: 'circle', label: 'Circle', icon: '<circle cx="8" cy="8" r="5.5"/>' },
  { id: 'diamond', label: 'Diamond', icon: '<path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/>' },
  { id: 'hexagon', label: 'Hexagon', icon: '<path d="M4.5 3h7l3 5-3 5h-7l-3-5Z"/>' },
];
const SHAPE_IDS = new Set(SHAPES.map((s) => s.id));
const HEX_INSET = 14;

let cache = null; // { [projectId]: { map, fileId } }
let project = null;
let current = null;
let readOnly = false;
let loadSeq = 0;
let pushChain = Promise.resolve();
let view = { x: 0, y: 0, k: 1 };
let selectedId = null;
let selectedLinkId = null;
let editing = null; // { id, before, isNew }
let linkFromId = null;
let undoStack = [];
let redoStack = [];
let saveTimer = null;
let pinTimer = null;
let sizes = {};
let gesture = null;
let shapeMenuOpen = false;
let fullscreen = false;
let resourcesOpen = window.matchMedia('(min-width: 821px)').matches;
const pointers = new Map();

/* ---------- Local cache ---------- */

function cacheKey() {
  return profileKey(STORAGE_KEYS.projectMaps);
}

function getCache() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cache = raw;
  } catch {
    /* ignore corrupt cache */
  }
  if (!cache) cache = {};
  return cache;
}

function cacheEntry(id) {
  const c = getCache();
  if (!c[id]) c[id] = { map: null, fileId: null };
  return c[id];
}

function persistCache() {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(getCache()));
  } catch {
    /* quota exceeded: Drive remains the source of truth */
  }
}

/* ---------- Validation (Drive files are untrusted) ---------- */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, n)) : 0;
}

function isoOrNow(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeMap(raw, id) {
  if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object') return null;
  const nodes = {};
  Object.values(raw.nodes).forEach((n) => {
    if (!n || !ID_RE.test(String(n.id))) return;
    const node = {
      id: String(n.id),
      parent: n.parent != null && ID_RE.test(String(n.parent)) ? String(n.parent) : null,
      text: String(n.text ?? '').slice(0, 2000),
      x: num(n.x),
      y: num(n.y),
    };
    if (COLOR_RE.test(String(n.color || ''))) node.color = n.color;
    if (SHAPE_IDS.has(n.shape)) node.shape = n.shape;
    if (n.collapsed === true) node.collapsed = true;
    nodes[node.id] = node;
  });
  Object.values(nodes).forEach((n) => {
    if (n.parent && !nodes[n.parent]) n.parent = null;
  });
  Object.values(nodes).forEach((n) => {
    const seen = new Set([n.id]);
    let p = n.parent;
    while (p) {
      if (seen.has(p)) {
        n.parent = null;
        break;
      }
      seen.add(p);
      p = nodes[p].parent;
    }
  });
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .filter((l) => l && ID_RE.test(String(l.id)) && nodes[l.from] && nodes[l.to] && l.from !== l.to)
    .map((l) => ({ id: String(l.id), from: String(l.from), to: String(l.to) }));
  return { version: 1, id, createdAt: isoOrNow(raw.createdAt), updatedAt: isoOrNow(raw.updatedAt), nodes, links };
}

function freshMap(p) {
  const now = new Date().toISOString();
  const rootId = uid();
  return {
    version: 1,
    id: p.id,
    createdAt: now,
    updatedAt: now,
    nodes: { [rootId]: { id: rootId, parent: null, text: p.name || 'Central idea', x: 0, y: 0 } },
    links: [],
  };
}

/* ---------- Saving ---------- */

function setSaveStatus(text) {
  const el = byId('mm-save-status');
  if (el) el.textContent = text;
}

async function doPush(p, map) {
  const entry = cacheEntry(map.id);
  try {
    entry.fileId = await saveProjectMap(p, map, entry.fileId);
  } catch (error) {
    if (!entry.fileId) throw error;
    // The cached file id may be stale (file removed in Drive); look it up again once.
    entry.fileId = await saveProjectMap(p, map, null);
  }
  persistCache();
}

// Serialized so two quick saves never race to create duplicate map.json files.
function pushMap(p, map) {
  const run = pushChain.then(() => doPush(p, map));
  pushChain = run.catch(() => {});
  return run;
}

async function flush(p, map) {
  saveTimer = null;
  try {
    await pushMap(p, map);
    if (current === map) setSaveStatus('Saved to Drive');
  } catch {
    if (current === map) setSaveStatus('Saved on this device · Drive sync failed');
  }
}

function scheduleSave() {
  if (!current || readOnly) return;
  current.updatedAt = new Date().toISOString();
  cacheEntry(current.id).map = current;
  persistCache();
  window.clearTimeout(saveTimer);
  if (!state.token) {
    setSaveStatus('Saved on this device');
    return;
  }
  setSaveStatus('Saving…');
  const p = project;
  const map = current;
  saveTimer = window.setTimeout(() => flush(p, map), SAVE_DELAY);
}

function flushPending() {
  if (!saveTimer) return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  if (project && current) flush(project, current);
}

/* ---------- Tree helpers ---------- */

function nodesList() {
  return Object.values(current.nodes);
}

function childrenOf(id) {
  return nodesList()
    .filter((n) => n.parent === id)
    .sort((a, b) => a.y - b.y);
}

function descendants(id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    nodesList().forEach((n) => {
      if (n.parent === cur) {
        out.push(n.id);
        stack.push(n.id);
      }
    });
  }
  return out;
}

function depthOf(id) {
  let d = 0;
  let n = current.nodes[id];
  while (n && n.parent) {
    d += 1;
    n = current.nodes[n.parent];
  }
  return d;
}

function colorOf(id) {
  let n = current.nodes[id];
  while (n) {
    if (n.color && COLOR_RE.test(n.color)) return n.color;
    n = n.parent ? current.nodes[n.parent] : null;
  }
  return ROOT_COLOR;
}

function sideOf(n) {
  if (!n.parent) return 0;
  const p = current.nodes[n.parent];
  return !p || n.x >= p.x ? 1 : -1;
}

function defaultShape() {
  return 'oval';
}

function shapeOf(n) {
  return SHAPE_IDS.has(n.shape) ? n.shape : defaultShape();
}

function shapeIcon(id) {
  const shape = SHAPES.find((s) => s.id === id) || SHAPES[0];
  return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">' + shape.icon + '</svg>';
}

function isHidden(id) {
  let n = current.nodes[id];
  while (n && n.parent) {
    const p = current.nodes[n.parent];
    if (!p) return false;
    if (p.collapsed) return true;
    n = p;
  }
  return false;
}

function size(id) {
  return sizes[id] || { w: 80, h: 28 };
}

// Side nodes are anchored at the edge nearest their parent so text grows away from it.
function box(n) {
  const { w, h } = size(n.id);
  const s = sideOf(n);
  const left = s === 1 ? n.x : s === -1 ? n.x - w : n.x - w / 2;
  return { left, right: left + w, top: n.y - h / 2, bottom: n.y + h / 2, w, h };
}

function lineWidth(depth) {
  return depth === 0 ? 12 : Math.max(2, 9 - 2 * depth);
}

function visibleNodes() {
  return nodesList().filter((n) => !isHidden(n.id));
}

function truncate(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/* ---------- Resources ---------- */

function resources() {
  return project && Array.isArray(project.artifacts) ? project.artifacts : [];
}

function pinsOf(artifact) {
  return Array.isArray(artifact.nodeIds) ? artifact.nodeIds.filter((id) => current && current.nodes[id]) : [];
}

function resourcesFor(nodeId) {
  return resources().filter((a) => pinsOf(a).includes(nodeId));
}

function iconFor(artifact) {
  return (ARTIFACT_TYPES[artifact.type] || ARTIFACT_TYPES.link).icon;
}

function findResource(id) {
  return resources().find((a) => String(a.id) === String(id)) || null;
}

function persistPins() {
  saveProjects();
  renderResources();
  if (!editing) renderCanvas();
  window.clearTimeout(pinTimer);
  if (!state.token) return;
  const p = project;
  pinTimer = window.setTimeout(() => {
    saveProjectResources(p).catch(() => showToast('Pins saved on this device; Drive sync failed.'));
  }, PIN_SAVE_DELAY);
}

function setPin(artifactId, nodeId, pinned) {
  if (readOnly || !current || !current.nodes[nodeId]) return;
  const artifact = findResource(artifactId);
  if (!artifact) return;
  const pins = new Set(pinsOf(artifact));
  if (pinned) pins.add(nodeId);
  else pins.delete(nodeId);
  artifact.nodeIds = [...pins];
  persistPins();
}

function togglePin(artifactId, nodeId) {
  const artifact = findResource(artifactId);
  if (artifact) setPin(artifactId, nodeId, !pinsOf(artifact).includes(nodeId));
}

function resourceRow(artifact, nodeId) {
  const id = escapeHtml(String(artifact.id));
  const pins = pinsOf(artifact);
  const pinned = Boolean(nodeId) && pins.includes(nodeId);
  const pinBtn =
    readOnly || !nodeId
      ? ''
      : '<button class="mm-res__pin' + (pinned ? ' is-pinned' : '') + '" type="button" data-pin-resource="' + id + '" title="' +
        (pinned ? 'Unpin from the selected item' : 'Pin to the selected item') + '">' + (pinned ? 'Unpin' : 'Pin') + '</button>';
  const where = pins.length
    ? pins
        .map(
          (nid) =>
            '<button class="mm-res__chip" type="button" data-focus-node="' + escapeHtml(nid) + '">' +
            escapeHtml(truncate(stripMd(current.nodes[nid].text), 24) || 'Untitled') + '</button>'
        )
        .join('')
    : '<span class="mm-res__chip mm-res__chip--muted">Project-level</span>';
  return (
    '<div class="mm-res" data-resource="' + id + '"' + (readOnly ? '' : ' draggable="true"') + '>' +
    '<div class="mm-res__main">' +
    '<button class="mm-res__open" type="button" data-open-artifact="' + id + '" title="Open">' +
    '<span class="mm-res__icon" aria-hidden="true">' + iconFor(artifact) + '</span>' +
    '<span class="mm-res__title">' + escapeHtml(artifact.title || 'Untitled') + '</span></button>' +
    pinBtn +
    '</div>' +
    '<div class="mm-res__where">' + where + '</div>' +
    '</div>'
  );
}

function renderResources() {
  const panel = byId('mm-resources');
  byId('mm-res-toggle')?.classList.toggle('is-active', resourcesOpen);
  if (!panel) return;
  panel.classList.toggle('hidden', !resourcesOpen);
  if (!resourcesOpen || !project || !current) return;
  const all = resources();
  const node = selectedId ? current.nodes[selectedId] : null;
  const adds = readOnly
    ? ''
    : '<div class="mm-res-add">' +
      '<button class="btn btn--soft btn--sm" type="button" data-add-artifact="docs">+ Doc</button>' +
      '<button class="btn btn--soft btn--sm" type="button" data-add-link>+ Link</button>' +
      '<button class="btn btn--soft btn--sm" type="button" data-record-artifact>● Record</button>' +
      '</div>';
  let nodeSection = '';
  if (node) {
    const pinned = resourcesFor(node.id);
    nodeSection =
      '<div class="mm-res-section"><p class="kicker">Pinned to “' + escapeHtml(truncate(stripMd(node.text), 28) || 'Untitled') + '”</p>' +
      (pinned.length
        ? pinned.map((a) => resourceRow(a, node.id)).join('')
        : '<p class="mm-res-empty">Nothing pinned yet.' + (readOnly ? '' : ' Pin a resource below, drag one onto any item, or add a new one.') + '</p>') +
      '</div>';
  }
  panel.innerHTML =
    '<div class="mm-res-head"><h3>Resources</h3><span class="pill">' + all.length + '</span>' +
    '<button class="icon-btn mm-res-close" type="button" data-close-resources aria-label="Close resources">×</button></div>' +
    adds +
    nodeSection +
    '<div class="mm-res-section"><p class="kicker">All resources</p>' +
    (all.length ? all.map((a) => resourceRow(a, node && node.id)).join('') : '<p class="mm-res-empty">No resources yet.</p>') +
    '</div>' +
    (node || readOnly ? '' : '<p class="mm-res-hint">Select an item on the map to pin resources to it. New resources are pinned to the selected item.</p>');
}

/* ---------- History ---------- */

function snap() {
  return JSON.stringify({ nodes: current.nodes, links: current.links });
}

function restore(snapshot) {
  const data = JSON.parse(snapshot);
  current.nodes = data.nodes;
  current.links = data.links;
  if (selectedId && !current.nodes[selectedId]) selectedId = null;
  if (selectedLinkId && !current.links.some((l) => l.id === selectedLinkId)) selectedLinkId = null;
  scheduleSave();
  renderCanvas();
}

function commit(before) {
  if (before === snap()) {
    renderCanvas();
    return;
  }
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  scheduleSave();
  renderCanvas();
}

function undo() {
  if (readOnly || !undoStack.length) return;
  redoStack.push(snap());
  restore(undoStack.pop());
}

function redo() {
  if (readOnly || !redoStack.length) return;
  undoStack.push(snap());
  restore(redoStack.pop());
}

/* ---------- Rendering ---------- */

function renderText(text) {
  if (!text) return '<span class="mm-node__empty">&nbsp;</span>';
  return escapeHtml(text)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\n/g, '<br>');
}

function stripMd(text) {
  return String(text || '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*|~~|`/g, '')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
}

function addBtn(id, side) {
  return '<button class="mm-node__add" type="button" data-add="' + id + '" data-side="' + side + '" title="Add branch (Tab)" aria-label="Add branch">+</button>';
}

function badgesHtml(nodeId) {
  const pinned = resourcesFor(nodeId);
  if (!pinned.length) return '';
  return (
    '<div class="mm-node__res">' +
    pinned
      .slice(0, MAX_BADGES)
      .map(
        (a) =>
          '<button class="mm-node__res-item" type="button" data-open-artifact="' + escapeHtml(String(a.id)) + '" title="' +
          escapeHtml(a.title || 'Resource') + '">' + iconFor(a) + '</button>'
      )
      .join('') +
    (pinned.length > MAX_BADGES ? '<span class="mm-node__res-more">+' + (pinned.length - MAX_BADGES) + '</span>' : '') +
    '</div>'
  );
}

function nodeHtml(n) {
  const side = sideOf(n);
  const kids = childrenOf(n.id).length;
  const cls = ['mm-node', side === 0 ? 'mm-node--root' : side === 1 ? 'mm-node--right' : 'mm-node--left'];
  const shape = shapeOf(n);
  cls.push('mm-shape--' + shape);
  if (shape !== 'underline') cls.push('mm-shaped');
  if (n.id === selectedId) cls.push('is-selected');
  if (n.id === linkFromId) cls.push('is-link-source');
  if (n.collapsed) cls.push('is-collapsed');
  const style = 'left:' + n.x + 'px;top:' + n.y + 'px;--c:' + colorOf(n.id) + ';--lw:' + lineWidth(depthOf(n.id)) + 'px';
  const adds = readOnly ? '' : side === 0 ? addBtn(n.id, 1) + addBtn(n.id, -1) : addBtn(n.id, side);
  const fold = kids
    ? '<button class="mm-node__fold" type="button" data-fold="' + n.id + '" title="' + (n.collapsed ? 'Expand' : 'Collapse') + '">' +
      (n.collapsed ? kids : '−') + '</button>'
    : '';
  return (
    '<div class="' + cls.join(' ') + '" data-node="' + n.id + '" style="' + style + '">' +
    '<div class="mm-node__text">' + renderText(n.text) + '</div>' + badgesHtml(n.id) + fold + adds + '</div>'
  );
}

// Filled ribbon along a horizontal-tangent bezier, tapering from w0 to w1 like Coggle branches.
function ribbon(a, b, w0, w1) {
  const dir = b.x >= a.x ? 1 : -1;
  const dx = Math.max(Math.abs(b.x - a.x) * 0.5, 24) * dir;
  const c1 = { x: a.x + dx, y: a.y };
  const c2 = { x: b.x - dx, y: b.y };
  const h0 = w0 / 2;
  const h1 = w1 / 2;
  const f = (v) => Math.round(v * 10) / 10;
  return (
    'M' + f(a.x) + ',' + f(a.y - h0) +
    ' C' + f(c1.x) + ',' + f(c1.y - h0) + ' ' + f(c2.x) + ',' + f(c2.y - h1) + ' ' + f(b.x) + ',' + f(b.y - h1) +
    ' L' + f(b.x) + ',' + f(b.y + h1) +
    ' C' + f(c2.x) + ',' + f(c2.y + h1) + ' ' + f(c1.x) + ',' + f(c1.y + h0) + ' ' + f(a.x) + ',' + f(a.y + h0) + ' Z'
  );
}

// Point where the segment from the box centre towards `toward` leaves the box.
function boxExit(b, toward, pad = 4) {
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  const vx = toward.x - cx;
  const vy = toward.y - cy;
  const s = Math.min(vx ? (b.w / 2 + pad) / Math.abs(vx) : Infinity, vy ? (b.h / 2 + pad) / Math.abs(vy) : Infinity, 1);
  return { x: cx + vx * s, y: cy + vy * s };
}

function edgesMarkup() {
  const parts = [];
  visibleNodes().forEach((n) => {
    if (!n.parent) return;
    const p = current.nodes[n.parent];
    const pb = box(p);
    const cb = box(n);
    const d = sideOf(n);
    const pDepth = depthOf(p.id);
    const w0 = lineWidth(pDepth);
    const w1 = lineWidth(pDepth + 1);
    // Shaped items connect at their side midpoint; underlined items connect along the underline.
    const pShaped = shapeOf(p) !== 'underline';
    const cShaped = shapeOf(n) !== 'underline';
    const a = !p.parent
      ? { x: p.x, y: p.y }
      : { x: d > 0 ? pb.right : pb.left, y: pShaped ? p.y : pb.bottom - w0 / 2 };
    const b = { x: d > 0 ? cb.left : cb.right, y: cShaped ? n.y : cb.bottom - w1 / 2 };
    parts.push('<path d="' + ribbon(a, b, w0, w1) + '" fill="' + colorOf(n.id) + '"/>');
  });
  current.links.forEach((l) => {
    const from = current.nodes[l.from];
    const to = current.nodes[l.to];
    if (!from || !to || isHidden(from.id) || isHidden(to.id)) return;
    const fb = box(from);
    const tb = box(to);
    const fc = { x: (fb.left + fb.right) / 2, y: (fb.top + fb.bottom) / 2 };
    const tc = { x: (tb.left + tb.right) / 2, y: (tb.top + tb.bottom) / 2 };
    const ctrl = {
      x: (fc.x + tc.x) / 2 - (tc.y - fc.y) * 0.2,
      y: (fc.y + tc.y) / 2 + (tc.x - fc.x) * 0.2,
    };
    const s = boxExit(fb, ctrl);
    const e = boxExit(tb, ctrl, 8);
    const d = 'M' + s.x + ',' + s.y + ' Q' + ctrl.x + ',' + ctrl.y + ' ' + e.x + ',' + e.y;
    parts.push(
      '<path class="mm-link-hit" data-link="' + l.id + '" d="' + d + '"/>' +
      '<path class="mm-link' + (l.id === selectedLinkId ? ' is-selected' : '') + '" d="' + d + '" marker-end="url(#mm-arrow)"/>'
    );
  });
  return parts.join('');
}

const ARROW_DEFS =
  '<defs><marker id="mm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
  '<path d="M0,0 L10,5 L0,10 z" fill="#8a8178"/></marker></defs>';

function renderEdges() {
  const svg = byId('mm-edges');
  if (svg && current) svg.innerHTML = ARROW_DEFS + edgesMarkup();
}

function canvasVisible() {
  const canvas = byId('mm-canvas');
  return Boolean(canvas && canvas.offsetWidth);
}

// Hidden canvases report zero sizes, so keep the last real measurements until it is visible again.
function measureAll() {
  if (!canvasVisible()) return;
  sizes = {};
  byId('mm-nodes')?.querySelectorAll('[data-node]').forEach((el) => {
    sizes[el.dataset.node] = { w: el.offsetWidth, h: el.offsetHeight };
  });
}

function applyView() {
  const stage = byId('mm-stage');
  const canvas = byId('mm-canvas');
  if (stage) stage.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
  if (canvas) {
    canvas.style.backgroundPosition = view.x + 'px ' + view.y + 'px';
    canvas.style.backgroundSize = 24 * view.k + 'px ' + 24 * view.k + 'px';
  }
  const zoom = byId('mm-zoom-label');
  if (zoom) zoom.textContent = Math.round(view.k * 100) + '%';
}

function renderToolbarState() {
  const undoBtn = byId('mm-undo');
  const redoBtn = byId('mm-redo');
  if (undoBtn) undoBtn.disabled = readOnly || !undoStack.length;
  if (redoBtn) redoBtn.disabled = readOnly || !redoStack.length;
  const tidyBtn = byId('mm-tidy');
  if (tidyBtn) tidyBtn.disabled = readOnly;
  byId('mm-canvas')?.classList.toggle('is-linking', Boolean(linkFromId));
}

function renderNodebar() {
  const bar = byId('mm-nodebar');
  if (!bar) return;
  const n = current && selectedId ? current.nodes[selectedId] : null;
  if (!n || readOnly || editing || (gesture && gesture.moved) || isHidden(n.id)) {
    bar.classList.add('hidden');
    return;
  }
  const b = box(n);
  bar.style.left = ((b.left + b.right) / 2) * view.k + view.x + 'px';
  bar.style.top = b.top * view.k + view.y + 'px';
  const color = colorOf(n.id);
  const hasKids = childrenOf(n.id).length > 0;
  const shape = shapeOf(n);
  const shapeMenu = shapeMenuOpen
    ? '<div class="mm-shape-menu" role="menu">' +
      SHAPES.map(
        (s) => '<button class="mm-shape-option' + (s.id === shape ? ' is-active' : '') + '" type="button" role="menuitemradio" aria-checked="' +
          (s.id === shape) + '" data-shape="' + s.id + '" title="' + s.label + '">' + shapeIcon(s.id) + '<span>' + s.label + '</span></button>'
      ).join('') +
      '</div>'
    : '';
  bar.innerHTML =
    PALETTE.map(
      (c) => '<button class="mm-swatch' + (c === color ? ' is-active' : '') + '" type="button" data-color="' + c + '" style="--c:' + c + '" aria-label="Colour ' + c + '"></button>'
    ).join('') +
    '<span class="mm-nodebar__sep"></span>' +
    '<button class="mm-nodebar__btn' + (shapeMenuOpen ? ' is-active' : '') + '" type="button" data-action="shape" title="Shape" aria-haspopup="true" aria-expanded="' + shapeMenuOpen + '">' + shapeIcon(shape) + '</button>' +
    '<button class="mm-nodebar__btn" type="button" data-action="add" title="Add branch (Tab)">＋</button>' +
    (hasKids
      ? '<button class="mm-nodebar__btn" type="button" data-action="fold" title="' + (n.collapsed ? 'Expand' : 'Collapse') + '">' + (n.collapsed ? '⊕' : '⊖') + '</button>'
      : '') +
    '<button class="mm-nodebar__btn" type="button" data-action="resources" title="Resources for this item">📎</button>' +
    '<button class="mm-nodebar__btn" type="button" data-action="link" title="Connect to another item">⤳</button>' +
    '<button class="mm-nodebar__btn" type="button" data-action="edit" title="Edit text (F2)">✎</button>' +
    '<button class="mm-nodebar__btn mm-nodebar__btn--danger" type="button" data-action="delete" title="Delete (Del)">🗑</button>' +
    shapeMenu;
  bar.classList.remove('hidden');
}

function renderCanvas() {
  const nodesEl = byId('mm-nodes');
  if (!current || !nodesEl) return;
  nodesEl.innerHTML = visibleNodes().map(nodeHtml).join('');
  measureAll();
  renderEdges();
  applyView();
  renderNodebar();
  renderToolbarState();
}

function nodeElement(id) {
  return byId('mm-nodes')?.querySelector('[data-node="' + CSS.escape(id) + '"]') || null;
}

function select(id) {
  const next = id && current.nodes[id] ? id : null;
  if (next !== selectedId) shapeMenuOpen = false;
  selectedId = next;
  const hadLink = selectedLinkId;
  selectedLinkId = null;
  byId('mm-nodes')?.querySelectorAll('.mm-node').forEach((el) => {
    el.classList.toggle('is-selected', el.dataset.node === selectedId);
  });
  if (hadLink) renderEdges();
  renderNodebar();
  renderResources();
}

function selectLink(id) {
  select(null);
  selectedLinkId = id;
  renderEdges();
}

/* ---------- View transforms ---------- */

function canvasRect() {
  return byId('mm-canvas').getBoundingClientRect();
}

function toWorld(clientX, clientY) {
  const r = canvasRect();
  return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
}

function clampZoom(k) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

function zoomAt(factor, cx, cy) {
  const k = clampZoom(view.k * factor);
  view.x = cx - (cx - view.x) * (k / view.k);
  view.y = cy - (cy - view.y) * (k / view.k);
  view.k = k;
  applyView();
  renderNodebar();
}

function zoomBy(factor) {
  const r = canvasRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

function fitView() {
  if (!current || !canvasVisible()) return;
  const r = canvasRect();
  const vis = visibleNodes();
  if (!vis.length) {
    view = { x: r.width / 2, y: r.height / 2, k: 1 };
    applyView();
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  vis.forEach((n) => {
    const b = box(n);
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.right);
    maxY = Math.max(maxY, b.bottom);
  });
  const pad = 60;
  const k = clampZoom(Math.min((r.width - pad * 2) / (maxX - minX || 1), (r.height - pad * 2) / (maxY - minY || 1), 1.25));
  view = { k, x: r.width / 2 - ((minX + maxX) / 2) * k, y: r.height / 2 - ((minY + maxY) / 2) * k };
  applyView();
  renderNodebar();
}

function revealNode(id) {
  const n = current.nodes[id];
  if (!n || !canvasVisible()) return;
  const r = canvasRect();
  const b = box(n);
  const margin = 60;
  const sl = b.left * view.k + view.x;
  const sr = b.right * view.k + view.x;
  const st = b.top * view.k + view.y;
  const sb = b.bottom * view.k + view.y;
  if (sr > r.width - margin) view.x -= sr - (r.width - margin);
  if (sl < margin) view.x += margin - sl;
  if (sb > r.height - margin) view.y -= sb - (r.height - margin);
  if (st < margin) view.y += margin - st;
  applyView();
  renderNodebar();
}

/* ---------- Editing operations ---------- */

// Match existing siblings; the first child gets the next palette colour after its parent's.
function colorForNewChild(parentId, excludeId) {
  const sibs = childrenOf(parentId).filter((c) => c.id !== excludeId);
  if (sibs.length) return colorOf(sibs[sibs.length - 1].id);
  const idx = PALETTE.indexOf(colorOf(parentId));
  return PALETTE[(idx + 1) % PALETTE.length];
}

function rootSide(rootId) {
  const kids = childrenOf(rootId);
  const right = kids.filter((c) => sideOf(c) === 1).length;
  return right <= kids.length - right ? 1 : -1;
}

// Next free slot beside a parent: below the lowest visible descendant of existing siblings on that side.
function slotFor(parentId, dir, exclude = new Set()) {
  const p = current.nodes[parentId];
  const pb = box(p);
  const sibs = childrenOf(parentId).filter((c) => !exclude.has(c.id) && sideOf(c) === dir);
  const x = dir > 0 ? pb.right + H_GAP : pb.left - H_GAP;
  if (!sibs.length) return { x, y: p.y };
  let bottom = -Infinity;
  sibs.forEach((c) => {
    [c.id, ...descendants(c.id)].forEach((id) => {
      if (!isHidden(id)) bottom = Math.max(bottom, box(current.nodes[id]).bottom);
    });
  });
  return { x: sibs[sibs.length - 1].x, y: bottom + V_GAP + 26 };
}

function addChild(parentId, dir) {
  const p = current.nodes[parentId];
  if (readOnly || !p) return;
  const before = snap();
  if (p.collapsed) {
    p.collapsed = false;
    renderCanvas();
  }
  const side = dir || (p.parent ? sideOf(p) : rootSide(parentId));
  const pos = slotFor(parentId, side);
  const id = uid();
  const node = { id, parent: parentId, text: '', x: pos.x, y: pos.y, color: colorForNewChild(parentId) };
  current.nodes[id] = node;
  selectedId = id;
  renderCanvas();
  revealNode(id);
  startEdit(id, '', { before, isNew: true });
}

function addSibling(id) {
  const n = current.nodes[id];
  if (!n) return;
  if (n.parent) addChild(n.parent, sideOf(n));
  else addChild(id);
}

function addFloating(x, y) {
  if (readOnly) return;
  const before = snap();
  const id = uid();
  current.nodes[id] = { id, parent: null, text: '', x, y };
  selectedId = id;
  renderCanvas();
  startEdit(id, '', { before, isNew: true });
}

function deleteNode(id) {
  const n = current.nodes[id];
  if (readOnly || !n) return;
  const before = snap();
  const ids = new Set([id, ...descendants(id)]);
  ids.forEach((i) => delete current.nodes[i]);
  current.links = current.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
  selectedId = n.parent || null;
  commit(before);
  renderResources();
}

function deleteLink(id) {
  if (readOnly) return;
  const before = snap();
  current.links = current.links.filter((l) => l.id !== id);
  selectedLinkId = null;
  commit(before);
}

// Folding is allowed in read-only maps but is only persisted for editable ones.
function toggleFold(id) {
  const n = current.nodes[id];
  if (!n || !childrenOf(id).length) return;
  const before = snap();
  n.collapsed = !n.collapsed;
  commit(before);
}

function setColor(id, color) {
  const n = current.nodes[id];
  if (readOnly || !n || !COLOR_RE.test(color)) return;
  const before = snap();
  n.color = color;
  commit(before);
}

function setShape(id, shape) {
  const n = current.nodes[id];
  if (readOnly || !n || !SHAPE_IDS.has(shape)) return;
  const before = snap();
  if (shape === defaultShape()) delete n.shape;
  else n.shape = shape;
  shapeMenuOpen = false;
  commit(before);
}

function startLink() {
  if (readOnly || !selectedId) return;
  linkFromId = selectedId;
  renderCanvas();
  showToast('Click another item to connect it. Esc to cancel.');
}

function cancelLink() {
  linkFromId = null;
  renderCanvas();
}

function finishLink(targetId) {
  const from = linkFromId;
  linkFromId = null;
  if (!from || from === targetId || !current.nodes[from]) {
    renderCanvas();
    return;
  }
  const exists = current.links.some((l) => (l.from === from && l.to === targetId) || (l.from === targetId && l.to === from));
  if (exists) {
    renderCanvas();
    return;
  }
  const before = snap();
  current.links.push({ id: uid(), from, to: targetId });
  selectedId = targetId;
  commit(before);
}

function reparent(id, targetId) {
  const n = current.nodes[id];
  const target = current.nodes[targetId];
  if (!n || !target) return;
  n.color = colorForNewChild(targetId, id);
  n.parent = targetId;
  if (target.collapsed) target.collapsed = false;
  const dir = target.parent ? sideOf(target) : n.x >= target.x ? 1 : -1;
  const moving = [id, ...descendants(id)];
  const pos = slotFor(targetId, dir, new Set([id]));
  const dx = pos.x - n.x;
  const dy = pos.y - n.y;
  moving.forEach((mid) => {
    current.nodes[mid].x += dx;
    current.nodes[mid].y += dy;
  });
}

/* ---------- Auto layout ---------- */

function subtreeHeight(id, memo) {
  if (memo.has(id)) return memo.get(id);
  const n = current.nodes[id];
  const own = size(id).h;
  const kids = childrenOf(id);
  let h = own;
  if (kids.length && !n.collapsed) {
    const sum = kids.reduce((s, c) => s + subtreeHeight(c.id, memo), 0) + V_GAP * (kids.length - 1);
    h = Math.max(own, sum);
  }
  memo.set(id, h);
  return h;
}

function layoutChildren(parentId, dir, kids, memo) {
  if (!kids.length) return;
  const p = current.nodes[parentId];
  const pb = box(p);
  const heights = kids.map((c) => (p.collapsed ? size(c.id).h : subtreeHeight(c.id, memo)));
  const total = heights.reduce((s, h) => s + h, 0) + V_GAP * (kids.length - 1);
  let y = p.y - total / 2;
  kids.forEach((c, i) => {
    c.y = y + heights[i] / 2;
    c.x = dir > 0 ? pb.right + H_GAP : pb.left - H_GAP;
    y += heights[i] + V_GAP;
    layoutChildren(c.id, dir, childrenOf(c.id), memo);
  });
}

function tidy() {
  if (readOnly) return;
  const before = snap();
  const memo = new Map();
  nodesList()
    .filter((n) => !n.parent)
    .forEach((root) => {
      const kids = childrenOf(root.id);
      layoutChildren(root.id, 1, kids.filter((c) => sideOf(c) === 1), memo);
      layoutChildren(root.id, -1, kids.filter((c) => sideOf(c) === -1), memo);
    });
  commit(before);
  fitView();
}

/* ---------- Inline text editing ---------- */

function onEditInput(event) {
  if (!editing) return;
  const el = event.currentTarget.closest('[data-node]');
  if (el) sizes[editing.id] = { w: el.offsetWidth, h: el.offsetHeight };
  renderEdges();
}

function onEditKey(event) {
  event.stopPropagation();
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    commitEdit(true);
  } else if (event.key === 'Tab') {
    event.preventDefault();
    const id = editing && editing.id;
    commitEdit(true);
    if (id && current.nodes[id]) addChild(id);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelEdit();
  }
}

function onEditBlur() {
  commitEdit(false);
}

function startEdit(id, initial, opts = {}) {
  if (readOnly) return;
  if (editing) commitEdit(false);
  const node = current.nodes[id];
  const el = nodeElement(id);
  if (!node || !el) return;
  const textEl = el.querySelector('.mm-node__text');
  editing = { id, before: opts.before || snap(), isNew: Boolean(opts.isNew) };
  selectedId = id;
  el.classList.add('is-editing', 'is-selected');
  textEl.textContent = initial !== undefined ? initial : node.text;
  try {
    textEl.contentEditable = 'plaintext-only';
  } catch {
    /* unsupported value */
  }
  if (textEl.contentEditable !== 'plaintext-only') textEl.contentEditable = 'true';
  textEl.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(textEl);
  if (initial !== undefined) range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  textEl.addEventListener('input', onEditInput);
  textEl.addEventListener('keydown', onEditKey);
  textEl.addEventListener('blur', onEditBlur);
  renderNodebar();
  renderResources();
}

function commitEdit(refocus) {
  if (!editing) return;
  const { id, before, isNew } = editing;
  editing = null;
  const textEl = nodeElement(id)?.querySelector('.mm-node__text');
  const text = textEl ? textEl.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '').trim() : '';
  const node = current.nodes[id];
  if (node) {
    if (!text && isNew) {
      delete current.nodes[id];
      selectedId = node.parent || null;
    } else {
      node.text = text.slice(0, 2000);
    }
  }
  commit(before);
  renderResources();
  if (refocus) byId('mm-canvas')?.focus({ preventScroll: true });
}

function cancelEdit() {
  if (!editing) return;
  const { id, isNew } = editing;
  editing = null;
  const node = current.nodes[id];
  if (node && isNew) {
    delete current.nodes[id];
    selectedId = node.parent || null;
  }
  renderCanvas();
  renderResources();
  byId('mm-canvas')?.focus({ preventScroll: true });
}

/* ---------- Pointer, drag & drop, keyboard ---------- */

function startPinch() {
  const [a, b] = [...pointers.values()];
  const r = canvasRect();
  gesture = {
    type: 'pinch',
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    k: view.k,
    vx: view.x,
    vy: view.y,
    mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
  };
}

function updatePinch() {
  const [a, b] = [...pointers.values()];
  const r = canvasRect();
  const g = gesture;
  const k = clampZoom(g.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist));
  const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
  view = { k, x: mid.x - (g.mid.x - g.vx) * (k / g.k), y: mid.y - (g.mid.y - g.vy) * (k / g.k) };
  applyView();
  renderNodebar();
}

function dropTargetAt(x, y, excluded) {
  const hit = document.elementsFromPoint(x, y).find((el) => el.dataset && el.dataset.node && !excluded.has(el.dataset.node));
  return hit ? hit.dataset.node : null;
}

function onPointerDown(event) {
  if (!current) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    startPinch();
    return;
  }
  if (event.target.closest('.mm-nodebar, .mm-help, .mm-zoombar')) return;
  if (editing && event.target.closest('[contenteditable]')) return;
  if (event.target.closest('button, a')) return;
  const canvas = byId('mm-canvas');
  const nodeEl = event.target.closest('[data-node]');
  const linkEl = event.target.closest('[data-link]');
  if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
  if (nodeEl) {
    const id = nodeEl.dataset.node;
    if (!current.nodes[id]) return;
    if (linkFromId) {
      finishLink(id);
      return;
    }
    select(id);
    if (readOnly) return;
    const ids = [id, ...descendants(id)];
    const origin = {};
    ids.forEach((i) => {
      origin[i] = { x: current.nodes[i].x, y: current.nodes[i].y };
    });
    gesture = { type: 'node', id, startX: event.clientX, startY: event.clientY, moved: false, before: snap(), ids, origin, target: null };
  } else if (linkEl) {
    selectLink(linkEl.dataset.link);
  } else {
    if (linkFromId) cancelLink();
    select(null);
    gesture = { type: 'pan', startX: event.clientX, startY: event.clientY, vx: view.x, vy: view.y };
    canvas.classList.add('is-panning');
  }
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (pointers.size === 2) updatePinch();
    return;
  }
  const dx = event.clientX - gesture.startX;
  const dy = event.clientY - gesture.startY;
  if (gesture.type === 'pan') {
    view.x = gesture.vx + dx;
    view.y = gesture.vy + dy;
    applyView();
    renderNodebar();
    return;
  }
  if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  gesture.moved = true;
  byId('mm-canvas').classList.add('is-dragging');
  gesture.ids.forEach((id) => {
    const o = gesture.origin[id];
    current.nodes[id].x = o.x + dx / view.k;
    current.nodes[id].y = o.y + dy / view.k;
  });
  gesture.ids.forEach((id) => {
    const el = nodeElement(id);
    if (!el) return;
    const n = current.nodes[id];
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    const side = sideOf(n);
    el.classList.toggle('mm-node--right', side === 1);
    el.classList.toggle('mm-node--left', side === -1);
  });
  const target = dropTargetAt(event.clientX, event.clientY, new Set(gesture.ids));
  if (target !== gesture.target) {
    if (gesture.target) nodeElement(gesture.target)?.classList.remove('is-drop-target');
    if (target) nodeElement(target)?.classList.add('is-drop-target');
    gesture.target = target;
  }
  renderEdges();
  renderNodebar();
}

function onPointerUp(event) {
  pointers.delete(event.pointerId);
  byId('mm-canvas')?.classList.remove('is-panning', 'is-dragging');
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (pointers.size < 2) gesture = null;
    return;
  }
  const g = gesture;
  gesture = null;
  if (g.type === 'node' && g.moved) {
    if (g.target && g.target !== current.nodes[g.id].parent) reparent(g.id, g.target);
    commit(g.before);
  } else {
    renderNodebar();
  }
}

function onWheel(event) {
  if (!current) return;
  event.preventDefault();
  const r = canvasRect();
  if (event.ctrlKey || event.metaKey) {
    zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - r.left, event.clientY - r.top);
  } else {
    view.x -= event.deltaX;
    view.y -= event.deltaY;
    applyView();
    renderNodebar();
  }
}

function onDblClick(event) {
  if (!current || event.target.closest('button, a, .mm-nodebar, .mm-help, .mm-zoombar')) return;
  const nodeEl = event.target.closest('[data-node]');
  if (nodeEl) {
    if (!editing || editing.id !== nodeEl.dataset.node) startEdit(nodeEl.dataset.node);
    return;
  }
  if (event.target.closest('[data-link]')) return;
  const p = toWorld(event.clientX, event.clientY);
  addFloating(p.x, p.y);
}

function onCanvasClick(event) {
  const add = event.target.closest('[data-add]');
  if (add) {
    addChild(add.dataset.add, Number(add.dataset.side) || undefined);
    return;
  }
  const fold = event.target.closest('[data-fold]');
  if (fold) toggleFold(fold.dataset.fold);
}

function hasResourcePayload(event) {
  return Boolean(event.dataTransfer && [...event.dataTransfer.types].includes(RESOURCE_MIME));
}

let dropHighlight = null;

function setDropHighlight(id) {
  if (dropHighlight === id) return;
  if (dropHighlight) nodeElement(dropHighlight)?.classList.remove('is-drop-target');
  dropHighlight = id;
  if (id) nodeElement(id)?.classList.add('is-drop-target');
}

function onCanvasDragOver(event) {
  if (readOnly || !hasResourcePayload(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'link';
  setDropHighlight(event.target.closest('[data-node]')?.dataset.node || null);
}

function onCanvasDrop(event) {
  if (readOnly || !hasResourcePayload(event)) return;
  event.preventDefault();
  const nodeId = event.target.closest('[data-node]')?.dataset.node;
  const artifactId = event.dataTransfer.getData(RESOURCE_MIME);
  setDropHighlight(null);
  if (!nodeId) {
    showToast('Drop the resource onto an item to pin it.');
    return;
  }
  setPin(artifactId, nodeId, true);
  select(nodeId);
}

function navigate(key) {
  const n = selectedId && current.nodes[selectedId];
  if (!n) {
    const first = visibleNodes().find((x) => !x.parent);
    if (first) select(first.id);
    return;
  }
  const side = sideOf(n);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const peers = (n.parent ? childrenOf(n.parent).filter((c) => sideOf(c) === side) : nodesList().filter((r) => !r.parent))
      .filter((c) => !isHidden(c.id))
      .sort((a, b) => a.y - b.y);
    const next = peers[peers.indexOf(n) + (key === 'ArrowUp' ? -1 : 1)];
    if (next) select(next.id);
  } else {
    const dir = key === 'ArrowRight' ? 1 : -1;
    if (side === 0 || side === dir) {
      if (n.collapsed) return;
      const kids = childrenOf(n.id).filter((c) => side !== 0 || sideOf(c) === dir);
      if (kids.length) select(kids[Math.floor((kids.length - 1) / 2)].id);
    } else if (n.parent) {
      select(n.parent);
    }
  }
  if (selectedId) revealNode(selectedId);
}

function isActive() {
  const el = byId('mm-editor');
  return Boolean(current && el && state.activeView === 'projects' && !byId('mm-parking')?.contains(el) && canvasVisible());
}

function onKeyDown(event) {
  if (!isActive() || editing || document.querySelector('.modal.is-open')) return;
  const canvas = byId('mm-canvas');
  const t = event.target;
  if (t !== document.body && !canvas.contains(t)) return;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key;
  if (mod) {
    const lower = key.toLowerCase();
    if (lower === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (lower === 'y') {
      event.preventDefault();
      redo();
    } else if (key === '=' || key === '+') {
      event.preventDefault();
      zoomBy(1.2);
    } else if (key === '-') {
      event.preventDefault();
      zoomBy(1 / 1.2);
    } else if (key === '0') {
      event.preventDefault();
      fitView();
    }
    return;
  }
  if (key === 'Escape') {
    if (linkFromId) cancelLink();
    else if (shapeMenuOpen) {
      shapeMenuOpen = false;
      renderNodebar();
    } else if (selectedId || selectedLinkId) select(null);
    else if (fullscreen) setFullscreen(false);
    return;
  }
  if ((key === 'Delete' || key === 'Backspace') && selectedLinkId) {
    event.preventDefault();
    deleteLink(selectedLinkId);
    return;
  }
  if (!selectedId) {
    if (key.startsWith('Arrow')) {
      event.preventDefault();
      navigate(key);
    }
    return;
  }
  if (key.startsWith('Arrow')) {
    event.preventDefault();
    navigate(key);
  } else if (key === ' ') {
    event.preventDefault();
    toggleFold(selectedId);
  } else if (readOnly) {
    return;
  } else if (key === 'Tab') {
    event.preventDefault();
    addChild(selectedId);
  } else if (key === 'Enter') {
    event.preventDefault();
    addSibling(selectedId);
  } else if (key === 'Delete' || key === 'Backspace') {
    event.preventDefault();
    deleteNode(selectedId);
  } else if (key === 'F2') {
    event.preventDefault();
    startEdit(selectedId);
  } else if (key.length === 1 && !event.altKey) {
    event.preventDefault();
    startEdit(selectedId, key);
  }
}

function setResourcesOpen(open) {
  resourcesOpen = open;
  renderResources();
  renderNodebar();
}

const ICON_EXPAND =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
const ICON_COLLAPSE =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';

// The editor covers the viewport via CSS; the whole page (not just the editor) goes native
// full screen so modals for adding resources still appear above it.
function setFullscreen(on) {
  const el = byId('mm-editor');
  if (!el || on === fullscreen) return;
  const center = canvasVisible()
    ? (() => {
        const r = canvasRect();
        return toWorld(r.left + r.width / 2, r.top + r.height / 2);
      })()
    : null;
  fullscreen = on;
  el.classList.toggle('is-fullscreen', on);
  document.body.classList.toggle('mm-fullscreen-open', on);
  const btn = byId('mm-fullscreen');
  if (btn) {
    btn.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
    btn.title = on ? 'Exit full screen (Esc)' : 'Full screen';
    btn.setAttribute('aria-pressed', String(on));
  }
  const root = document.documentElement;
  if (on && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  window.requestAnimationFrame(() => {
    if (!current) return;
    renderCanvas();
    if (center && canvasVisible()) {
      const r = canvasRect();
      view.x = r.width / 2 - center.x * view.k;
      view.y = r.height / 2 - center.y * view.k;
      applyView();
      renderNodebar();
    }
    if (on) byId('mm-canvas')?.focus({ preventScroll: true });
  });
}

function onNodebarClick(event) {
  const id = selectedId;
  if (!id) return;
  const swatch = event.target.closest('[data-color]');
  if (swatch) {
    setColor(id, swatch.dataset.color);
    return;
  }
  const shapeBtn = event.target.closest('[data-shape]');
  if (shapeBtn) {
    setShape(id, shapeBtn.dataset.shape);
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'shape') {
    shapeMenuOpen = !shapeMenuOpen;
    renderNodebar();
  } else if (action === 'add') addChild(id);
  else if (action === 'fold') toggleFold(id);
  else if (action === 'resources') setResourcesOpen(true);
  else if (action === 'link') startLink();
  else if (action === 'edit') startEdit(id);
  else if (action === 'delete') deleteNode(id);
}

function onResourcesClick(event) {
  if (event.target.closest('[data-close-resources]')) {
    setResourcesOpen(false);
    return;
  }
  const pin = event.target.closest('[data-pin-resource]');
  if (pin && selectedId) {
    togglePin(pin.dataset.pinResource, selectedId);
    return;
  }
  const focus = event.target.closest('[data-focus-node]');
  if (focus && current.nodes[focus.dataset.focusNode]) {
    const id = focus.dataset.focusNode;
    let p = current.nodes[id].parent;
    let unfolded = false;
    while (p) {
      if (current.nodes[p].collapsed) {
        current.nodes[p].collapsed = false;
        unfolded = true;
      }
      p = current.nodes[p].parent;
    }
    if (unfolded) renderCanvas();
    select(id);
    revealNode(id);
  }
}

/* ---------- Export ---------- */

function safeFileName(title) {
  return String(title || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'mind-map';
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildSvg() {
  const vis = visibleNodes();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  vis.forEach((n) => {
    const b = box(n);
    minX = Math.min(minX, b.left - 20);
    minY = Math.min(minY, b.top - 20);
    maxX = Math.max(maxX, b.right + 20);
    maxY = Math.max(maxY, b.bottom + 20);
  });
  if (!vis.length) {
    minX = minY = 0;
    maxX = maxY = 100;
  }
  const pad = 30;
  minX -= pad;
  minY -= pad;
  const width = Math.ceil(maxX - minX + pad);
  const height = Math.ceil(maxY - minY + pad);
  const font = 'Space Grotesk, system-ui, -apple-system, sans-serif';
  const nodesSvg = vis
    .map((n) => {
      const b = box(n);
      const color = colorOf(n.id);
      const isRoot = !n.parent;
      const side = sideOf(n);
      const shape = shapeOf(n);
      const fs = isRoot ? 18 : 15;
      const lh = fs * 1.35;
      const padTop = isRoot ? 10 : 4;
      const lines = stripMd(n.text).split('\n');
      const cx = (b.left + b.right) / 2;
      const cy = (b.top + b.bottom) / 2;
      const paint = ' fill="#fff" stroke="' + color + '" stroke-width="2"';
      let out = '';
      if (shape === 'underline') {
        const lw = lineWidth(depthOf(n.id));
        out += '<line x1="' + b.left + '" y1="' + (b.bottom - lw / 2) + '" x2="' + b.right + '" y2="' + (b.bottom - lw / 2) + '" stroke="' + color + '" stroke-width="' + lw + '"/>';
      } else if (shape === 'oval' || shape === 'circle') {
        out += '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + (b.w / 2 - 1) + '" ry="' + (b.h / 2 - 1) + '"' + paint + '/>';
      } else if (shape === 'diamond') {
        out += '<polygon points="' + cx + ',' + b.top + ' ' + b.right + ',' + cy + ' ' + cx + ',' + b.bottom + ' ' + b.left + ',' + cy + '"' + paint + '/>';
      } else if (shape === 'hexagon') {
        out +=
          '<polygon points="' + (b.left + HEX_INSET) + ',' + b.top + ' ' + (b.right - HEX_INSET) + ',' + b.top + ' ' + b.right + ',' + cy + ' ' +
          (b.right - HEX_INSET) + ',' + b.bottom + ' ' + (b.left + HEX_INSET) + ',' + b.bottom + ' ' + b.left + ',' + cy + '"' + paint + '/>';
      } else {
        const rx = shape === 'rounded' ? 12 : shape === 'pill' ? b.h / 2 : 0;
        out += '<rect x="' + (b.left + 1) + '" y="' + (b.top + 1) + '" width="' + (b.w - 2) + '" height="' + (b.h - 2) + '" rx="' + rx + '"' + paint + '/>';
      }
      const centered = isRoot || shape !== 'underline';
      const tx = centered ? cx : side === -1 ? b.right - 6 : b.left + 6;
      const anchor = centered ? 'middle' : side === -1 ? 'end' : 'start';
      const ty = shape === 'underline'
        ? b.top + padTop + (lh - fs) / 2 + fs * 0.9
        : cy - (lines.length * lh) / 2 + (lh - fs) / 2 + fs * 0.9;
      out +=
        '<text x="' + tx + '" y="' + ty + '" font-family="' + font + '" font-size="' + fs + '" font-weight="' + (isRoot ? 600 : 400) +
        '" fill="#1d1a16" text-anchor="' + anchor + '">' +
        lines.map((line, i) => '<tspan x="' + tx + '" dy="' + (i ? lh : 0) + '">' + escapeHtml(line) + '</tspan>').join('') +
        '</text>';
      return out;
    })
    .join('');
  const markup =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="' + minX + ' ' + minY + ' ' + width + ' ' + height + '">' +
    '<style>.mm-link-hit{display:none}.mm-link{fill:none;stroke:#8a8178;stroke-width:2;stroke-dasharray:6 5}</style>' +
    '<rect x="' + minX + '" y="' + minY + '" width="' + width + '" height="' + height + '" fill="#fbf9f5"/>' +
    ARROW_DEFS + edgesMarkup() + nodesSvg + '</svg>';
  return { markup, width, height };
}

function exportPng(name) {
  const { markup, width, height } = buildSvg();
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (blob) download(blob, name + '.png');
      else showToast('Could not export PNG.');
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('Could not export PNG.');
  };
  img.src = url;
}

// Outline export lists pinned resources under the item they belong to.
function toMarkdown() {
  const lines = [];
  const resourceLines = (id, depth) =>
    resourcesFor(id).forEach((a) => lines.push('  '.repeat(depth) + '- 📎 [' + (a.title || 'Resource') + '](' + (a.url || '') + ')'));
  const walk = (id, depth) => {
    childrenOf(id)
      .sort((a, b) => sideOf(b) - sideOf(a) || a.y - b.y)
      .forEach((c) => {
        lines.push('  '.repeat(depth) + '- ' + c.text.replace(/\n+/g, ' '));
        resourceLines(c.id, depth + 1);
        walk(c.id, depth + 1);
      });
  };
  nodesList()
    .filter((n) => !n.parent)
    .sort((a, b) => a.y - b.y)
    .forEach((root) => {
      if (lines.length) lines.push('');
      lines.push('# ' + root.text.replace(/\n+/g, ' '));
      resourceLines(root.id, 0);
      walk(root.id, 0);
    });
  return lines.join('\n') + '\n';
}

function handleExport(kind) {
  if (!current || !project) return;
  const name = safeFileName(project.name);
  if (kind === 'png') exportPng(name);
  else if (kind === 'svg') download(new Blob([buildSvg().markup], { type: 'image/svg+xml' }), name + '.svg');
  else if (kind === 'md') download(new Blob([toMarkdown()], { type: 'text/markdown' }), name + '.md');
}

/* ---------- Loading & mounting ---------- */

function resetSession() {
  selectedId = null;
  selectedLinkId = null;
  linkFromId = null;
  editing = null;
  gesture = null;
  undoStack = [];
  redoStack = [];
  sizes = {};
}

function loadFor(p) {
  if (editing) commitEdit(false);
  flushPending();
  project = p;
  readOnly = Boolean(p.readOnly);
  const entry = getCache()[p.id];
  const cached = entry && entry.map ? normalizeMap(entry.map, p.id) : null;
  current = cached || freshMap(p);
  cacheEntry(p.id).map = current;
  resetSession();
  setSaveStatus(readOnly ? 'View only' : '');
  const seq = ++loadSeq;
  if (!state.token || !p.folderId) return;
  if (!readOnly) setSaveStatus('Syncing…');
  loadProjectMap(p)
    .then((res) => {
      if (seq !== loadSeq) return;
      if (!res) {
        // Nothing in Drive yet: upload a locally cached map, otherwise wait for the first edit.
        if (cached && !readOnly) pushMap(p, current).then(() => setSaveStatus('Saved to Drive'), () => setSaveStatus('Saved on this device'));
        else setSaveStatus(readOnly ? 'View only' : '');
        return;
      }
      const remote = normalizeMap(res.map, p.id);
      cacheEntry(p.id).fileId = res.fileId;
      const untouched = !undoStack.length && !editing;
      if (remote && untouched && (!cached || remote.updatedAt >= current.updatedAt)) {
        current = remote;
        cacheEntry(p.id).map = current;
        persistCache();
        if (selectedId && !current.nodes[selectedId]) selectedId = null;
        renderCanvas();
        fitView();
        renderResources();
      } else if (remote && !readOnly && current.updatedAt > remote.updatedAt) {
        pushMap(p, current).catch(() => {});
      }
      setSaveStatus(readOnly ? 'View only' : 'Saved to Drive');
    })
    .catch(() => {
      if (seq === loadSeq) setSaveStatus(readOnly ? 'View only' : 'Offline · saved on this device');
    });
}

// The editor DOM is persistent: it is parked off-screen whenever the project workspace re-renders.
export function parkProjectMap() {
  const el = byId('mm-editor');
  const parking = byId('mm-parking');
  if (!el || !parking || parking.contains(el)) return;
  if (editing) commitEdit(false);
  setFullscreen(false);
  flushPending();
  gesture = null;
  parking.appendChild(el);
}

export function isProjectMapMounted(p, container) {
  const el = byId('mm-editor');
  return Boolean(el && current && project && p && project.id === p.id && container && container.contains(el));
}

export function mountProjectMap(slot, p) {
  const el = byId('mm-editor');
  if (!el || !slot || !p) return;
  slot.appendChild(el);
  const isNew = !project || project.id !== p.id || !current;
  if (isNew) loadFor(p);
  else {
    project = p;
    readOnly = Boolean(p.readOnly);
  }
  el.classList.toggle('is-readonly', readOnly);
  // Measure after the view is shown; render() reveals the view after rendering its content.
  window.requestAnimationFrame(() => {
    if (!isActive()) return;
    renderCanvas();
    renderResources();
    if (isNew) fitView();
  });
}

// Called on every render while the map stays mounted (e.g. after resources change).
export function refreshProjectMap(p) {
  if (!project || !p || project.id !== p.id) return;
  project = p;
  readOnly = Boolean(p.readOnly);
  renderResources();
  if (!editing && !gesture) renderCanvas();
}

// Pin a newly created resource to the selected item, if any.
export function pinToSelected(artifactId) {
  if (!selectedId || !current || !current.nodes[selectedId]) return false;
  setPin(artifactId, selectedId, true);
  return true;
}

export function flushProjectMap() {
  if (editing) commitEdit(false);
  setFullscreen(false);
  flushPending();
}

export function forgetProjectMap(projectId) {
  const c = getCache();
  if (!c[projectId]) return;
  delete c[projectId];
  persistCache();
  if (project && project.id === projectId) {
    project = null;
    current = null;
    resetSession();
  }
}

export function resetProjectMaps() {
  window.clearTimeout(saveTimer);
  window.clearTimeout(pinTimer);
  saveTimer = null;
  pinTimer = null;
  parkProjectMap();
  cache = null;
  project = null;
  current = null;
  loadSeq += 1;
  resetSession();
}

export function wireProjectMap() {
  const canvas = byId('mm-canvas');
  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('dragover', onCanvasDragOver);
    canvas.addEventListener('dragleave', (event) => {
      if (!canvas.contains(event.relatedTarget)) setDropHighlight(null);
    });
    canvas.addEventListener('drop', onCanvasDrop);
  }
  const panel = byId('mm-resources');
  if (panel) {
    panel.addEventListener('click', onResourcesClick);
    panel.addEventListener('dragstart', (event) => {
      const row = event.target.closest('[data-resource]');
      if (!row || readOnly) return;
      event.dataTransfer.setData(RESOURCE_MIME, row.dataset.resource);
      event.dataTransfer.effectAllowed = 'link';
    });
    panel.addEventListener('dragend', () => setDropHighlight(null));
  }
  byId('mm-nodebar')?.addEventListener('click', onNodebarClick);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => {
    if (isActive()) renderNodebar();
  });

  byId('mm-undo')?.addEventListener('click', undo);
  byId('mm-redo')?.addEventListener('click', redo);
  byId('mm-tidy')?.addEventListener('click', tidy);
  byId('mm-res-toggle')?.addEventListener('click', () => setResourcesOpen(!resourcesOpen));
  byId('mm-fullscreen')?.addEventListener('click', () => setFullscreen(!fullscreen));
  // Leaving native full screen (Esc, browser UI) also leaves the map's full-screen mode.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && fullscreen) setFullscreen(false);
  });
  byId('mm-zoom-in')?.addEventListener('click', () => zoomBy(1.2));
  byId('mm-zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.2));
  byId('mm-zoom-label')?.addEventListener('click', () => {
    const r = canvasRect();
    zoomAt(1 / view.k, r.width / 2, r.height / 2);
  });
  byId('mm-fit')?.addEventListener('click', fitView);
  byId('mm-help-toggle')?.addEventListener('click', () => byId('mm-help')?.classList.toggle('hidden'));
  byId('mm-export')?.addEventListener('click', (event) => {
    const kind = event.target.closest('[data-export]')?.dataset.export;
    if (!kind) return;
    event.currentTarget.removeAttribute('open');
    handleExport(kind);
  });
}
