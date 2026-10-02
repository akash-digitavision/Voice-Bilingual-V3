/**
 * Popup Controller & State Machine (Phase 4, 5, 8, 9, 10)
 */

import { SpeechService } from './modules/speech.js';
import { LocalSTTEngine, STT_STAGE, classifyLocalSttError } from './modules/local-stt-engine.js';
import { isVoiceInputConfigured, providerName } from './modules/voice-input.js';
import { normalizeTranscript } from './modules/normalizer.js';
import { generateBilingualOutput } from './modules/ai-providers.js';
import { copyToClipboard } from './modules/clipboard.js';
import { getSettings, saveSettings, getEffectiveProvider } from './modules/storage.js';

// Timestamp of popup document start — used to log the popup-open → recognition.start()
// delay (§ Web Speech diagnostics: "time between popup opening and start()").
const POPUP_OPENED_AT = performance.now();

// FIXED MAXIMUM POPUP SIZE (§ layout fix): the complete UI fits in 320 × 430.
// Windows may be smaller (collapsed transcript / user-resized detached window) but
// never larger — enforced in-page for detached windows and at creation in background.
const MAX_POPUP_WIDTH = 320;
const MAX_POPUP_HEIGHT = 380;
const MAX_COLLAPSED_HEIGHT = 340;

function enforceMaxWindowSize() {
  if (typeof window.resizeTo !== 'function') return;
  const w = window.outerWidth;
  const h = window.outerHeight;
  if (w > MAX_POPUP_WIDTH || h > MAX_POPUP_HEIGHT) {
    try {
      window.resizeTo(Math.min(w, MAX_POPUP_WIDTH), Math.min(h, MAX_POPUP_HEIGHT));
    } catch (e) { /* some contexts forbid programmatic resize */ }
  }
}

/**
 * § COLLAPSE/EXPAND HEIGHT FIX (attached bubble): pin the popup body to the measured
 * content height so the bubble shrinks/grows with collapse/expand instead of leaving
 * a blank area below the footer. Clamped to the fixed maximum.
 */
function pinAttachedBubbleHeight() {
  if (typeof isDetached !== 'undefined' && isDetached) return;
  requestAnimationFrame(() => {
    const target = Math.min(document.body.scrollHeight, MAX_POPUP_HEIGHT);
    document.body.style.height = `${target}px`;
  });
}

// DOM Elements
const stageVoice = document.getElementById('stage-voice');
const stageLoading = document.getElementById('stage-loading');
const stageResult = document.getElementById('stage-result');
const stageError = document.getElementById('stage-error');

const btnMic = document.getElementById('btn-mic');
const micPulseRing = document.getElementById('mic-pulse-ring');
const recordingTimer = document.getElementById('recording-timer');
const statusLabel = document.getElementById('status-label');
const transcriptPreview = document.getElementById('transcript-preview');
const transcriptBox = document.getElementById('transcript-box');
const btnExpandTranscript = document.getElementById('btn-expand-transcript');
const expandIconSvg = document.getElementById('expand-icon-svg');
const popoutLabel = document.getElementById('popout-label');
const btnStop = document.getElementById('btn-stop');
const btnCopyOriginal = document.getElementById('btn-copy-original');
const btnCopyHeader = document.getElementById('btn-copy-header');
const copyHeaderText = document.getElementById('copy-header-text');
const btnRefine = document.getElementById('btn-refine');
const btnCancel = document.getElementById('btn-cancel');

const langBn = document.getElementById('lang-bn');
const langEn = document.getElementById('lang-en');

/**
 * § CLEANUP: the Bangla/English/Timer row was removed from the UI. The language
 * radios may therefore be absent — fall back to the prior default (Bangla) so
 * recognition behavior stays consistent without the removed controls.
 */
function selectedPopupLanguage() {
  if (langBn && langBn.checked) return 'bn-BD';
  if (langEn && langEn.checked) return 'en-US';
  return 'bn-BD';
}

const outputBn = document.getElementById('output-bn');
const outputEn = document.getElementById('output-en');
const btnCopyBn = document.getElementById('btn-copy-bn');
const btnCopyEn = document.getElementById('btn-copy-en');
// § RESULT EXPAND: per-field expand/collapse controls for the refined outputs.
const btnExpandBn = document.getElementById('btn-expand-bn');
const btnExpandEn = document.getElementById('btn-expand-en');
const expandBnSvg = document.getElementById('expand-bn-svg');
const expandEnSvg = document.getElementById('expand-en-svg');
const btnCopyBoth = document.getElementById('btn-copy-both');
const btnRecordAgain = document.getElementById('btn-record-again');

const btnSettings = document.getElementById('btn-settings');
const popupApiName = document.getElementById('popup-api-name');
const btnPopout = document.getElementById('btn-popout');

const errorTitle = document.getElementById('error-title');
const errorDesc = document.getElementById('error-desc');
const btnErrorRetry = document.getElementById('btn-error-retry');
const btnErrorSettings = document.getElementById('btn-error-settings');
const btnSwitchCloudStt = document.getElementById('btn-switch-cloud-stt');
const btnSwitchLocalStt = document.getElementById('btn-switch-local-stt');

// State variables
let currentState = 'IDLE'; // 'IDLE' | 'RECORDING' | 'GENERATING' | 'RESULT' | 'ERROR'
let speech = null;
// (Recording lives in the persistent offscreen document — see offscreen-recorder.js.)
let isUsingLocalSTT = false; // Default to Cloud Web Speech API for guaranteed instant functionality
let whisperAudioDetected = false; // §9: last known mic level state (offscreen broadcast)
let localSttStage = STT_STAGE.IDLE; // Explicit local-Whisper lifecycle stage (100% download != ready)
let timerInterval = null;
let recordingStartTime = null;
let currentTranscript = '';
let settings = null;
const sttPrivacyBadge = document.getElementById('stt-privacy-badge');
const voiceStackBadge = document.getElementById('voice-stack-badge');
const voiceStackName = document.getElementById('voice-stack-name');

function setStage(stage) {
  stageVoice.classList.remove('active');
  stageLoading.classList.remove('active');
  stageResult.classList.remove('active');
  stageError.classList.remove('active');

  if (stage === 'voice') stageVoice.classList.add('active');
  if (stage === 'loading') stageLoading.classList.add('active');
  if (stage === 'result') stageResult.classList.add('active');
  if (stage === 'error') stageError.classList.add('active');

  // § COLLAPSE/EXPAND HEIGHT FIX: re-pin the attached bubble height whenever the
  // visible stage changes, so the popup always matches its rendered content.
  if (typeof pinAttachedBubbleHeight === 'function') pinAttachedBubbleHeight();
}

function updateTimer() {
  if (!recordingStartTime) return;
  if (!recordingTimer) return; // § cleanup: timer display removed from the UI
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const secs = String(elapsed % 60).padStart(2, '0');
  recordingTimer.textContent = `${mins}:${secs}`;
}

function startTimer() {
  recordingStartTime = Date.now();
  updateTimer();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 500);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function updatePrivacyBadge(device = 'WebGPU') {
  if (!isUsingLocalSTT) {
    if (sttPrivacyBadge) {
      // UI cleanup: the Running API row no longer displays the "Cloud Web Speech"
      // text. The badge is hidden in cloud mode (nothing to show there) and stays
      // visible for Local Whisper, where the privacy note matters.
      sttPrivacyBadge.textContent = '';
      sttPrivacyBadge.style.display = 'none';
    }
    if (voiceStackName) {
      voiceStackName.textContent = 'Web Speech (Cloud)';
    }
    if (voiceStackBadge) {
      voiceStackBadge.className = 'voice-stack-pill';
      voiceStackBadge.title = 'Current voice recognition engine: Cloud Web Speech API (Instant real-time words)';
    }
  } else {
    if (sttPrivacyBadge) {
      sttPrivacyBadge.style.display = '';
      sttPrivacyBadge.textContent = `● Local (${device})`;
      sttPrivacyBadge.style.color = '#059669';
      sttPrivacyBadge.style.background = 'rgba(16, 185, 129, 0.15)';
      sttPrivacyBadge.title = `Privacy-First: On-device Multilingual Whisper (${device}). Zero audio sent externally.`;
    }
    if (voiceStackName) {
      const isGpu = device.toLowerCase().includes('webgpu') || device.toLowerCase().includes('gpu');
      voiceStackName.textContent = isGpu ? `Whisper (${device})` : `Whisper (CPU Fallback)`;
    }
    if (voiceStackBadge) {
      const isGpu = device.toLowerCase().includes('webgpu') || device.toLowerCase().includes('gpu');
      voiceStackBadge.className = isGpu ? 'voice-stack-pill local-webgpu' : 'voice-stack-pill local-cpu';
      voiceStackBadge.title = `Current voice recognition engine: On-Device Whisper Model (${device})`;
    }
  }
}

function initSpeech() {
  const selectedLang = selectedPopupLanguage();

  // Never orphan a previous recognition instance: abort it before replacing it, so a
  // stale browser-side speech session cannot collide with the fresh popup's session
  // (the classic freshly-reopened-popup start failure in Chromium forks).
  if (speech) {
    try { speech.abort(); } catch (e) { /* ignore */ }
    speech = null;
  }
  console.log('[Popup] creating Web Speech session', {
    language: selectedLang,
    msSincePopupOpen: Math.round(performance.now() - POPUP_OPENED_AT)
  });

  speech = new SpeechService({
    language: selectedLang,
    continuous: true,
    interimResults: true,
    onStart: () => {
      currentState = 'RECORDING';
      btnMic.classList.add('recording');
      micPulseRing.classList.add('recording');
      if (statusLabel) statusLabel.textContent = '';
      btnStop.disabled = false;
      btnStop.classList.add('recording');
      btnRefine.disabled = true;
      btnCopyOriginal.disabled = true;
      btnCopyHeader.disabled = true;
      startTimer();
    },
    onResult: (result) => {
      currentTranscript = result.full;
      if (currentTranscript.trim()) {
        transcriptPreview.classList.remove('empty');
        transcriptPreview.textContent = currentTranscript;
        btnCopyOriginal.disabled = false;
        btnCopyHeader.disabled = false;
        btnRefine.disabled = false;
      }
    },
    onError: (err) => {
      console.warn('Speech error:', err);
      stopTimer();
      currentState = 'ERROR';
      btnMic.classList.remove('recording');
      micPulseRing.classList.remove('recording');
      btnStop.classList.remove('recording');

      if (!currentTranscript.trim()) {
        let showLocalSwitch = false;
        let message = err.message;

        if (err.code === 'network' && err.transient === false) {
          // Definitive diagnosis: the browser's speech service is unreachable even
          // after all retries. Shift and other Chromium forks without Google's
          // speech backend can NEVER do cloud recognition — offer the on-device path.
          // §22: remember the lack of support so Auto mode skips Browser Speech.
          message = 'The browser speech service is unreachable (network error after all attempts). ' +
            'Shift Browser and other Chromium forks ship without Google\'s speech service, so cloud ' +
            'voice recognition cannot work in them — Google Chrome can, because it ships with it. ' +
            'Switch to Local (Whisper): it runs entirely on this device, needs no speech service ' +
            'and no internet, and supports Bangla/English.';
          showLocalSwitch = true;
          try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({ browserSpeechUnavailable: true });
              if (settings) settings.browserSpeechUnavailable = true;
            }
          } catch (e) { /* ignore */ }
        } else if (err.transient === false || ['service-not-allowed', 'audio-capture', 'not-allowed'].includes(err.code)) {
          message += '\n\nIf this browser does not provide a speech service (Shift and some Chromium forks do not), ' +
            'open Settings → "🎤 Test Microphone (audio chain)": if the mic test passes, the problem is the speech ' +
            'service — switch Speech Recognition Engine to "Local (Whisper)", which works without it.';
        }

        showError('Microphone / Recognition Notice', message, false, showLocalSwitch);
        // §3: concise diagnostic so the real error category is visible in the UI.
        if (err.diagnostic && errorDesc) {
          const d = err.diagnostic;
          errorDesc.textContent += `\n\n[Diagnostic] error: ${d.error} · visibility: ${d.visibility} · focus: ${d.hasFocus} · at: ${d.timestamp}`;
        }
      }
    },
    onEnd: () => {
      btnMic.classList.remove('recording');
      micPulseRing.classList.remove('recording');
      btnStop.classList.remove('recording');
      btnStop.disabled = true;
      stopTimer();

      if (currentState === 'RECORDING') {
        currentState = 'IDLE';
        if (statusLabel) statusLabel.textContent = '';
      }
    }
  });
}

/**
 * Reflects the local-Whisper lifecycle stage in the popup so that a 100% download
 * never looks like a frozen UI: download -> cache verify -> pipeline init -> ready.
 */
function applyLocalSttStage(st) {
  if (!st || !st.stage) return;
  localSttStage = st.stage;
  if (st.device) updatePrivacyBadge(st.device);

  // While the user is recording, pipeline warm-up messages must not overwrite the
  // "Listening..." prompt (initialization now runs in parallel with capture).
  if (currentState === 'RECORDING') return;

  if (st.stage === STT_STAGE.READY) {
    if (statusLabel) statusLabel.textContent = '';
    return;
  }

  if (st.stage === STT_STAGE.DOWNLOADING) {
    // Per-file percentage already shown elsewhere; avoid noise on the status line.
    return;
  }

  if (statusLabel) statusLabel.textContent = st.message || 'Preparing on-device Whisper...';
  if (transcriptPreview && (st.stage === STT_STAGE.DOWNLOAD_COMPLETE ||
      st.stage === STT_STAGE.INITIALIZING_BACKEND ||
      st.stage === STT_STAGE.INITIALIZING_MODEL)) {
    transcriptPreview.classList.remove('empty');
    transcriptPreview.textContent = st.message || 'Initializing on-device Whisper...';
  }
}

/**
 * Sends a recorder command to the persistent offscreen document (via the service
 * worker). Recording must NOT live in the popup: MV3 popups are destroyed on blur,
 * which previously killed the AudioContext and every captured audio chunk.
 */
function whisperCommand(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'WHISPER_CMD', ...payload }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, message: err.message || 'Extension messaging failed.' });
        } else {
          resolve(resp || { ok: false, message: 'Recorder did not respond.' });
        }
      });
    } catch (e) {
      resolve({ ok: false, message: (e && e.message) || 'Extension messaging unavailable.' });
    }
  });
}

async function startRecording() {
  // Capability-driven provider selection (§4). Modes:
  //   'auto'  — Browser Speech, unless it was detected as unavailable (Shift),
  //             then Local Whisper automatically (§22: no repeated attempts).
  //   'cloud' — Browser Speech always.
  //   'local' — Local Whisper always.
  //   ('voiceapi' becomes selectable once the on-device Whisper benchmark on the
  //    target machine justifies an external provider — §26 order.)
  const mode = settings?.speechEngine || 'cloud';
  if (mode === 'auto') {
    isUsingLocalSTT = Boolean(settings?.browserSpeechUnavailable);
  } else {
    isUsingLocalSTT = (mode === 'local');
  }
  const useVoiceApi = (mode === 'voiceapi');

  if (useVoiceApi) {
    const vi = settings?.voiceInput || {};
    if (!isVoiceInputConfigured(vi)) {
      showError(
        'Voice API Not Configured',
        'Voice API transcription needs a provider and key in Settings → Voice Input ' +
        '(OpenAI, Google Cloud Speech-to-Text, Deepgram, AssemblyAI, or a Custom endpoint). ' +
        'Until then, use Browser Speech or Local Whisper.'
      );
      return;
    }
    try {
      const resp = await whisperCommand({
        action: 'RECORD_START',
        engine: 'voiceapi',
        language: settings?.voiceInput?.language || 'auto',
        voice: vi
      });
      if (!resp.ok) throw new Error(resp.message || 'Voice API recorder failed to start.');
      currentState = 'RECORDING';
      btnMic.classList.add('recording');
      micPulseRing.classList.add('recording');
      btnStop.disabled = false;
      btnStop.classList.add('recording');
      btnRefine.disabled = true;
      btnCopyOriginal.disabled = true;
      btnCopyHeader.disabled = true;
      currentTranscript = '';
      transcriptPreview.classList.add('empty');
      transcriptPreview.textContent =
        `Recording — Voice API (${providerName(vi.provider)}, batch). Press Stop to transcribe.`;
      startTimer();
      return;
    } catch (err) {
      console.warn('[Voice API] recording start failed:', err);
      showError('Voice API Error', (err && err.message) || 'Voice API recording failed to start.');
      return;
    }
  }

  if (isUsingLocalSTT) {
    try {
      const resp = await whisperCommand({
        action: 'RECORD_START',
        language: selectedPopupLanguage() === 'en-US' ? 'en' : 'bn',
        modelId: settings?.localModel || 'onnx-community/whisper-base',
        devicePreference: settings?.accelerationPreference || 'auto'
      });
      if (!resp.ok) {
        const micDenied = /permission|not allowed|denied|dismissed/i.test(resp.message || '') ||
          resp.code === 'MIC_ERROR';
        const message = micDenied
          ? 'Microphone access was denied for the extension. Open the extension details in chrome://extensions, allow Microphone, or rerun the mic setup page, then try again.'
          : (resp.message || 'Could not start on-device recording.');
        console.warn('[Whisper] RECORD_START failed:', resp);
        showError('Microphone / Recorder Error', message, false);
        return;
      }

      currentState = 'RECORDING';
      btnMic.classList.add('recording');
      micPulseRing.classList.add('recording');
      btnStop.disabled = false;
      btnStop.classList.add('recording');
      btnRefine.disabled = true;
      btnCopyOriginal.disabled = true;
      btnCopyHeader.disabled = true;
      currentTranscript = '';
      transcriptPreview.classList.add('empty');
      transcriptPreview.textContent = 'Listening on-device... Speak naturally. (Recording continues even if this window closes.)';
      startTimer();
      return;
    } catch (err) {
      console.warn('[Whisper] Local recording start failed, falling back to Web Speech API:', err);
      isUsingLocalSTT = false;
      localSttStage = STT_STAGE.IDLE;
      updatePrivacyBadge('Cloud Web Speech');
    }
  }

  // Cloud / Web Speech path (instant live words)
  if (speech && speech.isRecording) return;
  initSpeech();
  currentTranscript = '';
  transcriptPreview.classList.add('empty');
  transcriptPreview.textContent = '';
  btnCopyOriginal.disabled = true;
  btnCopyHeader.disabled = true;
  btnRefine.disabled = true;
  speech.start();
}

async function stopRecording() {
  stopTimer();
  currentState = 'IDLE';
  btnMic.classList.remove('recording');
  micPulseRing.classList.remove('recording');
  btnStop.classList.remove('recording');
  btnStop.disabled = true;

  if (settings?.speechEngine === 'voiceapi') {
    transcriptPreview.classList.remove('empty');
    transcriptPreview.textContent = 'Transcribing with Voice API (batch)...';
    try {
      const resp = await whisperCommand({ action: 'RECORD_STOP' });
      if (!resp.ok) throw new Error(resp.message || 'Voice API transcription failed.');
      const result = resp.result || {};
      currentTranscript = result.transcript || '';
      // §18: visible provider — Voice API means audio left the device.
      if (sttPrivacyBadge) {
        sttPrivacyBadge.textContent = `● Voice API (${result.provider || 'unknown'})`;
        sttPrivacyBadge.style.color = '#a78bfa';
        sttPrivacyBadge.style.background = 'rgba(167, 139, 250, 0.15)';
        sttPrivacyBadge.title = 'Transcribed via an external Voice API. Audio was uploaded to the configured provider.';
      }
      if (voiceStackName) voiceStackName.textContent = `Voice API (${result.provider || 'unknown'})`;
      const dur = result.inferenceDurationMs ? `${(result.inferenceDurationMs / 1000).toFixed(1)}s transcription` : '';
      if (currentTranscript.trim()) {
        transcriptPreview.textContent = currentTranscript;
        if (statusLabel) statusLabel.textContent = `Listening was — Voice API · ${dur}`;
        btnCopyOriginal.disabled = false;
        btnCopyHeader.disabled = false;
        btnRefine.disabled = false;
      } else {
        transcriptPreview.classList.add('empty');
        transcriptPreview.textContent = 'Voice API returned an empty transcript.';
      }
    } catch (e) {
      console.error('[Voice API] transcription failed:', e);
      showError('Voice API Transcription Failed', (e && e.message) || 'Voice API transcription failed.');
    }
    return;
  }

  if (isUsingLocalSTT) {
    transcriptPreview.classList.remove('empty');
    transcriptPreview.textContent = 'Transcribing on-device with Whisper...';
    try {
      const selectedLang = selectedPopupLanguage() === 'en-US' ? 'en' : 'bn';
      const resp = await whisperCommand({ action: 'RECORD_STOP', language: selectedLang });

      if (!resp.ok) {
        throw Object.assign(new Error(resp.message || 'On-device transcription failed.'), {
          stage: resp.stage || null,
          attempts: resp.attempts || null
        });
      }

      const result = resp.result || {};
      currentTranscript = result.transcript || '';
      updatePrivacyBadge(result.device);

      const stats = resp.stats;
      const m = result.metrics || {};
      const metricBits = [];
      if (m.avgChunkLatencyMs != null) metricBits.push(`chunk ${m.avgChunkLatencyMs}ms`);
      if (m.finalizationMs != null) metricBits.push(`finalize ${m.finalizationMs}ms`);
      if (m.avgRtf != null) metricBits.push(`RTF ${m.avgRtf}`);
      const statsLine =
        (stats && stats.durationSec ? `🎙 ${stats.durationSec}s audio (peak ${stats.peakAmplitude})` : '') +
        (result.incremental ? ' · incremental' : '') +
        ` · ${result.device}` +
        (result.inferenceDuration ? ` · ${result.inferenceDuration}s finalize` : '') +
        (metricBits.length ? ` · ${metricBits.join(' · ')}` : '');

      if (currentTranscript.trim()) {
        transcriptPreview.textContent = currentTranscript;
        if (statusLabel) statusLabel.textContent = statsLine.trim();
        btnCopyOriginal.disabled = false;
        btnCopyHeader.disabled = false;
        btnRefine.disabled = false;
      } else {
        transcriptPreview.classList.add('empty');
        const why = resp.result && resp.result.reason === 'NO_AUDIO_CAPTURED'
          ? 'No audio reached the recorder (0 seconds captured). Check that the correct microphone is selected and not muted.'
          : 'No voice input detected. Please speak clearly into your microphone.';
        transcriptPreview.textContent = why + (statsLine ? ` (${statsLine.trim()})` : '');
      }
    } catch (e) {
      // Report the stage that genuinely failed. A 100% download is not a failure,
      // and an initialization/backend error must not be labelled a download error.
      const info = classifyLocalSttError(e);
      const failedStage = e?.stage || info.stage;
      console.error('[Whisper] Local transcription failed at stage', failedStage, e);

      let title = 'Local Whisper Initialization Failed';
      let guidance = `${(e && e.message) || 'On-device model initialization issue'}. ` +
        'You can switch to Cloud (Web Speech API) in Settings for instant live speech.';

      if (failedStage === STT_STAGE.DOWNLOADING) {
        title = 'Local Whisper Download Failed';
        guidance = 'Whisper ONNX weights could not be downloaded from HuggingFace. Check your internet ' +
          'connection, then retry — or switch to "Cloud (Web Speech API)" for instant voice recognition with no download.';
      } else if (info.kind === 'backend' || info.kind === 'runtime-wasm') {
        title = 'Local Whisper Runtime Setup Failed';
        guidance = `${(e && e.message) || 'ONNX Runtime Web could not start.'} ` +
          'Reload the extension so its packaged wasm runtime is registered, then retry.';
      } else if (info.kind === 'webgpu') {
        title = 'WebGPU Unavailable';
        guidance = 'WebGPU could not be initialized on this device. Set Hardware Acceleration to ' +
          '"CPU / WASM Only" in Settings, or switch to Cloud (Web Speech API).';
      } else if (info.kind === 'memory') {
        title = 'Local Whisper Out Of Memory';
        guidance = 'The on-device model exceeded available GPU/WASM memory. Try the lighter whisper-base ' +
          'model, set Hardware Acceleration to CPU, or switch to Cloud (Web Speech API).';
      } else if (info.kind === 'model-assets') {
        title = 'Local Whisper Model Assets Failed';
        guidance = `${(e && e.message) || 'Tokenizer/processor initialization failed.'} ` +
          'Retry initialization — cached files are reused, so no full re-download is needed.';
      } else {
        title = 'Local Whisper Initialization Failed';
        guidance = `${(e && e.message) || 'On-device model initialization issue'} ` +
          `(stage: ${failedStage}). Retry initialization — cached weights are reused. ` +
          'You can also switch to Cloud (Web Speech API) in Settings.';
      }

      showError(title, guidance, true);
    }
    return;
  }

  if (speech && speech.isRecording) {
    speech.stop();
  }
  if (statusLabel) statusLabel.textContent = '';
  if (currentTranscript.trim()) {
    btnCopyOriginal.disabled = false;
    btnCopyHeader.disabled = false;
    btnRefine.disabled = false;
  }
}

function cancelRecording() {
  if (isUsingLocalSTT || settings?.speechEngine === 'voiceapi') {
    // Fire-and-forget: the recorder lives in the offscreen document.
    whisperCommand({ action: 'RECORD_CANCEL' });
  }
  if (speech) {
    speech.abort();
  }
  stopTimer();
  currentState = 'IDLE';
  btnMic.classList.remove('recording');
  micPulseRing.classList.remove('recording');
  btnStop.classList.remove('recording');
  btnStop.disabled = true;
  btnRefine.disabled = true;
  btnCopyOriginal.disabled = true;
  btnCopyHeader.disabled = true;
  currentTranscript = '';
  if (statusLabel) statusLabel.textContent = '';
  if (recordingTimer) recordingTimer.textContent = '00:00';
  transcriptPreview.classList.add('empty');
  transcriptPreview.textContent = '';
}

async function processTranscript() {
  currentState = 'GENERATING';
  setStage('loading');

  const normalized = normalizeTranscript(currentTranscript);

  if (!normalized) {
    showError('No Speech Detected', 'No clear voice input was detected. Please try recording again.');
    return;
  }

  try {
    settings = await getSettings();

    // Check credential availability
    if (settings.provider === 'openai' && !settings.openaiKey) {
      showError(
        'OpenAI API Key Required',
        'Please configure your OpenAI API Key in Settings to enable professional bilingual refinement.'
      );
      return;
    }

    if (settings.provider === 'gemini' && !settings.geminiKey) {
      showError(
        'Gemini API Key Required',
        'Please configure your Gemini API Key in Settings.'
      );
      return;
    }

    const result = await generateBilingualOutput(normalized, settings);

    outputBn.value = result.bangla;
    outputEn.value = result.english;
    currentState = 'RESULT';
    setStage('result');
  } catch (err) {
    console.error('Refinement failed:', err);
    showError('Refinement Notice', err.message || 'Unable to refine transcript. Please try again.');
  }
}

function showError(title, message, isLocalSttIssue = false, showLocalSwitch = false) {
  currentState = 'ERROR';
  errorTitle.textContent = title;
  errorDesc.textContent = message;
  if (btnSwitchCloudStt) {
    btnSwitchCloudStt.style.display = isLocalSttIssue ? 'inline-flex' : 'none';
  }
  if (btnSwitchLocalStt) {
    // Offered when the browser's own speech service is unavailable (Shift and other
    // Chromium forks without the Google speech backend): Local Whisper needs none.
    btnSwitchLocalStt.style.display = showLocalSwitch ? 'inline-flex' : 'none';
  }
  setStage('error');
}

function handleCopy(btn, textarea) {
  const text = textarea.value.trim();
  if (!text) return;

  copyToClipboard(text).then((success) => {
    if (success) {
      const originalText = btn.querySelector('.copy-text').textContent;
      btn.classList.add('copied');
      btn.querySelector('.copy-text').textContent = 'Copied ✓';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.querySelector('.copy-text').textContent = originalText;
      }, 1800);
    }
  });
}

// Event Listeners
btnMic.addEventListener('click', () => {
  if (currentState === 'RECORDING') {
    stopRecording();
  } else {
    startRecording();
  }
});

btnStop.addEventListener('click', stopRecording);

if (btnRefine) {
  btnRefine.addEventListener('click', () => {
    if (currentTranscript.trim()) {
      processTranscript();
    }
  });
}

function handleCopyOriginal() {
  if (!currentTranscript.trim()) return;
  copyToClipboard(currentTranscript).then((success) => {
    if (success) {
      if (btnCopyOriginal) {
        const origHtml = btnCopyOriginal.innerHTML;
        btnCopyOriginal.innerHTML = '<span>Copied ✓</span>';
        setTimeout(() => {
          btnCopyOriginal.innerHTML = origHtml;
        }, 1800);
      }
      if (copyHeaderText) {
        const origText = copyHeaderText.textContent;
        copyHeaderText.textContent = 'Copied ✓';
        setTimeout(() => {
          copyHeaderText.textContent = origText;
        }, 1800);
      }
    }
  });
}

if (btnCopyOriginal) {
  btnCopyOriginal.addEventListener('click', handleCopyOriginal);
}

if (btnCopyHeader) {
  btnCopyHeader.addEventListener('click', handleCopyOriginal);
}

btnCancel.addEventListener('click', cancelRecording);

// § cleanup: the language chips were removed from the UI — guard the listeners.
if (langBn) langBn.addEventListener('change', () => {
  if (speech && speech.isRecording) {
    speech.setLanguage('bn-BD');
  }
});

if (langEn) langEn.addEventListener('change', () => {
  if (speech && speech.isRecording) {
    speech.setLanguage('en-US');
  }
});

btnCopyBn.addEventListener('click', () => handleCopy(btnCopyBn, outputBn));
btnCopyEn.addEventListener('click', () => handleCopy(btnCopyEn, outputEn));

btnCopyBoth.addEventListener('click', () => {
  const combined = `🇧🇩 Bangla:\n${outputBn.value.trim()}\n\n🇬🇧 English:\n${outputEn.value.trim()}`;
  copyToClipboard(combined).then((success) => {
    if (success) {
      btnCopyBoth.textContent = 'Both Copied ✓';
      setTimeout(() => {
        btnCopyBoth.textContent = 'Copy Both';
      }, 1800);
    }
  });
});

btnRecordAgain.addEventListener('click', () => {
  setStage('voice');
  cancelRecording();
  startRecording();
});

btnErrorRetry.addEventListener('click', () => {
  setStage('voice');
  cancelRecording();
});

if (btnSwitchCloudStt) {
  btnSwitchCloudStt.addEventListener('click', async () => {
    isUsingLocalSTT = false;
    if (settings) settings.speechEngine = 'cloud';
    // User explicitly chose Browser Speech: clear the auto-mode capability flag so
    // Auto mode tries it again (e.g. the speech service came back / new browser).
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ browserSpeechUnavailable: false });
      }
      if (settings) settings.browserSpeechUnavailable = false;
    } catch (e) { /* ignore */ }
    await saveSettings({ speechEngine: 'cloud' });
    updatePrivacyBadge('Cloud Web Speech');
    setStage('voice');
    cancelRecording();
    startRecording();
  });
}

if (btnSwitchLocalStt) {
  // One-click fallback for browsers whose speech service is unavailable (Shift):
  // switch the saved engine to Local Whisper and start on-device recording.
  btnSwitchLocalStt.addEventListener('click', async () => {
    isUsingLocalSTT = true;
    if (settings) settings.speechEngine = 'local';
    try { await saveSettings({ speechEngine: 'local' }); } catch (e) { /* persist best-effort */ }
    console.log('[Popup] switched to Local (Whisper) engine');
    setStage('voice');
    cancelRecording();
    startRecording();
  });
}

btnSettings.addEventListener('click', () => {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

btnErrorSettings.addEventListener('click', () => {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

// Transcript Expand / Collapse logic (Expanded by default)
let isTranscriptExpanded = true;

function toggleTranscriptExpand() {
  isTranscriptExpanded = !isTranscriptExpanded;
  if (transcriptBox) {
    transcriptBox.classList.toggle('is-expanded', isTranscriptExpanded);
  }
  const expandLabel = document.getElementById('expand-btn-label');
  if (expandIconSvg) {
    if (isTranscriptExpanded) {
      expandIconSvg.innerHTML = '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>';
      if (btnExpandTranscript) btnExpandTranscript.title = 'Collapse text area';
      if (expandLabel) expandLabel.textContent = 'Collapse';
    } else {
      expandIconSvg.innerHTML = '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>';
      if (btnExpandTranscript) btnExpandTranscript.title = 'Expand text area';
      if (expandLabel) expandLabel.textContent = 'Expand';
    }
  }

  // § COLLAPSE/EXPAND HEIGHT FIX: the browser never shrinks a popup on its own when
  // content shrinks — the old height stayed and left a blank area at the bottom.
  // After the toggle, measure the new layout and actively resize:
  //   • detached window → chrome.windows.update (clamped to the fixed maximum)
  //   • attached bubble → explicit body height set to the measured content height,
  //     which the popup bubble follows.
  if (isDetached) {
    const targetHeight = isTranscriptExpanded ? MAX_POPUP_HEIGHT : MAX_COLLAPSED_HEIGHT;
    if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.getCurrent) {
      chrome.windows.getCurrent((win) => {
        if (chrome.runtime.lastError || !win) {
          if (typeof window.resizeTo === 'function') {
            window.resizeTo(
              Math.min(Math.max(290, window.outerWidth), MAX_POPUP_WIDTH),
              Math.min(targetHeight, MAX_POPUP_HEIGHT)
            );
          }
          return;
        }
        try {
          chrome.windows.update(win.id, {
            width: Math.min(Math.max(290, win.width || MAX_POPUP_WIDTH), MAX_POPUP_WIDTH),
            height: Math.min(targetHeight, MAX_POPUP_HEIGHT)
          });
        } catch (e) { /* ignore */ }
      });
    } else if (typeof window.resizeTo === 'function') {
      window.resizeTo(
        Math.min(Math.max(290, window.outerWidth), MAX_POPUP_WIDTH),
        Math.min(targetHeight, MAX_POPUP_HEIGHT)
      );
    }
  } else {
    // Attached bubble: pin the body to the measured content height so the popup
    // view follows the collapse/expand state (browsers never shrink it themselves).
    pinAttachedBubbleHeight();
  }
}

if (btnExpandTranscript) {
  btnExpandTranscript.addEventListener('click', toggleTranscriptExpand);
}

// § RESULT EXPAND: independent expand/collapse for the Bangla and English output
// textareas — vertical height only, each field has its own state. Reuses the
// input field's expand icon language and popup sizing behavior. Visual read aid
// only; no data or Refine/Bilingual flow changes.
const RESULT_EXPAND_ICON = '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>';
const RESULT_COLLAPSE_ICON = '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>';
let isBanglaExpanded = false;
let isEnglishExpanded = false;

function applyResultExpandState() {
  if (outputBn) outputBn.classList.toggle('is-expanded', isBanglaExpanded);
  if (outputEn) outputEn.classList.toggle('is-expanded', isEnglishExpanded);
  if (expandBnSvg) {
    expandBnSvg.innerHTML = isBanglaExpanded ? RESULT_COLLAPSE_ICON : RESULT_EXPAND_ICON;
  }
  if (expandEnSvg) {
    expandEnSvg.innerHTML = isEnglishExpanded ? RESULT_COLLAPSE_ICON : RESULT_EXPAND_ICON;
  }
  if (btnExpandBn) {
    btnExpandBn.title = isBanglaExpanded ? 'Collapse Bangla text' : 'Expand Bangla text';
    btnExpandBn.setAttribute('aria-label', btnExpandBn.title);
  }
  if (btnExpandEn) {
    btnExpandEn.title = isEnglishExpanded ? 'Collapse English text' : 'Expand English text';
    btnExpandEn.setAttribute('aria-label', btnExpandEn.title);
  }
  // Popup sizing follows the new content height (same pattern as the transcript
  // collapse/expand: detached → chrome.windows.update, attached → measured pin).
  if (typeof isDetached !== 'undefined' && isDetached) {
    const needed = document.body.scrollHeight + (window.outerHeight - window.innerHeight || 0);
    if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.getCurrent) {
      chrome.windows.getCurrent((win) => {
        if (chrome.runtime.lastError || !win) {
          if (typeof window.resizeTo === 'function') {
            window.resizeTo(
              Math.min(Math.max(290, window.outerWidth), MAX_POPUP_WIDTH),
              Math.min(needed, MAX_POPUP_HEIGHT)
            );
          }
          return;
        }
        try {
          chrome.windows.update(win.id, {
            width: Math.min(Math.max(290, win.width || MAX_POPUP_WIDTH), MAX_POPUP_WIDTH),
            height: Math.min(needed, MAX_POPUP_HEIGHT)
          });
        } catch (e) { /* ignore */ }
      });
    } else if (typeof window.resizeTo === 'function') {
      window.resizeTo(
        Math.min(Math.max(290, window.outerWidth), MAX_POPUP_WIDTH),
        Math.min(needed, MAX_POPUP_HEIGHT)
      );
    }
  } else if (typeof pinAttachedBubbleHeight === 'function') {
    pinAttachedBubbleHeight();
  }
}

function toggleBanglaExpand() {
  isBanglaExpanded = !isBanglaExpanded;
  applyResultExpandState();
}

function toggleEnglishExpand() {
  isEnglishExpanded = !isEnglishExpanded;
  applyResultExpandState();
}

if (btnExpandBn) btnExpandBn.addEventListener('click', toggleBanglaExpand);
if (btnExpandEn) btnExpandEn.addEventListener('click', toggleEnglishExpand);

// Detached movable popup support with permanent memory
const urlParams = new URLSearchParams(window.location.search);
const isDetached = urlParams.get('mode') === 'detached';

if (isDetached) {
  document.body.classList.add('detached-mode');
  if (popoutLabel) popoutLabel.textContent = '📌';
  if (btnPopout) btnPopout.title = 'Dock back to toolbar';

  const saveWindowBounds = () => {
    if (typeof chrome !== 'undefined' && chrome.storage && typeof window.screenX === 'number' && typeof window.screenY === 'number') {
      const screenLeft = Math.max(10, window.screenX);
      const screenTop = Math.max(10, window.screenY);
      chrome.storage.local.set({
        detachedWindowPos: {
          left: screenLeft,
          top: screenTop,
          // Persisted bounds are clamped to the fixed maximum (never larger).
          width: Math.min(window.outerWidth || MAX_POPUP_WIDTH, MAX_POPUP_WIDTH),
          height: Math.min(window.outerHeight || MAX_POPUP_HEIGHT, MAX_POPUP_HEIGHT)
        }
      });
    }
  };
  window.addEventListener('beforeunload', saveWindowBounds);
  window.addEventListener('resize', saveWindowBounds);
  window.addEventListener('blur', saveWindowBounds);
  window.addEventListener('resize', enforceMaxWindowSize);
  const boundsTimer = setInterval(saveWindowBounds, 800);
  window.addEventListener('unload', () => clearInterval(boundsTimer));
}

if (btnPopout) {
  btnPopout.addEventListener('click', async () => {
    if (isDetached) {
      // User clicked dock back to toolbar
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ windowMode: 'attached' });
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SET_WINDOW_MODE', mode: 'attached' });
      }
      window.close();
    } else {
      // User clicked Free Window: save mode permanently and open detached
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ windowMode: 'detached' });
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SET_WINDOW_MODE', mode: 'detached' });
        chrome.runtime.sendMessage({ type: 'OPEN_DETACHED_WINDOW' });
      }
      window.close();
    }
  });
}

// Live status from the offscreen recorder (lifecycle stages + final result).
// This keeps the popup UI correct even though recording no longer lives here.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.whisper) return false; // ignore recorder command relays
    if (msg.type === 'WHISPER_STATUS' && msg.status) {
      applyLocalSttStage(msg.status);
    }
    if (msg.type === 'WHISPER_INTERIM' && currentState === 'RECORDING') {
      // Live typing: incremental Whisper chunks reconcile into FINAL text and the
      // stable tail streams into the field, mirroring Web Speech interim results.
      transcriptPreview.classList.remove('empty');
      transcriptPreview.textContent = msg.text;
    }
    if (msg.type === 'WHISPER_LEVEL' && currentState === 'RECORDING') {
      // §9: the user must see that the microphone is working even before text
      // appears. Local RMS from the worklet — nothing is uploaded.
      const detected = msg.audible && msg.level > 0;
      if (detected !== whisperAudioDetected) {
        whisperAudioDetected = detected;
        if (statusLabel) {
          statusLabel.textContent = detected
            ? 'Listening • Audio detected'
            : 'Listening — speak to see live text';
        }
      }
    }
    if (msg.type === 'WHISPER_RESULT') {
      // The direct command response usually delivers the transcript; this broadcast
      // covers the case where the popup was (re)opened after recording finished.
      if (msg.ok && msg.result && msg.result.transcript && currentState !== 'RECORDING') {
        currentTranscript = msg.result.transcript;
        transcriptPreview.classList.remove('empty');
        transcriptPreview.textContent = currentTranscript;
        btnCopyOriginal.disabled = false;
        btnCopyHeader.disabled = false;
        btnRefine.disabled = false;
      }
    }
    return false; // no async response
  });
}

// Popup teardown: abort any live recognition session so the browser-side speech
// service is clean the next time the popup opens. A stale session from a destroyed
// popup colliding with a fresh session is the classic freshly-reopened-popup start
// failure in Chromium forks (Shift Browser).
window.addEventListener('pagehide', () => {
  try {
    if (speech) {
      speech.abort();
      console.log('[Popup] recognition aborted on close');
    }
  } catch (e) { /* ignore */ }
});
window.addEventListener('unload', () => {
  try { if (speech) speech.abort(); } catch (e) { /* ignore */ }
});

// Auto-start on popup open if configured
window.addEventListener('DOMContentLoaded', async () => {
  // If user previously chose free/independent window and this opened attached, immediately pop out
  if (!isDetached && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['windowMode'], (res) => {
      if (res && res.windowMode === 'detached') {
        chrome.runtime.sendMessage({ type: 'OPEN_DETACHED_WINDOW' });
        window.close();
        return;
      }
    });
  }

  settings = await getSettings();

  // Initialize Privacy & Acceleration Indicator
  const isLocal = (settings?.speechEngine === 'local');
  isUsingLocalSTT = isLocal;
  let recorderStatePromise = null;
  if (isLocal) {
    LocalSTTEngine.detectAcceleration().then((acc) => {
      updatePrivacyBadge(acc);
    });

    // A recording may still be running in the offscreen document (e.g. the popup was
    // closed mid-recording). Reattach the UI instead of silently starting a second one.
    recorderStatePromise = whisperCommand({ action: 'RECORD_STATE' }).then((state) => {
      if (state && state.ok && state.recording) {
        currentState = 'RECORDING';
        btnMic.classList.add('recording');
        micPulseRing.classList.add('recording');
        btnStop.disabled = false;
        btnStop.classList.add('recording');
        transcriptPreview.classList.remove('empty');
        transcriptPreview.textContent = 'Recording continues in the background — press stop to transcribe.';
        return true;
      }
      return false;
    }).catch(() => false);
  } else {
    updatePrivacyBadge('Cloud Web Speech');
  }

  // Populate active running API name
  if (popupApiName) {
    const prov = getEffectiveProvider(settings);
    const liveDot = document.getElementById('popup-live-dot');
    if (prov === 'none') {
      popupApiName.textContent = 'None (Configure in Settings)';
      if (liveDot) {
        liveDot.style.background = '#64748b';
        liveDot.style.boxShadow = 'none';
      }
    } else {
      const nameMap = {
        openai: 'OpenAI',
        gemini: 'Google Gemini',
        custom: 'Custom API'
      };
      const mod = prov === 'openai' ? settings.openaiModel : prov === 'gemini' ? settings.geminiModel : settings.customModel;
      popupApiName.textContent = `${nameMap[prov] || prov} (${mod || 'default'})`;
      if (liveDot) {
        liveDot.style.background = '#10b981';
        liveDot.style.boxShadow = '0 0 6px #10b981';
      }
    }
  }

  if (settings.inputLanguage === 'en-US') {
    langEn.checked = true;
  } else {
    langBn.checked = true;
  }

  // Auto-start if preferred (but never start a second recording over a live one)
  if (settings.autoStartOnOpen) {
    setTimeout(async () => {
      try {
        if (recorderStatePromise && await recorderStatePromise) return; // already recording
      } catch (e) { /* fall through and start */ }
      startRecording();
    }, 200);
  }

  // § COLLAPSE/EXPAND HEIGHT FIX: pin the attached bubble to the real content height
  // on open, so it starts matched to the layout (no blank area below the footer).
  pinAttachedBubbleHeight();
});
