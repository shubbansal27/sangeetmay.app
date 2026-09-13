// Small, dependency-free helpers shared across modules.

export function byId(id) {
  return document.getElementById(id);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function uid() {
  return crypto.randomUUID();
}

export function slugify(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

const DATE_OPTS = { day: 'numeric', month: 'short', year: 'numeric' };

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, DATE_OPTS);
}

export function formatDue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'No due date'
    : 'Due ' + date.toLocaleDateString(undefined, DATE_OPTS);
}

// Google Tasks stores due dates as date-only (UTC midnight); read the calendar day without timezone drift.
function dueDateOnly(value) {
  if (typeof value === 'string' && value.length >= 10) {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    if (y && m && d) return new Date(y, m - 1, d);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Human-friendly urgency for a due date. tone drives the inbox badge colour.
export function dueStatus(value) {
  const target = value ? dueDateOnly(value) : null;
  if (!target) return { label: 'No due date', tone: 'none', overdue: false };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (days < 0) {
    const by = Math.abs(days);
    return { label: 'Overdue by ' + by + (by === 1 ? ' day' : ' days'), tone: 'overdue', overdue: true };
  }
  if (days === 0) return { label: 'Due today', tone: 'today', overdue: false };
  if (days === 1) return { label: 'Due tomorrow', tone: 'soon', overdue: false };
  if (days <= 7) return { label: 'Due in ' + days + ' days', tone: 'soon', overdue: false };
  return { label: formatDue(value), tone: 'later', overdue: false };
}

export function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not set'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatRelative(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return 'Today';
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 7 * day) return Math.floor(diff / day) + ' days ago';
  return formatDate(value);
}
