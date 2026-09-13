// Google OAuth (implicit flow via popup) and session lifecycle.

import { GOOGLE_CLIENT_ID, SOURCES, isConfigured } from './config.js';
import { state, saveProfile, clearProfile } from './store.js';

function callbackUrl() {
  return new URL('auth-callback.html', window.location.href).href;
}

export function authScope() {
  const sourceScopes = SOURCES.map((source) => source.scope).filter(Boolean);
  return ['openid', 'profile', 'email', 'https://www.googleapis.com/auth/drive', ...sourceScopes].join(' ');
}

export function openAuthPopup(scope, stateValue, extraParams = {}) {
  if (!isConfigured()) {
    throw new Error('Google client ID is not configured in domark-config.js.');
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(),
    response_type: 'token',
    scope,
    state: stateValue,
    prompt: 'select_account',
    ...extraParams,
  });

  const popup = window.open(
    'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(),
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
      } catch {
        /* popup already closed */
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

export async function signIn(options = {}) {
  const token = await openAuthPopup(authScope(), options.state || 'signin', options.extraParams || {});
  const profile = await fetchProfile(token);
  state.token = token;
  state.profile = profile;
  saveProfile(profile);
  return profile;
}

export function signOut() {
  state.token = null;
  state.profile = null;
  Object.values(state.sources).forEach((slice) => {
    slice.items = [];
    slice.status = 'idle';
    slice.error = '';
    slice.fetchedAt = null;
  });
  clearProfile();
}

export async function trySilentSignIn() {
  const profile = state.profile;
  if (!profile || !profile.email) return;
  try {
    state.token = await openAuthPopup(authScope(), 'silent', {
      prompt: 'none',
      login_hint: profile.email,
    });
  } catch {
    state.token = null;
  }
}
