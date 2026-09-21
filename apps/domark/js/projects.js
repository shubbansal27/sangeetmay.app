// Projects view: category grid, project list and the project workspace.

import { state, currentProject } from './store.js';
import { PROJECT_CATEGORIES, ARTIFACT_TYPES } from './config.js';
import { byId, escapeHtml, slugify, formatDateTime, formatRelative } from './utils.js';
import { itemMeta, metaFieldHtml } from './inbox.js';
import { categoryOptionsHtml } from './categories.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'docs', label: 'Docs' },
  { id: 'recordings', label: 'Recordings' },
  { id: 'links', label: 'Links' },
];

export function projectProgress(project) {
  const value = Number(project && project.progress);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function projectStatus(project) {
  return projectProgress(project) >= 100 ? 'Complete' : 'In progress';
}

export function getCategories() {
  const grouped = new Map();
  PROJECT_CATEGORIES.forEach((name) => grouped.set(name, []));
  state.projects.forEach((project) => {
    const name = (project.category || 'Others').trim() || 'Others';
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(project);
  });
  return [...grouped.entries()]
    .filter(([, projects]) => projects.length > 0)
    .map(([name, projects]) => ({ name, projects }));
}

function lastUpdated(projects) {
  const times = projects.map((project) => new Date(project.createdAt || 0).getTime()).filter(Boolean);
  return times.length ? formatRelative(new Date(Math.max(...times)).toISOString()) : '—';
}

// Segmented switcher between the owner's projects and projects shared with the account.
function scopeNav() {
  const scope = state.projectScope === 'shared' ? 'shared' : 'owned';
  const tab = (id, label) =>
    '<button class="scope-tab' + (scope === id ? ' is-active' : '') +
    '" type="button" role="tab" aria-selected="' + (scope === id) + '" data-project-scope="' + id + '">' +
    escapeHtml(label) + '</button>';
  return (
    '<div class="scope-nav" role="tablist" aria-label="Project scope">' +
    tab('owned', 'Owned by me') +
    tab('shared', 'Shared with me') +
    '</div>'
  );
}

function sharedProjectCard(project) {
  const percent = projectProgress(project);
  const status = projectStatus(project);
  const isComplete = percent >= 100;
  const ownerLabel = (project.owner && (project.owner.name || project.owner.email)) || 'someone';
  return (
    '<div class="proj-card">' +
    '<button class="proj-card__open" type="button" data-project-id="' + escapeHtml(project.id) + '">' +
    '<div class="proj-card__top"><h3>' + escapeHtml(project.name) + '</h3>' +
    '<span class="badge">' + escapeHtml(project.category || 'Others') + '</span></div>' +
    '<p>' + escapeHtml(project.description || 'No description yet.') + '</p>' +
    '<div class="proj-card__progress">' +
    '<div class="proj-card__progress-head">' +
    '<span class="status-pill' + (isComplete ? ' is-complete' : '') + '">' + escapeHtml(status) + '</span>' +
    '<span class="proj-card__pct">' + percent + '%</span></div>' +
    '<div class="progress-bar' + (isComplete ? ' is-complete' : '') + '">' +
    '<span class="progress-bar__fill" style="width:' + percent + '%"></span></div>' +
    '</div>' +
    '<span class="proj-card__foot">Shared by ' + escapeHtml(ownerLabel) + '</span>' +
    '</button>' +
    '</div>'
  );
}

function sharedListView() {
  const head =
    '<div class="list-head list-head--root">' +
    '<h2>Shared with me</h2>' +
    '<button class="btn btn--soft btn--sm list-head__end" type="button" data-refresh-projects aria-label="Refresh shared projects" title="Refresh">↻</button>' +
    '</div>';
  if (state.sharedProjectsLoading && state.sharedProjects.length === 0) {
    const cards = Array.from({ length: 4 }).map(() => '<div class="cat-card cat-card--skeleton"></div>').join('');
    return head + '<div class="card-grid">' + cards + '</div>';
  }
  if (!state.sharedProjects.length) {
    return (
      head +
      '<div class="empty-state"><h3>No shared projects</h3>' +
      '<p>Projects that others share with you will appear here.</p></div>'
    );
  }
  return head + '<div class="card-grid">' + state.sharedProjects.map(sharedProjectCard).join('') + '</div>';
}

function categoryGrid() {
  const categories = getCategories();
  const head =
    '<div class="list-head list-head--root">' +
    '<h2>Projects</h2>' +
    '<button class="btn btn--soft btn--sm list-head__end" type="button" data-refresh-projects aria-label="Refresh projects" title="Refresh">↻</button>' +
    '<button class="btn btn--primary btn--sm" type="button" data-new-project>+ New project</button>' +
    '</div>';
  if (categories.length === 0) {
    return (
      '<div class="empty-state">' +
      '<h3>No projects yet</h3>' +
      '<p>Create a project from an inbox item, or start one independently.</p>' +
      '<button class="btn btn--primary" type="button" data-new-project>+ New project</button>' +
      '</div>'
    );
  }
  return (
    head +
    '<div class="card-grid">' +
    categories
      .map(
        (group) =>
          '<button class="cat-card" type="button" data-category="' + escapeHtml(group.name) + '">' +
          '<div class="cat-card__top"><h3>' + escapeHtml(group.name) + '</h3>' +
          '<span class="pill">' + group.projects.length + '</span></div>' +
          '<p class="cat-card__meta">Updated ' + escapeHtml(lastUpdated(group.projects)) + '</p>' +
          '</button>'
      )
      .join('') +
    '</div>'
  );
}

function projectList() {
  const inCategory = state.projects.filter(
    (project) => (project.category || 'Others') === state.selectedProjectCategory
  );
  const statusFilter = state.selectedProjectStatus || 'all';
  const projects = inCategory.filter((project) => {
    if (statusFilter === 'all') return true;
    return projectStatus(project) === statusFilter;
  });

  const counts = {
    all: inCategory.length,
    'In progress': inCategory.filter((project) => projectStatus(project) === 'In progress').length,
    Complete: inCategory.filter((project) => projectStatus(project) === 'Complete').length,
  };
  const filters = [
    { id: 'all', label: 'All' },
    { id: 'In progress', label: 'In progress' },
    { id: 'Complete', label: 'Complete' },
  ]
    .map(
      (filter) =>
        '<button class="status-filter' + (filter.id === statusFilter ? ' is-active' : '') +
        '" type="button" data-status-filter="' + escapeHtml(filter.id) + '">' +
        escapeHtml(filter.label) + '<span class="status-filter__count">' + counts[filter.id] + '</span></button>'
    )
    .join('');

  const cards = projects
    .map((project) => {
      const percent = projectProgress(project);
      const status = projectStatus(project);
      const isComplete = percent >= 100;
      return (
        '<div class="proj-card">' +
        '<button class="proj-card__open" type="button" data-project-id="' + escapeHtml(project.id) + '">' +
        '<div class="proj-card__top"><h3>' + escapeHtml(project.name) + '</h3>' +
        '<span class="badge">' + escapeHtml(project.category || 'Others') + '</span>' +
        (project.shared ? '<span class="badge badge--shared">Shared</span>' : '') + '</div>' +
        '<p>' + escapeHtml(project.description || 'No description yet.') + '</p>' +
        '<div class="proj-card__progress">' +
        '<div class="proj-card__progress-head">' +
        '<span class="status-pill' + (isComplete ? ' is-complete' : '') + '">' + escapeHtml(status) + '</span>' +
        '<span class="proj-card__pct">' + percent + '%</span></div>' +
        '<div class="progress-bar' + (isComplete ? ' is-complete' : '') + '">' +
        '<span class="progress-bar__fill" style="width:' + percent + '%"></span></div>' +
        '</div>' +
        '<span class="proj-card__foot">Created ' + escapeHtml(formatRelative(project.createdAt)) + '</span>' +
        '</button>' +
        '</div>'
      );
    })
    .join('');

  return (
    '<div class="list-head">' +
    '<button class="btn btn--ghost" type="button" data-crumb="root">← Categories</button>' +
    '<h2>' + escapeHtml(state.selectedProjectCategory) + '</h2>' +
    '<span class="pill">' + inCategory.length + '</span>' +
    '<button class="btn btn--soft btn--sm list-head__end" type="button" data-refresh-projects aria-label="Refresh projects" title="Refresh">↻</button>' +
    '<button class="btn btn--primary btn--sm" type="button" data-new-project>+ New project</button>' +
    '</div>' +
    '<div class="status-filters">' + filters + '</div>' +
    (projects.length
      ? '<div class="card-grid">' + cards + '</div>'
      : '<div class="empty-state"><h3>No projects</h3><p>Nothing matches this status filter.</p></div>')
  );
}

function artifactSpec(artifact) {
  const type = String(artifact?.type || 'drawio').toLowerCase();
  return ARTIFACT_TYPES[type] || ARTIFACT_TYPES.drawio;
}

function artifactList(project, tab) {
  const configByTab = {
    docs: { heading: 'Documents', empty: 'documents', addButton: '<button class="btn btn--soft" type="button" data-add-artifact="docs">+ New</button>' },
    recordings: { heading: 'Recordings', empty: 'recordings', addButton: '<button class="btn btn--soft" type="button" data-record-artifact>● Record</button>' },
    links: { heading: 'Links', empty: 'links', addButton: '<button class="btn btn--soft" type="button" data-add-link>+ Add link</button>' },
  };
  const cfg = configByTab[tab] || configByTab.docs;
  const artifacts = (Array.isArray(project.artifacts) ? project.artifacts : []).filter(
    (artifact) => artifactSpec(artifact).tab === tab
  );

  const rows = artifacts.length
    ? artifacts
        .map((artifact) => {
          const spec = artifactSpec(artifact);
          const removeBtn = project.readOnly
            ? ''
            : '<button class="file-row__remove" type="button" data-remove-artifact="' + escapeHtml(String(artifact.id)) + '" aria-label="Remove">Remove</button>';
          return (
            '<div class="file-row-wrap">' +
            '<button class="file-row" type="button" data-open-artifact="' + escapeHtml(String(artifact.id)) + '">' +
            '<span class="file-row__icon">' + spec.icon + '</span>' +
            '<span class="file-row__text"><strong>' + escapeHtml(artifact.title || spec.label) + '</strong>' +
            '<small>' + escapeHtml(artifact.fileName || spec.label) + '</small></span>' +
            '<span class="file-row__type">' + escapeHtml(spec.label) + '</span>' +
            '<span class="file-row__open">Open ↗</span>' +
            '</button>' +
            removeBtn +
            '</div>'
          );
        })
        .join('')
    : '<div class="empty-state empty-state--sm"><p>No ' + cfg.empty + ' yet.</p></div>';

  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><h3>' + cfg.heading + '</h3>' +
    (project.readOnly ? '' : cfg.addButton) + '</div>' +
    '<div class="file-list">' + rows + '</div>' +
    '</div>'
  );
}

function progressBlock(project) {
  const percent = projectProgress(project);
  const isComplete = percent >= 100;
  // Shared projects are read-only in-app: no progress editing.
  const controls = project.readOnly
    ? ''
    : '<div class="progress-controls">' +
      '<input class="progress-slider" type="range" min="0" max="100" step="5" value="' + percent +
      '" data-project-progress aria-label="Completion percentage" />' +
      '<button class="btn btn--primary btn--sm" type="button" data-project-complete' +
      (isComplete ? ' disabled' : '') + '>' + (isComplete ? 'Completed' : 'Mark complete') + '</button>' +
      '</div>';

  return (
    '<div class="panel-block progress-block">' +
    '<div class="progress-block__head"><p class="kicker">Progress</p>' +
    '<span class="progress-block__value" data-progress-label>' + percent + '%</span></div>' +
    '<div class="progress-bar' + (isComplete ? ' is-complete' : '') + '">' +
    '<span class="progress-bar__fill" data-progress-fill style="width:' + percent + '%"></span></div>' +
    controls +
    '</div>'
  );
}

// A single editable key/value tag row; reused when adding rows in the overview editor.
export function ovTagRowHtml(tag = { key: '', value: '' }) {
  return (
    '<div class="tag-input-row">' +
    '<input type="text" placeholder="Key" aria-label="Tag key" value="' + escapeHtml(tag.key || '') + '" />' +
    '<input type="text" placeholder="Value" aria-label="Tag value" value="' + escapeHtml(tag.value || '') + '" />' +
    '<button type="button" class="tag-input-remove" data-ov-remove-tag aria-label="Remove tag">×</button>' +
    '</div>'
  );
}

function overviewEdit(project) {
  const categoryOptions = categoryOptionsHtml(project.category);

  const tags = Array.isArray(project.tags) && project.tags.length ? project.tags : [{ key: '', value: '' }];
  const tagRows = tags.map(ovTagRowHtml).join('');

  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><p class="kicker">Edit project</p></div>' +
    '<div class="form">' +
    '<label class="field"><span>Project name</span>' +
    '<input id="ov-name" class="input" type="text" maxlength="80" value="' + escapeHtml(project.name || '') + '" /></label>' +
    '<label class="field"><span>Category</span>' +
    '<select id="ov-category" class="select" data-current="' + escapeHtml(project.category || 'Others') + '">' + categoryOptions + '</select></label>' +
    '<label class="field"><span>Description</span>' +
    '<textarea id="ov-description" class="input" rows="3">' + escapeHtml(project.description || '') + '</textarea></label>' +
    '<div class="field-head"><span>Tags</span>' +
    '<button class="btn btn--soft btn--sm" type="button" data-ov-add-tag>+ Add tag</button></div>' +
    '<div id="ov-tags" class="tags-editor">' + tagRows + '</div>' +
    '<div class="modal__actions">' +
    '<button class="btn btn--ghost" type="button" data-cancel-overview>Cancel</button>' +
    '<button class="btn btn--primary" type="button" data-save-overview>Save changes</button>' +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

// Source details mirror the inbox item; hide legacy fields from older saved bookmarks.
const HIDDEN_SOURCE_FIELDS = new Set(['Status', 'Due', 'Updated', 'Urgency', 'Source', 'Type']);

function overviewTab(project) {
  if (state.editingOverview && !project.readOnly) return overviewEdit(project);

  const tags =
    Array.isArray(project.tags) && project.tags.length
      ? project.tags
          .map((tag) => {
            const key = tag && tag.key ? String(tag.key).trim() : 'Tag';
            const value = tag && tag.value ? String(tag.value).trim() : '';
            return '<span class="tag">' + escapeHtml(key) + (value ? ': ' + escapeHtml(value) : '') + '</span>';
          })
          .join('')
      : '<span class="muted">No tags yet</span>';

  const bookmark = project.bookmark || null;
  const sourceFields = bookmark ? itemMeta(bookmark).filter((field) => !HIDDEN_SOURCE_FIELDS.has(field.label)) : [];
  if (bookmark && !sourceFields.some((field) => field.href)) {
    const openHref =
      bookmark.link || (String(bookmark.source || '').toLowerCase().includes('task') ? 'https://tasks.google.com/' : '');
    if (openHref) sourceFields.push({ label: 'Open', value: 'Open source', href: openHref });
  }
  if (bookmark) sourceFields.unshift({ label: 'Type', value: bookmark.source || 'Inbox item' });
  const bookmarkMeta = sourceFields.map(metaFieldHtml).join('');
  const sourceBlock =
    '<div class="panel-block__sub"><p class="kicker">Source</p>' +
    (bookmark
      ? '<div class="preview__grid source-grid">' + bookmarkMeta + '</div>'
      : '<p class="lede">Created independently — not linked to an inbox item.</p>') +
    '</div>';

  const editBtn = project.readOnly
    ? ''
    : '<button class="btn btn--soft btn--sm" type="button" data-edit-overview>Edit</button>';

  return (
    '<div class="panel-block">' +
    '<div class="panel-block__head"><p class="kicker">Description</p>' + editBtn + '</div>' +
    '<p class="lede">' + escapeHtml(project.description || 'No description added for this project yet.') + '</p>' +
    '<div class="meta-grid">' +
    '<div><span>Category</span><strong>' + escapeHtml(project.category || 'Others') + '</strong></div>' +
    '<div><span>Status</span><strong>' + escapeHtml(projectStatus(project)) + '</strong></div>' +
    '<div><span>Created</span><strong>' + escapeHtml(formatDateTime(project.createdAt)) + '</strong></div>' +
    '<div><span>Folder</span>' +
    (project.folderId
      ? '<a href="https://drive.google.com/drive/folders/' + encodeURIComponent(project.folderId) +
        '" target="_blank" rel="noopener noreferrer">' + escapeHtml(project.slug || slugify(project.name)) + ' ↗</a>'
      : '<strong>' + escapeHtml(project.slug || slugify(project.name)) + '</strong>') +
    '</div>' +
    '</div>' +
    '<div class="panel-block__sub"><p class="kicker">Tags</p><div class="tag-row">' + tags + '</div></div>' +
    sourceBlock +
    '</div>'
  );
}

function tabContent(project) {
  const tab = state.selectedProjectTab || 'overview';
  if (tab === 'docs') return artifactList(project, 'docs');
  if (tab === 'recordings') return artifactList(project, 'recordings');
  if (tab === 'links') return artifactList(project, 'links');
  return progressBlock(project) + overviewTab(project);
}

function workspace(project) {
  const activeTab = state.selectedProjectTab || 'overview';
  const tabs = TABS.map(
    (tab) =>
      '<button class="wtab' + (tab.id === activeTab ? ' is-active' : '') + '" type="button" data-project-tab="' +
      tab.id + '">' + tab.label + '</button>'
  ).join('');

  const status = projectStatus(project);
  const isComplete = projectProgress(project) >= 100;
  const readOnly = !!project.readOnly;
  const ownerLabel = (project.owner && (project.owner.name || project.owner.email)) || 'someone';

  const actions = readOnly
    ? '<button class="btn btn--ghost" type="button" data-project-back>← Back</button>'
    : '<button class="btn btn--ghost" type="button" data-project-back>← Back</button>' +
      '<button class="btn btn--soft" type="button" data-share-project="' + escapeHtml(project.id) + '">Share</button>' +
      '<button class="btn btn--ghost workspace-head__remove" type="button" data-remove-project="' + escapeHtml(project.id) + '">Remove</button>';

  const sharedPill = !readOnly && project.shared
    ? '<span class="badge badge--shared">Shared</span>'
    : '';
  const banner = readOnly
    ? '<div class="readonly-banner">Shared by ' + escapeHtml(ownerLabel) + ' · view &amp; open artifacts</div>'
    : '';

  return (
    '<div class="workspace-head">' +
    '<div class="workspace-head__title">' +
    '<h1>' + escapeHtml(project.name) + '</h1>' +
    '<span class="badge">' + escapeHtml(project.category || 'Others') + '</span>' +
    sharedPill +
    '<span class="status-dot' + (isComplete ? ' is-complete' : '') + '">' + escapeHtml(status) + '</span>' +
    '</div>' +
    '<div class="workspace-head__actions">' + actions + '</div>' +
    '</div>' +
    banner +
    '<div class="wtabs">' + tabs + '</div>' +
    '<div class="workspace-body">' + tabContent(project) + '</div>'
  );
}

export function renderProjects() {
  const list = byId('project-list');
  const detail = byId('project-workspace');
  if (!list || !detail) return;

  const project = currentProject();
  if (project) {
    list.classList.add('hidden');
    detail.classList.remove('hidden');
    detail.innerHTML = workspace(project);
    return;
  }

  detail.classList.add('hidden');
  list.classList.remove('hidden');

  if (state.projectScope === 'shared') {
    list.innerHTML = scopeNav() + sharedListView();
    return;
  }

  if (state.projectsLoading && state.projects.length === 0) {
    list.innerHTML = scopeNav() + projectsLoadingState();
    return;
  }
  // The scope switcher shows at the category root; drilling into a category hides it behind the crumb.
  list.innerHTML = state.selectedProjectCategory ? projectList() : scopeNav() + categoryGrid();
}

function projectsLoadingState() {
  const cards = Array.from({ length: 4 })
    .map(() => '<div class="cat-card cat-card--skeleton"></div>')
    .join('');
  return (
    '<div class="list-head list-head--root"><h2>Projects</h2>' +
    '<span class="muted list-head__end">Syncing from Drive…</span></div>' +
    '<div class="card-grid">' + cards + '</div>'
  );
}
