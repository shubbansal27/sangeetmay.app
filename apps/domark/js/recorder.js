// Video recording modal: capture webcam + mic, then upload to YouTube.

import { byId } from './utils.js';
import { uploadVideo } from './youtube.js';

let stream = null;
let recorder = null;
let chunks = [];
let recordMime = '';
let recordedBlob = null;
let recordedUrl = null;
let startedAt = 0;
let timerId = null;
let resolver = null;
let captureMode = 'camera';

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins + ':' + String(secs).padStart(2, '0');
}

function setStatus(message) {
  const el = byId('rec-status');
  if (el) el.textContent = message || '';
}

function revokeRecordedUrl() {
  if (recordedUrl) {
    URL.revokeObjectURL(recordedUrl);
    recordedUrl = null;
  }
}

// Show the live camera feed (mirrored, muted, no controls) ready for recording.
function showLivePreview() {
  const video = byId('rec-preview');
  if (!video) return;
  revokeRecordedUrl();
  video.pause?.();
  video.removeAttribute('src');
  video.load?.();
  video.controls = false;
  video.muted = true;
  video.classList.remove('is-playback');
  video.classList.toggle('is-screen', captureMode === 'screen');
  video.srcObject = stream;
  video.play?.().catch(() => {});
}

// Swap to the recorded clip so the user can review it before uploading.
function showPlayback() {
  const video = byId('rec-preview');
  if (!video || !recordedBlob) return;
  revokeRecordedUrl();
  recordedUrl = URL.createObjectURL(recordedBlob);
  video.srcObject = null;
  video.src = recordedUrl;
  video.controls = true;
  video.muted = false;
  video.classList.add('is-playback');
  video.load?.();
}

function stopStream() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  const video = byId('rec-preview');
  if (video) video.srcObject = null;
}

function startTimer() {
  startedAt = Date.now();
  const label = byId('rec-timer');
  timerId = window.setInterval(() => {
    if (label) label.textContent = formatDuration((Date.now() - startedAt) / 1000);
  }, 250);
}

function stopTimer() {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function resetUi() {
  chunks = [];
  recordedBlob = null;
  revokeRecordedUrl();
  const timer = byId('rec-timer');
  if (timer) timer.textContent = '0:00';
  const startButton = byId('btn-rec-start');
  if (startButton) {
    startButton.disabled = true;
    startButton.textContent = '● Record';
  }
  byId('btn-rec-stop') && (byId('btn-rec-stop').disabled = true);
  byId('btn-rec-upload') && (byId('btn-rec-upload').disabled = true);
  byId('rec-progress-wrap')?.classList.add('hidden');
  const fill = byId('rec-progress-fill');
  if (fill) fill.style.width = '0%';
  byId('rec-indicator')?.classList.remove('is-live');
}

async function enableSource() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Recording is not available in this browser or context.');
    return;
  }
  try {
    if (captureMode === 'screen') {
      if (!navigator.mediaDevices.getDisplayMedia) {
        setStatus('Screen capture is not supported in this browser.');
        return;
      }
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const tracks = [...display.getVideoTracks()];
      // Add microphone narration alongside the screen when available.
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        tracks.push(...mic.getAudioTracks());
      } catch {
        /* no mic access — record screen video only */
      }
      stream = new MediaStream(tracks);
      // Auto-stop if the user ends sharing from the browser chrome.
      display.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (recorder && recorder.state === 'recording') stopRecording();
      });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
    const video = byId('rec-preview');
    if (video) {
      video.srcObject = stream;
      video.muted = true;
      video.classList.remove('is-playback');
      video.classList.toggle('is-screen', captureMode === 'screen');
      await video.play?.().catch(() => {});
    }
    const startButton = byId('btn-rec-start');
    if (startButton) startButton.disabled = false;
    setStatus(captureMode === 'screen'
      ? 'Screen shared. Press Record to start.'
      : 'Camera ready. Press Record to start.');
  } catch (error) {
    setStatus('Could not start capture: ' + (error.message || error));
  }
}

function updateModeButtons() {
  byId('btn-rec-mode-camera')?.classList.toggle('is-active', captureMode === 'camera');
  byId('btn-rec-mode-screen')?.classList.toggle('is-active', captureMode === 'screen');
}

async function setMode(mode) {
  if (mode !== 'camera' && mode !== 'screen') return;
  if (mode === captureMode && stream) return;
  captureMode = mode;
  updateModeButtons();
  stopStream();
  resetUi();
  setStatus(mode === 'screen' ? 'Choose a screen or window to share.' : 'Enable your camera to begin.');
  await enableSource();
}

function startRecording() {
  if (!stream) return;
  showLivePreview();
  recordMime = pickMimeType();
  chunks = [];
  recordedBlob = null;
  recorder = new MediaRecorder(stream, recordMime ? { mimeType: recordMime } : {});
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    recordedBlob = new Blob(chunks, { type: recordMime || 'video/webm' });
    showPlayback();
    const uploadButton = byId('btn-rec-upload');
    if (uploadButton) uploadButton.disabled = false;
    const startButton = byId('btn-rec-start');
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = '↺ Re-record';
    }
    setStatus('Review the take below, then upload to YouTube — or re-record.');
  };
  recorder.start();
  byId('btn-rec-start').disabled = true;
  byId('btn-rec-stop').disabled = false;
  byId('btn-rec-upload').disabled = true;
  byId('rec-indicator')?.classList.add('is-live');
  setStatus('Recording…');
  startTimer();
}

function stopRecording() {
  if (recorder && recorder.state === 'recording') recorder.stop();
  recorder = null;
  byId('btn-rec-stop').disabled = true;
  byId('rec-indicator')?.classList.remove('is-live');
  stopTimer();
}

async function uploadRecording() {
  if (!recordedBlob) return;
  const title = (byId('rec-title')?.value || '').trim() || 'Recording ' + new Date().toLocaleString();
  const privacyStatus = document.querySelector('input[name="rec-privacy"]:checked')?.value || 'unlisted';

  byId('btn-rec-upload').disabled = true;
  byId('btn-rec-start').disabled = true;
  byId('rec-progress-wrap')?.classList.remove('hidden');
  setStatus('Uploading to YouTube…');

  try {
    const result = await uploadVideo(recordedBlob, { title, privacyStatus }, ({ pct }) => {
      const fill = byId('rec-progress-fill');
      if (fill) fill.style.width = pct + '%';
      setStatus('Uploading to YouTube… ' + pct + '%');
    });
    setStatus('Uploaded!');
    finish({ ...result, title });
  } catch (error) {
    setStatus(error.message || 'Upload failed.');
    const uploadButton = byId('btn-rec-upload');
    if (uploadButton) uploadButton.disabled = false;
  }
}

function finish(value) {
  const settle = resolver;
  resolver = null;
  stopTimer();
  if (recorder && recorder.state === 'recording') {
    try {
      recorder.stop();
    } catch {
      /* ignore */
    }
  }
  recorder = null;
  stopStream();
  revokeRecordedUrl();
  const video = byId('rec-preview');
  if (video) {
    video.pause?.();
    video.removeAttribute('src');
    video.controls = false;
    video.classList.remove('is-playback');
    video.load?.();
  }
  const modal = byId('recorder-modal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (settle) settle(value);
}

export function closeRecorder() {
  finish(null);
}

export function openRecorder() {
  const modal = byId('recorder-modal');
  if (!modal) return Promise.resolve(null);
  captureMode = 'camera';
  updateModeButtons();
  resetUi();
  const title = byId('rec-title');
  if (title) title.value = '';
  setStatus('Enable your camera to begin.');
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  enableSource();
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

export function isRecorderOpen() {
  return byId('recorder-modal')?.classList.contains('is-open') === true;
}

export function wireRecorder() {
  byId('btn-rec-mode-camera')?.addEventListener('click', () => setMode('camera'));
  byId('btn-rec-mode-screen')?.addEventListener('click', () => setMode('screen'));
  byId('btn-rec-start')?.addEventListener('click', startRecording);
  byId('btn-rec-stop')?.addEventListener('click', stopRecording);
  byId('btn-rec-upload')?.addEventListener('click', uploadRecording);
  byId('btn-rec-close')?.addEventListener('click', closeRecorder);
  byId('btn-rec-cancel')?.addEventListener('click', closeRecorder);
  byId('recorder-modal')?.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') closeRecorder();
  });
}
