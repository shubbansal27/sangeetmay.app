// Product announcements: fetch a static feed and surface unread items in the topbar bell.
// Seen ids are stored in localStorage with a 7-day TTL and auto-purged.

import { STORAGE_KEYS } from './config.js';
import { byId, escapeHtml } from './utils.js';

const FEED_URL = 'product/announcements/announcements.json';
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let items = [];

function readSeen() {
  let map;
  try {
    map = JSON.parse(localStorage.getItem(STORAGE_KEYS.announcementsSeen) || '{}');
  } catch {
    map = {};
  }
  if (!map || typeof map !== 'object') map = {};
  const now = Date.now();
  let changed = false;
  Object.keys(map).forEach((id) => {
    if (!map[id] || map[id] < now) {
      delete map[id];
      changed = true;
    }
  });
  if (changed) writeSeen(map);
  return map;
}

function writeSeen(map) {
  try {
    localStorage.setItem(STORAGE_KEYS.announcementsSeen, JSON.stringify(map));
  } catch {
    /* ignore quota errors */
  }
}

function announcementRow(item, isUnread) {
  return (
    '<li class="ann-item' + (isUnread ? ' is-unread' : '') + '">' +
    '<div class="ann-item__head">' +
    (item.tag ? '<span class="ann-item__tag">' + escapeHtml(item.tag) + '</span>' : '') +
    (item.date ? '<span class="ann-item__date">' + escapeHtml(item.date) + '</span>' : '') +
    '</div>' +
    '<p class="ann-item__title">' + escapeHtml(item.title) + '</p>' +
    (item.body ? '<p class="ann-item__body">' + escapeHtml(item.body) + '</p>' : '') +
    '</li>'
  );
}

export function renderBell() {
  const bell = byId('notif-bell');
  if (!bell) return;
  const seen = readSeen();
  const unread = items.filter((item) => !seen[item.id]).length;

  const badge = byId('notif-badge');
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
  }

  const list = byId('notif-list');
  if (list) {
    list.innerHTML = items.length
      ? items.map((item) => announcementRow(item, !seen[item.id])).join('')
      : '<li class="ann-empty">No announcements yet.</li>';
  }
}

// Fetch the feed, keep only enabled items (newest first), then update the bell.
export async function loadAnnouncements() {
  try {
    const res = await fetch(FEED_URL, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data.announcements) ? data.announcements : [];
      items = list
        .filter((item) => item && item.enabled && item.id && item.title)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    }
  } catch {
    items = [];
  }
  renderBell();
}

// Mark every currently shown announcement as seen (7-day TTL), then refresh the bell.
export function markAnnouncementsSeen() {
  if (!items.length) return;
  const map = readSeen();
  const expiry = Date.now() + SEEN_TTL_MS;
  items.forEach((item) => {
    map[item.id] = expiry;
  });
  writeSeen(map);
  renderBell();
}
