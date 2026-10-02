/**
 * Live reproduction harness — runs the REAL Whisper initialization inside a real
 * headless Chrome with a real Chrome extension context (same CSP model as the popup).
 *
 * Usage: node repro-whisper-live.mjs [--model=<id>] [--port=<cdpPort>] [--keep]
 *
 * It loads the extension under test from ../ (the real project folder) and drives
 * tests/repro-fixture.html in an offscreen document, then prints every console line
 * and the collected result log.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
// NOTE: the profile MUST live under this workspace drive. Chrome refuses to create
// its ProcessSingleton lock file elsewhere in this environment ("Lock file can not be
// created: Access is denied (0x5)") and then aborts with exit code 21.
const TMP = path.join(HERE, '.repro');
const PROFILE = path.join(TMP, 'profile');
const SINK_PORT = 8799;

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const MODEL = arg('model', 'onnx-community/whisper-tiny');
const DPORT = Number(arg('port', '9871'));
const KEEP = process.argv.includes('--keep');

const BROWSERS = [
  // Chrome for Testing honours --load-extension; branded Chrome 137+ ignores it.
  'C:\\Users\\IT LAB\\Documents\\deepseek-harness\\default-workspace\\_cft\\chrome-win64\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) { console.error('no browser'); process.exit(2); }

// ---------------------------------------------------------------- log sink
const logLines = [];
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    try {
      const parsed = JSON.parse(body);
      if (parsed.tag === 'CONSOLE') {
        console.log(`    [page] ${parsed.payload.level}: ${parsed.payload.text}`);
      } else {
        logLines.push(parsed);
        console.log(`  [${parsed.tag}] ${JSON.stringify(parsed.payload)}`);
      }
    } catch {
      console.log(`  [raw] ${body}`);
    }
  });
});
await new Promise((r) => server.listen(SINK_PORT, '127.0.0.1', r));
console.log(`SINK listening on ${SINK_PORT}`);

// ---------------------------------------------------------------- extension dir
// The extension under test is the REAL project, plus the repro fixture files.
// We copy the project into .repro/ext so we never modify the deliverable.
const EXT = path.join(TMP, 'ext');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(EXT, { recursive: true });
for (const entry of fs.readdirSync(PROJECT_ROOT)) {
  if (entry === 'tests' || entry === 'node_modules') continue;
  fs.cpSync(path.join(PROJECT_ROOT, entry), path.join(EXT, entry), { recursive: true });
}

const manifestPath = path.join(EXT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
// Register an offscreen document so we can run the engine in an extension page
// (identical CSP/context to the popup) without needing user interaction.
manifest.permissions = Array.from(new Set([...manifest.permissions, 'offscreen']));
const war = manifest.web_accessible_resources[0];
war.resources = Array.from(new Set([...war.resources, 'fixture.html', 'fixture.js', 'background-fixture.js']));
manifest.background = { service_worker: 'background-fixture.js', type: 'module' };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`extension staged at ${EXT}`);

// ---------------------------------------------------------------- fixture files
fs.writeFileSync(path.join(EXT, 'background-fixture.js'), `
async function boot() {
  try {
    const has = chrome.offscreen && chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'fixture.html',
        reasons: ['WORKERS'],
        justification: 'Whisper initialization reproduction'
      });
    }
    console.log('[fixture] offscreen ready');
  } catch (e) {
    console.log('[fixture] offscreen error: ' + (e && e.message));
  }
}
chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
boot();
`);

fs.writeFileSync(path.join(EXT, 'fixture.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>repro</title></head>
<body><pre id="out"></pre><script type="module" src="fixture.js"></script></body></html>`);

fs.writeFileSync(path.join(EXT, 'fixture.js'), `
const SINK = 'http://127.0.0.1:${SINK_PORT}/log';
const MODEL = ${JSON.stringify(MODEL)};

function send(tag, payload) {
  try {
    fetch(SINK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, payload, t: Date.now() }) }).catch(() => {});
  } catch (e) {}
}
function logConsole(level, args) {
  send('CONSOLE', { level, text: Array.from(args).map(a => {
    try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ') });
}
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { logConsole(level, args); orig(...args); };
}
window.addEventListener('error', (e) => send('WINDOW_ERROR', { message: e.message, file: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => send('UNHANDLED_REJECTION', { reason: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));

(async () => {
  send('START', { href: location.href, origin: location.origin, crossOriginIsolated: self.crossOriginIsolated, ua: navigator.userAgent });

  // Report WebGPU availability exactly as the extension would see it.
  let gpuInfo = 'NO_NAVIGATOR_GPU';
  try {
    if (navigator.gpu && navigator.gpu.requestAdapter) {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) gpuInfo = 'NO_ADAPTER';
      else {
        let deviceOk = false;
        try { deviceOk = Boolean(await adapter.requestDevice()); } catch (e) { deviceOk = 'ERROR: ' + e.message; }
        gpuInfo = 'ADAPTER_OK device=' + deviceOk + ' features=' + JSON.stringify(Array.from(adapter.features || []));
      }
    }
  } catch (e) { gpuInfo = 'ADAPTER_ERROR: ' + e.message; }
  send('WEBGPU', { info: gpuInfo });

  // Use the REAL engine module.
  const mod = await import(chrome.runtime.getURL('modules/local-stt-engine.js'));
  const { LocalSTTEngine, STT_STAGE, classifyLocalSttError } = mod;

  const preference = ${JSON.stringify(arg('accel', 'auto'))};
  const engine = new LocalSTTEngine({ modelId: MODEL, devicePreference: preference });
  engine.onStatus = (st) => send('STAGE', { stage: st.stage, message: st.message, device: st.device });
  engine.onProgress = (p) => {
    if (p && p.status === 'progress' && typeof p.progress === 'number') {
      const pct = Math.round(p.progress);
      if (pct === 100 || pct % 25 === 0) send('PROGRESS', { file: p.file, pct, loaded: p.loaded, total: p.total });
    }
  };
  engine.onError = (e) => send('ENGINE_ERROR', e);
  engine.onReady = (r) => send('ENGINE_READY', r);

  try {
    const t0 = performance.now();
    await engine.forcePreloadModel();
    const ms = Math.round(performance.now() - t0);
    send('SUCCESS', { stage: engine.stage, ms });
    const report = await engine.buildDiagnosticReport();
    send('REPORT', { text: LocalSTTEngine.formatDiagnosticReport(report) });
  } catch (e) {
    send('FAILURE', {
      message: e && e.message,
      stack: e && e.stack,
      stage: e && e.stage,
      classified: classifyLocalSttError(e),
      attempts: e && e.attempts
    });
    try {
      const report = await engine.buildDiagnosticReport();
      send('REPORT', { text: LocalSTTEngine.formatDiagnosticReport(report) });
    } catch (e2) { send('REPORT_ERROR', { message: String(e2 && e2.message) }); }
  }
  send('DONE', {});
})();
`);

// ---------------------------------------------------------------- launch
fs.mkdirSync(PROFILE, { recursive: true });
const args = [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${DPORT}`,
  '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-crash-reporter', '--disable-breakpad',
  '--disable-features=Translate,OptimizationHints,DisableLoadExtensionCommandLineSwitch',
  '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-gl=angle',
  '--headless=new', '--no-sandbox',
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  'about:blank'
];
console.log(`launching: ${browser}`);
const outFd = fs.openSync(path.join(TMP, 'browser.log'), 'a');
const child = spawn(browser, args, { stdio: ['ignore', outFd, outFd] });

const cdp = async (p) => {
  const res = await fetch(`http://127.0.0.1:${DPORT}${p}`);
  return await res.json();
};

// wait for the fixture to finish
const deadline = Date.now() + Number(arg('timeoutSec', '420')) * 1000;
let done = false;
let sawTargets = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  if (!sawTargets) {
    try {
      const list = await cdp('/json/list');
      const mine = list.filter((t) => String(t.url).includes('chrome-extension://'));
      if (mine.length) {
        sawTargets = mine.map((t) => `${t.type} ${t.url}`);
        console.log('extension targets:'); for (const t of sawTargets) console.log(`   ${t}`);
      }
    } catch {}
  }
  if (logLines.some((l) => l.tag === 'DONE')) { done = true; break; }
  if (child.exitCode !== null) { console.log(`browser exited code=${child.exitCode}`); break; }
}

console.log('\n================ REPRO RESULT ================');
console.log(done ? 'harness reported DONE' : 'TIMEOUT / no DONE');
const failure = logLines.find((l) => l.tag === 'FAILURE');
const success = logLines.find((l) => l.tag === 'SUCCESS');
if (success) console.log(`SUCCESS: ${JSON.stringify(success.payload)}`);
if (failure) console.log(`FAILURE: ${JSON.stringify(failure.payload, null, 2)}`);
const report = logLines.find((l) => l.tag === 'REPORT');
if (report) { console.log('\n--- diagnostic report ---'); console.log(report.payload.text); }

if (!KEEP) {
  try { child.kill('SIGKILL'); } catch {}
  try {
    const { execSync } = await import('node:child_process');
    execSync('taskkill /F /T /FI "IMAGENAME eq chrome.exe" /FI "COMMANDLINE eq *repro*"', { stdio: 'ignore' });
  } catch {}
}
server.close();
console.log(`\nsink lines captured: ${logLines.length}`);
process.exit(done ? 0 : 1);
