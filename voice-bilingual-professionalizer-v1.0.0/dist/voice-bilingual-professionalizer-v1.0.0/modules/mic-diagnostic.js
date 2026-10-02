/**
 * Stage-by-stage microphone / audio-chain diagnostic.
 *
 * Built for triage in Chromium forks (Shift Browser): finds the FIRST stage of the
 * input chain that fails, instead of jumping to the final recognition error.
 *
 * Stages probed, in order:
 *   1. navigator.mediaDevices.getUserMedia availability
 *   2. microphone permission (navigator.permissions) + input device enumeration
 *   3. getUserMedia({ audio: true })
 *   4. MediaStream / AudioTrack inspection (active, readyState, muted, settings)
 *   5. AudioContext creation, state, resume, sample rate
 *   6. MediaStreamAudioSourceNode + AudioWorklet module load + node registration
 *   7. REAL audio frames flowing into the AudioWorklet over a test window
 *      (frame count, total samples, peak amplitude, RMS, mute events)
 *
 * Privacy: samples are only measured (peak/RMS) — never stored, logged verbatim,
 * or transmitted. The stream is stopped and the context closed afterwards.
 */

const WORKLET_PATH = 'modules/audio-recorder-worklet.js';

function assetUrl(relativePath) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(relativePath);
  }
  return `/${relativePath}`;
}

function cleanupStream(stream, track, onMute, onUnmute) {
  try { if (track) { track.removeEventListener('mute', onMute); track.removeEventListener('unmute', onUnmute); } } catch (e) { /* ignore */ }
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
}

export async function runAudioChainDiagnostic(opts = {}) {
  const durationMs = Math.max(500, opts.durationMs ?? 2500);
  const stages = [];
  const addStage = (name, status, details = {}) => {
    const stage = { name, status, details, at: Date.now() };
    stages.push(stage);
    const tag = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN';
    try { console.log(`[MicTest] ${tag} — ${name}`, details); } catch (e) { /* ignore */ }
    return stage;
  };

  const report = {
    startedAt: new Date().toISOString(),
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
    stages,
    verdict: null
  };

  // ---- Stage 1: API availability -------------------------------------------
  const hasMD = typeof navigator !== 'undefined' && navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function';
  addStage('1. navigator.mediaDevices.getUserMedia available', hasMD ? 'pass' : 'fail', {
    hasMediaDevices: Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices),
    secureContext: (typeof isSecureContext !== 'undefined') ? isSecureContext : null
  });
  if (!hasMD) {
    report.verdict = {
      ok: false,
      firstFailure: 'navigator.mediaDevices',
      summary: 'This context does not expose navigator.mediaDevices at all — no mic capture is possible here.'
    };
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // ---- Stage 2: permission + device enumeration ----------------------------
  let permState = 'unknown';
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const p = await navigator.permissions.query({ name: 'microphone' });
      permState = p.state;
    }
  } catch (e) {
    permState = 'query-unsupported';
  }
  addStage('2. microphone permission', permState === 'granted' ? 'pass' : permState === 'denied' ? 'fail' : 'warn', {
    permissionState: permState,
    note: permState === 'denied'
      ? 'Microphone is DENIED for this origin — getUserMedia will keep failing until it is allowed in site settings.'
      : (permState === 'query-unsupported' ? 'Permission API unsupported; skipping.' : '')
  });

  let inputs = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((d) => d.kind === 'audioinput');
  } catch (e) { /* enumeration is best-effort */ }
  addStage('2b. audio input devices enumerated', inputs.length > 0 ? 'pass' : 'warn', {
    count: inputs.length,
    withLabels: inputs.filter((d) => d.label).length,
    devices: inputs.map((d) => ({
      label: d.label || '(label hidden before permission)',
      deviceId: String(d.deviceId || '').slice(0, 8)
    }))
  });

  // ---- Stage 3: getUserMedia -----------------------------------------------
  let stream = null;
  const t0 = performance.now();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    addStage('3. getUserMedia({audio:true})', 'pass', { acquiredInMs: Math.round(performance.now() - t0) });
  } catch (err) {
    addStage('3. getUserMedia({audio:true})', 'fail', {
      name: err && err.name,
      message: err && err.message,
      constraintName: err && err.constraintName
    });
    report.verdict = {
      ok: false,
      firstFailure: 'getUserMedia',
      summary: `getUserMedia failed: ${(err && err.name) || 'Error'} — ${(err && err.message) || ''}`,
      hint: (err && err.name) === 'NotAllowedError'
        ? 'Microphone permission denied. Allow the microphone for this browser/origin, then rerun.'
        : null
    };
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // ---- Stage 4: MediaStream / AudioTrack -----------------------------------
  const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
  const track = tracks[0] || null;
  let mutedDuringWindow = false;
  const onMute = () => { mutedDuringWindow = true; };
  const onUnmute = () => { };
  try {
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
  } catch (e) {
    try { track.onmute = onMute; } catch (e2) { /* ignore */ }
  }
  const settings = track && track.getSettings ? track.getSettings() : null;
  addStage('4. MediaStream / AudioTrack', tracks.length > 0 && stream.active ? 'pass' : 'fail', {
    streamActive: stream.active,
    trackCount: tracks.length,
    readyState: track ? track.readyState : null,
    label: track ? track.label : null,
    mutedAtStart: track ? track.muted : null,
    settings
  });
  if (!track || !stream.active) {
    cleanupStream(stream, track, onMute, onUnmute);
    report.verdict = {
      ok: false,
      firstFailure: 'MediaStream',
      summary: 'getUserMedia resolved but the stream has no live audio track.'
    };
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // ---- Stage 5: AudioContext ------------------------------------------------
  let ctx = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    const initialState = ctx.state;
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* reported via state below */ }
    }
    addStage('5. AudioContext', ctx.state === 'running' ? 'pass' : 'warn', {
      initialState,
      stateNow: ctx.state,
      sampleRate: ctx.sampleRate,
      note: ctx.state !== 'running' ? 'Context is not running — frames may not flow.' : ''
    });
  } catch (err) {
    addStage('5. AudioContext', 'fail', { name: err && err.name, message: err && err.message });
    cleanupStream(stream, track, onMute, onUnmute);
    report.verdict = {
      ok: false,
      firstFailure: 'AudioContext',
      summary: `AudioContext failed: ${(err && err.message) || err}`
    };
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // ---- Stages 6 + 7: AudioWorklet and real frames ---------------------------
  let frames = 0;
  let samples = 0;
  let peak = 0;
  let rmsAcc = 0;
  try {
    await ctx.audioWorklet.addModule(assetUrl(WORKLET_PATH));
    addStage('6. AudioWorklet module load', 'pass', { module: WORKLET_PATH });

    const sourceNode = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'audio-recorder-processor');
    node.port.onmessage = (event) => {
      if (event.data && event.data.type === 'AUDIO_CHUNK') {
        const chunk = new Float32Array(event.data.samples);
        frames++;
        samples += chunk.length;
        for (let i = 0; i < chunk.length; i++) {
          const a = Math.abs(chunk[i]);
          if (a > peak) peak = a;
          rmsAcc += chunk[i] * chunk[i];
        }
      }
    };
    sourceNode.connect(node);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    node.connect(silentGain);
    silentGain.connect(ctx.destination);

    addStage('7. capture window', 'warn', { note: `collecting ${durationMs} ms of live frames...` });
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    const rms = samples ? Math.sqrt(rmsAcc / samples) : 0;
    const expectedFrames = Math.round((durationMs / 1000) * ((ctx.sampleRate || 48000) / 128));
    const flowed = frames > 0;
    const audible = peak > 0.0015;
    const micMuted = mutedDuringWindow || track.muted === true;
    addStage('7. audio frames reaching AudioWorklet', flowed ? 'pass' : 'fail', {
      frames,
      expectedFrames,
      totalSamples: samples,
      windowMs: durationMs,
      peak: Number(peak.toFixed(5)),
      rms: Number(rms.toFixed(5)),
      trackMuted: micMuted,
      note: !flowed
        ? 'NO FRAMES — permission and stream exist, but the browser is not delivering audio to the Web Audio graph.'
        : (!audible
          ? 'Frames flow but samples are ~zero: mic muted, wrong input device selected, or system input volume is 0.'
          : 'Live audio confirmed flowing through the whole Web Audio chain.')
    });

    report.verdict = {
      ok: flowed,
      firstFailure: flowed ? null : 'AudioWorklet frames',
      audioFlows: flowed,
      audible,
      frames,
      totalSamples: samples,
      durationSec: Number((samples / (ctx.sampleRate || 48000)).toFixed(2)),
      peak: Number(peak.toFixed(5)),
      rms: Number(rms.toFixed(5)),
      trackMuted: micMuted,
      summary: !flowed
        ? 'Microphone permission and stream exist, but NO audio frames reach the Web Audio graph — this browser is not delivering microphone audio.'
        : (audible
          ? 'SUCCESS: the full audio chain (permission → stream → track → AudioContext → worklet frames) works in this browser.'
          : 'Frames flow but the signal is silent — check microphone mute, the selected input device, and system input level.')
    };
  } catch (err) {
    addStage('6/7. AudioWorklet', 'fail', { name: err && err.name, message: err && err.message });
    report.verdict = {
      ok: false,
      firstFailure: 'AudioWorklet',
      summary: `AudioWorklet stage failed: ${(err && err.message) || err}`
    };
  } finally {
    cleanupStream(stream, track, onMute, onUnmute);
    try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (e) { /* ignore */ }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/**
 * Renders the report as plain text for display / clipboard.
 */
export function formatMicReport(report) {
  const lines = [];
  lines.push('Microphone / audio-chain diagnostic');
  lines.push('='.repeat(64));
  lines.push(`Started:   ${report.startedAt}`);
  lines.push(`Browser:   ${report.userAgent}`);
  lines.push('');
  for (const s of report.stages) {
    const tag = s.status === 'pass' ? 'PASS' : s.status === 'fail' ? 'FAIL' : 'WARN';
    lines.push(`[${tag}] ${s.name}`);
    if (s.details && Object.keys(s.details).length) {
      lines.push('       ' + JSON.stringify(s.details));
    }
  }
  lines.push('');
  lines.push('VERDICT:');
  lines.push('  ' + ((report.verdict && report.verdict.summary) || 'no verdict'));
  if (report.verdict && report.verdict.firstFailure) {
    lines.push(`  FIRST FAILING STAGE: ${report.verdict.firstFailure}`);
  }
  if (report.verdict && report.verdict.hint) {
    lines.push(`  HINT: ${report.verdict.hint}`);
  }
  return lines.join('\n');
}
