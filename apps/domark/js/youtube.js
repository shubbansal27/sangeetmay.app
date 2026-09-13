// YouTube integration: lazy upload-scope token plus resumable video upload.

import { YOUTUBE_UPLOAD_SCOPE } from './config.js';
import { openAuthPopup } from './auth.js';
import { state } from './store.js';

const YT_TOKEN_KEY = 'domark_yt_token';

let uploadToken = null;
try {
  uploadToken = sessionStorage.getItem(YT_TOKEN_KEY) || null;
} catch {
  /* sessionStorage unavailable */
}

async function acquireToken() {
  const hint = state.profile && state.profile.email;
  try {
    return await openAuthPopup(YOUTUBE_UPLOAD_SCOPE, 'yt_upload_silent', {
      prompt: 'none',
      ...(hint ? { login_hint: hint } : {}),
    });
  } catch {
    return await openAuthPopup(YOUTUBE_UPLOAD_SCOPE, 'yt_upload');
  }
}

async function ensureToken() {
  if (uploadToken) return uploadToken;
  uploadToken = await acquireToken();
  try {
    sessionStorage.setItem(YT_TOKEN_KEY, uploadToken);
  } catch {
    /* ignore */
  }
  return uploadToken;
}

function clearToken() {
  uploadToken = null;
  try {
    sessionStorage.removeItem(YT_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export async function uploadVideo(blob, meta = {}, onProgress = () => {}) {
  const token = await ensureToken();
  const metadata = {
    snippet: {
      title: String(meta.title || 'Recording').trim().slice(0, 100) || 'Recording',
      description: String(meta.description || '').trim().slice(0, 5000),
      categoryId: '22',
    },
    status: { privacyStatus: meta.privacyStatus || 'unlisted' },
  };

  onProgress({ pct: 0 });

  const initResp = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    }
  );
  if (initResp.status === 401) {
    clearToken();
    throw new Error('YouTube session expired — please try again.');
  }
  if (!initResp.ok) {
    let message = 'YouTube API error (' + initResp.status + ').';
    try {
      const data = await initResp.json();
      message = data?.error?.message || message;
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }

  const uploadUri = initResp.headers.get('Location');
  if (!uploadUri) throw new Error('YouTube did not return an upload URL.');

  const mimeType = (blob.type || 'video/webm').split(';')[0];
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUri);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress({ pct: Math.round((event.loaded / event.total) * 100) });
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const videoId = JSON.parse(xhr.responseText).id;
          resolve({ videoId, url: 'https://www.youtube.com/watch?v=' + videoId });
        } catch {
          reject(new Error('Unexpected response from YouTube.'));
        }
      } else {
        reject(new Error('Upload failed (HTTP ' + xhr.status + ').'));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    xhr.send(blob);
  });
}
