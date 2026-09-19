// Google Calendar integration for Timebox: create, list and delete calendar events tagged as domark timeboxes.

import { state } from './store.js';
import { getActiveProfile } from './profiles.js';

const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function authHeaders(extra = {}) {
  return { Authorization: 'Bearer ' + state.token, ...extra };
}

function scopeError(status) {
  if (status === 401 || status === 403) {
    return new Error('Calendar access is not granted yet. Sign out and sign in again to allow Calendar.');
  }
  return null;
}

// start/end are ISO date-time strings (UTC). Events are tagged so we can list only our timeboxes, per profile.
export async function createTimebox({ title, description, start, end }) {
  if (!state.token) throw new Error('Please sign in to schedule a timebox.');
  const body = {
    summary: title,
    description: description || '',
    start: { dateTime: start },
    end: { dateTime: end },
    extendedProperties: { private: { domarkTimebox: '1', domarkProfile: getActiveProfile() } },
    reminders: { useDefault: true },
  };
  const response = await fetch(CALENDAR_EVENTS, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw scopeError(response.status) || new Error('Could not create the calendar event.');
  }
  return response.json();
}

export async function listTimeboxes() {
  if (!state.token) return [];
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: new Date().toISOString(),
    maxResults: '30',
    privateExtendedProperty: 'domarkTimebox=1',
  });
  params.append('privateExtendedProperty', 'domarkProfile=' + getActiveProfile());
  const response = await fetch(CALENDAR_EVENTS + '?' + params.toString(), { headers: authHeaders() });
  if (!response.ok) {
    throw scopeError(response.status) || new Error('Could not load your timeboxes.');
  }
  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

export async function deleteTimebox(eventId) {
  if (!state.token || !eventId) return;
  const response = await fetch(CALENDAR_EVENTS + '/' + encodeURIComponent(eventId), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  // 410 = already deleted; treat as success.
  if (!response.ok && response.status !== 410) {
    throw scopeError(response.status) || new Error('Could not cancel this timebox.');
  }
}
