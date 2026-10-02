/**
 * Launch a controllable Chrome/Edge instance and verify the CDP endpoint.
 * Node passes arguments without PowerShell quoting surprises.
 *
 * Usage: node launch-browser.mjs <profileDir> <port> [--headless] [--extension=<path>] [--keep]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BROWSERS = [
  // Chrome for Testing honours --load-extension; branded Chrome 137+ ignores it.
  'C:\\Users\\IT LAB\\Documents\\deepseek-harness\\default-workspace\\_cft\\chrome-win64\\chrome.exe',
  process.env.CFT_CHROME || '',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1200\\chrome-win\\chrome.exe` : '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const profileDir = process.argv[2] || 'C:\\Users\\IT LAB\\Documents\\deepseek-harness\\default-workspace\\_cdp-profile';
const port = Number(process.argv[3] || 9861);
const headless = process.argv.includes('--headless');
const extArg = process.argv.find((a) => a.startsWith('--extension='));
const extension = extArg ? extArg.slice('--extension='.length) : null;
const keep = process.argv.includes('--keep');

const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('LAUNCH_FAIL: no browser binary found');
  process.exit(2);
}

fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });

const args = [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--no-default-browser-check',
  '--disable-features=Translate,OptimizationHints,DisableLoadExtensionCommandLineSwitch',
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle'
];
if (headless) args.push('--headless=new', '--no-sandbox', '--disable-gpu');
if (extension) {
  args.push(`--load-extension=${extension}`, `--disable-extensions-except=${extension}`);
}
args.push('about:blank');

console.log(`BROWSER=${browser}`);
console.log(`ARGS=${JSON.stringify(args)}`);

const out = fs.openSync(path.join(profileDir, 'browser-stdout.log'), 'a');
const err = fs.openSync(path.join(profileDir, 'browser-stderr.log'), 'a');
const child = spawn(browser, args, { stdio: ['ignore', out, err], detached: false });
console.log(`PID=${child.pid}`);

child.on('exit', (code, signal) => {
  console.log(`BROWSER_EXIT code=${code} signal=${signal}`);
});

async function cdp(pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

let version = null;
for (let i = 1; i <= 20; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  try {
    version = await cdp('/json/version');
    console.log(`CDP_UP after ${i * 1.5}s: ${version.Browser}`);
    break;
  } catch (e) {
    if (child.exitCode !== null) {
      console.log(`CHILD_EXITED_EARLY code=${child.exitCode}`);
      break;
    }
    console.log(`waiting ${i}: ${e.message}`);
  }
}

if (version) {
  const list = await cdp('/json/list');
  console.log(`TARGETS=${list.length}`);
  for (const t of list) console.log(`  type=${t.type} url=${t.url}`);

  const targets = await cdp('/json/list').catch(() => []);
  const extTargets = targets.filter((t) => String(t.url).startsWith('chrome-extension://'));
  console.log(`EXTENSION_TARGETS=${extTargets.length}`);
  for (const t of extTargets) console.log(`  ext: type=${t.type} url=${t.url}`);
}

console.log('--- browser stderr (first 25 lines) ---');
try {
  const e = fs.readFileSync(path.join(profileDir, 'browser-stderr.log'), 'utf8').split('\n').slice(0, 25);
  console.log(e.join('\n'));
} catch {}

if (!keep) {
  try { child.kill('SIGKILL'); } catch {}
  console.log('BROWSER_KILLED');
} else {
  console.log(`BROWSER_KEPT_ALIVE pid=${child.pid} port=${port}`);
}
// Detach so the harness can exit even with the browser alive.
process.exit(version ? 0 : 1);

