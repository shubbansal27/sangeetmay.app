// Transient user feedback: toasts, the login status line, and the busy overlay.

import { byId } from './utils.js';

let toastTimer = 0;

export function showToast(message) {
  const toast = byId('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

export function showBusy(message = 'Working…') {
  const overlay = byId('busy-overlay');
  if (!overlay) return;
  const label = byId('busy-message');
  if (label) label.textContent = message;
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

export function hideBusy() {
  const overlay = byId('busy-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
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
