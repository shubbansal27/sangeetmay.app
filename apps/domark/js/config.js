// Static configuration derived from the global domark-config.js script.

export const GOOGLE_CLIENT_ID = String(window.DOMARK_GOOGLE_CLIENT_ID || '').trim();

export const YOUTUBE_PLAYLIST_TITLE =
  String(window.DOMARK_YOUTUBE_PLAYLIST_TITLE || 'Review Later').trim() || 'Review Later';

export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

export const STORAGE_KEYS = {
  profile: 'domark_google_profile',
  projects: 'domark_projects',
  driveRoot: 'domark_drive_root_id',
  driveProfilesFolder: 'domark_drive_profiles_id',
  driveProfile: 'domark_drive_profile_id',
  driveProjects: 'domark_drive_projects_id',
  activeProfile: 'domark_active_profile',
  profiles: 'domark_profiles',
  announcementsSeen: 'domark_announcements_seen',
  customCategories: 'domark_custom_categories',
  settings: 'domark_settings',
};

export const DRIVE = {
  rootFolder: 'domark',
  defaultProfile: 'default',
  profilesFile: 'profiles.json',
  profilesFolder: 'profiles',
  projectsFolder: 'projects',
  indexFile: 'projects.json',
  projectFile: 'project.json',
  settingsFile: 'settings.json',
};

export const PROJECT_CATEGORIES = ['System design', 'Algorithms', 'AI/ML', 'Music', 'Others'];

export const PROJECT_STATUSES = ['In progress', 'Complete'];

export const SOURCES = [
  {
    id: 'google_tasks',
    label: 'Google Tasks',
    scope: 'https://www.googleapis.com/auth/tasks',
  },
  {
    id: 'youtube_review_later',
    label: 'YouTube',
    scope: 'https://www.googleapis.com/auth/youtube',
  },
];

export const DATE_FILTERS = [
  { id: 'all', label: 'All time' },
  { id: '1d', label: 'Today' },
  { id: '7d', label: 'This week' },
  { id: '30d', label: 'This month' },
  { id: '90d', label: 'Last 3 months' },
];

export const ARTIFACT_TYPES = {
  drawio: { type: 'drawio', provider: 'drawio', label: 'Design board', tab: 'docs', icon: '◨' },
  gdoc: {
    type: 'gdoc',
    provider: 'google_docs',
    label: 'Google Doc',
    tab: 'docs',
    icon: '📄',
    mimeType: 'application/vnd.google-apps.document',
    drivePath: 'document',
  },
  gsheet: {
    type: 'gsheet',
    provider: 'google_sheets',
    label: 'Google Sheet',
    tab: 'docs',
    icon: '📊',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    drivePath: 'spreadsheets',
  },
  gslides: {
    type: 'gslides',
    provider: 'google_slides',
    label: 'Google Slides',
    tab: 'docs',
    icon: '📽',
    mimeType: 'application/vnd.google-apps.presentation',
    drivePath: 'presentation',
  },
  gdrawing: {
    type: 'gdrawing',
    provider: 'google_drawings',
    label: 'Google Drawing',
    tab: 'docs',
    icon: '🖌',
    mimeType: 'application/vnd.google-apps.drawing',
    drivePath: 'drawings',
  },
  recording: {
    type: 'recording',
    provider: 'youtube',
    label: 'Recording',
    tab: 'recordings',
    icon: '🎥',
  },
  link: {
    type: 'link',
    provider: 'web',
    label: 'Link',
    tab: 'links',
    icon: '🔗',
  },
};

export function isConfigured() {
  return GOOGLE_CLIENT_ID !== '';
}
