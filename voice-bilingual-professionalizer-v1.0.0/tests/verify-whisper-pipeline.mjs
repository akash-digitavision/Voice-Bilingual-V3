/**
 * Verification suite for the Local Whisper (on-device STT) pipeline.
 *
 * Run from anywhere:
 *     node tests/verify-whisper-pipeline.mjs [--verbose]
 *
 * Executes the REAL modules/local-stt-engine.js source in a stubbed extension/DOM
 * environment with a stubbed Transformers.js module, then asserts the contract that
 * fixes the "download reaches 100% then stuck on Retry download" bug.
 * Exits non-zero if any check fails.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ENGINE_PATH = process.env.WHISPER_ENGINE_PATH ||
  path.join(PROJECT_ROOT, 'modules', 'local-stt-engine.js');

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop/';
const WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm';
const LOADER_FILE = 'ort-wasm-simd-threaded.jsep.mjs';
const REMOTE_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/';

let failures = 0;
let checks = 0;
const VERBOSE = process.argv.includes('--verbose');

// The engine is intentionally chatty in DevTools; keep harness output readable.
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);
if (!VERBOSE) {
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[Whisper]')) return;
    realLog(...args);
  };
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[Whisper]')) return;
    realWarn(...args);
  };
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[Whisper]')) return;
    realError(...args);
  };
}

function check(label, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined && detail !== null) {
      console.log(`        detail: ${require$stringify(detail)}`);
    }
  }
}

function require$stringify(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------- shared state
const fetched = [];
const pipelineCalls = [];

function makeFakeTransformers({ behaviour = 'ok' } = {}) {
  const env = {
    version: '3.3.3',
    useBrowserCache: false,
    allowLocalModels: true,
    allowRemoteModels: true,
    backends: {
      onnx: {
        // Mirrors what the bundled transformers.js does at import time.
        wasm: { wasmPaths: REMOTE_CDN, proxy: false, numThreads: 4 },
        webgpu: { powerPreference: 'high-performance' }
      }
    }
  };

  async function pipeline(task, modelId, options = {}) {
    // dtype must be per-module for Whisper: resolve the encoder module dtype.
    const dtypeObj = options.dtype;
    const encoderDtype = (dtypeObj && typeof dtypeObj === 'object')
      ? dtypeObj.encoder_model
      : dtypeObj;

    pipelineCalls.push({
      task,
      modelId,
      device: options.device,
      dtype: dtypeObj,
      dtypeShape: typeof dtypeObj === 'object' ? 'per-module' : 'string',
      encoderDtype,
      decoderDtype: (dtypeObj && typeof dtypeObj === 'object') ? dtypeObj.decoder_model_merged : dtypeObj,
      wasmPathsAtCallTime: env.backends.onnx.wasm.wasmPaths,
      numThreadsAtCallTime: env.backends.onnx.wasm.numThreads
    });

    // Fail ONLY for configurations that are documented as broken.
    if (behaviour === 'webgpu-broken-decoder' && dtypeObj && dtypeObj.decoder_model_merged === 'fp16') {
      throw new Error('Error: [WebGPU] Kernel "[MatMul]" failed. Error: shared dimension does not match.');
    }

    const cb = options.progress_callback;
    if (cb) {
      cb({ status: 'progress', file: 'config.json', progress: 100 });
      cb({ status: 'progress', file: 'encoder_model.onnx', progress: 42 });
      cb({ status: 'progress', file: 'encoder_model.onnx', progress: 100 });
      cb({ status: 'progress', file: 'decoder_model_merged.onnx', progress: 100 });
      cb({ status: 'done', file: 'decoder_model_merged.onnx' });
    }

    if (behaviour === 'fail-download') {
      throw new Error('Failed to fetch model file: 404 Not Found for onnx/encoder_model.onnx');
    }
    if (behaviour === 'fail-webgpu-then-ok' && options.device === 'webgpu') {
      throw new Error('WebGPU adapter does not support required limits');
    }
    if (behaviour === 'fail-every-provider') {
      throw new Error("Can't create a session. Failed to allocate a buffer of size 2079238052.");
    }
    if (behaviour === 'fail-q4-missing' && encoderDtype === 'q4') {
      throw new Error('File not found: onnx/encoder_model_q4.onnx (404)');
    }

    return async () => ({ text: 'stub transcript' });
  }

  return { env, pipeline };
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false
  });
}

function installStubs({ transformers, availableWasmFiles = [WASM_FILE, LOADER_FILE], gpu = false }) {
  defineGlobal('chrome', {
    runtime: {
      getURL: (p) => `${EXT_ORIGIN}${String(p).replace(/^\/+/, '')}`,
      connect: () => ({ postMessage() {}, onDisconnect: { addListener() {} }, disconnect() {} })
    }
  });

  defineGlobal('window', {
    AudioContext: function () {},
    webkitAudioContext: function () {},
    transformers // the engine prefers this forward-compatible entry point
  });

  defineGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    gpu: gpu ? { requestAdapter: async () => ({ requestDevice: async () => ({}) }) } : undefined
  });

  defineGlobal('fetch', async (url, opts = {}) => {
    fetched.push({ url, method: opts.method || 'GET' });
    const name = String(url).split('/').pop();
    if (availableWasmFiles.includes(name)) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? (name.endsWith('.wasm') ? '23013109' : '49241') : null) },
        body: (opts.method === 'GET' && name.endsWith('.mjs')) ? { cancel: async () => {} } : null
      };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  });
}

async function loadEngineFresh() {
  // Cache-bust so each scenario gets fresh module-level state.
  const url = `${pathToFileURL(ENGINE_PATH).href}?t=${Date.now()}-${Math.random()}`;
  return await import(url);
}

function resetGlobals() {
  fetched.length = 0;
  pipelineCalls.length = 0;
}

// ------------------------------------------------------------------ scenario 1
async function scenarioConfigureBackend() {
  section('SCENARIO 1 — ONNX Runtime wasm path is re-pointed to the extension package');
  resetGlobals();
  const transformers = makeFakeTransformers();
  installStubs({ transformers, gpu: false });

  const { LocalSTTEngine, STT_STAGE } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  const stages = [];
  engine.onStatus = (st) => stages.push(st.stage);

  const pipe = await engine.initPipeline();

  check('pipeline instance returned', typeof pipe === 'function');
  check('pipeline called exactly once', pipelineCalls.length === 1, pipelineCalls.length);
  check(
    'wasmPaths was LOCAL at pipeline creation time',
    pipelineCalls[0] && pipelineCalls[0].wasmPathsAtCallTime === `${EXT_ORIGIN}vendor/`,
    pipelineCalls[0] && pipelineCalls[0].wasmPathsAtCallTime
  );
  check(
    'remote CDN path was replaced',
    transformers.env.backends.onnx.wasm.wasmPaths === `${EXT_ORIGIN}vendor/`,
    transformers.env.backends.onnx.wasm.wasmPaths
  );
  check('numThreads pinned to 1', pipelineCalls[0] && pipelineCalls[0].numThreadsAtCallTime === 1, pipelineCalls[0] && pipelineCalls[0].numThreadsAtCallTime);
  check('CPU device selected when no WebGPU', pipelineCalls[0] && pipelineCalls[0].device === 'wasm', pipelineCalls[0] && pipelineCalls[0].device);
  check('dtype is per-module (not a single string)',
    pipelineCalls[0] && pipelineCalls[0].dtypeShape === 'per-module',
    pipelineCalls[0] && pipelineCalls[0].dtype);
  check('WASM uses the documented q8 weights',
    pipelineCalls[0] && pipelineCalls[0].encoderDtype === 'q8' && pipelineCalls[0].decoderDtype === 'q8',
    pipelineCalls[0] && pipelineCalls[0].dtype);
  check('task is automatic-speech-recognition', pipelineCalls[0] && pipelineCalls[0].task === 'automatic-speech-recognition');
  check(
    'packaged wasm binary was verified via HEAD before pipeline creation',
    fetched.some((f) => String(f.url).endsWith(`vendor/${WASM_FILE}`) && f.method === 'HEAD'),
    fetched
  );
  check(
    'packaged ORT loader (.mjs) was verified via GET before pipeline creation',
    fetched.some((f) => String(f.url).endsWith(`vendor/${LOADER_FILE}`) && f.method === 'GET'),
    fetched
  );
  check('final stage is READY', engine.stage === STT_STAGE.READY, engine.stage);
  check(
    'stage order: INITIALIZING_BACKEND -> INITIALIZING_MODEL -> (download events) -> READY',
    stages[0] === STT_STAGE.INITIALIZING_BACKEND &&
      stages[1] === STT_STAGE.INITIALIZING_MODEL &&
      stages[stages.length - 1] === STT_STAGE.READY &&
      stages.indexOf(STT_STAGE.DOWNLOAD_COMPLETE) === 2,
    stages
  );
  check(
    '100% download produced DOWNLOAD_COMPLETE before READY',
    stages.includes(STT_STAGE.DOWNLOAD_COMPLETE) &&
      stages.indexOf(STT_STAGE.DOWNLOAD_COMPLETE) < stages.lastIndexOf(STT_STAGE.READY),
    stages
  );
  check(
    'DOWNLOADING stage reported while a file was below 100%',
    stages.includes(STT_STAGE.DOWNLOADING),
    stages
  );
}

// ------------------------------------------------------------------ scenario 2
async function scenarioPackagedWasmMissing() {
  section('SCENARIO 2 — missing packaged wasm is a RUNTIME error, not a download error');
  resetGlobals();
  const transformers = makeFakeTransformers();
  installStubs({ transformers, availableWasmFiles: [], gpu: false });

  const { LocalSTTEngine, STT_STAGE, classifyLocalSttError } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base' });
  const errors = [];
  engine.onError = (e) => errors.push(e);
  engine.onStatus = () => {};

  let threw = null;
  try {
    await engine.initPipeline();
  } catch (e) {
    threw = e;
  }

  check('initialization rejected', Boolean(threw));
  check('pipeline was never created', pipelineCalls.length === 0, pipelineCalls.length);
  const info = classifyLocalSttError(threw);
  check('classified as runtime-wasm failure', info.kind === 'runtime-wasm', info);
  check('retry label is not "Retry Download"', info.retryLabel !== 'Retry Download', info.retryLabel);
  check('engine stage is ERROR', engine.stage === STT_STAGE.ERROR, engine.stage);
  check('onError callback fired', errors.length > 0, errors.length);
  check('engine.lastError carries the failing stage', engine.lastError && engine.lastError.stage === STT_STAGE.INITIALIZING_BACKEND, engine.lastError);
}

// ------------------------------------------------------------------ scenario 3
async function scenarioErrorClassification() {
  section('SCENARIO 3 — real failures are classified by their true failing stage');
  const { classifyLocalSttError, STT_STAGE } = await loadEngineFresh();

  const cases = [
    ['Failed to fetch model file: 404 Not Found for onnx/encoder_model.onnx', STT_STAGE.DOWNLOADING, 'network'],
    ['TypeError: Failed to fetch', STT_STAGE.DOWNLOADING, 'network'],
    ["failed to load wasm binary file at 'chrome-extension://x/ort-wasm-simd-threaded.jsep.wasm'", STT_STAGE.INITIALIZING_BACKEND, 'runtime-wasm'],
    ['WebGPU device creation failed: requestDevice returned null', STT_STAGE.INITIALIZING_BACKEND, 'webgpu'],
    ['Could not locate file tokenizer.json in cache or remote host', STT_STAGE.INITIALIZING_MODEL, 'model-assets'],
    ['Array buffer allocation failed: out of memory', STT_STAGE.INITIALIZING_MODEL, 'memory'],
    ['WebAssembly.Module(): Compiling function failed: invalid opcode', STT_STAGE.INITIALIZING_BACKEND, 'runtime-wasm'],
    ['Repository not found: onnx-community/whisper-base (401)', STT_STAGE.DOWNLOADING, 'model-access']
  ];

  for (const [message, expectedStage, expectedKind] of cases) {
    const info = classifyLocalSttError(new Error(message));
    check(
      `-> ${expectedKind} (${expectedStage})`,
      info.kind === expectedKind && info.stage === expectedStage,
      { message, info }
    );
  }
}

// ------------------------------------------------------------------ scenario 4
async function scenarioWebGpuFallback() {
  section('SCENARIO 4 — WebGPU failure falls back to WASM/CPU automatically');
  resetGlobals();
  const transformers = makeFakeTransformers({ behaviour: 'fail-webgpu-then-ok' });
  installStubs({ transformers, gpu: true });

  const { LocalSTTEngine, STT_STAGE } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  const stages = [];
  engine.onStatus = (st) => stages.push(st.stage);

  const pipe = await engine.initPipeline();

  check('pipeline eventually created', typeof pipe === 'function');
  check('attempted webgpu first', pipelineCalls[0] && pipelineCalls[0].device === 'webgpu', pipelineCalls[0] && pipelineCalls[0].device);
  check('WebGPU uses per-module q4 (not the broken uniform fp16)',
    pipelineCalls[0] && pipelineCalls[0].dtypeShape === 'per-module' &&
      pipelineCalls[0].encoderDtype === 'q4' && pipelineCalls[0].decoderDtype === 'q4',
    pipelineCalls[0] && pipelineCalls[0].dtype);
  check('fell back to wasm', pipelineCalls.some((c) => c.device === 'wasm'), pipelineCalls.map((c) => c.device));
  check('wasm fallback uses q8',
    pipelineCalls.some((c) => c.device === 'wasm' && c.encoderDtype === 'q8'),
    pipelineCalls.map((c) => `${c.device}:${c.encoderDtype}`));
  check(
    'local wasm path used on every attempt',
    pipelineCalls.every((c) => c.wasmPathsAtCallTime === `${EXT_ORIGIN}vendor/`),
    pipelineCalls.map((c) => c.wasmPathsAtCallTime)
  );
  check('final stage READY', engine.stage === STT_STAGE.READY, engine.stage);
  check('fallback was surfaced in stages', stages.length >= 4, stages);
}

// ------------------------------------------------------------------ scenario 5
async function scenarioAttemptPlanAndUnderlyingErrors() {
  section('SCENARIO 5 — both providers fail: every underlying exception is preserved');

  // (a) A uniform fp16 dtype for the decoder is the documented-broken config; the
  //     engine must never request it.
  resetGlobals();
  const t1 = makeFakeTransformers({ behaviour: 'webgpu-broken-decoder' });
  installStubs({ transformers: t1, gpu: true });
  const { LocalSTTEngine: Eng1, STT_STAGE: S1 } = await loadEngineFresh();
  const e1 = new Eng1({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  e1.onStatus = () => {};
  const pipe1 = await e1.initPipeline();

  check('never requests a uniform string dtype', pipelineCalls.every((c) => c.dtypeShape === 'per-module'),
    pipelineCalls.map((c) => c.dtype));
  check('never requests fp16 for the broken decoder',
    pipelineCalls.every((c) => c.decoderDtype !== 'fp16'),
    pipelineCalls.map((c) => c.decoderDtype));
  check('succeeds with the documented config', typeof pipe1 === 'function' && e1.stage === S1.READY, e1.stage);

  // (b) Both providers fail -> the real exceptions must survive in the report.
  resetGlobals();
  const t2 = makeFakeTransformers({ behaviour: 'fail-every-provider' });
  installStubs({ transformers: t2, gpu: true });
  const { LocalSTTEngine: Eng2, STT_STAGE: S2 } = await loadEngineFresh();
  const e2 = new Eng2({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  e2.onStatus = () => {};
  e2.onError = () => {};

  let threw = null;
  try { await e2.initPipeline(); } catch (e) { threw = e; }

  check('both providers were attempted', pipelineCalls.length === 2, pipelineCalls.map((c) => c.device));
  check('attempt order is webgpu then wasm',
    JSON.stringify(pipelineCalls.map((c) => c.device)) === JSON.stringify(['webgpu', 'wasm']),
    pipelineCalls.map((c) => c.device));
  check('initialization rejected', Boolean(threw));
  check('engine stage is ERROR', e2.stage === S2.ERROR, e2.stage);
  check('reported stage is INITIALIZING_MODEL',
    e2.lastError && e2.lastError.stage === S2.INITIALIZING_MODEL, e2.lastError);
  check('per-attempt underlying exceptions preserved',
    e2.lastError && Array.isArray(e2.lastError.attempts) && e2.lastError.attempts.length === 2,
    e2.lastError && e2.lastError.attempts);
  check('underlying message text is not swallowed',
    e2.lastError && e2.lastError.attempts.every((a) => /Failed to allocate a buffer/.test(a.message)),
    e2.lastError && e2.lastError.attempts);
}

// ------------------------------------------------------------------ scenario 6
async function scenarioFailureStageReporting() {
  section('SCENARIO 6 — a real download failure is still reported as a download failure');
  resetGlobals();
  const transformers = makeFakeTransformers({ behaviour: 'fail-download' });
  installStubs({ transformers, gpu: false });

  const { LocalSTTEngine, STT_STAGE } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  engine.onStatus = () => {};
  engine.onError = () => {};

  let threw = null;
  try {
    await engine.initPipeline();
  } catch (e) {
    threw = e;
  }

  check('initialization rejected', Boolean(threw));
  check('engine stage is ERROR', engine.stage === STT_STAGE.ERROR, engine.stage);
  check('retry label is "Retry Download"', engine.lastError && engine.lastError.retryLabel === 'Retry Download', engine.lastError);
  check('classified kind is network', engine.lastError && engine.lastError.kind === 'network', engine.lastError);
}

// ------------------------------------------------------------------ scenario 7
async function scenarioEngineSourceFacts() {
  section('SCENARIO 7 — engine source targets the packaged wasm and never a remote CDN');
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(ENGINE_PATH, 'utf8');

  check('references the packaged vendor/ wasm directory', source.includes("ORT_WASM_DIR = 'vendor/'"));
  check('names the bundled ORT wasm file', source.includes(WASM_FILE));
  check('names the bundled ORT loader (.mjs) file', source.includes(LOADER_FILE));
  check('does not hardcode a remote executable-code CDN URL', !/jsdelivr/.test(source));
  check(
    'sets wasmPaths before pipeline creation',
    source.indexOf('wasmPaths = wasmDir') !== -1 &&
      source.indexOf('wasmPaths = wasmDir') < source.indexOf("transformers.pipeline('automatic-speech-recognition'")
  );
  check('exposes explicit lifecycle stages', source.includes('INITIALIZING_BACKEND') && source.includes('DOWNLOAD_COMPLETE'));
  check('exports classifyLocalSttError for the UI layer', source.includes('export function classifyLocalSttError'));
}

// ------------------------------------------------------------------ scenario 8
async function scenarioUiWiring() {
  section('SCENARIO 8 — UI wiring reports the true lifecycle stage (no false "download" labels)');
  const fs = await import('node:fs/promises');
  const read = async (rel) => await fs.readFile(path.join(PROJECT_ROOT, rel), 'utf8');

  const optionsJs = await read('options.js');
  const optionsHtml = await read('options.html');
  const popupJs = await read('popup.js');
  const manifest = JSON.parse(await read('manifest.json'));

  check('options.js imports the stage constants and classifier',
    optionsJs.includes('STT_STAGE') && optionsJs.includes('classifyLocalSttError'));
  check('options.js uses explicit stages for messages',
    optionsJs.includes('STT_STAGE.DOWNLOAD_COMPLETE') && optionsJs.includes('STT_STAGE.INITIALIZING_BACKEND'));
  check('options.js distinguishes download vs initialization retry labels',
    optionsJs.includes('Retry Whisper Download') && optionsJs.includes('Retry Model Initialization'));
  check('options.js includes the local-runtime verification flow',
    optionsJs.includes('runWhisperSetup') && optionsJs.includes('btn-verify-whisper'));
  check('options.html declares the verify button',
    optionsHtml.includes('id="btn-verify-whisper"'));
  check('options.html declares the diagnostics copy button',
    optionsHtml.includes('id="btn-copy-whisper-report"'));
  check('options.html declares the visible raw-error panel',
    optionsHtml.includes('id="whisper-error-detail"'));
  check('options.html still declares the original download button unchanged',
    optionsHtml.includes('id="btn-force-download-whisper"'));
  check('options.html no longer loads the ESM bundle as a classic script',
    !/<script\s+src="vendor\/transformers\.js"/.test(optionsHtml));

  const popupHtml = await read('popup.html');
  check('popup.html no longer loads the ESM bundle as a classic script',
    !/<script\s+src="vendor\/transformers\.js"/.test(popupHtml));
  check('popup.html still loads the popup module',
    /<script\s+type="module"\s+src="popup\.js">/.test(popupHtml));
  check('popup.html keeps the Ctrl+Shift+X shortcut hint',
    popupHtml.includes('Ctrl+Shift+X'));

  check('popup.js imports the classifier', popupJs.includes('classifyLocalSttError'));
  check('popup.js keeps cloud Web Speech path intact',
    popupJs.includes('new SpeechService(') && popupJs.includes('speech.start()'));
  check('popup.js still supports switching back to cloud STT',
    popupJs.includes("settings.speechEngine = 'cloud'"));
  check('popup.js surfaces the local stage without freezing the UI',
    popupJs.includes('applyLocalSttStage'));
  check('popup.js no longer blames the download for every local failure',
    !popupJs.includes('Local Whisper Diagnostic'));
  check('popup.js includes the raw error message in its guidance',
    popupJs.includes('(e && e.message)') || popupJs.includes('e?.message'));

  // Manifest command wiring: the original Ctrl+Shift+X shortcut must be untouched.
  check('manifest still binds Ctrl+Shift+X to the action',
    manifest.commands &&
      manifest.commands._execute_action &&
      manifest.commands._execute_action.suggested_key &&
      manifest.commands._execute_action.suggested_key.default === 'Ctrl+Shift+X',
    manifest.commands);
  check('manifest keeps the Mac Command+Shift+X binding',
    manifest.commands._execute_action.suggested_key.mac === 'Command+Shift+X');
  check('manifest keeps the Alt+Shift+X overlay command',
    Boolean(manifest.commands['toggle-voice-overlay']));
  check('manifest keeps the default popup for the action',
    manifest.action && manifest.action.default_popup === 'popup.html');
  check('manifest kept wasm-unsafe-eval for WebAssembly compilation',
    manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"));

  const war = manifest.web_accessible_resources[0].resources;
  check('manifest exposes the packaged ORT wasm to extension pages',
    war.includes('vendor/*.wasm'), war);
  check('manifest exposes the packaged ORT loader (.mjs) to extension pages',
    war.includes('vendor/*.mjs'), war);
  check('manifest still exposes the transformers bundle', war.includes('vendor/*.js'), war);
  check('manifest keeps offscreen permission for the existing architecture',
    manifest.permissions.includes('offscreen'));
  check('manifest CSP was not widened with an executable-code CDN',
    !/jsdelivr/.test(manifest.content_security_policy.extension_pages));

  // Offscreen recorder wiring: recording must live in a persistent context, not the
  // popup (MV3 popups are destroyed on blur, killing the AudioContext mid-recording).
  const offscreenHtml = await read('offscreen.html');
  const offscreenJs = await read('offscreen-recorder.js');
  const backgroundJs = await read('background.js');

  check('offscreen recorder page exists', offscreenHtml.includes('offscreen-recorder.js'));
  check('offscreen recorder imports the real engine',
    offscreenJs.includes("from './modules/local-stt-engine.js'"));
  check('offscreen recorder handles recorder commands',
    offscreenJs.includes("msg.target !== 'offscreen'") &&
      offscreenJs.includes("'RECORD_START'") && offscreenJs.includes("'RECORD_STOP'") &&
      offscreenJs.includes("'RECORD_CANCEL'") && offscreenJs.includes("'RECORD_STATE'"));
  check('offscreen recorder persists the last result for diagnostics',
    offscreenJs.includes('whisperLastResult'));
  check('background ensures the offscreen document exists',
    backgroundJs.includes('ensureWhisperOffscreen') && backgroundJs.includes('createDocument'));
  check('offscreen document declares the USER_MEDIA reason',
    backgroundJs.includes("'USER_MEDIA'"));
  check('background relays WHISPER_CMD to the offscreen recorder',
    backgroundJs.includes("'WHISPER_CMD'") && backgroundJs.includes("target: 'offscreen'"));
  check('popup no longer owns microphone capture directly',
    !popupJs.includes('localSTTEngine.startRecording'));
  check('popup drives the offscreen recorder via messaging',
    popupJs.includes("'WHISPER_CMD'") && popupJs.includes("'RECORD_START'") &&
      popupJs.includes("'RECORD_STOP'"));
  check('popup reattaches to an in-flight background recording',
    popupJs.includes("'RECORD_STATE'"));
  check('popup listens for offscreen status broadcasts',
    popupJs.includes('WHISPER_STATUS') && popupJs.includes('WHISPER_RESULT'));

  // Live interim typing: Whisper is batch, so the rolling buffer is re-transcribed
  // periodically to mirror Web Speech API's interim results.
  const engineSrc = await read('modules/local-stt-engine.js');
  const offscreenSrc = await read('offscreen-recorder.js');
  check('engine implements interim (rolling-buffer) transcription',
    engineSrc.includes('transcribeInterim') && engineSrc.includes('_interimBusy'));
  check('interim pass never closes the recording (separate from stopAndTranscribe)',
    engineSrc.indexOf('transcribeInterim') !== -1 &&
      engineSrc.indexOf('transcribeInterim') < engineSrc.indexOf('stopAndTranscribe'));
  check('interim bounds the window to one 30s Whisper pass',
    engineSrc.includes('maxSamples'));
  check('offscreen recorder runs the interim loop and broadcasts live text',
    offscreenSrc.includes('WHISPER_INTERIM') && offscreenSrc.includes('setInterval') &&
      offscreenSrc.includes('stopInterimLoop'));
  check('popup renders interim text live during recording',
    popupJs.includes('WHISPER_INTERIM'));

  // Shortcut diagnostics: the binding itself cannot be re-bound from code; the
  // service worker must at least surface the ground truth.
  check('background logs the actual registered shortcuts at startup',
    backgroundJs.includes('commands.getAll') && backgroundJs.includes('UNASSIGNED'));
  check('detached-window creation is hardened against stale off-screen positions',
    backgroundJs.includes('detached window creation failed, retrying'));

  // The packaged runtime must actually be present and be a real WebAssembly module.
  const fsSync = await import('node:fs');
  const wasmPath = path.join(PROJECT_ROOT, 'vendor', WASM_FILE);
  const loaderPath = path.join(PROJECT_ROOT, 'vendor', LOADER_FILE);
  check('packaged wasm binary exists on disk', fsSync.existsSync(wasmPath), wasmPath);
  check('packaged ORT loader (.mjs) exists on disk', fsSync.existsSync(loaderPath), loaderPath);
  if (fsSync.existsSync(loaderPath)) {
    const loader = fsSync.readFileSync(loaderPath, 'utf8');
    check('ORT loader references the wasm binary it will fetch',
      loader.includes(WASM_FILE) && /export default/.test(loader),
      { hasWasmRef: loader.includes(WASM_FILE), hasDefaultExport: /export default/.test(loader) });
  }
  if (fsSync.existsSync(wasmPath)) {
    const stat = fsSync.statSync(wasmPath);
    check('packaged wasm binary is non-trivial (>10 MB)', stat.size > 10 * 1024 * 1024, stat.size);
    const head = Buffer.alloc(4);
    const fd = fsSync.openSync(wasmPath, 'r');
    fsSync.readSync(fd, head, 0, 4, 0);
    fsSync.closeSync(fd);
    check('packaged wasm binary has the WebAssembly magic header',
      head.toString('hex') === '0061736d', head.toString('hex'));
  }
}

// ------------------------------------------------------------------ scenario 9
async function scenarioFatalPackagingErrorNotRetried() {
  section('SCENARIO 9 — fatal packaging error is not retried on the CPU fallback');
  resetGlobals();
  const transformers = makeFakeTransformers();
  installStubs({ transformers, availableWasmFiles: [], gpu: true });

  const { LocalSTTEngine, STT_STAGE } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base', devicePreference: 'webgpu' });
  engine.onStatus = () => {};
  engine.onError = () => {};

  let threw = null;
  try {
    await engine.initPipeline();
  } catch (e) {
    threw = e;
  }

  check('initialization rejected', Boolean(threw));
  check('pipeline creation was never attempted', pipelineCalls.length === 0, pipelineCalls.length);
  check('no pointless CPU fallback retry happened',
    !engine.diagnostics.some((d) => d.event === 'WEBGPU_FALLBACK'),
    engine.diagnostics.map((d) => d.event));
  check('engine stage is ERROR', engine.stage === STT_STAGE.ERROR, engine.stage);
  check('reported stage is the backend stage',
    engine.lastError && engine.lastError.stage === STT_STAGE.INITIALIZING_BACKEND,
    engine.lastError);
}

// ------------------------------------------------------------------ scenario 10
async function scenarioPipelineReuse() {
  section('SCENARIO 10 — a READY pipeline is reused, and a failed one is not cached');
  resetGlobals();
  const transformers = makeFakeTransformers();
  installStubs({ transformers, gpu: false });

  const { LocalSTTEngine, STT_STAGE } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  engine.onStatus = () => {};

  await engine.initPipeline();
  await engine.forcePreloadModel();
  await engine.initPipeline();

  check('pipeline created once and reused', pipelineCalls.length === 1, pipelineCalls.length);
  check('stage remains READY after reuse', engine.stage === STT_STAGE.READY, engine.stage);

  engine.resetPipelineCache();
  check('resetPipelineCache clears the cached pipeline', engine.stage === STT_STAGE.IDLE, engine.stage);
}

// ------------------------------------------------------------------ scenario 11
async function scenarioDiagnosticReport() {
  section('SCENARIO 11 — diagnostic report exposes the real error and the wasm asset state');
  resetGlobals();
  const transformers = makeFakeTransformers({ behaviour: 'fail-every-provider' });
  installStubs({ transformers, gpu: true });

  const { LocalSTTEngine, STT_STAGE } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  engine.onStatus = () => {};
  engine.onError = () => {};
  try { await engine.initPipeline(); } catch (e) { /* expected */ }

  const report = await engine.buildDiagnosticReport();
  const text = LocalSTTEngine.formatDiagnosticReport(report);

  check('report records the engine stage', report.engineStage === STT_STAGE.ERROR, report.engineStage);
  check('report records the model id', report.modelId === 'onnx-community/whisper-base');
  check('report records BOTH packaged ORT assets',
    Array.isArray(report.onnxRuntime.assets) && report.onnxRuntime.assets.length === 2 &&
      report.onnxRuntime.assets.some((a) => a.file === WASM_FILE && String(a.url).endsWith(`vendor/${WASM_FILE}`)) &&
      report.onnxRuntime.assets.some((a) => a.file === LOADER_FILE && String(a.url).endsWith(`vendor/${LOADER_FILE}`)),
    report.onnxRuntime.assets);
  check('report records both assets as reachable',
    report.onnxRuntime.assets.every((a) => a.status.includes('200')),
    report.onnxRuntime.assets);
  check('report records both attempt plans',
    report.attempts.length === 2 &&
      report.attempts[0].device === 'webgpu' && report.attempts[0].dtype.encoder_model === 'q4' &&
      report.attempts[1].device === 'wasm' && report.attempts[1].dtype.encoder_model === 'q8',
    report.attempts);
  check('report includes the raw underlying error text',
    report.lastError && /Failed to allocate a buffer/.test(report.lastError.message),
    report.lastError && report.lastError.message);
  check('report includes per-attempt errors',
    report.lastError && report.lastError.attempts.length === 2,
    report.lastError && report.lastError.attempts);
  check('formatted text contains the real exception', /Failed to allocate a buffer/.test(text));
  check('formatted text contains the lifecycle log', /Lifecycle event log/.test(text));
  check('formatted text is copy-pasteable (multi-line)', text.split('\n').length > 20, text.split('\n').length);
}

// ------------------------------------------------------------------ scenario 12
// Web Speech lifecycle (Shift Browser compatibility) with a mocked SpeechRecognition.
// Verifies the MANUAL-RETRY-ONLY Web Speech contract: one user action = exactly one
// recognition attempt; failure surfaces the real error immediately; NO automatic
// retries of any kind; fresh instance per attempt; duplicate starts ignored;
// session stable while listening.
class MockSpeechRecognition {
  constructor() {
    MockSpeechRecognition.instances.push(this);
  }
  start() {
    MockSpeechRecognition.startCalls++;
    const b = MockSpeechRecognition.behavior;
    if (b === 'throw') {
      throw Object.assign(new Error('InvalidStateError: recognition has already started'), { name: 'InvalidStateError' });
    }
    if (b === 'error-network') {
      setTimeout(() => this.onerror && this.onerror({ error: 'network' }), 5);
      return;
    }
    if (b === 'error-not-allowed') {
      setTimeout(() => this.onerror && this.onerror({ error: 'not-allowed' }), 5);
      return;
    }
    if (b === 'immediate-end') {
      // THE SHIFT SYMPTOM: onstart fires, then the session immediately ends.
      setTimeout(() => this.onstart && this.onstart(), 5);
      setTimeout(() => this.onend && this.onend(), 40);
      return;
    }
    if (b === 'no-speech-instant') {
      setTimeout(() => this.onstart && this.onstart(), 5);
      setTimeout(() => this.onerror && this.onerror({ error: 'no-speech' }), 40);
      return;
    }
    setTimeout(() => this.onstart && this.onstart(), 5);
  }
  stop() { setTimeout(() => this.onend && this.onend(), 5); }
  abort() { setTimeout(() => this.onend && this.onend(), 5); }
}

async function scenarioWebSpeechLifecycle() {
  section('SCENARIO 12 — Web Speech lifecycle: ONE attempt per user action, manual retry only');
  // SpeechService lives in its own module (pure Web Speech abstraction).
  const speechUrl = `${pathToFileURL(path.join(PROJECT_ROOT, 'modules', 'speech.js')).href}?t=${Date.now()}-${Math.random()}`;
  const { SpeechService } = await import(speechUrl);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // (a) Failure → the real error surfaces immediately; NO automatic second attempt.
  //     Waiting far beyond any historical backoff proves there is no hidden retry.
  MockSpeechRecognition.instances = [];
  MockSpeechRecognition.startCalls = 0;
  MockSpeechRecognition.behavior = 'error-network';
  Object.defineProperty(globalThis, 'window', {
    value: { SpeechRecognition: MockSpeechRecognition }, writable: true, configurable: true
  });
  const svc1 = new SpeechService({ language: 'en-US' });
  const errors1 = [];
  svc1.onError = (e) => errors1.push(e);
  svc1.onEnd = () => {};
  svc1.start();
  await sleep(1500);
  check('manual-only: one start() = exactly ONE recognition attempt',
    MockSpeechRecognition.startCalls === 1, MockSpeechRecognition.startCalls);
  check('manual-only: NO automatic retry after failure (1.5s watch window)',
    MockSpeechRecognition.startCalls === 1 && MockSpeechRecognition.instances.length === 1,
    { startCalls: MockSpeechRecognition.startCalls, instances: MockSpeechRecognition.instances.length });
  check('failure surfaces the REAL error code immediately',
    errors1.length === 1 && errors1[0].code === 'network', errors1);

  // (b) MANUAL retry: a second user action (start()) = exactly ONE new attempt,
  //     on a FRESH recognition instance, with no overlap of the old one.
  const instancesBeforeManual = MockSpeechRecognition.instances.length;
  svc1.start();
  await sleep(120);
  check('manual retry: one user action = one new attempt on a fresh instance',
    MockSpeechRecognition.startCalls === 2 &&
      MockSpeechRecognition.instances.length === instancesBeforeManual + 1,
    { startCalls: MockSpeechRecognition.startCalls, instances: MockSpeechRecognition.instances.length });

  // (c) Success → LISTENING; duplicate start() ignored while active.
  MockSpeechRecognition.instances = [];
  MockSpeechRecognition.startCalls = 0;
  MockSpeechRecognition.behavior = 'ok';
  const svc2 = new SpeechService({ language: 'en-US' });
  let started2 = 0;
  svc2.onStart = () => { started2++; };
  svc2.onError = () => {};
  svc2.onEnd = () => {};
  svc2.start();
  await sleep(120);
  check('successful attempt reaches LISTENING',
    started2 === 1 && svc2.isRecording === true && svc2.state === 'LISTENING',
    { started2, state: svc2.state });

  // (d) Session STAYS STABLE while listening — no restarts/teardowns behind the UI.
  const stableCount = MockSpeechRecognition.instances.length;
  await sleep(300);
  check('session stable while popup open (no restart, no re-init)',
    svc2.state === 'LISTENING' && MockSpeechRecognition.instances.length === stableCount,
    { state: svc2.state, instances: MockSpeechRecognition.instances.length });

  // (e) Duplicate start() is ignored while a session is active.
  svc2.start();
  await sleep(50);
  check('duplicate start() ignored — single active instance',
    MockSpeechRecognition.instances.length === stableCount,
    { before: stableCount, after: MockSpeechRecognition.instances.length });

  // (f) User stop ends the session cleanly.
  svc2.stop();
  await sleep(60);
  check('stop() ends the session (ENDED, not recording)',
    svc2.state === 'ENDED' && svc2.isRecording === false, svc2.state);

  // (g) Permanent error (not-allowed) surfaces immediately, one attempt only.
  MockSpeechRecognition.instances = [];
  MockSpeechRecognition.startCalls = 0;
  MockSpeechRecognition.behavior = 'error-not-allowed';
  const svc3 = new SpeechService({ language: 'en-US' });
  const errors3 = [];
  svc3.onError = (e) => errors3.push(e);
  svc3.onEnd = () => {};
  svc3.start();
  await sleep(1200);
  check('permanent error surfaces immediately (one attempt, no retry)',
    MockSpeechRecognition.startCalls === 1 && errors3.length === 1 && errors3[0].code === 'not-allowed',
    { startCalls: MockSpeechRecognition.startCalls, errors: errors3 });

  // (h) THE SHIFT SYMPTOM: onstart then immediate onend. One attempt = one session
  //     that ends; the real outcome reaches the UI (onEnd) with NO auto restart.
  //     Recovery is the user pressing Retry (manual), exactly as requested.
  MockSpeechRecognition.instances = [];
  MockSpeechRecognition.startCalls = 0;
  MockSpeechRecognition.behavior = 'immediate-end';
  const svc4 = new SpeechService({ language: 'en-US' });
  const errors4 = [];
  let endCalls4 = 0;
  svc4.onError = (e) => errors4.push(e);
  svc4.onEnd = () => { endCalls4++; };
  svc4.start();
  await sleep(1500);
  check('immediate-end: exactly ONE attempt (no automatic restart)',
    MockSpeechRecognition.startCalls === 1, MockSpeechRecognition.startCalls);
  check('immediate-end: session end surfaced to the UI (onEnd fired)',
    endCalls4 === 1 && svc4.state === 'ENDED', { endCalls4, state: svc4.state });

  // (i) Instant no-speech: surfaced immediately, one attempt, no retry.
  MockSpeechRecognition.instances = [];
  MockSpeechRecognition.startCalls = 0;
  MockSpeechRecognition.behavior = 'no-speech-instant';
  const svc5 = new SpeechService({ language: 'en-US' });
  const errors5 = [];
  svc5.onError = (e) => errors5.push(e);
  svc5.onEnd = () => {};
  svc5.start();
  await sleep(1200);
  check('instant no-speech surfaces immediately (one attempt, no retry)',
    MockSpeechRecognition.startCalls === 1 && errors5.length === 1 && errors5[0].code === 'no-speech',
    { startCalls: MockSpeechRecognition.startCalls, errors: errors5 });
}

// ------------------------------------------------------------------ scenario 13
async function scenarioWebSpeechWiringAndSeparation() {
  section('SCENARIO 13 — Web Speech wiring, shortcut diagnostics, settings instructions, path separation');
  const fs = await import('node:fs/promises');
  const read = async (rel) => await fs.readFile(path.join(PROJECT_ROOT, rel), 'utf8');

  const speechSrc = await read('modules/speech.js');
  const popupJs = await read('popup.js');
  const sidepanelJs = await read('sidepanel.js');
  const backgroundJs = await read('background.js');
  const contentJs = await read('content.js');
  const optionsHtml = await read('options.html');
  const engineSrc = await read('modules/local-stt-engine.js');

  check('WebSpeech lifecycle logs the real error and attempts',
    speechSrc.includes('[WebSpeech]') && speechSrc.includes('start requested') && speechSrc.includes('onerror'));
  check('WebSpeech logs the full recognition event chain (audio/sound/speech start)',
    speechSrc.includes('onaudiostart') && speechSrc.includes('onsoundstart') && speechSrc.includes('onspeechstart'));
  check('WebSpeech uses the explicit state machine',
    speechSrc.includes("STARTING: 'STARTING'") && speechSrc.includes("LISTENING: 'LISTENING'") &&
      speechSrc.includes("STOPPING: 'STOPPING'"));
  check('NO automatic retry machinery remains (removed per directive)',
    !speechSrc.includes('_scheduleRetry') && !speechSrc.includes('RETRY_DELAYS') &&
      !speechSrc.includes('MAX_ATTEMPTS') && !speechSrc.includes('_beginRetry') &&
      !speechSrc.includes('onRetry') && !speechSrc.includes('_retryPending'));
  check('one attempt per user action (no onerror/onend → start recursion)',
    (() => {
      // Extract ONLY the onerror and onend handler bodies and assert neither
      // triggers a new attempt.
      const onerrStart = speechSrc.indexOf('recognition.onerror');
      const onendStart = speechSrc.indexOf('recognition.onend');
      const handlerEnd = speechSrc.indexOf('return recognition;');
      if (onerrStart < 0 || onendStart < 0 || handlerEnd < 0) return false;
      const onerrorBody = speechSrc.slice(onerrStart, onendStart);
      const onendBody = speechSrc.slice(onendStart, handlerEnd);
      const startsRecognition = (body) => /_attemptStart|this\.recognition\.start\(|\.start\(\)/.test(body);
      return !startsRecognition(onerrorBody) && !startsRecognition(onendBody);
    })());

  check('popup aborts the old session before creating a new one',
    popupJs.includes('speech.abort()') && popupJs.includes('creating Web Speech session'));
  check('popup cleans up recognition on close (pagehide/unload)',
    popupJs.includes("addEventListener('pagehide'") && popupJs.includes('recognition aborted on close'));
  check('popup logs the popup-open → start() delay for diagnostics',
    popupJs.includes('POPUP_OPENED_AT') && popupJs.includes('msSincePopupOpen'));
  check('manual Retry UI remains available (mic button + Try Again, no auto retry)',
    popupJs.includes("btnErrorRetry.addEventListener") && popupJs.includes("btnMic.addEventListener"));
  check('sidepanel cleans up recognition on close',
    sidepanelJs.includes("addEventListener('pagehide'") && sidepanelJs.includes('speech.abort()'));

  check('background logs received shortcut commands',
    backgroundJs.includes('[Shortcut] command received'));
  check('background logs ground-truth shortcut bindings at startup',
    backgroundJs.includes('commands.getAll'));
  check('content script logs whether the in-page shortcut fallback fires',
    contentJs.includes('[Shortcut] in-page Ctrl+Shift+X captured'));

  check('settings include the graphics-acceleration instruction',
    optionsHtml.includes('chrome://settings/system') && optionsHtml.includes('Use graphics acceleration when available'));
  check('settings include the WebGPU verification instruction',
    optionsHtml.includes('chrome://gpu') && optionsHtml.includes('Graphics Feature Status'));
  check('settings include the chrome://flags WebGPU enable instruction',
    optionsHtml.includes('chrome://flags') && optionsHtml.includes('#enable-unsafe-webgpu') &&
      optionsHtml.includes('when WebGPU is genuinely missing'));
  check('settings keep the existing chrome://extensions/shortcuts instructions',
    optionsHtml.includes('chrome://extensions/shortcuts'));
  check('settings document the Shift Ctrl+Shift+X conflict without unsafe workarounds',
    optionsHtml.includes('Shift Browser users'));

  // Microphone audio-chain diagnostic wiring (Shift triage).
  const micDiagSrc = await read('modules/mic-diagnostic.js');
  const optionsJs = await read('options.js');
  check('mic diagnostic module exists and probes every chain stage',
    micDiagSrc.includes('getUserMedia') && micDiagSrc.includes('AudioWorklet') &&
      micDiagSrc.includes('enumerateDevices') && micDiagSrc.includes('permissions'));
  check('mic diagnostic measures real frames (peak/RMS), stores nothing',
    micDiagSrc.includes('peak') && micDiagSrc.includes('rms') && !micDiagSrc.includes('fetch('));
  check('mic diagnostic reuses the packaged worklet (no new audio architecture)',
    micDiagSrc.includes('modules/audio-recorder-worklet.js'));
  check('options declares the mic-test button and output panel',
    optionsHtml.includes('id="btn-run-mic-test"') && optionsHtml.includes('id="mic-test-output"'));
  check('options runs the diagnostic and persists the result for the report',
    optionsJs.includes('runAudioChainDiagnostic') && optionsJs.includes('lastMicTest'));
  check('popup guides to the mic test and Local engine on persistent speech-service errors',
    popupJs.includes('Test Microphone (audio chain)') && popupJs.includes('Local (Whisper)'));

  // Shift: cloud recognition is impossible without the Google speech backend. The
  // network-exhausted error must say so and offer a one-click Local engine switch.
  check('popup fixes the saveSettings import (cloud-switch button no longer crashes)',
    /import\s*\{[^}]*saveSettings[^}]*\}\s*from\s*'\.\/modules\/storage\.js'/.test(popupJs));
  check('popup.html declares the Local (Whisper) switch button',
    (await read('popup.html')).includes('id="btn-switch-local-stt"'));
  check('popup handles the Local switch: persists engine and restarts recording',
    popupJs.includes('btn-switch-local-stt') && popupJs.includes("saveSettings({ speechEngine: 'local' })"));
  check('network-exhausted error names the missing speech service and offers Local',
    popupJs.includes('speech service is unreachable') && popupJs.includes('showLocalSwitch = true'));
  check('copy diagnostics includes the last mic test',
    optionsJs.includes('formatMicReport'));

  // Chunked incremental Whisper + provider modes (§3–§12, §22).
  const engineSrcInc = await read('modules/local-stt-engine.js');
  const offscreenSrc = await read('offscreen-recorder.js');
  const storageSrc = await read('modules/storage.js');
  check('engine implements chunked incremental transcription with reconciliation',
    engineSrcInc.includes('transcribeIncremental') && engineSrcInc.includes('beginIncremental') &&
      engineSrcInc.includes('reconcileTranscript'));
  check('engine exposes RTF/performance stats (§11)',
    engineSrcInc.includes('getPerformanceStats') && engineSrcInc.includes('rtf'));
  check('engine exposes local audio level for the indicator (§9)',
    engineSrcInc.includes('getRecentLevel'));
  check('stop fast-path finalizes the tail without full re-transcription (§10)',
    engineSrcInc.includes('FINALIZED_INCREMENTAL') || engineSrcInc.includes('FINALIZE_TAIL'));
  check('offscreen drives the incremental loop and broadcasts live text + level',
    offscreenSrc.includes('transcribeIncremental') && offscreenSrc.includes('WHISPER_INTERIM') &&
      offscreenSrc.includes('WHISPER_LEVEL'));
  check('popup renders audio-level detection state (§9)',
    popupJs.includes('WHISPER_LEVEL') && popupJs.includes('Audio detected'));
  check('popup implements Auto mode with capability memory (§4/§22)',
    popupJs.includes("mode === 'auto'") && popupJs.includes('browserSpeechUnavailable'));
  check('popup records Browser-Speech-unavailable on persistent speech-service failure',
    popupJs.includes('browserSpeechUnavailable: true'));
  check('options offers the Auto voice recognition mode',
    optionsHtml.includes('value="auto"'));
  check('storage defaults include the capability flag',
    storageSrc.includes('browserSpeechUnavailable: false'));

  // Voice Input API wiring (§ PART 3): separate namespace, all providers, CSP hosts.
  const voiceInputSrc = await read('modules/voice-input.js');
  const manifestVi = JSON.parse(await read('manifest.json'));
  check('voice-input module implements all required providers',
    voiceInputSrc.includes("'openai'") && voiceInputSrc.includes("'google'") &&
      voiceInputSrc.includes("'deepgram'") && voiceInputSrc.includes("'assemblyai'") &&
      voiceInputSrc.includes("'custom'"));
  check('voice-input uses transcriptions endpoints (no text-chat audio uploads)',
    voiceInputSrc.includes('/v1/audio/transcriptions') &&
      voiceInputSrc.includes('speech:recognize') &&
      voiceInputSrc.includes('/v1/listen') &&
      voiceInputSrc.includes('/v2/upload'));
  check('voice-input reads only its own voiceInput config fields',
    voiceInputSrc.includes('cfg.openaiKey') && !voiceInputSrc.includes('settings.openaiKey'));
  check('voice-input never logs secrets',
    !/console\.(log|warn|error)/.test(voiceInputSrc));
  check('storage declares the separate voiceInput namespace',
    storageSrc.includes('voiceInput: {') && storageSrc.includes("engine: 'browser'"));
  check('options declares the Voice Input section',
    optionsHtml.includes('id="pref-voice-engine"') &&
      optionsHtml.includes('id="voice-openai-key"') &&
      optionsHtml.includes('id="voice-google-key"') &&
      optionsHtml.includes('id="voice-deepgram-key"') &&
      optionsHtml.includes('id="voice-assemblyai-key"') &&
      optionsHtml.includes('id="voice-custom-endpoint"') &&
      optionsHtml.includes('id="btn-voice-test"'));
  check('options saves the separate voiceInput namespace',
    optionsJs.includes('collectVoiceInput') && optionsJs.includes('voiceInput: collectVoiceInput()'));
  check('popup routes voiceapi mode through the offscreen recorder',
    popupJs.includes("engine: 'voiceapi'") && popupJs.includes('Voice API'));
  check('offscreen implements the Voice API batch recording path',
    (await read('offscreen-recorder.js')).includes('transcribeWithVoiceInput') &&
      (await read('offscreen-recorder.js')).includes('MediaRecorder'));
  check('manifest CSP allows the configured transcription endpoints',
    manifestVi.content_security_policy.extension_pages.includes('speech.googleapis.com') &&
      manifestVi.content_security_policy.extension_pages.includes('api.deepgram.com') &&
      manifestVi.content_security_policy.extension_pages.includes('api.assemblyai.com'));
  check('popup offers a Local (Whisper) fallback alongside Voice API',
    popupJs.includes('btn-switch-local-stt'));

  // Path separation (§2/§12): Web Speech and Local Whisper must stay independent.
  check('speech.js has no module imports at all (pure Web Speech abstraction)',
    !/^\s*import\s/m.test(speechSrc));
  check('speech.js never references the Whisper/ONNX stack',
    !/transformers|onnx|local-stt/i.test(speechSrc));
  check('local-stt-engine.js does not import the Web Speech module',
    !engineSrc.includes('speech.js'));

  // Local Whisper files were not regressed by this round: the packaged runtime is
  // still intact and the engine still reaches READY in the mocked pipeline tests.
  const fsSync = await import('node:fs');
  check('Whisper runtime assets still packaged',
    fsSync.existsSync(path.join(PROJECT_ROOT, 'vendor', WASM_FILE)) &&
      fsSync.existsSync(path.join(PROJECT_ROOT, 'vendor', LOADER_FILE)));
}

// ------------------------------------------------------------------ scenario 14
// Microphone audio-chain diagnostic (Shift triage) against mocked browser audio APIs.
class FakeMicTrack {
  constructor(muted = false) {
    this.kind = 'audioinput';
    this.readyState = 'live';
    this.label = 'Fake Microphone';
    this.muted = muted;
    this._listeners = {};
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() { /* noop */ }
  getSettings() { return { sampleRate: 48000, channelCount: 1, deviceId: 'fake-device' }; }
  stop() { this.readyState = 'ended'; }
}
class FakeMicStream {
  constructor(track) { this._track = track; this.active = true; }
  getAudioTracks() { return [this._track]; }
  getTracks() { return [this._track]; }
}
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = {};
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  get audioWorklet() { return { addModule: async () => { } }; }
  createMediaStreamSource() { return { connect() { } }; }
  createGain() { return { connect() { }, gain: { value: 0 } }; }
}
class FakeWorkletNode {
  constructor(ctx, name) {
    FakeWorkletNode.created++;
    this.port = {
      set onmessage(fn) { FakeWorkletNode._deliver(fn); },
      postMessage() { }
    };
  }
  connect() { }
  static _deliver(fn) {
    for (let i = 0; i < 20; i++) {
      setTimeout(() => {
        try {
          const amp = FakeWorkletNode.silent ? 0.0001 : 0.3;
          const samples = new Float32Array(128);
          for (let j = 0; j < 128; j++) samples[j] = Math.sin(j / 8) * amp;
          fn({ data: { type: 'AUDIO_CHUNK', samples } });
        } catch (e) { /* node may be gone */ }
      }, 50 + i * 80);
    }
  }
}

async function scenarioMicDiagnostic() {
  section('SCENARIO 14 — microphone audio-chain diagnostic finds the first failing stage');
  const micUrl = `${pathToFileURL(path.join(PROJECT_ROOT, 'modules', 'mic-diagnostic.js')).href}?t=${Date.now()}-${Math.random()}`;
  const { runAudioChainDiagnostic, formatMicReport } = await import(micUrl);
  const define = (name, value) => Object.defineProperty(globalThis, name, {
    value, writable: true, configurable: true, enumerable: false
  });

  function installMicEnv({ micWorks = true, silent = false, muted = false, withMediaDevices = true }) {
    FakeWorkletNode.created = 0;
    FakeWorkletNode.silent = silent;
    define('chrome', { runtime: { getURL: (p) => `${EXT_ORIGIN}${p}` } });
    define('window', { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext });
    define('AudioWorkletNode', FakeWorkletNode);
    define('navigator', {
      userAgent: 'Mock Shift Browser',
      permissions: { query: async () => ({ state: micWorks || !withMediaDevices ? 'granted' : 'granted' }) },
      mediaDevices: withMediaDevices ? {
        enumerateDevices: async () => [
          { kind: 'audioinput', label: micWorks ? 'Fake Microphone' : '', deviceId: 'fake-device' },
          { kind: 'audiooutput', label: 'Fake Speakers', deviceId: 'fake-out' }
        ],
        getUserMedia: async () => {
          if (!micWorks) {
            const e = new Error('The user has denied permission');
            e.name = 'NotAllowedError';
            throw e;
          }
          return new FakeMicStream(new FakeMicTrack(muted));
        }
      } : undefined
    });
  }

  // (a) Full chain works: frames flow, audible signal, no failure.
  installMicEnv({ micWorks: true });
  let r = await runAudioChainDiagnostic({ durationMs: 2000 });
  check('mic test: full chain passes when audio flows',
    r.verdict && r.verdict.ok === true && r.verdict.audioFlows === true && r.verdict.audible === true &&
    r.verdict.firstFailure === null, r.verdict);
  check('mic test: real frames were measured (not faked results)',
    r.verdict.frames >= 15 && r.verdict.peak > 0.1, { frames: r.verdict.frames, peak: r.verdict.peak });
  check('mic test: worklet node was actually created once',
    FakeWorkletNode.created === 1, FakeWorkletNode.created);

  // (b) Permission denied: getUserMedia is the FIRST failing stage.
  installMicEnv({ micWorks: false });
  r = await runAudioChainDiagnostic({ durationMs: 800 });
  check('mic test: denied permission → first failure is getUserMedia',
    r.verdict && r.verdict.ok === false && r.verdict.firstFailure === 'getUserMedia' && Boolean(r.verdict.hint),
    r.verdict);
  check('mic test: report renders FIRST FAILING STAGE line',
    formatMicReport(r).includes('FIRST FAILING STAGE: getUserMedia'));

  // (c) No navigator.mediaDevices at all.
  installMicEnv({ withMediaDevices: false });
  r = await runAudioChainDiagnostic({ durationMs: 500 });
  check('mic test: missing mediaDevices → first failure is the API itself',
    r.verdict && r.verdict.firstFailure === 'navigator.mediaDevices', r.verdict);

  // (d) Frames flow but the signal is silent (muted mic / zero volume).
  installMicEnv({ micWorks: true, silent: true, muted: true });
  r = await runAudioChainDiagnostic({ durationMs: 2000 });
  check('mic test: silent signal flagged (flows but not audible)',
    r.verdict && r.verdict.audioFlows === true && r.verdict.audible === false &&
    r.verdict.summary.toLowerCase().includes('silent'), r.verdict);
}

// ------------------------------------------------------------------ scenario 15
// Chunked incremental Whisper (§5–§12): rolling windows, word-level overlap
// reconciliation (no duplicate text), stop finalizes only the remaining tail,
// pipeline stays warm, RTF metrics are produced.
async function scenarioIncrementalWhisper() {
  section('SCENARIO 15 — incremental Whisper: chunks, reconciliation, fast finalize, metrics');

  // ---- Unit: reconcileTranscript overlap dedup (§8) ----
  {
    const { reconcileTranscript } = await import(`${pathToFileURL(path.join(PROJECT_ROOT, 'modules', 'local-stt-engine.js')).href}?t=${Date.now()}-r1`);
    let r = reconcileTranscript('Hello I want to know', 'I want to know about your service');
    check('reconcile: §8 example produces no duplicate text',
      r.combined === 'Hello I want to know about your service' && r.appended, r);
    r = reconcileTranscript('Hello I want to know', 'Hello I want to know');
    check('reconcile: identical window appends nothing', r.appended === false, r);
    r = reconcileTranscript('', 'আমি জানতে চাই');
    check('reconcile: empty final adopts the chunk', r.combined === 'আমি জানতে চাই' && r.appended, r);
    r = reconcileTranscript('আমি এই সার্ভিস সম্পর্কে', 'সম্পর্কে আরও জানতে চাই');
    check('reconcile: Bangla overlap merged word-level',
      r.combined === 'আমি এই সার্ভিস সম্পর্কে আরও জানতে চাই' && r.appended, r);
    r = reconcileTranscript('completely different words here', 'totally new tail text');
    check('reconcile: no overlap appends the whole new text',
      r.combined === 'completely different words here totally new tail text', r);
  }

  // ---- Integration: incremental session with a scripted pipeline ----
  const texts = [
    'Hello I want to know',                    // chunk 1 (with overlap re-recognized later)
    'I want to know about your service',       // chunk 2 (overlaps chunk 1 tail)
    'about your service and pricing'           // finalize tail
  ];
  const fakeEnv = {
    version: '3.3.3',
    useBrowserCache: false,
    allowLocalModels: true,
    allowRemoteModels: true,
    backends: { onnx: { wasm: { wasmPaths: REMOTE_CDN, proxy: false, numThreads: 1 } } }
  };
  // Mirrors the real Transformers.js shape: pipeline() is called ONCE (creation),
  // and every inference invokes the returned callable.
  const fakeT = {
    env: fakeEnv,
    pipeline: async (task, modelId, options) => {
      pipelineCalls.push({
        task, modelId,
        device: options.device,
        dtype: options.dtype,
        wasmPathsAtCallTime: fakeEnv.backends.onnx.wasm.wasmPaths
      });
      return async () => {
        const idx = fakeT.inferences++;
        fakeT.inferenceLog.push({
          idx,
          wasmPathsAtCallTime: fakeEnv.backends.onnx.wasm.wasmPaths,
          text: texts[Math.min(idx, texts.length - 1)]
        });
        return { text: texts[Math.min(idx, texts.length - 1)] };
      };
    }
  };
  fakeT.inferences = 0;
  fakeT.inferenceLog = [];
  installStubs({ transformers: fakeT, gpu: false });
  resetGlobals();

  const { LocalSTTEngine, STT_STAGE } = await loadEngineFresh();
  const engine = new LocalSTTEngine({ modelId: 'onnx-community/whisper-base', devicePreference: 'auto' });
  engine.isRecording = true;
  engine._captureSampleRate = 16000;
  engine.beginIncremental();

  const pushChunk = (seconds) => {
    engine.audioChunks.push(new Float32Array(16000 * seconds));
  };

  // chunk 1: 2.4s buffered
  pushChunk(1.2); pushChunk(1.2);
  let r1 = await engine.transcribeIncremental('en');
  check('incremental chunk 1 produced FINAL text', r1 && r1.finalText === 'Hello I want to know', r1);
  check('chunk metrics recorded (latency + RTF)', r1 && r1.latencyMs >= 0 && typeof r1.rtf === 'number', r1);

  // chunk 2: 2.4s more
  pushChunk(1.2); pushChunk(1.2);
  let r2 = await engine.transcribeIncremental('en');
  check('incremental chunk 2 reconciled without duplicates (§8)',
    r2 && r2.finalText === 'Hello I want to know about your service' && r2.appended, r2);
  check('pipeline stayed warm — ONE creation across chunks (§12)',
    pipelineCalls.length === 1 && fakeT.inferences === 2,
    { creations: pipelineCalls.length, inferences: fakeT.inferences });

  // Stop: fast path finalizes ONLY the tail (third scripted text), no full replay.
  engine.isRecording = false;
  const stopResult = await engine.stopAndTranscribe('en');
  check('stop fast-path produced the complete reconciled transcript',
    stopResult.transcript === 'Hello I want to know about your service and pricing', stopResult);
  check('stop did NOT re-transcribe the whole recording (tail inference only, §10)',
    fakeT.inferences === 3 && stopResult.metrics.audioDurationSec === 4.8,
    { inferences: fakeT.inferences, audio: stopResult.metrics.audioDurationSec });
  check('stop result carries incremental flag + metrics',
    stopResult.incremental === true && stopResult.metrics && typeof stopResult.metrics.avgRtf === 'number',
    stopResult.metrics);
  check('session stage remains consistent after stop', engine._inc.active === false);

  // Every inference (creation-time + per-chunk) used the local wasm runtime.
  check('incremental passes used the packaged local runtime',
    pipelineCalls.every((c) => c.wasmPathsAtCallTime === `${EXT_ORIGIN}vendor/`) &&
      fakeT.inferenceLog.every((c) => c.wasmPathsAtCallTime === `${EXT_ORIGIN}vendor/`),
    { creations: pipelineCalls.map((c) => c.wasmPathsAtCallTime), inferences: fakeT.inferenceLog.map((c) => c.wasmPathsAtCallTime) });
}

// ------------------------------------------------------------------ scenario 16
// Voice Input API (§ PART 3): provider abstraction, per-provider request shapes,
// separate credentials, custom response-path resolution. Fetch is fully mocked.
async function scenarioVoiceInputApi() {
  section('SCENARIO 16 — Voice Input API providers (OpenAI/Google/Deepgram/AssemblyAI/Custom)');
  const viUrl = `${pathToFileURL(path.join(PROJECT_ROOT, 'modules', 'voice-input.js')).href}?t=${Date.now()}-${Math.random()}`;
  const { transcribeWithVoiceInput, isVoiceInputConfigured, resolvePath } = await import(viUrl);

  const fakeBlob = {
    size: 1024,
    type: 'audio/webm',
    arrayBuffer: async () => new Uint8Array(1024).buffer
  };
  const fetchCalls = [];
  function installFetch(handler) {
    defineGlobal('fetch', async (url, opts = {}) => handler(String(url), opts));
  }
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj });

  // resolvePath unit checks
  check('resolvePath: simple path', resolvePath({ text: 'x' }, 'text') === 'x');
  check('resolvePath: nested numeric path',
    resolvePath({ results: [{ alternatives: [{ transcript: 't' }] }] }, 'results.0.alternatives.0.transcript') === 't');
  check('resolvePath: missing path → undefined', resolvePath({}, 'a.b.c') === undefined);

  // (a) OpenAI: dedicated key, multipart POST to the transcriptions endpoint.
  resetGlobals();
  installFetch(async (url, opts) => {
    fetchCalls.push({ url, auth: opts.headers && opts.headers.Authorization, isForm: opts.body instanceof FormData });
    return json({ text: 'OPENAI_TRANSCRIPT' });
  });
  defineGlobal('FormData', class { append(k, v) { this[k] = v; } });
  defineGlobal('Blob', class { constructor() {} });
  let r = await transcribeWithVoiceInput(fakeBlob, {
    provider: 'openai', openaiKey: 'K-OPENAI', openaiModel: 'whisper-1', language: 'bn'
  });
  check('openai: posts to /v1/audio/transcriptions with Bearer key',
    fetchCalls[0].url === 'https://api.openai.com/v1/audio/transcriptions' &&
      fetchCalls[0].auth === 'Bearer K-OPENAI' && fetchCalls[0].isForm,
    fetchCalls[0]);
  check('openai: returns transcript text', r.text === 'OPENAI_TRANSCRIPT' && r.provider === 'openai', r);
  check('openai: isConfigured requires the voice key (not the Refine key)',
    isVoiceInputConfigured({ provider: 'openai', openaiKey: 'x' }) === true &&
      isVoiceInputConfigured({ provider: 'openai' }) === false);

  // (b) Google: key in URL, languageCode mapped bn → bn-BD.
  fetchCalls.length = 0;
  installFetch(async (url, opts) => {
    fetchCalls.push({ url, body: JSON.parse(opts.body) });
    return json({ results: [{ alternatives: [{ transcript: 'GOOGLE_TRANSCRIPT' }] }] });
  });
  r = await transcribeWithVoiceInput(fakeBlob, { provider: 'google', googleKey: 'K-G', language: 'bn' });
  check('google: calls speech:recognize with key param',
    fetchCalls[0].url.startsWith('https://speech.googleapis.com/v1/speech:recognize?key=K-G'), fetchCalls[0].url);
  check('google: bn mapped to languageCode bn-BD, WEBM_OPUS encoding',
    fetchCalls[0].body.config.languageCode === 'bn-BD' && fetchCalls[0].body.config.encoding === 'WEBM_OPUS',
    fetchCalls[0].body.config);
  check('google: transcript extracted', r.text === 'GOOGLE_TRANSCRIPT', r);

  // (c) Deepgram: Token auth, model + language params, raw audio body.
  fetchCalls.length = 0;
  installFetch(async (url, opts) => {
    fetchCalls.push({ url, auth: opts.headers && opts.headers.Authorization, ct: opts.headers && opts.headers['Content-Type'] });
    return json({ results: { channels: [{ alternatives: [{ transcript: 'DEEPGRAM_TRANSCRIPT' }] }] } });
  });
  r = await transcribeWithVoiceInput(fakeBlob, { provider: 'deepgram', deepgramKey: 'K-DG', deepgramModel: 'nova-2', language: 'en' });
  check('deepgram: Token auth + model/language params + audio content-type',
    fetchCalls[0].url.includes('https://api.deepgram.com/v1/listen') &&
      fetchCalls[0].url.includes('model=nova-2') && fetchCalls[0].url.includes('language=en') &&
      fetchCalls[0].auth === 'Token K-DG' && fetchCalls[0].ct === 'audio/webm',
    fetchCalls[0]);
  check('deepgram: transcript extracted', r.text === 'DEEPGRAM_TRANSCRIPT', r);

  // (d) AssemblyAI: upload → create → poll lifecycle.
  fetchCalls.length = 0;
  installFetch(async (url, opts) => {
    fetchCalls.push({ url, auth: opts.headers && opts.headers.authorization });
    if (url.endsWith('/upload')) return json({ upload_url: 'https://aai/upload/1' });
    if (url.endsWith('/transcript')) return json({ id: 't-1' });
    if (url.includes('/transcript/t-1')) {
      return json(fetchCalls.length >= 4
        ? { status: 'completed', text: 'ASSEMBLYAI_TRANSCRIPT' }
        : { status: 'processing' });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  r = await transcribeWithVoiceInput(fakeBlob, { provider: 'assemblyai', assemblyaiKey: 'K-AA', language: 'en' });
  check('assemblyai: upload → create → poll lifecycle executed',
    fetchCalls.length === 4 &&
      fetchCalls[0].url.endsWith('/upload') && fetchCalls[1].url.endsWith('/transcript') &&
      fetchCalls[2].url.includes('/transcript/t-1'),
    fetchCalls.map((f) => f.url));
  check('assemblyai: transcript extracted after polling',
    r.text === 'ASSEMBLYAI_TRANSCRIPT' && r.provider === 'assemblyai', r);

  // (e) Custom API: configurable endpoint/auth/response-path.
  fetchCalls.length = 0;
  installFetch(async (url, opts) => {
    fetchCalls.push({ url, auth: opts.headers && opts.headers['X-Custom-Key'], method: opts.method });
    return json({ result: { text: 'CUSTOM_TRANSCRIPT' } });
  });
  r = await transcribeWithVoiceInput(fakeBlob, {
    provider: 'custom',
    customEndpoint: 'https://example.com/v1/transcribe',
    customKey: 'K-CUSTOM', customAuthType: 'apiKeyHeader', customAuthHeaderName: 'X-Custom-Key',
    customAudioField: 'audio', customModel: 'my-model', customLanguage: 'bn',
    customResponsePath: 'result.text'
  });
  check('custom: endpoint, auth header, POST used',
    fetchCalls[0].url === 'https://example.com/v1/transcribe' &&
      fetchCalls[0].auth === 'K-CUSTOM' && fetchCalls[0].method === 'POST',
    fetchCalls[0]);
  check('custom: response text path resolved', r.text === 'CUSTOM_TRANSCRIPT', r);

  // (f) Errors: unconfigured provider and 401 are actionable, secret-free.
  let threw = null;
  try { await transcribeWithVoiceInput(fakeBlob, { provider: 'openai', openaiKey: '' }); }
  catch (e) { threw = e; }
  check('unconfigured provider → actionable key error (no secrets)',
    threw && /key is missing/i.test(threw.message) && !String(threw.message).includes('K-'),
    threw && threw.message);
}

// ------------------------------------------------------------------ scenario 17
// Compact popup UI (§ UI-only cleanup): unnecessary text labels removed, icons,
// dynamic names, tooltips, aria-labels, and all functionality retained.
async function scenarioCompactPopupUi() {
  section('SCENARIO 17 — compact popup UI: text removed, icons/functionality/accessibility kept');
  const fs = await import('node:fs/promises');
  const popupHtml = await fs.readFile(path.join(PROJECT_ROOT, 'popup.html'), 'utf8');
  const popupJs = await fs.readFile(path.join(PROJECT_ROOT, 'popup.js'), 'utf8');

  // 1. Running API row: "Cloud Web Speech" text removed, indicator functionality kept.
  check('popup badge no longer renders "Cloud Web Speech" text',
    !popupHtml.includes('Cloud Web Speech') && !popupJs.includes("textContent = '○ Cloud Web Speech'"));
  check('popup hides the badge in cloud mode but keeps it for Local Whisper',
    popupJs.includes("sttPrivacyBadge.style.display = 'none'") &&
      popupJs.includes("sttPrivacyBadge.style.display = ''"));
  check('Running API indicator itself is untouched',
    popupHtml.includes('id="popup-api-name"') && popupJs.includes('popupApiName.textContent'));

  // 2. Free Window / Dock: icons only.
  check('"Free Window" text removed', !popupHtml.includes('Free Window'));
  check('"Dock" label removed from the detached-mode swap',
    !popupJs.includes("'📌 Dock'"));
  check('popout icon-only label kept (⤢ / 📌)',
    popupHtml.includes('id="popout-label"') && /id="popout-label">⤢</.test(popupHtml) &&
      popupJs.includes("popoutLabel.textContent = '📌'"));
  check('popout button keeps tooltip + aria-label',
    /id="btn-popout"[^>]*title="Toggle free movable window"/.test(popupHtml) &&
      /id="btn-popout"[^>]*aria-label="Toggle free movable window"/.test(popupHtml));

  // 3. § LAYOUT: Input Text Field leads the stage; the Bangla/English/Timer row
  //    was removed entirely (§ cleanup) so the field is directly followed by the
  //    action grid.
  const voiceRowPos = popupHtml.indexOf('class="voice-action-row"');
  const transcriptPos = popupHtml.indexOf('id="transcript-box"');
  const gridPos = popupHtml.indexOf('class="voice-controls-grid"');
  check('Input Text Field directly precedes the action grid (Voice row removed)',
    transcriptPos > -1 && gridPos > transcriptPos && voiceRowPos === -1,
    { transcriptPos, gridPos, voiceRowPos });
  check('no duplicated Input Text Field; Voice row fully removed (no blank wrapper)',
    (popupHtml.match(/id="transcript-box"/g) || []).length === 1 &&
      (popupHtml.match(/class="voice-action-row"/g) || []).length === 0);
  check('Voice Stack pill single instance, inside the transcript box',
    (popupHtml.match(/id="voice-stack-badge"/g) || []).length === 1 &&
      popupHtml.indexOf('id="voice-stack-badge"') < gridPos);
  check('bottom action row still follows after the Voice row and transcript',
    gridPos > transcriptPos);
  check('Input Text Field label retained as in the restored baseline',
    popupHtml.includes('Input Text Field'));

  // § FINAL TOP ROW FIX: Voice Recorder LEFT; Dock/Pin + Settings RIGHT.
  const headerPos = popupHtml.indexOf('class="header-actions"');
  const micPos = popupHtml.indexOf('id="btn-mic"');
  const popoutPos = popupHtml.indexOf('id="btn-popout"', headerPos);
  const settingsPos = popupHtml.indexOf('id="btn-settings"', headerPos);
  check('top row: Voice key sits LEFT of the header-actions group',
    micPos > -1 && micPos < headerPos, { micPos, headerPos });
  check('top row: Dock/Pin + Settings are the RIGHT group inside header-actions',
    popoutPos > headerPos && settingsPos > popoutPos, { popoutPos, settingsPos });
  check('top order is Voice → Dock/Pin → Settings (no duplicates)',
    micPos > -1 && popoutPos > -1 && settingsPos > -1 &&
      micPos < popoutPos && popoutPos < settingsPos);
  check('Voice key exists exactly once (moved, not duplicated)',
    (popupHtml.match(/id="btn-mic"/g) || []).length === 1 &&
      (popupHtml.match(/class="mic-icon-wrapper"/g) || []).length === 1);
  check('Voice key removed from the old second row',
    popupHtml.slice(popupHtml.indexOf('class="voice-action-row"')).indexOf('id="btn-mic"') === -1);
  check('Dock/Pin key exists exactly once (moved, not duplicated)',
    (popupHtml.match(/id="btn-popout"/g) || []).length === 1);
  check('Running API banner moved below the action grid, before the footer',
    popupHtml.indexOf('id="popup-api-banner"') > popupHtml.indexOf('class="voice-controls-grid"') &&
      popupHtml.indexOf('id="popup-api-banner"') < popupHtml.indexOf('<footer class="app-footer"') &&
      (popupHtml.match(/id="popup-api-banner"/g) || []).length === 1);

  // 4. Voice Stack label removed; dynamic stack name retained.
  check('"Voice Stack:" prefix removed',
    !popupHtml.includes('Voice Stack:') && !popupHtml.includes('Voices'));
  check('dynamic stack name element retained',
    popupHtml.includes('id="voice-stack-name"'));
  check('stack name still updates dynamically per provider',
    popupJs.includes("voiceStackName.textContent = 'Web Speech (Cloud)'") &&
      popupJs.includes('`Whisper (${device})`') &&
      popupJs.includes('voiceStackName.textContent = `Voice API (${result.provider || \'unknown\'})`'));

  // 5. Copy: icon-only, accessibility kept.
  check('header copy button is icon-only with accessibility labels',
    /id="copy-header-text">📋</.test(popupHtml) &&
      /id="btn-copy-header"[^>]*aria-label="Copy voice input"/.test(popupHtml) &&
      !popupHtml.includes('📋 Copy'));
  check('main copy button is text-based with accessibility labels',
    popupHtml.includes('<span>Copy</span>') &&
      /id="btn-copy-original"[^>]*aria-label="Copy voice input"/.test(popupHtml));
  check('copy handlers untouched (popup.js still wires both copy buttons)',
    popupJs.includes('btn-copy-header') && popupJs.includes('btn-copy-original'));

  // 6. Collapse/Expand: icon-only, state logic + accessibility kept.
  check('collapse/expand visible labels removed',
    !popupHtml.includes('id="expand-btn-label"') && !/<span>Collapse<\/span>/.test(popupHtml));
  check('expand/collapse icon and accessibility retained',
    popupHtml.includes('id="expand-icon-svg"') &&
      /id="btn-expand-transcript"[^>]*aria-label="Collapse transcript"/.test(popupHtml) &&
      popupJs.includes('btnExpandTranscript.title'));

  // 7. Result-stage copy buttons: icon-only for consistency, tooltips/aria kept.
  check('result-stage copy buttons are icon-only (📋) with tooltips',
    (popupHtml.match(/<span class="copy-text">📋<\/span>/g) || []).length === 2 &&
      popupHtml.includes('title="Copy Bangla"') && popupHtml.includes('title="Copy English"') &&
      popupHtml.includes('aria-label="Copy Bangla"') && popupHtml.includes('aria-label="Copy English"'));

  // 8. UPPER icons (§ already-fixed area): header Copy + Expand stay 20px — untouched.
  const popupCss = await fs.readFile(path.join(PROJECT_ROOT, 'popup.css'), 'utf8');
  const backgroundJs = await fs.readFile(path.join(PROJECT_ROOT, 'background.js'), 'utf8');
  check('upper header Copy icon stays 20px (already fixed — untouched)',
    /#btn-copy-header #copy-header-text\s*\{[^}]*font-size:\s*20px/.test(popupCss));
  check('upper Expand/Collapse icon stays 20px (already fixed — untouched)',
    /#btn-expand-transcript #expand-icon-svg\s*\{[^}]*width:\s*20px/.test(popupCss) &&
      /#btn-expand-transcript #expand-icon-svg\s*\{[^}]*height:\s*20px/.test(popupCss));
  check('copy icon color made more visible (contrast filter, no design change)',
    /#btn-copy-header #copy-header-text,[\s\S]*?\.copy-btn \.copy-text\s*\{[^}]*filter:[^}]*\}/.test(popupCss) &&
      popupCss.includes('drop-shadow'));

  // § LOWER COPY FIX: the lower Copy button is TEXT-based again ("Copy"), while the
  // upper icons stay icon-only.
  check('lower Copy button is text-based ("Copy")',
    /id="btn-copy-original"[^>]*>\s*<span>Copy<\/span>/.test(popupHtml) &&
      !popupHtml.includes('<span>📋</span>'));

  // § FINAL TOP ROW & CLEANUP: centered brown title, key size match, section removal.
  check('header has the centered brown "Voice Assistant" title between the key groups',
    popupHtml.includes('<span class="header-title">Voice Assistant</span>') &&
      /\.header-title\s*\{[^}]*color:\s*#8a5a2b/.test(popupCss) &&
      popupHtml.indexOf('header-title') > popupHtml.indexOf('id="btn-mic"') &&
      popupHtml.indexOf('header-title') < popupHtml.indexOf('class="header-actions"'));
  check('Dock/Pin + Settings keys sized to match the Voice key (30px)',
    /#btn-popout,\s*\n#btn-settings\s*\{[^}]*width:\s*30px/.test(popupCss) &&
      /#btn-popout,\s*\n#btn-settings\s*\{[^}]*height:\s*30px/.test(popupCss));
  check('Settings icon scale matches the Voice key icon (17px)',
    /#btn-settings svg\s*\{[^}]*width:\s*17px/.test(popupCss));
  check('Bangla/English/Timer section fully removed (no leftover wrapper)',
    !popupHtml.includes('lang-strip-mini') && !popupHtml.includes('lang-chip-mini') &&
      !popupHtml.includes('timer-badge-mini') && !popupHtml.includes('lang-bn') &&
      !popupHtml.includes('recording-timer') && !popupHtml.includes('voice-action-row'));
  check('language falls back to Bangla default; timer code is null-safe',
    popupJs.includes('function selectedPopupLanguage') &&
      popupJs.includes('if (!recordingTimer) return;') &&
      popupJs.includes('if (langBn) langBn.addEventListener'));
  check('four lower keys show exactly Copy / Refine / Stop / Close (no icons)',
    popupHtml.includes('<span>Copy</span>') && popupHtml.includes('<span>Refine</span>') &&
      popupHtml.includes('<span>Stop</span>') && popupHtml.includes('<span>Close</span>') &&
      !popupHtml.includes('✨') && !popupHtml.includes('■ Stop') && !popupHtml.includes('✕ Cancel'));

  // § RESULT EXPAND: independent expand/collapse for Bangla + English outputs.
  check('expand buttons exist on both result cards (reusing the input-field key style)',
    popupHtml.includes('id="btn-expand-bn"') && popupHtml.includes('id="btn-expand-en"') &&
      (popupHtml.match(/class="mini-action-btn expand-btn"/g) || []).length >= 2);
  check('expand wiring + independent state in popup.js',
    popupJs.includes('let isBanglaExpanded') && popupJs.includes('let isEnglishExpanded') &&
      popupJs.includes("btnExpandBn.addEventListener('click', toggleBanglaExpand)") &&
      popupJs.includes("btnExpandEn.addEventListener('click', toggleEnglishExpand)"));
  check('expanded textarea state is vertical-only and reversible',
    /\.result-textarea\.is-expanded\s*\{[^}]*min-height:\s*130px/.test(popupCss) &&
      /\.result-textarea\.is-expanded\s*\{[^}]*max-height:\s*190px/.test(popupCss) &&
      !/\.result-textarea\.is-expanded\s*\{[^}]*width/.test(popupCss));
  check('expand toggles reuse the input-field icon language',
    popupJs.includes("expandBnSvg.innerHTML = isBanglaExpanded ? RESULT_COLLAPSE_ICON : RESULT_EXPAND_ICON") &&
      popupJs.includes("expandEnSvg.innerHTML = isEnglishExpanded ? RESULT_COLLAPSE_ICON : RESULT_EXPAND_ICON"));
  check('copy handlers on the result cards untouched',
    popupJs.includes("btnCopyBn.addEventListener('click', () => handleCopy(btnCopyBn, outputBn))") &&
      popupJs.includes("btnCopyEn.addEventListener('click', () => handleCopy(btnCopyEn, outputEn))"));

  // § RESULT ICON SIZE MATCH: Copy and Expand controls identical in each header.
  check('result header Copy + Expand controls locked to the same exact box (36 x 27)',
    /\.result-card \.card-header \.copy-btn,\s*\n\.result-card \.card-header \.mini-action-btn\.expand-btn\s*\{[^}]*width:\s*36px/.test(popupCss) &&
      /\.result-card \.card-header \.copy-btn,\s*\n\.result-card \.card-header \.mini-action-btn\.expand-btn\s*\{[^}]*height:\s*27px/.test(popupCss) &&
      /\.result-card \.card-header \.copy-btn,\s*\n\.result-card \.card-header \.mini-action-btn\.expand-btn\s*\{[^}]*padding:\s*0/.test(popupCss));
  check('Expand icon scale matches the Copy emoji (20px) in result headers',
    /\.result-card \.card-header \.mini-action-btn\.expand-btn svg\s*\{[^}]*width:\s*20px/.test(popupCss) &&
      /\.result-card \.card-header \.mini-action-btn\.expand-btn svg\s*\{[^}]*height:\s*20px/.test(popupCss));

  // § FOUR-BUTTON FIX: Copy / Refine / Stop / Cancel are locked to identical size.
  check('four lower buttons locked to exactly the same size (height 31px)',
    /\.voice-controls-grid \.btn\s*\{[^}]*height:\s*31px/.test(popupCss) &&
      /\.voice-controls-grid \.btn\s*\{[^}]*padding-top:\s*0/.test(popupCss));
  check('all four lower buttons still present with their handlers',
    popupHtml.includes('id="btn-copy-original"') && popupHtml.includes('id="btn-refine"') &&
      popupHtml.includes('id="btn-stop"') && popupHtml.includes('id="btn-cancel"'));

  // 9. Popup MAXIMUM height is exactly 390px — smaller allowed, never taller.
  check('CSS caps the popup at the 390px maximum height (320 wide)',
    /body\s*\{[^}]*max-width:\s*320px/.test(popupCss) &&
      /body\s*\{[^}]*max-height:\s*390px/.test(popupCss));
  check('content body scrolls internally instead of clipping',
    /content-body\s*\{[^}]*overflow-y:\s*auto/.test(popupCss) &&
      /content-body\s*\{[^}]*min-height:\s*0/.test(popupCss));
  check('detached window resize targets are clamped to the maximum',
    popupJs.includes('MAX_POPUP_WIDTH') && popupJs.includes('MAX_POPUP_HEIGHT = 390') &&
      popupJs.includes('Math.min(targetHeight, MAX_POPUP_HEIGHT)'));
  check('detached window enforces the maximum on user resize',
    popupJs.includes('enforceMaxWindowSize') &&
      popupJs.includes("window.addEventListener('resize', enforceMaxWindowSize)"));
  check('background clamps detached window creation to 390px',
    backgroundJs.includes('Math.min(Math.max(290, pos.width || 320), 320)') &&
      backgroundJs.includes('Math.min(Math.max(200, pos.height || 390), 390)'));
  check('no stale height constant remains',
    !popupJs.includes('MAX_POPUP_HEIGHT = 430') && !popupJs.includes('MAX_POPUP_HEIGHT = 420') &&
      !popupJs.includes('MAX_POPUP_HEIGHT = 375') && !popupJs.includes('MAX_POPUP_HEIGHT = 378') &&
      !popupJs.includes('MAX_POPUP_HEIGHT = 380') && !popupJs.includes('MAX_POPUP_HEIGHT = 385'));

  // § COLLAPSE/EXPAND HEIGHT AUTO-ADJUST: the popup must actively resize on
  // collapse/expand (browsers never shrink it themselves — blank-area bug).
  check('collapse/expand resizes the detached window via chrome.windows',
    popupJs.includes('chrome.windows.getCurrent') && popupJs.includes('chrome.windows.update'));
  check('detached resize keeps the window.resizeTo fallback',
    popupJs.includes("window.resizeTo(") );
  check('attached bubble height is pinned to measured content (no blank area)',
    popupJs.includes('pinAttachedBubbleHeight') && popupJs.includes('document.body.scrollHeight') &&
      popupJs.includes('document.body.style.height'));
  check('bubble height re-pinned on every stage transition',
    /function setStage\([\s\S]*?pinAttachedBubbleHeight\(\)/.test(popupJs));
  check('bubble height pinned once on popup open',
    /DOMContentLoaded[\s\S]*pinAttachedBubbleHeight\(\);\s*\n\}\);/.test(popupJs) || popupJs.includes('pinAttachedBubbleHeight();\n});'));
  check('collapsed height target recalibrated for the 430 layout',
    popupJs.includes('MAX_COLLAPSED_HEIGHT = 340'));

  // 10. Unused Side Panel icon removed from the popup header.
  check('Side Panel icon removed from the popup header',
    !popupHtml.includes('btn-sidepanel'));
  check('no orphan Side Panel listener remains in popup.js',
    !popupJs.includes('btnSidepanel') && !popupJs.includes('OPEN_SIDEPANEL'));
}

// ------------------------------------------------------------------ run all
console.log(`Engine under test: ${ENGINE_PATH}`);
console.log(`Node: ${process.version}`);

await scenarioConfigureBackend();
await scenarioPackagedWasmMissing();
await scenarioErrorClassification();
await scenarioWebGpuFallback();
await scenarioAttemptPlanAndUnderlyingErrors();
await scenarioFailureStageReporting();
await scenarioEngineSourceFacts();
await scenarioUiWiring();
await scenarioDiagnosticReport();
await scenarioFatalPackagingErrorNotRetried();
await scenarioPipelineReuse();
await scenarioWebSpeechLifecycle();
await scenarioWebSpeechWiringAndSeparation();
await scenarioMicDiagnostic();
await scenarioIncrementalWhisper();
await scenarioVoiceInputApi();
await scenarioCompactPopupUi();

console.log('\n================ RESULT ================');
console.log(`checks: ${checks}   failures: ${failures}`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
process.exit(failures === 0 ? 0 : 1);
