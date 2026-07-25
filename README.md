<p align="center">
  <img src="src/logo.png" alt="SaReGaMa" width="140" />
</p>

<h1 align="center">sa · re · ga · ma</h1>

<p align="center">
  <em>Listen. Practice. Record. Repeat.</em><br/>
  A macOS desktop studio for musicians who learn by watching and doing.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS-black?style=flat-square" />
  <img src="https://img.shields.io/badge/python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-gold?style=flat-square" />
</p>

---

## The idea

Every musician knows the loop — play the reference, try it yourself, listen back, fix, repeat.  
SaReGaMa puts that whole cycle in one window: a YouTube (or local) reference on the left, your webcam or screen recording on the right, with every take saved and ready to review.

No browser tabs. No switching apps. Just music.

---

## Split-screen studio

| 🎵 Left — Reference | 🎙 Right — My Practice |
|---|---|
| Paste a YouTube URL **or** load a local video | Enable webcam **or** screen-capture |
| Speed control · A-B loop · ±5 s seek | Record takes · play back inline · download |
| Fullscreen overlay | Fullscreen overlay |

---

## Features

- **Split-screen workspace** with a draggable resizer — set the balance that works for you
- **Reference player** — YouTube embed or local video, playback speed ½× – 1½×, A-B loop to drill any phrase
- **Practice recorder** — webcam or screen-capture, saves to WebM/MP4
- **Projects** — organise by raga, song, or exercise; each project has its own reference videos and takes
- **YouTube upload** — share a take to your channel without leaving the app
- **Persistent sign-in** — Google login is remembered across restarts
- **Fullscreen overlay** — expand any video to near-full-screen with one click
- **Splash screen** — clean loading screen on every launch

---

## Getting started

### Dev mode

Requires Python 3.10+.

```bash
# Install dependencies (first time only)
pip install pywebview

# Start the server
./start.sh            # http://localhost:9000
./start.sh 3001       # custom port
```

### Build the macOS app

```bash
./build.sh
```

Produces **`dist/SaReGaMa.app`** — double-click and play, no Python needed.

**Requirements:** macOS 12+ · Python 3.10+ · `pip install pyinstaller pywebview`

---

## Google sign-in setup

SaReGaMa uses Google OAuth for sign-in and YouTube upload.

1. Open [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add `http://localhost:9000` to **Authorised JavaScript origins**
4. Add `http://localhost:9000/auth/callback` to **Authorised redirect URIs**
5. Paste your Client ID into `src/yt-config.js`:
   ```js
   window.PM_YT_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
   ```
6. Under **OAuth consent screen → Test users**, add every account that should have access

> Users not on the list will see:
> *"Access not granted. Contact shubbansal27@gmail.com for account activation."*

---

## Tech stack

| | |
|---|---|
| Desktop window | [PyWebView](https://pywebview.flowrl.com) — WKWebView on macOS |
| HTTP server | Python stdlib `ThreadingHTTPServer` — zero extra dependencies |
| Database | SQLite via `sqlite3` |
| Frontend | Vanilla JS + CSS — no framework |
| Packaging | [PyInstaller](https://pyinstaller.org) |

---

## Data on disk

| Path | Contents |
|---|---|
| `~/.project-mentor/practice.db` | Projects, recordings, references |
| `~/.project-mentor/projects/` | Your recording files |
| `~/.project-mentor/profile.json` | Persisted sign-in |

---

## License

[MIT](LICENSE) — play freely.
