# Music Practice Studio — Plan

## Goal
A local web app for musicians to study reference videos alongside a self-recording workspace.

## Layout
Split screen: **left = Reference Video** · **right = My Practice**

---

## Left Panel — Reference Video
- Paste any YouTube URL → embedded player loads in-page
- **Play / Pause / ±5 s seek** buttons + Space / ← / → keyboard shortcuts
- **Playback speed**: ½× · ¾× · 1× · 1¼× · 1½×
- **A-B Loop**: set start `[` and end `]` markers, toggle loop on/off with `L`

## Right Panel — My Practice
- **Webcam preview** (mirrored, 16:9) — click "Enable Camera" to activate
- **Record / Stop** controls (keyboard: `R` / `S`)
- **Takes list**: every recording is listed with duration + time;
  each take has Play (inline), Download, and Delete buttons
- **Inline player** appears below the list when you hit Play on a take

## Compare Modal
- Available once you have ≥ 2 takes
- Select Take A and Take B from drop-downs → Compare
- Side-by-side video playback with **Play Both / Pause Both / Reset Both** sync controls

---

## File Structure
```
project-mentor/
  start.sh          ← run this; opens on http://localhost:8080
  docs/
    plan.md         ← this file
  src/
    index.html
    styles.css
    app.js
```

## Running
```bash
./start.sh          # defaults to port 8080
./start.sh 3000     # custom port
```
Then open `http://localhost:8080` in your browser.
**Must be served over HTTP** — the YouTube IFrame API and MediaRecorder both require it.

## Keyboard Shortcuts
| Key | Action |
|-----|--------|
| Space | Play / Pause reference video |
| ← / → | Seek ±5 seconds |
| `[` | Set loop start at current time |
| `]` | Set loop end at current time |
| `L` | Toggle loop on/off |
| `R` | Start recording |
| `S` | Stop recording |
| Esc | Close compare modal |
