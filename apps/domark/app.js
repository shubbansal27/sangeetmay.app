'use strict';

const DOMARK_PROFILE_KEY = 'domark_google_profile';
const DOMARK_PROJECTS_KEY = 'domark_projects';

const SOURCES = {
  google_tasks: {
    id: 'google_tasks',
    label: 'Google Tasks',
    scope: 'https://www.googleapis.com/auth/tasks.readonly',
    loadItems: fetchGoogleTasksItems,
  },
  youtube_review_later: {
    id: 'youtube_review_later',
    label: 'YouTube: Review Later',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    loadItems: fetchYouTubeReviewLaterItems,
  },
};

const state = {
  activeView: 'inbox',
  activeSource: 'google_tasks',
  activeDateFilter: 'all',
  selectedItem: null,
  profile: null,
  token: null,
  projects: loadProjects(),
  selectedProjectId: null,
  selectedProjectTab: 'details',
  sourceItems: [],
  sourceStatus: 'idle',
  sourceError: '',
};

function byId(id) {
  return document.getElementById(id);
}

function loadProjects() {
  try {
    const saved = JSON.parse(localStorage.getItem(DOMARK_PROJECTS_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch (_) {
    return [];
  }
}

function saveProjects() {
  localStorage.setItem(DOMARK_PROJECTS_KEY, JSON.stringify(state.projects));
}

function restoreProfile() {
  try {
    return JSON.parse(localStorage.getItem(DOMARK_PROFILE_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

function saveProfile(profile) {
  localStorage.setItem(DOMARK_PROFILE_KEY, JSON.stringify(profile));
}

function clearProfile() {
  localStorage.removeItem(DOMARK_PROFILE_KEY);
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    toast.classList.add('hidden');
  }, 2400);
}

function setLoginStatus(message, isError) {
  const el = byId('login-status');
  el.textContent = message;
  el.classList.remove('hidden');
  el.style.color = isError ? '#8f3520' : '';
}

function clearLoginStatus() {
  const el = byId('login-status');
  el.textContent = '';
  el.classList.add('hidden');
  el.style.color = '';
}

function callbackUrl() {
  return new URL('auth-callback.html', window.location.href).href;
}

function activeSource() {
  return SOURCES[state.activeSource] || SOURCES.google_tasks;
}

function authScope() {

  const sourceScopes = Array.from(
    new Set(
      Object.values(SOURCES)
        .map((source) => source.scope)
        .filter((scope) => typeof scope === 'string' && scope.trim() !== '')
    )
  );
  return ['openid', 'profile', 'email', ...sourceScopes].join(' ');
}

function youtubePlaylistTitle() {
  const value = String(window.DOMARK_YOUTUBE_PLAYLIST_TITLE || '').trim();
  return value || 'Review Later';
}

function isConfigured() {
  return typeof window.DOMARK_GOOGLE_CLIENT_ID === 'string' && window.DOMARK_GOOGLE_CLIENT_ID.trim() !== '';
}

function openAuthPopup(scope, stateValue, extraParams = {}) {
  if (!isConfigured()) {
    throw new Error('Google client ID is not configured in domark-config.js.');
  }

  const params = new URLSearchParams({
    client_id: window.DOMARK_GOOGLE_CLIENT_ID.trim(),
    redirect_uri: callbackUrl(),
    response_type: 'token',
    scope,
    state: stateValue,
    prompt: 'select_account',
    ...extraParams,
  });

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  const popup = window.open(
    authUrl,
    'domark_auth',
    'width=600,height=700,left=120,top=80,resizable=yes'
  );

  if (!popup) {
    throw new Error('Popup blocked. Allow popups for this site and try again.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const closePoll = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(closePoll);
      window.setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        reject(new Error('Sign-in window was closed before completion.'));
      }, 600);
    }, 400);

    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'domark_auth_token') return;
      if (settled) return;
      settled = true;
      window.clearInterval(closePoll);
      window.removeEventListener('message', onMessage);
      try {
        popup.close();
      } catch (_) {
      }
      if (event.data.error) {
        reject(new Error(event.data.error));
        return;
      }
      resolve(event.data.token);
    }

    window.addEventListener('message', onMessage);
  });
}

async function fetchProfile(token) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + token },
  });

  if (!response.ok) {
    throw new Error('Could not read your Google profile.');
  }

  const data = await response.json();
  return {
    name: data.name || data.email || 'Google User',
    email: data.email || '',
    picture: data.picture || '',
  };
}

async function signIn(options = {}) {
  const token = await openAuthPopup(authScope(), options.state || 'signin', options.extraParams || {});
  const profile = await fetchProfile(token);
  state.token = token;
  state.profile = profile;
  saveProfile(profile);
  render();
  return profile;
}

function signOut() {
  state.token = null;
  state.profile = null;
  state.sourceItems = [];
  state.sourceStatus = 'idle';
  state.sourceError = '';
  clearProfile();
  render();
}

async function trySilentSignIn() {
  const profile = restoreProfile();
  if (!profile || !profile.email) return;

  state.profile = profile;
  render();

  try {
    const token = await openAuthPopup(authScope(), 'silent', {
      prompt: 'none',
      login_hint: profile.email,
    });
    state.token = token;
  } catch (_) {
    state.token = null;
  }

  render();
}

function setActiveView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === 'view-' + viewName);
  });
}

function inboxItems() {
  const source = activeSource();

  if (!state.profile) {
    return [
      {
        tag: 'Next step',
        title: 'Authenticate to initialize the inbox',
        body: 'Google sign-in is the first required step before any inbox source can be queried.',
      },
      {
        tag: 'Source model',
        title: 'Adapters keep the inbox source-agnostic',
        body: 'Google Tasks and YouTube Review Later are wired to the same card model.',
      },
    ];
  }

  if (state.sourceStatus === 'loading') {
    return [
      {
        tag: source.label,
        title: 'Sync in progress',
        body: 'Loading items from the active source adapter.',
      },
    ];
  }

  if (state.sourceError) {
    return [
      {
        tag: source.label,
        title: 'Sync failed',
        body: state.sourceError,
      },
    ];
  }

  if (state.sourceItems.length > 0) {
    return state.sourceItems;
  }

  return [
    {
      tag: 'Account',
      title: state.profile.name,
      body: state.profile.email || 'Google account linked.',
    },
    {
      tag: source.label,
      title: 'No tasks yet',
      body: 'The source adapter is active. Add items in the selected source and press refresh to sync again.',
    },
    {
      tag: 'Next move',
      title: 'Add another source adapter',
      body: 'This same card model can be reused for future providers without changing the dashboard layout.',
    },
  ];
}

async function fetchGoogleTasksItems(token) {
  const headers = { Authorization: 'Bearer ' + token };
  const listsResponse = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=10', { headers });

  if (!listsResponse.ok) {
    throw new Error('Could not read your Google Task lists. Please sign in again and retry.');
  }

  const listsData = await listsResponse.json();
  const lists = Array.isArray(listsData.items) ? listsData.items : [];

  if (lists.length === 0) {
    return [];
  }

  const results = await Promise.all(
    lists.slice(0, 4).map(async (list) => {
      const encodedListId = encodeURIComponent(list.id);
      let pageToken = null;
      let allTasks = [];

      do {
        const pageParams = new URLSearchParams({
          showCompleted: 'true',
          showHidden: 'false',
          maxResults: '100',
        });

        if (pageToken) {
          pageParams.set('pageToken', pageToken);
        }

        const url = 'https://tasks.googleapis.com/tasks/v1/lists/' + encodedListId + '/tasks?' + pageParams.toString();
        const tasksResponse = await fetch(url, { headers });

        if (!tasksResponse.ok) {
          return [];
        }

        const tasksData = await tasksResponse.json();
        const items = Array.isArray(tasksData.items) ? tasksData.items : [];
        allTasks = allTasks.concat(items);
        pageToken = tasksData.nextPageToken || null;
      } while (pageToken);

      return allTasks
        .filter((task) => task && task.title)
        .sort((a, b) => {
          const aTime = a.updated || a.due || 0;
          const bTime = b.updated || b.due || 0;
          return new Date(bTime).getTime() - new Date(aTime).getTime();
        })
        .map((task) => {
          const due = task.due ? formatDueDate(task.due) : 'No due date';
          const updated = task.updated ? formatAddedDate(task.updated) : 'Not set';
          const notes = typeof task.notes === 'string' && task.notes.trim() ? task.notes.trim() : 'No notes';
          const bodyParts = [due, formatAddedDate(task.updated || task.due)].filter((part) => part && part !== 'No due date');
          return {
            source: 'Google Tasks',
            tag: list.title || 'Task list',
            title: task.title || '(Untitled task)',
            body: bodyParts.join(' · '),
            addedAt: task.updated || task.due || null,
            detailLabel: 'Due',
            detailValue: task.due ? formatDueDate(task.due) : 'No due date',
            status: task.status === 'completed' ? 'Completed' : 'Open',
            extraMeta: [
              { label: 'List', value: list.title || 'Task list' },
              { label: 'Due', value: task.due ? formatDueDate(task.due) : 'No due date' },
              { label: 'Updated', value: updated },
              { label: 'Notes', value: notes },
              { label: 'Status', value: task.status === 'completed' ? 'Completed' : 'Open' },
            ],
          };
        });
    })
  );

  return results.flat().sort((a, b) => {
    const aTime = a.addedAt || 0;
    const bTime = b.addedAt || 0;
    return new Date(bTime).getTime() - new Date(aTime).getTime();
  }).slice(0, 50);
}

async function fetchYouTubeReviewLaterItems(token) {
  const headers = { Authorization: 'Bearer ' + token };
  const targetTitle = youtubePlaylistTitle().toLowerCase();
  const playlistsResponse = await fetch('https://www.googleapis.com/youtube/v3/playlists?part=id,snippet&mine=true&maxResults=50', { headers });

  if (!playlistsResponse.ok) {
    throw new Error('Could not read your YouTube playlists. Please sign in again and retry.');
  }

  const playlistsData = await playlistsResponse.json();
  const playlists = Array.isArray(playlistsData.items) ? playlistsData.items : [];
  const targetPlaylist = playlists.find((playlist) => {
    const title = String(playlist?.snippet?.title || '').trim().toLowerCase();
    return title === targetTitle;
  });

  if (!targetPlaylist || !targetPlaylist.id) {
    return [
      {
        tag: 'YouTube',
        title: 'Playlist not found',
        body: 'Could not find a playlist named "' + youtubePlaylistTitle() + '" in this account.',
      },
    ];
  }

  const encodedId = encodeURIComponent(targetPlaylist.id);
  const itemsUrl = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=' + encodedId + '&maxResults=16';
  const itemsResponse = await fetch(itemsUrl, { headers });

  if (!itemsResponse.ok) {
    throw new Error('Could not read items from your YouTube playlist.');
  }

  const itemsData = await itemsResponse.json();
  const items = Array.isArray(itemsData.items) ? itemsData.items : [];

  return items.map((item) => {
    const title = item?.snippet?.title || 'Untitled video';
    const addedAt = item?.snippet?.publishedAt || item?.contentDetails?.videoPublishedAt || null;
    const added = formatAddedDate(addedAt);
    return {
      source: 'YouTube: Review Later',
      tag: youtubePlaylistTitle(),
      title,
      body: 'Added ' + added,
      addedAt,
      detailLabel: 'Playlist',
      detailValue: youtubePlaylistTitle(),
      status: 'Saved',
    };
  });
}

function formatDueDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'No due date';
  }
  return 'Due ' + date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatAddedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatPublishedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown publish date';
  }
  return 'Published ' + date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

async function refreshSourceItems() {
  if (!state.profile || !state.token) {
    state.sourceItems = [];
    state.sourceStatus = 'idle';
    state.sourceError = 'Sign in first to sync tasks.';
    renderInbox();
    return;
  }

  state.sourceStatus = 'loading';
  state.sourceError = '';
  renderInbox();

  try {
    state.sourceItems = await activeSource().loadItems(state.token);
    state.sourceStatus = 'ready';
  } catch (error) {
    state.sourceItems = [];
    state.sourceStatus = 'error';
    state.sourceError = error.message || 'Could not sync tasks.';
  }

  renderInbox();
}

function renderSourceTabs() {
  document.querySelectorAll('.source-tab').forEach((button) => {
    const isActive = button.dataset.source === state.activeSource;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
}

function renderDateFilters() {
  document.querySelectorAll('.date-filter-btn').forEach((button) => {
    const isActive = button.dataset.filter === state.activeDateFilter;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function parseItemDate(item) {
  const value = item && (item.addedAt || item.createdAt || item.updatedAt || item.date);
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function matchesDateFilter(item, filterName) {
  if (!filterName || filterName === 'all') {
    return true;
  }

  const date = parseItemDate(item);
  if (!date) {
    return false;
  }

  const diffMs = Date.now() - date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  switch (filterName) {
    case '1d':
      return diffMs <= dayMs;
    case '2d':
      return diffMs <= dayMs * 2;
    case '3d':
      return diffMs <= dayMs * 3;
    case '7d':
      return diffMs <= dayMs * 7;
    case '14d':
      return diffMs <= dayMs * 14;
    case '30d':
      return diffMs <= dayMs * 30;
    case '60d':
      return diffMs <= dayMs * 60;
    default:
      return true;
  }
}

function itemDetailMeta(item) {
  const source = item?.source || activeSource().label || 'Source';
  const addedAt = item?.addedAt ? formatAddedDate(item.addedAt) : 'Not set';
  const detailLabel = item?.detailLabel || 'Details';
  const detailValue = item?.detailValue || 'Not set';

  const fields = [
    { label: 'Source', value: source },
    { label: 'Title', value: item?.title || 'Untitled' },
    { label: 'Added', value: addedAt },
    { label: 'Status', value: item?.status || 'Open' },
    { label: detailLabel, value: detailValue },
  ];

  if (Array.isArray(item?.extraMeta)) {
    return [...fields, ...item.extraMeta.filter((entry) => entry && entry.label && entry.value)];
  }

  return fields;
}

function renderItemDetail() {
  const modal = byId('item-detail-modal');
  if (!modal) return;

  const title = byId('detail-title');
  const source = byId('detail-source');
  const meta = byId('detail-meta');
  const summary = byId('detail-summary');

  if (!state.selectedItem) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    return;
  }

  const item = state.selectedItem;
  const fields = itemDetailMeta(item);

  if (title) title.textContent = item.title || 'Item details';
  if (source) source.textContent = item.source || activeSource().label || 'Source';
  if (summary) summary.textContent = item.body || 'No additional details.';
  if (meta) {
    meta.innerHTML = fields.map((field) => {
      return '<div class="detail-row"><span class="detail-label">' + escapeHtml(field.label) + '</span><span class="detail-value">' + escapeHtml(field.value) + '</span></div>';
    }).join('');
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeItemDetail() {
  state.selectedItem = null;
  renderItemDetail();
}

function openItemDetail(item) {
  state.selectedItem = item;
  renderItemDetail();
}

function renderInbox() {
  const title = byId('sync-status-title');
  const copy = byId('sync-status-copy');
  const list = byId('inbox-list');
  const source = activeSource();

  if (title && copy) {
    if (state.profile) {
      title.textContent = source.label + ' inbox';
      copy.textContent = 'This tab is synced from your selected source.';
    } else {
      title.textContent = 'Waiting for sign-in';
      copy.textContent = 'Authenticate to initialize the inbox workspace and load your source tabs.';
    }
  }

  if (!list) return;

  const items = inboxItems().filter((item) => matchesDateFilter(item, state.activeDateFilter));
  list.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('article');
    empty.className = 'inbox-note empty-note';
    empty.innerHTML = '<h3>No items in this window</h3><p>Try a broader date filter or switch to another source tab.</p>';
    list.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const article = document.createElement('article');
    article.className = 'inbox-note';
    article.dataset.item = JSON.stringify(item);
    article.style.cursor = 'pointer';
    article.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openProjectFromInboxItem(item);
    });
    article.innerHTML = [
      '<div class="mail-row">',
      '  <div class="mail-select" aria-hidden="true"></div>',
      '  <div class="mail-source">' + escapeHtml(item.tag) + '</div>',
      '  <div class="mail-content">',
      '    <h3>' + escapeHtml(item.title) + '</h3>',
      '    <p>' + escapeHtml(item.body) + '</p>',
      '  </div>',
      '  <div class="mail-date">' + escapeHtml(item.body.split(' · ').slice(-1)[0] || '') + '</div>',
      '</div>',
    ].join('');
    list.appendChild(article);
  });
}

function currentProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) || null;
}

function renderProjectTabContent(project) {
  const tab = state.selectedProjectTab || 'details';

  if (tab === 'bookmark') {
    const bookmark = project?.bookmark || null;
    if (!bookmark) {
      return [
        '<div class="project-section-block">',
        '  <p class="card-kicker">Bookmark</p>',
        '  <h3>No bookmark attached</h3>',
        '  <p class="project-detail-copy">Open an inbox item to attach its source metadata here.</p>',
        '</div>',
      ].join('');
    }

    const meta = itemDetailMeta(bookmark);
    return [
      '<div class="project-section-block">',
      '  <p class="card-kicker">Bookmark</p>',
      '  <h3>' + escapeHtml(bookmark.title || project.name) + '</h3>',
      '  <p class="project-detail-copy">' + escapeHtml(bookmark.body || 'No summary available.') + '</p>',
      '  <div class="project-metadata project-bookmark-meta">',
      meta.map((field) => '<div><span>' + escapeHtml(field.label) + '</span><strong>' + escapeHtml(field.value) + '</strong></div>').join(''),
      '  </div>',
      '</div>',
    ].join('');
  }

  if (tab === 'design') {
    return [
      '<div class="project-embed-header">',
      '  <div>',
      '    <p class="card-kicker">Design</p>',
      '    <h3>Architecture board</h3>',
      '  </div>',
      '  <button class="ghost-btn" type="button" data-project-back>Back to projects</button>',
      '</div>',
      ' <div class="drawio-wrapper">',
      '   <iframe class="drawio-embed" src="https://embed.diagrams.net/?embed=1&ui=atlas&spin=1&proto=json" title="draw.io design canvas for ' + escapeHtml(project.name) + '"></iframe>',
      ' </div>',
    ].join('');
  }

  if (tab === 'references') {
    return [
      '<div class="project-section-block">',
      '  <p class="card-kicker">References</p>',
      '  <ul class="project-note-list">',
      '    <li>Bookmark source links</li>',
      '    <li>Research articles or product references</li>',
      '    <li>Inspiration links and examples</li>',
      '  </ul>',
      '</div>',
    ].join('');
  }

  if (tab === 'recordings') {
    return [
      '<div class="project-section-block">',
      '  <p class="card-kicker">Recordings</p>',
      '  <ul class="project-note-list">',
      '    <li>Design critique video notes</li>',
      '    <li>Customer feedback recording</li>',
      '    <li>Prototype walkthroughs</li>',
      '  </ul>',
      '</div>',
    ].join('');
  }

  return [
    '<div class="project-section-block">',
    '  <p class="card-kicker">Details</p>',
    '  <h3>' + escapeHtml(project.name) + '</h3>',
    '  <p class="project-detail-copy">Plan the objective, owner, and next milestone for this project in one place.</p>',
    '  <div class="project-metadata">',
    '    <div><span>Owner</span><strong>Unassigned</strong></div>',
    '    <div><span>Status</span><strong>Draft</strong></div>',
    '    <div><span>Next review</span><strong>None scheduled</strong></div>',
    '  </div>',
    '</div>',
  ].join('');
}

function renderProjects() {
  const list = byId('project-list');
  const detail = byId('project-detail');

  if (!list || !detail) return;

  const project = currentProject();
  if (project) {
    list.classList.add('hidden');
    detail.classList.remove('hidden');

    const tabButtons = [
      { id: 'details', label: 'Details' },
      { id: 'bookmark', label: 'Bookmark' },
      { id: 'design', label: 'Design' },
      { id: 'references', label: 'References' },
      { id: 'recordings', label: 'Recordings' },
    ];

    detail.innerHTML = [
      '<div class="project-detail-shell">',
      '  <aside class="project-side-nav">',
      tabButtons.map((tab) => {
        const isActive = state.selectedProjectTab === tab.id;
        return '<button class="project-tab-btn' + (isActive ? ' active' : '') + '" type="button" data-project-tab="' + tab.id + '">' + tab.label + '</button>';
      }).join(''),
      '  </aside>',
      '  <div class="project-main-panel">',
      '    <div class="project-main-header">',
      '      <div class="project-main-header-actions">',
      '        <button class="primary-btn" type="button" data-project-save>Save Project</button>',
      '        <button class="ghost-btn" type="button" data-project-back>Back</button>',
      '      </div>',
      '    </div>',
      '    <div class="project-main-body">' + renderProjectTabContent(project) + '</div>',
      '  </div>',
      '</div>',
    ].join('');
    return;
  }

  detail.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';

  if (state.projects.length === 0) {
    const empty = document.createElement('article');
    empty.className = 'project-item';
    empty.innerHTML = '<div><h3>No projects yet</h3><p>Use this area as the next navigation target after inbox work is defined.</p></div>';
    list.appendChild(empty);
    return;
  }

  state.projects.forEach((project) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'project-item project-card';
    item.dataset.projectId = project.id;
    item.innerHTML = [
      '<div>',
      '  <div class="project-top">',
      '    <h3>' + escapeHtml(project.name) + '</h3>',
      '    <span class="project-badge">Local</span>',
      '  </div>',
      '  <p>Created for dashboard structure. Storage backend is still open.</p>',
      '</div>',
      '<span class="ghost-btn project-card-action" data-remove-project="' + escapeHtml(project.id) + '">Remove</span>',
    ].join('');
    list.appendChild(item);
  });
}

function renderUser() {
  const chip = byId('user-chip');
  const signout = byId('btn-signout');
  const appShell = byId('app-shell');
  const gate = byId('login-gate');

  if (!state.profile) {
    if (chip) chip.classList.add('hidden');
    if (signout) signout.classList.add('hidden');
    if (appShell) appShell.classList.add('hidden');
    if (gate) gate.classList.remove('hidden');
    return;
  }

  const userName = byId('user-name');
  const userEmail = byId('user-email');
  const userAvatar = byId('user-avatar');

  if (userName) userName.textContent = state.profile.name;
  if (userEmail) userEmail.textContent = state.profile.email;
  if (userAvatar) {
    userAvatar.src = state.profile.picture || '';
    userAvatar.alt = state.profile.name;
  }

  if (chip) chip.classList.remove('hidden');
  if (signout) signout.classList.remove('hidden');
  if (appShell) appShell.classList.remove('hidden');
  if (gate) gate.classList.add('hidden');
}

function render() {
  renderUser();
  renderSourceTabs();
  renderDateFilters();
  renderInbox();
  renderProjects();
  renderItemDetail();
  setActiveView(state.activeView);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function openProjectModal() {
  const modal = byId('project-create-modal');
  if (!modal) return;
  const input = byId('project-input');
  if (input) {
    input.value = '';
    window.setTimeout(() => input.focus(), 50);
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeProjectModal() {
  const modal = byId('project-create-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function handleProjectSubmit(event) {
  event.preventDefault();
  const input = byId('project-input');
  const name = input.value.trim();
  if (!name) {
    showToast('Enter a project name first.');
    return;
  }

  const exists = state.projects.some((project) => project.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    showToast('Project already exists.');
    closeProjectModal();
    return;
  }

  state.projects.unshift({
    id: crypto.randomUUID(),
    name,
  });
  saveProjects();
  closeProjectModal();
  input.value = '';
  renderProjects();
  showToast('Project added.');
}

function saveCurrentProject() {
  if (!state.selectedProjectId) {
    showToast('Select a project first.');
    return;
  }

  const project = currentProject();
  if (!project) {
    showToast('Project not found.');
    return;
  }

  saveProjects();
  renderProjects();
  showToast('Project saved.');
}

function handleProjectActions(event) {
  const removeButton = event.target.closest('[data-remove-project]');
  if (removeButton) {
    state.projects = state.projects.filter((project) => project.id !== removeButton.dataset.removeProject);
    if (state.selectedProjectId === removeButton.dataset.removeProject) {
      state.selectedProjectId = null;
      state.selectedProjectTab = 'details';
    }
    saveProjects();
    renderProjects();
    showToast('Project removed.');
    return;
  }

  const projectCard = event.target.closest('[data-project-id]');
  if (!projectCard) return;
  state.selectedProjectId = projectCard.dataset.projectId;
  state.selectedProjectTab = 'details';
  renderProjects();
}

function openProjectFromInboxItem(item) {
  if (!item || !item.title) {
    showToast('This item has no title to turn into a project.');
    return;
  }

  const normalizedTitle = String(item.title).trim();
  let project = state.projects.find((entry) => entry.name.toLowerCase() === normalizedTitle.toLowerCase());

  if (!project) {
    project = {
      id: crypto.randomUUID(),
      name: normalizedTitle,
      bookmark: item,
    };
    state.projects.unshift(project);
    saveProjects();
  } else {
    project.bookmark = item;
    saveProjects();
  }

  state.selectedProjectId = project.id;
  state.selectedProjectTab = 'bookmark';
  state.activeView = 'projects';
  setActiveView('projects');
  renderProjects();
  showToast('Opened in project: ' + project.name);
}

function handleInboxClick(event) {
  const note = event.target.closest('.inbox-note');
  if (!note) return;

  try {
    const item = JSON.parse(note.dataset.item || 'null');
    if (!item) return;
    openProjectFromInboxItem(item);
  } catch (_) {
    showToast('Could not open this item.');
  }
}

function handleCreateProjectFromItem() {
  if (!state.selectedItem || !state.selectedItem.title) {
    showToast('Select an item first.');
    return;
  }

  const name = String(state.selectedItem.title).trim();
  if (!name) {
    showToast('Item title is empty.');
    return;
  }

  const exists = state.projects.some((project) => project.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    showToast('Project already exists.');
    closeItemDetail();
    return;
  }

  state.projects.unshift({
    id: crypto.randomUUID(),
    name,
  });
  saveProjects();
  renderProjects();
  showToast('Project created: ' + name);
  closeItemDetail();
}

function wireEvents() {
  document.querySelectorAll('.source-tab').forEach((button) => {
    button.addEventListener('click', async () => {
      const nextSource = button.dataset.source;
      if (!nextSource || nextSource === state.activeSource) {
        return;
      }

      state.activeSource = nextSource;
      renderSourceTabs();
      renderInbox();

      if (!state.profile || !state.token) {
        return;
      }

      try {
        await refreshSourceItems();
        if (!state.sourceError) {
          showToast('Loaded ' + activeSource().label + '.');
        }
      } catch (_) {
        showToast('Source sync failed.');
      }
    });
  });

  document.querySelectorAll('.date-filter-btn').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeDateFilter = button.dataset.filter || 'all';
      renderDateFilters();
      renderInbox();
    });
  });

  const inboxList = byId('inbox-list');
  if (inboxList) {
    inboxList.addEventListener('click', handleInboxClick);
  }

  const detailClose = byId('detail-close');
  if (detailClose) {
    detailClose.addEventListener('click', closeItemDetail);
  }

  const modal = byId('item-detail-modal');
  if (modal) {
    modal.addEventListener('click', (event) => {
      if (event.target && event.target.dataset && event.target.dataset.closeDetail === 'true') {
        closeItemDetail();
      }
    });
  }

  const createProjectFromItem = byId('btn-create-project-from-item');
  if (createProjectFromItem) {
    createProjectFromItem.addEventListener('click', handleCreateProjectFromItem);
  }

  const signInButton = byId('btn-signin');
  if (signInButton) {
    signInButton.addEventListener('click', async () => {
      clearLoginStatus();
      const previous = signInButton.textContent;
      signInButton.disabled = true;
      signInButton.textContent = 'Signing in...';

      try {
        await signIn();
        await refreshSourceItems();
        showToast('Signed in.');
      } catch (error) {
        setLoginStatus(error.message || 'Sign-in failed.', true);
      } finally {
        signInButton.disabled = false;
        signInButton.textContent = previous;
      }
    });
  }

  const signOutButton = byId('btn-signout');
  if (signOutButton) {
    signOutButton.addEventListener('click', () => {
      signOut();
      showToast('Signed out.');
    });
  }

  document.querySelectorAll('.nav-link').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.view === 'projects') {
        state.selectedProjectId = null;
        state.selectedProjectTab = 'details';
        renderProjects();
      }
      setActiveView(button.dataset.view);
    });
  });

  const projectForm = byId('project-form');
  if (projectForm) {
    projectForm.addEventListener('submit', handleProjectSubmit);
  }

  const openProjectModalButton = byId('btn-open-project-modal');
  if (openProjectModalButton) {
    openProjectModalButton.addEventListener('click', openProjectModal);
  }

  const closeProjectModalButton = byId('btn-close-project-modal');
  if (closeProjectModalButton) {
    closeProjectModalButton.addEventListener('click', closeProjectModal);
  }

  const cancelProjectModalButton = byId('btn-cancel-project-modal');
  if (cancelProjectModalButton) {
    cancelProjectModalButton.addEventListener('click', closeProjectModal);
  }

  const projectModal = byId('project-create-modal');
  if (projectModal) {
    projectModal.addEventListener('click', (event) => {
      if (event.target && event.target.dataset && event.target.dataset.closeProjectModal === 'true') {
        closeProjectModal();
      }
    });
  }

  const projectList = byId('project-list');
  if (projectList) {
    projectList.addEventListener('click', handleProjectActions);
  }

  const projectDetail = byId('project-detail');
  if (projectDetail) {
    projectDetail.addEventListener('click', (event) => {
      const tabButton = event.target.closest('[data-project-tab]');
      if (tabButton) {
        state.selectedProjectTab = tabButton.dataset.projectTab;
        renderProjects();
        return;
      }

      const saveButton = event.target.closest('[data-project-save]');
      if (saveButton) {
        saveCurrentProject();
        return;
      }

      const backButton = event.target.closest('[data-project-back]');
      if (backButton) {
        state.selectedProjectId = null;
        state.selectedProjectTab = 'details';
        renderProjects();
      }
    });
  }
}

async function init() {
  wireEvents();
  render();
  await trySilentSignIn();
  if (state.profile && state.token) {
    await refreshSourceItems();
  }
}

init().catch((error) => {
  setLoginStatus(error.message || 'App initialization failed.', true);
});