// Transient user feedback: toasts, the login status line, and the busy overlay.

import { byId } from './utils.js';

let toastTimer = 0;
let busyCount = 0;

export function showToast(message) {
  const toast = byId('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

// Reference-counted so nested/overlapping busy sections don't hide the overlay early.
export function showBusy(message = 'Working…') {
  const overlay = byId('busy-overlay');
  if (!overlay) return;
  busyCount += 1;
  const label = byId('busy-message');
  if (label && message) label.textContent = message;
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

export function hideBusy() {
  const overlay = byId('busy-overlay');
  if (!overlay) return;
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount > 0) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
}

// Update the overlay text without affecting the busy reference count.
export function setBusyMessage(message) {
  const label = byId('busy-message');
  if (label && message) label.textContent = message;
}

export function setLoginStatus(message, isError = false) {
  const el = byId('login-status');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  el.classList.toggle('is-error', Boolean(isError));
}

export function clearLoginStatus() {
  const el = byId('login-status');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
  el.classList.remove('is-error');
}
