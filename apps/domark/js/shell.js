// App shell: user identity, primary navigation and breadcrumbs.

import { state, currentProject } from './store.js';
import { byId, escapeHtml } from './utils.js';
import { getActiveProfile, listProfilesLocal, DEFAULT_PROFILE } from './profiles.js';

const TAB_LABELS = { overview: 'Overview', docs: 'Docs', recordings: 'Recordings', links: 'Links' };

function profileLabel(name) {
  return name === DEFAULT_PROFILE ? 'Default' : name;
}

export function renderProfiles() {
  const list = byId('profile-list');
  if (!list) return;
  const active = getActiveProfile();
  list.innerHTML = listProfilesLocal()
    .map((name) => {
      const isActive = name === active;
      return (
        '<button class="profile-item' + (isActive ? ' is-active' : '') + '" type="button" data-profile="' + escapeHtml(name) + '"' +
        (isActive ? ' aria-current="true"' : '') + '>' +
        '<span class="profile-item__dot" aria-hidden="true"></span>' +
        '<span class="profile-item__name">' + escapeHtml(profileLabel(name)) + '</span>' +
        (isActive ? '<span class="profile-item__check" aria-hidden="true">✓</span>' : '') +
        '</button>'
      );
    })
    .join('');
}

export function renderUser() {
  const gate = byId('login-gate');
  const shell = byId('app-shell');

  if (!state.profile) {
    if (gate) gate.classList.remove('hidden');
    if (shell) shell.classList.add('hidden');
    return;
  }

  if (gate) gate.classList.add('hidden');
  if (shell) shell.classList.remove('hidden');

  const name = byId('user-name');
  const email = byId('user-email');
  const avatar = byId('user-avatar');
  if (name) name.textContent = state.profile.name;
  if (email) email.textContent = state.profile.email;
  if (avatar) {
    avatar.src = state.profile.picture || '';
    avatar.alt = state.profile.name || '';
  }
  renderProfiles();
}

export function setActiveView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('is-active', view.id === 'view-' + viewName);
  });
}

export function renderShell() {
  const bar = byId('breadcrumbs');
  if (!bar) return;

  if (state.activeView !== 'projects') {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  const crumbs = [{ label: 'Projects', target: 'root' }];
  const project = currentProject();
  if (project) {
    crumbs.push({ label: project.category || 'Others', target: 'category', value: project.category || 'Others' });
    crumbs.push({ label: project.name, target: 'project' });
    crumbs.push({ label: TAB_LABELS[state.selectedProjectTab] || 'Overview' });
  } else if (state.selectedProjectCategory) {
    crumbs.push({ label: state.selectedProjectCategory });
  }

  bar.classList.remove('hidden');
  bar.innerHTML = crumbs
    .map((crumb, index) => {
      const isLast = index === crumbs.length - 1;
      const content = escapeHtml(crumb.label);
      const node = isLast || !crumb.target
        ? '<span class="crumb crumb--current">' + content + '</span>'
        : '<button class="crumb" type="button" data-crumb="' + crumb.target + '"' +
          (crumb.value ? ' data-crumb-value="' + escapeHtml(crumb.value) + '"' : '') +
          '>' + content + '</button>';
      return node + (isLast ? '' : '<span class="crumb-sep">›</span>');
    })
    .join('');
}
