/**
 * Local STT Engine — Privacy-First Multilingual Whisper (Transformers.js + ONNX Runtime Web)
 *
 * Pipeline:
 * Microphone -> getUserMedia -> AudioContext -> AudioWorklet -> 16kHz Float32 PCM -> Transformers.js Whisper -> Transcript
 *
 * Acceleration:
 * - WebGPU (when a real GPU adapter AND device can be acquired)
 * - WASM / CPU fallback (automatic & seamless)
 *
 * Target Multilingual Models:
 * - onnx-community/whisper-base (Recommended: ~73M params, fast, supports Bangla, English, Banglish)
 * - onnx-community/whisper-small (High-accuracy: ~244M params)
 *
 * ZERO audio is transmitted to external servers when local STT is active.
 *
 * NOTE ON ONNX RUNTIME BACKEND:
 * The bundled Transformers.js (vendor/transformers.js) hardcodes ONNX Runtime Web's
 * wasm binary location to a remote executable-code host (its own CDN build path).
 * Fetching that binary is blocked by the extension's Manifest V3 content security
 * policy — connect-src deliberately does not allow an executable-code CDN — and it
 * would also violate MV3 remote-code rules. The wasm backend is therefore re-pointed
 * at the copy shipped inside this extension package (vendor/) before any pipeline is
 * built. See configureOnnxRuntimeBackend()/verifyPackagedOnnxWasm() below.
 */

import { AudioResampler } from './audio-resampler.js';

/**
 * Explicit lifecycle stages. A 100% download is NOT a ready model.
 */
export const STT_STAGE = Object.freeze({
  IDLE: 'IDLE',
  DOWNLOADING: 'DOWNLOADING',
  DOWNLOAD_COMPLETE: 'DOWNLOAD_COMPLETE',
  INITIALIZING_BACKEND: 'INITIALIZING_BACKEND',
  INITIALIZING_MODEL: 'INITIALIZING_MODEL',
  READY: 'READY',
  ERROR: 'ERROR'
});

// ONNX Runtime Web ships as an Emscripten JS loader plus a wasm binary. Both must
// be packaged, because the bundle dynamically imports the loader
// (<dir>/ort-wasm-simd-threaded.jsep.mjs) and the loader then fetches the wasm
// binary from the same directory. Setting wasmPaths to <dir>/ redirects both.
const ORT_WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm';
const ORT_LOADER_FILE = 'ort-wasm-simd-threaded.jsep.mjs';
const ORT_WASM_DIR = 'vendor/';
const DEFAULT_MODEL_ID = 'onnx-community/whisper-base';

/**
 * Per-module quantization plans, in attempt order.
 *
 * Whisper is an encoder-decoder model and is "extremely sensitive to quantization
 * settings", so a single uniform dtype string (e.g. dtype:'fp16') is the wrong shape
 * of configuration:
 *  - The published Hugging Face WebGPU Whisper example uses per-module dtypes and
 *    carries the note that the fp16 *decoder* is broken.
 *  - q8 maps to the well-trodden *_quantized.onnx weights and is the dtype
 *    Transformers.js itself defaults to for the wasm device.
 *
 * Verified against the onnx-community/whisper-base repository contents:
 *  - encoder_model_q4.onnx          (18.8 MB)
 *  - decoder_model_merged_q4.onnx   (123.6 MB)
 *  - encoder_model_quantized.onnx   (23.2 MB)
 *  - decoder_model_merged_quantized.onnx (53.7 MB)
 */
const PIPELINE_ATTEMPTS = Object.freeze([
  {
    device: 'webgpu',
    label: 'WebGPU',
    dtype: Object.freeze({ encoder_model: 'q4', decoder_model_merged: 'q4' })
  },
  {
    device: 'wasm',
    label: 'CPU fallback',
    dtype: Object.freeze({ encoder_model: 'q8', decoder_model_merged: 'q8' })
  }
]);

/**
 * Incremental (chunked) transcription plan — near-real-time Whisper.
 * Instead of one large inference after Stop, the rolling PCM buffer is transcribed
 * in short overlapping windows while recording continues (§5/§6 of the speech
 * provider spec). Each pass is O(chunk), so latency stays constant as the recording
 * grows. Stop finalizes only the remaining tail — the full recording is never
 * re-transcribed (§10).
 */
const INCREMENTAL = Object.freeze({
  overlapSec: 1.2,        // left overlap re-transcribed for continuity
  minChunkSec: 1.2,       // don't infer on tiny tails
  immediateTailSec: 1.0   // minimum buffered audio before the first interim pass
});

/**
 * Word-level overlap reconciliation (§8): merges a new overlapping-window
 * transcription into the committed final text without duplicating words.
 * Matching is done on normalized tokens (Unicode letters/numbers, so Bangla works);
 * the appended tail preserves the new text's original casing/punctuation.
 */
export function reconcileTranscript(prevText, nextText, maxOverlapWords = 14) {
  const tokenize = (t) => String(t || '').split(/\s+/).filter(Boolean);
  const norm = (t) => (String(t || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join('');

  const prevRaw = tokenize(prevText);
  const nextRaw = tokenize(nextText);
  if (!nextRaw.length) return { combined: prevText || '', appended: false, overlapWords: 0 };
  if (!prevRaw.length) return { combined: nextRaw.join(' '), appended: true, overlapWords: 0 };

  const prevNorm = prevRaw.map(norm);
  const nextNorm = nextRaw.map(norm);

  // Degenerate repeat guard: the new window adds nothing new.
  const nextKey = nextNorm.join(' ');
  const prevKey = prevNorm.join(' ');
  if (!nextKey || prevKey.endsWith(nextKey) || prevKey.includes(nextKey)) {
    return { combined: prevText, appended: false, overlapWords: nextNorm.length };
  }

  // Longest suffix(prev) == prefix(next) word match.
  const maxK = Math.min(prevNorm.length, nextNorm.length, maxOverlapWords);
  let overlapWords = 0;
  for (let k = maxK; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prevNorm[prevNorm.length - k + i] !== nextNorm[i]) { match = false; break; }
    }
    if (match) { overlapWords = k; break; }
  }

  const tail = nextRaw.slice(overlapWords).join(' ').trim();
  if (!tail) return { combined: prevText, appended: false, overlapWords };
  return {
    combined: (prevText ? prevText.replace(/\s+$/, '') + ' ' : '') + tail,
    appended: true,
    overlapWords
  };
}


// Global singleton pipeline instance to keep model warm across recordings
let globalPipelinePromise = null;
let activeModelId = DEFAULT_MODEL_ID;
let activeDevice = 'auto'; // 'auto' | 'webgpu' | 'wasm'
let detectedAcceleration = 'detecting'; // 'WebGPU' | 'CPU fallback'
let onnxBackendConfigured = false;

function log(...args) {
  console.log('[Whisper]', ...args);
}

function logError(stage, error, extra) {
  console.error(`[Whisper] ERROR during ${stage}:`, error);
  if (extra) console.error('[Whisper] ERROR context:', extra);
}

/**
 * Resolves a packaged asset to an absolute extension URL.
 * Falls back to a root-relative path outside the extension runtime.
 */
function assetUrl(relativePath) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(relativePath);
  }
  return `/${relativePath}`;
}

/**
 * Best-effort worker keep-alive so long model downloads are not interrupted by
 * service-worker eviction. Purely an optimisation; failure is never fatal.
 */
function keepServiceWorkerAlive() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
      const port = chrome.runtime.connect({ name: 'whisper-model-download' });
      const timer = setInterval(() => {
        try { port.postMessage({ type: 'WHISPER_KEEPALIVE' }); } catch (e) { clearInterval(timer); }
      }, 20000);
      const stop = () => clearInterval(timer);
      if (port.onDisconnect && port.onDisconnect.addListener) port.onDisconnect.addListener(stop);
      return stop;
    }
  } catch (e) {
    // no-op: keep-alive is optional
  }
  return () => {};
}

/**
 * Loads the packaged Transformers.js bundle (ESM).
 */
async function loadTransformers() {
  // The bundle is an ES module and never defines window.transformers; the global is
  // only honoured for forward-compatibility with a UMD build.
  if (typeof window !== 'undefined' && window.transformers) {
    return window.transformers;
  }

  const vendorUrl = assetUrl('vendor/transformers.js');
  log('Loading Transformers.js runtime from', vendorUrl);
  const mod = await import(/* @vite-ignore */ vendorUrl);

  if (!mod || typeof mod.pipeline !== 'function') {
    throw new Error('Packaged Transformers.js runtime is missing the "pipeline" export.');
  }
  log('Transformers.js runtime loaded (version', mod.env && mod.env.version, ')');
  return mod;
}

/**
 * Points ONNX Runtime Web at the wasm binary bundled in this extension instead of
 * the remote CDN that the upstream bundle hardcodes.
 *
 * Must run BEFORE the first pipeline/session is created, because ORT resolves and
 * instantiates its wasm binary while creating the first InferenceSession.
 */
function configureOnnxRuntimeBackend(transformers, engine) {
  const ort = transformers.env && transformers.env.backends && transformers.env.backends.onnx;
  if (!ort || !ort.wasm) {
    engine._diagnostic('ORT_ENV_MISSING', {});
    log('WARNING: ONNX Runtime backend environment not exposed by bundle; using package defaults.');
    return;
  }

  const wasmDir = assetUrl(ORT_WASM_DIR);
  const previousPaths = ort.wasm.wasmPaths;

  ort.wasm.wasmPaths = wasmDir;
  ort.wasm.numThreads = 1; // extension pages are not cross-origin isolated
  ort.wasm.proxy = false;

  engine._diagnostic('ORT_BACKEND_CONFIGURED', {
    wasmPaths: wasmDir,
    wasmFile: ORT_WASM_FILE,
    loaderFile: ORT_LOADER_FILE,
    resolvedWasmUrl: `${wasmDir}${ORT_WASM_FILE}`,
    resolvedLoaderUrl: `${wasmDir}${ORT_LOADER_FILE}`,
    numThreads: ort.wasm.numThreads,
    replacedRemotePath: previousPaths || null
  });
  log('ONNX Runtime wasm paths ->', wasmDir, `(loader: ${ORT_LOADER_FILE}, binary: ${ORT_WASM_FILE})`);
  if (previousPaths && /^https?:/i.test(String(previousPaths))) {
    log('Replaced remote ONNX Runtime wasm location that MV3 CSP blocks with the packaged copy.');
  }

  onnxBackendConfigured = true;
}

/**
 * Verifies BOTH packaged ONNX Runtime assets are present and readable from the
 * extension origin. The bundle dynamically imports the Emscripten loader (.mjs) and
 * the loader then fetches the wasm binary from the same directory — if either is
 * missing the pipeline fails with "no available backend found". A packaging problem
 * is never reported as a "download" failure.
 */
async function verifyPackagedOnnxWasm(engine) {
  if (typeof fetch !== 'function') {
    engine._diagnostic('ORT_WASM_VERIFY_SKIPPED', { reason: 'fetch unavailable' });
    return;
  }

  const assets = [
    { file: ORT_LOADER_FILE, method: 'GET' }, // an ES module: GET to confirm 200 + body
    { file: ORT_WASM_FILE, method: 'HEAD' }
  ];

  for (const asset of assets) {
    const url = `${assetUrl(ORT_WASM_DIR)}${asset.file}`;
    engine._diagnostic('ORT_WASM_VERIFY_START', { url, method: asset.method });

    let response;
    try {
      response = await fetch(url, { method: asset.method });
    } catch (err) {
      engine._diagnostic('ORT_WASM_VERIFY_FAILED', { url, error: err && err.message });
      logError(STT_STAGE.INITIALIZING_BACKEND, err, { url });
      throw stageError(
        `ONNX Runtime asset ${asset.file} is not readable from the extension package (${url}). ` +
        `Reinstall or reload the extension so vendor/${asset.file} is present.`,
        STT_STAGE.INITIALIZING_BACKEND,
        { fatal: true }
      );
    }

    if (!response.ok) {
      engine._diagnostic('ORT_WASM_VERIFY_FAILED', { url, status: response.status });
      throw stageError(
        `ONNX Runtime asset ${asset.file} missing from the extension package (HTTP ${response.status} for ${url}).`,
        STT_STAGE.INITIALIZING_BACKEND,
        { fatal: true }
      );
    }

    // Drain the GET body so the browser does not keep the loader response buffered.
    if (asset.method === 'GET' && response.body && response.body.cancel) {
      try { await response.body.cancel(); } catch (e) { /* no-op */ }
    }

    engine._diagnostic('ORT_WASM_VERIFY_OK', {
      url,
      status: response.status,
      method: asset.method,
      bytes: response.headers.get('content-length')
    });
  }
}

/**
 * Normalises the "Hardware Acceleration" setting.
 * Accepts 'auto' | 'webgpu' | 'wasm' | 'cpu'.
 */
function normalizeDevicePreference(preference) {
  const value = String(preference || 'auto').toLowerCase();
  if (value === 'webgpu' || value === 'gpu') return 'webgpu';
  if (value === 'wasm' || value === 'cpu') return 'wasm';
  return 'auto';
}

/**
 * Classifies a real initialization error so the UI reports the true failing stage
 * instead of labelling everything "download failed".
 *
 * Order matters: transport-level failures are checked before the generic asset
 * matchers, so a genuine network/404 problem is still reported as a download problem
 * while a runtime/backend problem is never blamed on the download.
 */
export function classifyLocalSttError(error) {
  const message = String((error && error.message) || error || '');
  const lower = message.toLowerCase();
  const explicitStage = error && error.stage;

  // A failure that already identifies its own lifecycle stage is authoritative:
  // packaged-runtime problems are never reported as download problems.
  if (explicitStage === STT_STAGE.INITIALIZING_BACKEND) {
    const isWasm = /wasm|webassembly|instantiate|magic word/.test(lower);
    return {
      stage: STT_STAGE.INITIALIZING_BACKEND,
      kind: isWasm ? 'runtime-wasm' : 'backend',
      retryLabel: 'Retry Runtime Setup'
    };
  }

  // Runtime / execution-provider failures by message shape.
  if (/failed to load wasm binary|wasm binary file|\.wasm|webassembly|magic word|instantiate/.test(lower)) {
    return { stage: STT_STAGE.INITIALIZING_BACKEND, kind: 'runtime-wasm', retryLabel: 'Retry Runtime Setup' };
  }
  if (/webgpu|requestadapter|requestdevice|gpu adapter|gpu device|navigator\.gpu/.test(lower)) {
    return { stage: STT_STAGE.INITIALIZING_BACKEND, kind: 'webgpu', retryLabel: 'Retry with CPU Fallback' };
  }

  // Transport failures (download stage), checked before generic asset matchers.
  const isTransportFailure =
    /err_(network|connection|internet|name_not_resolved|timed_out|address_unreachable|connection_refused|connection_reset)/.test(lower) ||
    /failed to fetch|networkerror|network error|load failed|fetch failed|econnrefused|econnreset|socket hang up/.test(lower);
  const isHttpStatusFailure =
    /\b(401|403|404|429|500|502|503|504)\b/.test(lower) ||
    /not found|could not be downloaded|repository not found|entry not found|unauthorized|gated repo|invalid username or password/.test(lower);

  if (isTransportFailure || isHttpStatusFailure) {
    const accessIssue = /unauthorized|gated|repository not found|invalid username/.test(lower);
    return {
      stage: STT_STAGE.DOWNLOADING,
      kind: accessIssue ? 'model-access' : 'network',
      retryLabel: 'Retry Download'
    };
  }

  // Everything else is model/pipeline initialization.
  if (/out of memory|oom|memory limit|array buffer allocation|failed to allocate|gpu buffer/.test(lower)) {
    return { stage: STT_STAGE.INITIALIZING_MODEL, kind: 'memory', retryLabel: 'Retry Initialization' };
  }
  if (/tokenizer|processor|feature extractor|preprocessor|generation_config|config\.json|special_tokens/.test(lower)) {
    return { stage: STT_STAGE.INITIALIZING_MODEL, kind: 'model-assets', retryLabel: 'Retry Initialization' };
  }
  return { stage: STT_STAGE.INITIALIZING_MODEL, kind: 'model-init', retryLabel: 'Retry Initialization' };
}

/**
 * Builds an Error carrying the lifecycle stage that failed.
 */
function stageError(message, stage, extra) {
  return Object.assign(new Error(message), { stage }, extra || {});
}

export class LocalSTTEngine {
  constructor(options = {}) {
    this.modelId = options.modelId || DEFAULT_MODEL_ID;
    this.language = options.language || 'auto'; // 'auto' | 'bn' | 'en'
    this.devicePreference = normalizeDevicePreference(options.devicePreference || options.accelerationPreference);

    // Lifecycle state
    this.stage = STT_STAGE.IDLE;
    this.lastError = null;
    this.diagnostics = [];
    this._progressActive = false;
    this._inc = { active: false, finalText: '', committedSamples: 0, busy: false };
    this._metrics = {
      modelLoadMs: null, firstInferenceMs: null,
      chunkLatencies: [], rtfValues: [],
      finalizationMs: null, audioDurationSec: 0
    };
    this._lastLevel = 0;

    // Callbacks
    this.onProgress = options.onProgress || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onError = options.onError || (() => {});

    // Audio Capture State
    this.audioContext = null;
    this.mediaStream = null;
    this.workletNode = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.silenceTimer = null;
  }

  /**
   * Internal structured diagnostic channel: always visible in DevTools, and
   * forwarded to the host UI callbacks without exposing anything sensitive.
   */
  _diagnostic(event, data) {
    const entry = { event, stage: this.stage, data, at: Date.now() };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > 200) this.diagnostics.shift();
    log(event, data || '');
  }

  _setStage(stage, message, device) {
    this.stage = stage;
    this._diagnostic('STAGE', { stage, message });
    this.onStatus({ status: stage.toLowerCase(), stage, message, device });
  }

  _fail(stage, error) {
    const classified = classifyLocalSttError(error);
    // An error that already knows its stage (e.g. backend verification) wins over
    // the stage the caller happened to be in.
    const failingStage = (error && error.stage) || stage || classified.stage;
    this.stage = STT_STAGE.ERROR;
    this.lastError = {
      message: (error && error.message) || String(error),
      stage: failingStage,
      kind: classified.kind,
      retryLabel: classified.retryLabel,
      device: activeDevice,
      attempts: (error && error.attempts) || this._attemptFailures || []
    };
    this._attemptFailures = [];
    if (this.lastError.attempts.length) {
      // Preserve every underlying exception verbatim; nothing is swallowed.
      console.error('[Whisper] INITIALIZATION ERROR — underlying exceptions:', this.lastError.attempts);
    }
    console.error(`[Whisper] INITIALIZATION ERROR [${failingStage} / ${classified.kind}]:`, this.lastError.message);
    logError(failingStage, error, {
      model: this.modelId,
      device: activeDevice,
      classifiedKind: classified.kind,
      retryLabel: classified.retryLabel
    });
    this._diagnostic('FAILED', this.lastError);
    this.onStatus({
      status: 'error',
      stage: STT_STAGE.ERROR,
      message: this.lastError.message,
      error: this.lastError
    });
    this.onError(this.lastError);
    return this.lastError;
  }

  /**
   * Checks if WebGPU is truly functional.
   * Requesting an adapter is not enough: a device must also be acquirable.
   * Returns 'WebGPU' | 'CPU fallback'.
   */
  static async detectAcceleration() {
    if (detectedAcceleration !== 'detecting') {
      return detectedAcceleration;
    }

    try {
      if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          if (typeof adapter.requestDevice === 'function') {
            const device = await adapter.requestDevice();
            if (device) {
              detectedAcceleration = 'WebGPU';
              return 'WebGPU';
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Whisper] WebGPU detection error:', e);
    }

    detectedAcceleration = 'CPU fallback';
    return 'CPU fallback';
  }

  /**
   * Initializes or returns the cached Transformers.js pipeline.
   * The pipeline is only marked READY after real session creation succeeds.
   */
  async initPipeline() {
    if (globalPipelinePromise && activeModelId === this.modelId) {
      return globalPipelinePromise;
    }

    const acceleration = await LocalSTTEngine.detectAcceleration();
    const useWebGPU =
      this.devicePreference === 'webgpu' ||
      (this.devicePreference === 'auto' && acceleration === 'WebGPU');
    const selectedDevice = useWebGPU ? 'webgpu' : 'wasm';
    const deviceLabel = useWebGPU ? 'WebGPU' : 'CPU fallback';

    this._diagnostic('INIT_START', {
      modelId: this.modelId,
      requestedPreference: this.devicePreference,
      detectedAcceleration: acceleration,
      selectedDevice
    });

    globalPipelinePromise = this._buildPipeline(selectedDevice, deviceLabel);
    // Never leave a rejected promise cached: a retry must start cleanly.
    globalPipelinePromise.catch(() => {
      globalPipelinePromise = null;
    });

    return globalPipelinePromise;
  }

  async _buildPipeline(selectedDevice, deviceLabel) {
    const releaseKeepAlive = keepServiceWorkerAlive();
    const attemptFailures = [];
    let transformers;
    this._progressActive = false;

    // Build the ordered attempt plan for the resolved preference.
    const plan = PIPELINE_ATTEMPTS.filter((attempt) => {
      if (this.devicePreference === 'wasm') return attempt.device === 'wasm';
      if (this.devicePreference === 'webgpu') return attempt.device === 'webgpu' || attempt.device === 'wasm';
      return attempt.device === selectedDevice || attempt.device === 'wasm';
    });

    try {
      this._setStage(
        STT_STAGE.INITIALIZING_BACKEND,
        `Initializing ONNX Runtime (${deviceLabel})...`,
        deviceLabel
      );
      log('Initializing ONNX Runtime backend...');

      transformers = await loadTransformers();

      if (!onnxBackendConfigured) {
        configureOnnxRuntimeBackend(transformers, this);
      }
      await verifyPackagedOnnxWasm(this);
      log('ONNX Runtime backend ready.');

      if (transformers.env) {
        transformers.env.useBrowserCache = true;
        transformers.env.allowLocalModels = false;
        transformers.env.allowRemoteModels = true; // first run downloads; later runs hit the cache
      }

      for (let i = 0; i < plan.length; i++) {
        const attempt = plan[i];
        const isLastAttempt = i === plan.length - 1;
        const attemptLabel = attempt.label;

        this._setStage(
          STT_STAGE.INITIALIZING_MODEL,
          `Initializing Whisper pipeline on ${attemptLabel} (encoder: ${attempt.dtype.encoder_model}, decoder: ${attempt.dtype.decoder_model_merged})...`,
          attemptLabel
        );
        this._diagnostic('PIPELINE_ATTEMPT_START', {
          attempt: i + 1,
          of: plan.length,
          device: attempt.device,
          dtype: attempt.dtype,
          modelId: this.modelId
        });

        try {
          this._progressActive = true;
          const pipelineT0 = performance.now();
          const pipe = await this._createPipeline(transformers, attempt, attemptLabel);
          this._progressActive = false;
          this._metrics = this._metrics || { chunkLatencies: [], rtfValues: [] };
          this._metrics.modelLoadMs = Math.round(performance.now() - pipelineT0);
          activeModelId = this.modelId;
          activeDevice = attempt.device;
          detectedAcceleration = attempt.device === 'webgpu' ? 'WebGPU' : 'CPU fallback';

          this._setStage(STT_STAGE.READY, `Local Whisper ready (${attemptLabel})`, attemptLabel);
          this._diagnostic('PIPELINE_READY', {
            modelId: this.modelId,
            device: attempt.device,
            dtype: attempt.dtype
          });
          this.onReady({ device: attemptLabel, model: this.modelId });
          return pipe;
        } catch (err) {
          this._progressActive = false;
          console.warn(`[Whisper] Pipeline attempt failed on ${attempt.device}:`, err);
          attemptFailures.push({
            device: attempt.device,
            dtype: attempt.dtype,
            message: (err && err.message) || String(err)
          });
          this._diagnostic('PIPELINE_ATTEMPT_FAILED', {
            attempt: i + 1,
            device: attempt.device,
            dtype: attempt.dtype,
            error: (err && err.message) || String(err)
          });

          // A fatal packaging error (missing wasm runtime) fails identically on every
          // execution provider, so it is surfaced immediately instead of retried.
          if (err && err.fatal) throw err;
          if (isLastAttempt) throw err;

          this._setStage(
            STT_STAGE.INITIALIZING_BACKEND,
            `${attemptLabel} initialization failed — falling back to CPU/WASM...`,
            'CPU fallback'
          );
        }
      }

      throw new Error('No Whisper execution plan was available.');
    } catch (err) {
      // Report the failing stage accurately: a download-stage error keeps its real
      // stage, everything else is a model-pipeline initialization failure.
      const failedStage = (err && err.stage) === STT_STAGE.DOWNLOADING
        ? STT_STAGE.DOWNLOADING
        : STT_STAGE.INITIALIZING_MODEL;
      err.attempts = attemptFailures;
      this._fail(failedStage, err);
      throw err;
    } finally {
      releaseKeepAlive();
    }
  }

  /**
   * Creates the automatic-speech-recognition pipeline for one execution attempt.
   */
  async _createPipeline(transformers, attempt, deviceLabel) {
    const progress_callback = (prog) => this._handleProgress(prog, deviceLabel);
    log(`Creating pipeline: device=${attempt.device} dtype=${JSON.stringify(attempt.dtype)} model=${this.modelId}`);
    const pipe = await transformers.pipeline('automatic-speech-recognition', this.modelId, {
      device: attempt.device,
      dtype: { ...attempt.dtype },
      progress_callback
    });
    log(`Pipeline created successfully on ${deviceLabel}.`);
    return pipe;
  }

  /**
   * Turns Transformers.js progress events into explicit lifecycle stages so a
   * 100% download is never rendered as "ready" and post-download work is visible.
   */
  _handleProgress(prog, deviceLabel) {
    if (!prog) return;
    // Ignore late progress events from an attempt that has already finished or failed.
    if (this._progressActive === false) return;

    const pct = typeof prog.progress === 'number' ? Math.round(prog.progress) : undefined;
    const file = prog.file || 'model asset';

    if (prog.status === 'done' || prog.status === 'ready') {
      if (this.stage !== STT_STAGE.INITIALIZING_BACKEND) {
        this._setStage(
          STT_STAGE.DOWNLOAD_COMPLETE,
          `${file} ready — verifying cache & initializing (${deviceLabel})...`,
          deviceLabel
        );
      }
    } else if (prog.status === 'progress' && pct !== undefined) {
      if (pct >= 100) {
        // Download finished for this file: the remaining time is compilation and
        // session creation, not downloading.
        this._setStage(
          STT_STAGE.DOWNLOAD_COMPLETE,
          `Downloaded ${file}. Compiling ONNX graph & initializing session (${deviceLabel})...`,
          deviceLabel
        );
      } else {
        this._setStage(STT_STAGE.DOWNLOADING, `Downloading ${file}: ${pct}%`, deviceLabel);
      }
    }

    this.onProgress(prog);
  }

  /**
   * Force pre-downloads and caches model weights. Reuses an already-initialized
   * pipeline unless a genuine re-download is requested.
   */
  async forcePreloadModel(progressCallback = () => {}) {
    if (typeof progressCallback === 'function') {
      this.onProgress = progressCallback;
    }
    if (globalPipelinePromise && activeModelId === this.modelId && this.stage === STT_STAGE.READY) {
      this._diagnostic('PRELOAD_REUSED_READY_PIPELINE', { modelId: this.modelId });
      return globalPipelinePromise;
    }
    return await this.initPipeline();
  }

  /**
   * Explicitly drops the cached pipeline so the next initialization re-reads the
   * model (used after a failed stage).
   */
  resetPipelineCache() {
    globalPipelinePromise = null;
    this.stage = STT_STAGE.IDLE;
    this._diagnostic('PIPELINE_CACHE_RESET', {});
  }

  /**
   * Reports the model cache state using the Cache Storage / IndexedDB entries
   * Transformers.js writes for the selected model.
   */
  async inspectModelCache() {
    const hubBase = `https://huggingface.co/${this.modelId}/resolve/main`;
    // The dtype-suffixed ONNX files actually used by the attempt plan (q4 for
    // webgpu, q8 -> _quantized for wasm), plus the shared tokenizer/processor assets.
    const expected = [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ];
    const report = { modelId: this.modelId, cacheStorageAvailable: false, transformersCacheKeys: [], expectedFiles: expected };

    try {
      if (typeof caches !== 'undefined' && caches.keys) {
        const keys = await caches.keys();
        report.cacheStorageAvailable = true;
        report.transformersCacheKeys = keys.filter((k) => /transformers/i.test(k));
        const bucket = keys.find((k) => /transformers/i.test(k));
        if (bucket) {
          const cache = await caches.open(bucket);
          const requests = await cache.keys();
          const urls = requests.map((r) => r.url);
          report.cachedHubFiles = expected.map((f) => ({
            file: f,
            hubUrl: `${hubBase}/${f}`,
            cached: urls.some((u) => u.indexOf(f) !== -1)
          }));
          report.totalCachedEntries = urls.length;
        }
      }
    } catch (e) {
      report.error = (e && e.message) || String(e);
    }

    this._diagnostic('MODEL_CACHE_REPORT', report);
    return report;
  }

  /**
   * Builds a copy-pasteable diagnostic report containing the actual underlying error.
   * The real exception string is never swallowed: it is kept in full for DevTools and
   * for the user to share when reporting a problem.
   */
  async buildDiagnosticReport() {
    const acceleration = await LocalSTTEngine.detectAcceleration();
    const cache = await this.inspectModelCache();

    const ortAssets = [
      { file: ORT_LOADER_FILE, method: 'GET' },
      { file: ORT_WASM_FILE, method: 'HEAD' }
    ];
    const ortAssetStatus = [];
    for (const asset of ortAssets) {
      const url = `${assetUrl(ORT_WASM_DIR)}${asset.file}`;
      let status = 'not checked';
      try {
        if (typeof fetch === 'function') {
          const res = await fetch(url, { method: asset.method });
          status = `${res.status} ${res.ok ? 'OK' : 'FAILED'} (${res.headers.get('content-length') || '?'} bytes)`;
          if (asset.method === 'GET' && res.body && res.body.cancel) {
            try { await res.body.cancel(); } catch (e) { /* no-op */ }
          }
        }
      } catch (e) {
        status = `fetch failed: ${(e && e.message) || String(e)}`;
      }
      ortAssetStatus.push({ file: asset.file, url, method: asset.method, status });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      extensionVersion: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version
        : 'unknown',
      engineStage: this.stage,
      modelId: this.modelId,
      devicePreference: this.devicePreference,
      detectedAcceleration: acceleration,
      onnxRuntime: {
        wasmPaths: assetUrl(ORT_WASM_DIR),
        loaderFile: ORT_LOADER_FILE,
        wasmBinary: ORT_WASM_FILE,
        assets: ortAssetStatus,
        numThreads: 1,
        proxy: false
      },
      attempts: PIPELINE_ATTEMPTS.map((a) => ({
        device: a.device,
        dtype: { ...a.dtype }
      })),
      lastError: this.lastError,
      modelCache: cache,
      diagnostics: this.diagnostics
    };

    this._diagnostic('DIAGNOSTIC_REPORT_BUILT', {
      stage: report.engineStage,
      lastError: report.lastError && report.lastError.message
    });
    return report;
  }

  /**
   * Renders the diagnostic report as plain text for the clipboard.
   */
  static formatDiagnosticReport(report) {
    const lines = [];
    lines.push('Voice Bilingual Professionalizer — Local Whisper diagnostics');
    lines.push('='.repeat(64));
    lines.push(`Generated:            ${report.generatedAt}`);
    lines.push(`Extension version:    ${report.extensionVersion}`);
    lines.push(`Engine stage:         ${report.engineStage}`);
    lines.push(`Model:                ${report.modelId}`);
    lines.push(`Device preference:    ${report.devicePreference}`);
    lines.push(`WebGPU detected:      ${report.detectedAcceleration}`);
    lines.push('');
    lines.push('ONNX Runtime:');
    lines.push(`  wasmPaths:          ${report.onnxRuntime.wasmPaths}`);
    lines.push(`  loader (.mjs):      ${report.onnxRuntime.loaderFile}`);
    lines.push(`  wasm binary:        ${report.onnxRuntime.wasmBinary}`);
    for (const a of report.onnxRuntime.assets || []) {
      lines.push(`  ${a.file} -> ${a.status}`);
      lines.push(`      ${a.url}`);
    }
    lines.push(`  numThreads:         ${report.onnxRuntime.numThreads}`);
    lines.push('');
    lines.push('Pipeline attempts (in order):');
    for (const a of report.attempts) {
      lines.push(`  device=${a.device}  dtype=${JSON.stringify(a.dtype)}`);
    }
    lines.push('');
    if (report.lastError) {
      lines.push('LAST ERROR:');
      lines.push(`  stage:      ${report.lastError.stage}`);
      lines.push(`  kind:       ${report.lastError.kind}`);
      lines.push(`  retryLabel: ${report.lastError.retryLabel}`);
      lines.push(`  MESSAGE:    ${report.lastError.message}`);
      if (report.lastError.attempts && report.lastError.attempts.length) {
        lines.push('  per-attempt failures:');
        for (const att of report.lastError.attempts) {
          lines.push(`    [${att.device}] dtype=${JSON.stringify(att.dtype)}`);
          lines.push(`      ${att.message}`);
        }
      }
    } else {
      lines.push('LAST ERROR: none recorded');
    }
    lines.push('');
    lines.push('Model cache:');
    lines.push(`  cacheStorageAvailable: ${report.modelCache.cacheStorageAvailable}`);
    lines.push(`  transformers buckets:  ${JSON.stringify(report.modelCache.transformersCacheKeys || [])}`);
    lines.push(`  totalCachedEntries:    ${report.modelCache.totalCachedEntries ?? 'n/a'}`);
    for (const f of report.modelCache.cachedHubFiles || []) {
      lines.push(`  ${f.cached ? '[cached] ' : '[MISSING]'} ${f.file}`);
    }
    lines.push('');
    lines.push('Lifecycle event log:');
    for (const d of report.diagnostics) {
      lines.push(`  +${String(d.at).slice(-6)} ${d.stage} ${d.event} ${JSON.stringify(d.data)}`);
    }
    return lines.join('\n');
  }

  /**
   * Starts microphone capture via AudioWorklet.
   */
  async startRecording() {
    this.audioChunks = [];
    this.isRecording = true;
    this._recordingStats = null;
    this.beginIncremental();

    // Diagnostics for the capture stage: a silent/empty capture is a different
    // problem from a model problem and must be distinguishable in the report.
    const diag = {
      hasMediaDevices: Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'),
      hasAudioWorklet: false,
      audioContextState: null,
      sampleRate: null,
      chunks: 0,
      totalSamples: 0,
      peakAmplitude: 0,
      rms: 0,
      error: null
    };
    this._recordingStats = diag;
    this._diagnostic('RECORD_START', {
      hasMediaDevices: diag.hasMediaDevices,
      origin: (typeof location !== 'undefined' && location.origin) || null
    });

    try {
      if (!diag.hasMediaDevices) {
        throw new Error(
          'navigator.mediaDevices is unavailable in this context, so microphone capture is impossible here.'
        );
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      diag.trackCount = this.mediaStream.getAudioTracks ? this.mediaStream.getAudioTracks().length : null;
      this._diagnostic('RECORD_STREAM_OK', { tracks: diag.trackCount });

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      diag.audioContextState = this.audioContext.state;
      diag.sampleRate = this.audioContext.sampleRate;
      this._captureSampleRate = this.audioContext.sampleRate;
      this._interimBusy = false;

      // A newly created AudioContext can start "suspended" (autoplay policy). If it
      // is never resumed the worklet receives no frames and the recording is empty.
      if (this.audioContext.state === 'suspended') {
        try {
          await this.audioContext.resume();
        } catch (resumeErr) {
          this._diagnostic('RECORD_RESUME_FAILED', { error: (resumeErr && resumeErr.message) || String(resumeErr) });
        }
      }
      diag.audioContextStateAfterResume = this.audioContext.state;

      // Load our AudioWorkletProcessor
      const workletUrl = assetUrl('modules/audio-recorder-worklet.js');
      await this.audioContext.audioWorklet.addModule(workletUrl);
      diag.hasAudioWorklet = true;

      const sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-recorder-processor');

      this.workletNode.port.onmessage = (event) => {
        if (event.data && event.data.type === 'AUDIO_CHUNK') {
          const chunk = new Float32Array(event.data.samples);
          this.audioChunks.push(chunk);
          diag.chunks += 1;
          diag.totalSamples += chunk.length;
          let localPeak = 0;
          let localRms = 0;
          for (let i = 0; i < chunk.length; i++) {
            const abs = Math.abs(chunk[i]);
            if (abs > localPeak) localPeak = abs;
            localRms += chunk[i] * chunk[i];
          }
          if (localPeak > diag.peakAmplitude) diag.peakAmplitude = localPeak;
          diag.rms += localRms;
          // Live input level for the "Audio detected" indicator (§9) — local only.
          this._lastLevel = chunk.length ? Math.sqrt(localRms / chunk.length) : 0;
        }
      };

      sourceNode.connect(this.workletNode);
      // Connect to destination via silent gain to keep worklet active in Chrome
      const silentGain = this.audioContext.createGain();
      silentGain.gain.value = 0;
      this.workletNode.connect(silentGain);
      silentGain.connect(this.audioContext.destination);

      this._diagnostic('RECORD_STARTED', {
        sampleRate: diag.sampleRate,
        audioContextState: this.audioContext.state,
        workletLoaded: diag.hasAudioWorklet,
        tracks: diag.trackCount
      });
      return true;
    } catch (err) {
      this.isRecording = false;
      diag.error = (err && err.message) || String(err);
      this._diagnostic('RECORD_START_FAILED', diag);
      this.onError({
        code: 'MIC_ERROR',
        message: err.message || 'Failed to initialize microphone.'
      });
      throw err;
    }
  }

  /**
   * Returns capture diagnostics for the most recent recording (chunk count, duration,
   * peak amplitude). Lets the UI tell "microphone captured nothing" apart from
   * "Whisper returned no text".
   */
  getRecordingStats() {
    const diag = this._recordingStats;
    if (!diag) return null;
    const sampleRate = diag.sampleRate || 0;
    const rms = diag.totalSamples ? Math.sqrt(diag.rms / diag.totalSamples) : 0;
    return {
      ...diag,
      rms: Number(rms.toFixed(5)),
      peakAmplitude: Number(diag.peakAmplitude.toFixed(5)),
      durationSec: sampleRate ? Number((diag.totalSamples / sampleRate).toFixed(2)) : 0
    };
  }

  /**
   * Begins an incremental transcription session: FINAL transcript accumulates
   * reconciled chunk text while INTERIM is the unstable tail of the latest window.
   * The pipeline is initialized once and kept warm (§12) — chunks never reload it.
   */
  beginIncremental() {
    this._inc = {
      active: true,
      finalText: '',
      committedSamples: 0,
      busy: false
    };
    this._metrics = {
      modelLoadMs: this._metrics && this._metrics.modelLoadMs != null ? this._metrics.modelLoadMs : null,
      firstInferenceMs: null,
      chunkLatencies: [],
      rtfValues: [],
      finalizationMs: null,
      audioDurationSec: 0
    };
    this._diagnostic('INCREMENTAL_BEGIN', {});
  }

  _totalSamples() {
    let total = 0;
    for (const c of this.audioChunks) total += c.length;
    return total;
  }

  /**
   * Merges audioChunks into one Float32Array for the sample range [from, to)
   * (at the capture sample rate). Chunk list only appends, so offsets are stable.
   */
  _mergeRange(from, to) {
    const merged = new Float32Array(Math.max(0, to - from));
    let cursor = 0;           // absolute sample index of current chunk start
    let out = 0;
    for (const c of this.audioChunks) {
      const start = cursor;
      const end = cursor + c.length;
      cursor = end;
      if (end <= from) continue;
      if (start >= to) break;
      const s = Math.max(0, from - start);
      const e = Math.min(c.length, to - start);
      if (e > s) {
        merged.set(c.subarray(s, e), out);
        out += e - s;
      }
    }
    return merged;
  }

  _generationOptions(languageHint) {
    const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false };
    const lang = languageHint || this.language;
    if (lang === 'bn' || lang === 'bn-BD') {
      opts.language = 'bengali';
      opts.task = 'transcribe';
    } else if (lang === 'en' || lang === 'en-US') {
      opts.language = 'english';
      opts.task = 'transcribe';
    }
    return opts;
  }

  static _extractText(out) {
    if (typeof out === 'string') return out;
    if (out && typeof out.text === 'string') return out.text;
    if (Array.isArray(out) && out[0]?.text) return out[0].text;
    return '';
  }

  /**
   * One incremental pass: transcribe [committed - overlap .. now], reconcile the
   * text into FINAL, and commit everything except the overlap tail. Called
   * periodically by the recorder scheduler (never per audio callback, §5).
   * Returns { finalText, chunkText, appended, latencyMs, rtf } or null.
   * Never throws — an interim failure must not kill the recording.
   */
  async transcribeIncremental(languageHint = null) {
    if (!this.isRecording || !this._inc || !this._inc.active || this._inc.busy) return null;

    const sampleRate = this._captureSampleRate || 16000;
    const total = this._totalSamples();
    const committed = Math.min(this._inc.committedSamples, total);
    const uncommitted = total - committed;
    if (uncommitted < sampleRate * INCREMENTAL.minChunkSec) return null;

    this._inc.busy = true;
    try {
      const overlapSamples = Math.min(Math.floor(sampleRate * INCREMENTAL.overlapSec), committed);
      const from = Math.max(0, committed - overlapSamples);
      const merged = this._mergeRange(from, total);
      const audio = AudioResampler.normalizeAudio(AudioResampler.resampleTo16k(merged, sampleRate, 16000));
      const audioSec = audio.length / 16000;

      const pipe = await this.initPipeline();
      const t0 = performance.now();
      const out = await pipe(audio, this._generationOptions(languageHint));
      const latencyMs = performance.now() - t0;

      if (this._metrics.firstInferenceMs == null) this._metrics.firstInferenceMs = Math.round(latencyMs);
      this._metrics.chunkLatencies.push(Math.round(latencyMs));
      const rtf = (latencyMs / 1000) / Math.max(audioSec, 0.001);
      this._metrics.rtfValues.push(Number(rtf.toFixed(3)));

      const chunkText = LocalSTTEngine._extractText(out).trim();
      const rec = reconcileTranscript(this._inc.finalText, chunkText);
      if (rec.appended) this._inc.finalText = rec.combined;

      // Commit everything except the overlap tail (it anchors the next window).
      this._inc.committedSamples = total - overlapSamples;

      this._diagnostic('INCREMENTAL_CHUNK', {
        latencyMs: Math.round(latencyMs), rtf: Number(rtf.toFixed(3)),
        audioSec: Number(audioSec.toFixed(2)), appended: rec.appended,
        overlapWords: rec.overlapWords
      });

      return {
        finalText: this._inc.finalText,
        chunkText,
        appended: rec.appended,
        latencyMs: Math.round(latencyMs),
        rtf: Number(rtf.toFixed(3))
      };
    } catch (e) {
      this._diagnostic('INCREMENTAL_FAILED', { error: (e && e.message) || String(e) });
      return null;
    } finally {
      this._inc.busy = false;
    }
  }

  /**
   * Live "interim" transcription of the rolling buffer (legacy whole-buffer pass).
   * Kept for compatibility; the recorder now uses transcribeIncremental().
   */
  async transcribeInterim(languageHint = null) {
    if (!this.isRecording || this._interimBusy) return null;

    // Snapshot the chunk list so the worklet can keep pushing new chunks meanwhile.
    const snapshot = this.audioChunks.slice();
    let totalSamples = 0;
    for (const c of snapshot) totalSamples += c.length;

    const sampleRate = this._captureSampleRate || 16000;
    const minSamples = Math.floor(sampleRate * 1.0);      // need ≥1s to be worth it
    if (totalSamples < minSamples) return null;

    this._interimBusy = true;
    try {
      const maxSamples = Math.floor(sampleRate * 28);     // stay inside one 30s window
      const dropSamples = Math.max(0, totalSamples - maxSamples);
      const merged = new Float32Array(totalSamples - dropSamples);
      let offset = 0;
      let remainingDrop = dropSamples;
      for (const c of snapshot) {
        let skip = 0;
        if (remainingDrop > 0) {
          skip = Math.min(c.length, remainingDrop);
          remainingDrop -= skip;
        }
        if (skip < c.length) {
          merged.set(c.subarray(skip), offset);
          offset += c.length - skip;
        }
      }

      const resampled16k = AudioResampler.resampleTo16k(merged, sampleRate, 16000);
      const audio = AudioResampler.normalizeAudio(resampled16k);

      const pipe = await this.initPipeline();
      const out = await pipe(audio, this._generationOptions(languageHint));
      return LocalSTTEngine._extractText(out).trim();
    } catch (e) {
      this._diagnostic('INTERIM_FAILED', { error: (e && e.message) || String(e) });
      return null;
    } finally {
      this._interimBusy = false;
    }
  }

  /**
   * Stops microphone capture and transcribes accumulated audio.
   * Incremental fast path (§10): if chunked FINAL text exists, only the remaining
   * tail (last committed boundary minus overlap → end) is transcribed and reconciled
   * — the full recording is NOT re-processed.
   */
  async stopAndTranscribe(languageHint = null) {
    this.isRecording = false;
    const incremental = this._inc && this._inc.active;

    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ command: 'stop' });
        this.workletNode.disconnect();
      } catch (e) {}
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
    }

    const sourceSampleRate = this._captureSampleRate || this.audioContext?.sampleRate || 48000;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close();
      } catch (e) {}
    }

    // Merge all recorded chunks
    let totalSamples = 0;
    for (const chunk of this.audioChunks) {
      totalSamples += chunk.length;
    }

    const stats = this.getRecordingStats();
    this._diagnostic('TRANSCRIBE_AUDIO', stats || { totalSamples });

    if (totalSamples === 0) {
      this._diagnostic('TRANSCRIBE_NO_AUDIO', {
        reason: 'no audio chunks were captured',
        stats
      });
      return {
        transcript: '',
        duration: 0,
        device: detectedAcceleration,
        audioStats: stats,
        reason: 'NO_AUDIO_CAPTURED'
      };
    }

    // ---- Incremental fast path (§10): finalize only the remaining tail. ----
    if (incremental && this._inc.finalText && this._inc.finalText.trim()) {
      const t0 = performance.now();
      const committed = Math.min(this._inc.committedSamples, totalSamples);
      const overlap = Math.min(Math.floor(sourceSampleRate * INCREMENTAL.overlapSec), committed);
      const from = Math.max(0, committed - overlap);
      let finalText = this._inc.finalText;
      let tailInferenceMs = 0;

      if (totalSamples - from > sourceSampleRate * 0.35) {
        try {
          const tailAudio = this._mergeRange(from, totalSamples);
          const audio = AudioResampler.normalizeAudio(AudioResampler.resampleTo16k(tailAudio, sourceSampleRate, 16000));
          const pipe = await this.initPipeline();
          const out = await pipe(audio, this._generationOptions(languageHint));
          tailInferenceMs = Math.round(performance.now() - t0);
          const rec = reconcileTranscript(finalText, LocalSTTEngine._extractText(out).trim());
          if (rec.appended) finalText = rec.combined;
        } catch (e) {
          // Tail finalize failed: keep the reconciled incremental FINAL as-is.
          this._diagnostic('FINALIZE_TAIL_FAILED', { error: (e && e.message) || String(e) });
        }
      } else {
        this._diagnostic('FINALIZE_TAIL_SKIPPED', { remainingSec: Number(((totalSamples - from) / sourceSampleRate).toFixed(2)) });
      }

      this._metrics.finalizationMs = tailInferenceMs;
      this._metrics.audioDurationSec = Number((totalSamples / sourceSampleRate).toFixed(2));
      this._inc.active = false;

      this._diagnostic('FINALIZED_INCREMENTAL', {
        finalizationMs: tailInferenceMs,
        finalChars: finalText.length,
        audioSec: this._metrics.audioDurationSec
      });

      return {
        transcript: finalText.trim(),
        audioDuration: this._metrics.audioDurationSec.toFixed(2),
        inferenceDuration: (tailInferenceMs / 1000).toFixed(2),
        device: activeDevice === 'webgpu' ? 'WebGPU' : 'CPU fallback',
        model: this.modelId,
        incremental: true,
        metrics: this.getPerformanceStats()
      };
    }

    const mergedBuffer = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this.audioChunks) {
      mergedBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    // Mathematically resample to 16,000 Hz Mono Float32
    const resampled16k = AudioResampler.resampleTo16k(mergedBuffer, sourceSampleRate, 16000);
    const normalizedAudio = AudioResampler.normalizeAudio(resampled16k);
    const audioDuration = resampled16k.length / 16000;

    // Run inference through local Whisper (loads/creates the pipeline if needed)
    const transcriber = await this.initPipeline();
    const targetLang = languageHint || this.language || 'auto';

    const inferenceStartTime = performance.now();
    const output = await transcriber(normalizedAudio, this._generationOptions(targetLang));
    const inferenceDuration = ((performance.now() - inferenceStartTime) / 1000).toFixed(2);

    if (this._metrics.firstInferenceMs == null) {
      this._metrics.firstInferenceMs = Math.round(performance.now() - inferenceStartTime);
    }
    this._metrics.finalizationMs = Math.round(performance.now() - inferenceStartTime);
    this._metrics.audioDurationSec = Number(audioDuration.toFixed(2));

    const rawTranscript = LocalSTTEngine._extractText(output);

    return {
      transcript: rawTranscript.trim(),
      audioDuration: audioDuration.toFixed(2),
      inferenceDuration: inferenceDuration,
      device: activeDevice === 'webgpu' ? 'WebGPU' : 'CPU fallback',
      model: this.modelId,
      incremental: false,
      metrics: this.getPerformanceStats()
    };
  }

  /**
   * Performance metrics (§11). RTF = processing time / audio duration (lower=faster).
   */
  getPerformanceStats() {
    const m = this._metrics || {};
    const avg = (arr) => (arr && arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
    return {
      modelLoadMs: m.modelLoadMs ?? null,
      firstInferenceMs: m.firstInferenceMs ?? null,
      chunkCount: m.chunkLatencies ? m.chunkLatencies.length : 0,
      avgChunkLatencyMs: avg(m.chunkLatencies),
      lastChunkLatencyMs: m.chunkLatencies && m.chunkLatencies.length ? m.chunkLatencies[m.chunkLatencies.length - 1] : null,
      finalizationMs: m.finalizationMs ?? null,
      audioDurationSec: m.audioDurationSec ?? 0,
      avgRtf: m.rtfValues && m.rtfValues.length ? Number((m.rtfValues.reduce((a, b) => a + b, 0) / m.rtfValues.length).toFixed(3)) : null,
      device: activeDevice === 'webgpu' ? 'WebGPU' : 'WASM/CPU',
      quantization: activeDevice === 'webgpu' ? 'q4 encoder + q4 decoder' : 'q8 (int8) encoder + decoder'
    };
  }

  /**
   * Most recent capture level (RMS of the last worklet chunk), for the
   * "Audio detected" indicator (§9). Computed locally — no upload.
   */
  getRecentLevel() {
    return { level: Number((this._lastLevel || 0).toFixed(4)), at: Date.now() };
  }

  cancelRecording() {
    this.isRecording = false;
    this._interimBusy = false;
    if (this._inc) this._inc.active = false;
    this.audioChunks = [];
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ command: 'stop' });
        this.workletNode.disconnect();
      } catch (e) {}
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
  }
}
