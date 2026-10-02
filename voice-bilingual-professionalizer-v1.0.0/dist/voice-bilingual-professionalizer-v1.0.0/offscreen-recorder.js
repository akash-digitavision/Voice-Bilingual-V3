/**
 * Offscreen Whisper recorder.
 *
 * Owns the LocalSTTEngine (microphone capture via AudioWorklet + on-device Whisper
 * inference) inside a persistent offscreen document. The popup controls it through
 * the service worker, so:
 *   - the recording survives the popup losing focus or closing entirely,
 *   - the pipeline stays warm in one long-lived context,
 *   - status/progress events are broadcast back to whatever UI is open.
 *
 * Message contract:
 *   -> { target:'offscreen', action:'RECORD_START', language, modelId, devicePreference }
 *   -> { target:'offscreen', action:'RECORD_STOP', language }
 *   -> { target:'offscreen', action:'RECORD_CANCEL' }
 *   -> { target:'offscreen', action:'RECORD_STATE' }
 *   <- broadcast { whisper:true, type:'WHISPER_STATUS', status }   (lifecycle stages)
 *   <- broadcast { whisper:true, type:'WHISPER_RESULT', ... }       (final transcript)
 */

import { LocalSTTEngine, STT_STAGE } from './modules/local-stt-engine.js';
import { transcribeWithVoiceInput, providerName } from './modules/voice-input.js';

let engine = null;
let interimTimer = null;
let levelTimer = null;
let activeLanguage = null;
// Voice API (batch) session: MediaRecorder → Blob → provider transcription.
let voiceSession = null;

// Incremental transcription scheduler (§5): short overlapping windows transcribed
// periodically while recording continues — never per audio callback. Skipped while
// a pass is still running, so slow machines degrade gracefully.
const INTERIM_INTERVAL_MS = 2500;
// Audio-level broadcast cadence for the "Audio detected" indicator (§9).
const LEVEL_INTERVAL_MS = 250;

function startInterimLoop() {
  stopInterimLoop();
  interimTimer = setInterval(async () => {
    if (!engine || !engine.isRecording) { stopInterimLoop(); return; }
    try {
      // Incremental pass: transcribes only the NEW uncommitted audio (+overlap) and
      // reconciles it into the FINAL transcript — constant latency as recording grows.
      const r = await engine.transcribeIncremental(activeLanguage);
      if (r && r.finalText && r.finalText.trim()) {
        broadcast({
          type: 'WHISPER_INTERIM',
          text: r.finalText.trim(),
          chunkLatencyMs: r.latencyMs,
          rtf: r.rtf
        });
      }
    } catch (e) { /* interim must never break the recording */ }
  }, INTERIM_INTERVAL_MS);
}

function stopInterimLoop() {
  if (interimTimer) {
    clearInterval(interimTimer);
    interimTimer = null;
  }
}

function startLevelLoop() {
  stopLevelLoop();
  let lastBucket = -1;
  levelTimer = setInterval(() => {
    if (!engine || !engine.isRecording) { stopLevelLoop(); return; }
    const { level } = engine.getRecentLevel();
    const bucket = Math.round(level * 50) / 50; // only broadcast on meaningful change
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      broadcast({ type: 'WHISPER_LEVEL', level: bucket, audible: level > 0.02 });
    }
  }, LEVEL_INTERVAL_MS);
}

function stopLevelLoop() {
  if (levelTimer) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
}

function broadcast(payload) {
  try {
    chrome.runtime.sendMessage({ whisper: true, ...payload }).catch(() => {});
  } catch (e) { /* no listener open — fine */ }
}

function normalizeDevice(pref) {
  const v = String(pref || 'auto').toLowerCase();
  if (v === 'webgpu' || v === 'gpu') return 'webgpu';
  if (v === 'wasm' || v === 'cpu') return 'wasm';
  return 'auto';
}

function ensureEngine({ modelId, devicePreference, language } = {}) {
  if (!engine) {
    engine = new LocalSTTEngine({
      modelId: modelId || 'onnx-community/whisper-base',
      devicePreference: normalizeDevice(devicePreference),
      language: language === 'bn' ? 'bn' : 'en',
      onStatus: (st) => broadcast({ type: 'WHISPER_STATUS', status: st }),
      onError: (err) => broadcast({ type: 'WHISPER_ENGINE_ERROR', error: err })
    });
    return engine;
  }
  // Existing engine: apply per-request overrides that the engine reads at call time.
  if (modelId && engine.modelId !== modelId) engine.modelId = modelId;
  if (devicePreference) engine.devicePreference = normalizeDevice(devicePreference);
  if (language) engine.language = language === 'bn' ? 'bn' : 'en';
  return engine;
}

async function persistLastResult(payload) {
  try {
    if (chrome.storage && chrome.storage.session) {
      await chrome.storage.session.set({ whisperLastResult: { at: Date.now(), ...payload } });
    }
  } catch (e) { /* session storage unavailable — non-fatal */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false; // not for us

  // ---- Voice API (batch) recording path -------------------------------------
  if (msg.action === 'RECORD_START' && msg.engine === 'voiceapi') {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus' : 'audio/webm';
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

        const ctx = new AudioContext();
        await ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);

        voiceSession = { recorder, chunks, stream, ctx, cfg: msg.voice || {}, language: msg.language };

        // §9: local audio-level indicator — computed on-device, nothing uploaded.
        let lastBucket = -1;
        levelTimer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const level = Math.sqrt(sum / buf.length);
          const bucket = Math.round(level * 50) / 50;
          if (bucket !== lastBucket) {
            lastBucket = bucket;
            broadcast({ type: 'WHISPER_LEVEL', level: bucket, audible: level > 0.02 });
          }
        }, LEVEL_INTERVAL_MS);

        recorder.start(1000);
        const provider = providerName(voiceSession.cfg.provider);
        broadcast({
          type: 'WHISPER_STATUS',
          status: { stage: 'LISTENING', message: `Listening — Voice API (${provider}, batch)`, device: 'Voice API' }
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, code: 'MIC_ERROR', message: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (msg.action === 'RECORD_STOP' && voiceSession) {
    stopLevelLoop();
    const session = voiceSession;
    voiceSession = null;
    (async () => {
      let payload;
      try {
        const blob = await new Promise((resolve, reject) => {
          session.recorder.onstop = () => resolve(new Blob(session.chunks, { type: session.recorder.mimeType || 'audio/webm' }));
          try { session.recorder.stop(); } catch (e) { reject(e); }
        });
        try { session.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        try { if (session.ctx && session.ctx.state !== 'closed') await session.ctx.close(); } catch (e) {}

        broadcast({ type: 'WHISPER_STATUS', status: { stage: 'INITIALIZING_MODEL', message: 'Transcribing with Voice API (batch)...' } });
        const t0 = Date.now();
        const res = await transcribeWithVoiceInput(blob, { ...session.cfg, language: msg.language || session.language });
        payload = {
          ok: true,
          result: {
            transcript: res.text,
            device: 'Voice API',
            provider: res.provider,
            audioDurationSec: null,
            inferenceDurationMs: Date.now() - t0
          },
          stats: null,
          stage: 'READY'
        };
      } catch (e) {
        payload = { ok: false, message: (e && e.message) || String(e), stage: null, stats: null };
      }
      await persistLastResult(payload);
      try { sendResponse(payload); } catch (e) { /* popup may have closed */ }
      broadcast({ type: 'WHISPER_RESULT', ...payload });
    })();
    return true;
  }

  if (msg.action === 'RECORD_CANCEL' && voiceSession) {
    stopLevelLoop();
    try { voiceSession.recorder.stop(); } catch (e) {}
    try { voiceSession.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (voiceSession.ctx && voiceSession.ctx.state !== 'closed') voiceSession.ctx.close(); } catch (e) {}
    voiceSession = null;
  }

  if (msg.action === 'RECORD_STATE') {
    const voiceRecording = Boolean(voiceSession);
    sendResponse({
      ok: true,
      recording: voiceRecording || Boolean(engine && engine.isRecording),
      stage: engine ? engine.stage : (voiceRecording ? 'LISTENING' : null),
      voiceApi: voiceRecording
    });
    return false;
  }

  if (msg.action === 'RECORD_START') {
    (async () => {
      try {
        activeLanguage = msg.language === 'bn' ? 'bn' : 'en';
        const eng = ensureEngine(msg);
        await eng.startRecording();
        // Warm the pipeline in parallel so stop->transcript is fast. Failure here is
        // non-fatal: stopAndTranscribe() awaits the same pipeline promise and will
        // surface a proper stage error if initialization genuinely fails.
        eng.initPipeline().catch(() => {});
        // Live interim typing (incremental chunks) + audio-level indicator.
        startInterimLoop();
        startLevelLoop();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({
          ok: false,
          code: 'MIC_ERROR',
          name: e && e.name,
          message: (e && e.message) || String(e),
          stats: engine ? engine.getRecordingStats() : null
        });
      }
    })();
    return true; // async response
  }

  if (msg.action === 'RECORD_STOP') {
    stopInterimLoop();
    stopLevelLoop();
    (async () => {
      let payload;
      try {
        const eng = ensureEngine(msg);
        const result = await eng.stopAndTranscribe(msg.language || activeLanguage || null);
        payload = {
          ok: true,
          result,
          stats: eng.getRecordingStats(),
          stage: eng.stage
        };
      } catch (e) {
        payload = {
          ok: false,
          message: (e && e.message) || String(e),
          stage: (e && e.stage) || null,
          attempts: (e && e.attempts) || null,
          stats: engine ? engine.getRecordingStats() : null
        };
      }
      await persistLastResult(payload);
      try { sendResponse(payload); } catch (e) { /* popup may have closed */ }
      broadcast({ type: 'WHISPER_RESULT', ...payload });
    })();
    return true; // async response
  }

  if (msg.action === 'RECORD_CANCEL') {
    stopInterimLoop();
    stopLevelLoop();
    try { if (engine) engine.cancelRecording(); } catch (e) { /* ignore */ }
    broadcast({ type: 'WHISPER_STATUS', status: { stage: STT_STAGE.IDLE, message: 'Recording cancelled.' } });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'RECORD_STATE') {
    sendResponse({
      ok: true,
      recording: Boolean(engine && engine.isRecording),
      stage: engine ? engine.stage : null,
      modelId: engine ? engine.modelId : null
    });
    return false;
  }

  return false;
});

console.log('[Whisper offscreen] recorder ready');
