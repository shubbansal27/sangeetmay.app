<p align="center">
  <img src="apps/sangeetmay/logo1.png" alt="sangeetmay" width="140" />
</p>

<h1 align="center">Sangeetmay</h1>

<p align="center">
  <em>Every Day Begins with Riyaaz.</em><br/>
  A browser-based studio for musicians who learn by watching and doing.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-browser-black?style=flat-square" />
  <img src="https://img.shields.io/badge/storage-Google%20Drive-4285F4?style=flat-square&logo=googledrive&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-gold?style=flat-square" />
</p>

---

## The idea

Every musician knows the loop — play the reference, try it yourself, listen back, fix, repeat.  
sangeetmay puts that whole cycle in one window: a YouTube (or local) reference on the left, your webcam recording on the right, with every take saved and ready to review.

No apps to install. No switching tabs. Just music.

---

## Split-screen studio

| 🎵 Left — Reference | 🎙 Right — My Practice |
|---|---|
| Paste a YouTube URL **or** search YouTube inline | Enable webcam and hit Record |
| Speed control · A-B loop · ±5 s seek | Record takes · play back inline · upload to YouTube |
| Fullscreen overlay | Fullscreen overlay |

---

## Features

- **Split-screen workspace** with a draggable resizer
- **Reference player** — YouTube embed or local video, playback speed ½× – 1½×, A-B loop to drill any phrase
- **YouTube search** — find reference videos without leaving the app
- **Practice recorder** — webcam video, saves takes locally in IndexedDB
- **Projects** — organise by raga, song, or exercise; each project lives in its own Google Drive folder
- **Notes** — rich-text notes per project, saved as `notes.html` in Drive (openable directly in Google Drive)
- **YouTube upload** — share a take to your channel without leaving the app
- **Seamless sign-in** — silent token refresh on page reload; no repeated sign-in popups
- **Fullscreen overlay** — expand any video to near-full-screen with one click

---

## Getting started

No build step. Just serve the `src/` folder over HTTP.

```bash
./start.sh            # http://localhost:9000
./start.sh 3001       # custom port
```

Requires Python 3 (for the local dev server). The app itself is plain HTML + JS — no framework, no bundler.

---

## Google sign-in setup

sangeetmay uses Google OAuth for sign-in, Google Drive for storage, and the YouTube Data API for search and upload.

1. Open [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add `http://localhost:9000` to **Authorised JavaScript origins**
4. Add `http://localhost:9000/auth-callback.html` to **Authorised redirect URIs**
5. Paste your Client ID into `src/yt-config.js`:
   ```js
   window.PM_YT_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
   ```
6. Enable **YouTube Data API v3** and **Google Drive API** in APIs & Services → Library
7. Under **OAuth consent screen → Test users**, add every Google account that should have access

---

## Data storage

| What | Where |
|---|---|
| Recording blobs | Browser IndexedDB (`sangeetmay` database) — stays on device |
| Projects index | `sangeetmay/projects.json` in your Google Drive |
| Per-project data | `sangeetmay/<project-slug>/project.json` in your Google Drive |
| Notes | `sangeetmay/<project-slug>/notes.html` in your Google Drive |

---

## Tech stack

| | |
|---|---|
| Frontend | Vanilla JS + CSS — no framework, no build step |
| Auth | Google OAuth 2.0 implicit flow via popup |
| Storage | Google Drive API (JSON + HTML files) |
| Local recordings | IndexedDB (Blob storage, never leaves device) |
| YouTube | YouTube Data API v3 — search and upload |
| Dev server | `python3 -m http.server` |

---

## License

[MIT](LICENSE) — play freely.
