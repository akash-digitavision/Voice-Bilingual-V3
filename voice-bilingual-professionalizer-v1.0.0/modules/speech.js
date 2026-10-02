/**
 * Speech-to-Text Abstraction Module (Phase 5)
 * Browser Speech (Web Speech API) with a deterministic ONE-ATTEMPT lifecycle.
 *
 * CONTRACT (manual retry only — no automatic retries, ever):
 *   One user action (mic press / Retry button) = exactly ONE recognition attempt.
 *   Success → LISTENING (stable while the popup stays open; no restarts).
 *   Failure → the REAL error surfaces immediately; the user presses Retry again.
 *
 * Lifecycle state model (only one recognition instance may ever be active):
 *   IDLE → STARTING → LISTENING → STOPPING → ENDED
 *                                ↘ ERROR
 *
 * Every attempt uses a FRESH recognition instance: the previous instance is aborted
 * and awaited to fully end before a new one is created — stale/ending instances are
 * never reused and old/new sessions never overlap.
 *
 * Shift Browser compatibility note (diagnostics, not workarounds): Chromium forks can
 * fail start attempts with transient service errors until the speech service warms up.
 * Recovery is MANUAL by design — each user retry gets one clean attempt with full
 * [WebSpeech] diagnostics (onaudiostart/onsoundstart/onspeechstart included) so the
 * exact failing stage and error are visible.
 */

const SR_STATE = Object.freeze({
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  LISTENING: 'LISTENING',
  STOPPING: 'STOPPING',
  ENDED: 'ENDED',
  ERROR: 'ERROR'
});

const SETTLE_AFTER_ABORT_MS = 150; // let a previous session fully end before a new start

function friendlyError(code) {
  switch (code) {
    case 'not-allowed':
      return 'Microphone permission is required to record your voice.';
    case 'service-not-allowed':
      return 'The browser blocked the speech-recognition service. Check browser speech/microphone settings.';
    case 'no-speech':
      return 'No voice input was detected. Please try again.';
    case 'network':
      return 'Network error during speech recognition. Please check your connection.';
    case 'audio-capture':
      return 'Microphone hardware unavailable or muted.';
    case 'language-not-supported':
      return 'The selected recognition language is not supported by this browser.';
    case 'aborted':
      return 'Recognition was interrupted while starting.';
    default:
      return 'Speech recognition error occurred.';
  }
}

export class SpeechService {
  constructor(options = {}) {
    this.language = options.language || 'bn-BD'; // 'bn-BD' or 'en-US'
    this.continuous = options.continuous !== undefined ? options.continuous : true;
    this.interimResults = options.interimResults !== undefined ? options.interimResults : true;

    this.recognition = null;
    this.isRecording = false;      // true only while LISTENING
    this.state = SR_STATE.IDLE;
    this.finalTranscript = '';
    this.interimTranscript = '';

    this._startedAt = 0;           // timestamp of the current attempt's start()

    // Callbacks
    this.onStart = options.onStart || (() => {});
    this.onResult = options.onResult || (() => {});
    this.onError = options.onError || (() => {});
    this.onEnd = options.onEnd || (() => {});

    this._log('create', { language: this.language, continuous: this.continuous });
  }

  _log(message, data) {
    try {
      if (data !== undefined) console.log('[WebSpeech]', message, data);
      else console.log('[WebSpeech]', message);
    } catch (e) { /* logging must never break recognition */ }
  }

  _setState(state) {
    this.state = state;
    this._log('state →', state);
  }

  /**
   * Waits (bounded) for a recognition instance to fully end. Starting a new session
   * on top of an ending one is a documented source of browser errors.
   */
  _waitForEnd(recognition, timeoutMs = SETTLE_AFTER_ABORT_MS) {
    return new Promise((resolve) => {
      if (!recognition) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const previousOnEnd = recognition.onend;
      recognition.onend = () => {
        try { if (previousOnEnd) previousOnEnd(); } catch (e) { /* ignore */ }
        finish();
      };
      setTimeout(finish, timeoutMs);
    });
  }

  initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    // §2: feature detection + environment evidence — API existence ≠ service availability.
    this._log('environment', {
      speechRecognitionAvailable: Boolean(SpeechRecognition),
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
      platform: (typeof navigator !== 'undefined' && navigator.platform) || 'unknown',
      language: (typeof navigator !== 'undefined' && navigator.language) || 'unknown'
    });
    if (!SpeechRecognition) {
      this._log('SpeechRecognition API not supported in this browser');
      return null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = this.continuous;
    recognition.interimResults = this.interimResults;
    recognition.lang = this.language;
    this._log('create');

    recognition.onaudiostart = () => this._log('onaudiostart');
    recognition.onsoundstart = () => this._log('onsoundstart');
    recognition.onspeechstart = () => this._log('onspeechstart');

    recognition.onstart = () => {
      this._log('onstart', {
        afterMs: this._startedAt ? Math.round(performance.now() - this._startedAt) : null,
        lang: this.language
      });
      this.isRecording = true;
      this._setState(SR_STATE.LISTENING);
      this.onStart();
    };

    recognition.onresult = (event) => {
      this._log('onresult', { resultIndex: event.resultIndex, results: event.results.length });
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcriptPart = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          this.finalTranscript += (this.finalTranscript ? ' ' : '') + transcriptPart;
        } else {
          interim += transcriptPart;
        }
      }
      this.interimTranscript = interim;
      this.onResult({
        final: this.finalTranscript,
        interim: this.interimTranscript,
        full: (this.finalTranscript + ' ' + this.interimTranscript).trim()
      });
    };

    recognition.onerror = (event) => {
      const code = (event && event.error) || 'unknown';
      const extra = event && event.message ? event.message : undefined;
      const context = {
        error: code,
        message: extra || null,
        state: this.state,
        visibility: (typeof document !== 'undefined' && document.visibilityState) || null,
        hasFocus: (typeof document !== 'undefined' && document.hasFocus) ? document.hasFocus() : null,
        userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
        timestamp: new Date().toISOString()
      };
      this._log('onerror', context);

      if (this.state === SR_STATE.STOPPING) return; // user-initiated teardown noise

      // ONE attempt per user action: surface the real error immediately with the
      // capture context (§3). No automatic retries — recovery is the user pressing
      // Retry (manual).
      this.isRecording = false;
      this._setState(SR_STATE.ERROR);
      this.onError({
        code,
        message: friendlyError(code),
        error: code,
        rawMessage: extra || null,
        diagnostic: context
      });
    };

    recognition.onend = () => {
      this._log('onend', { state: this.state, hadTranscript: Boolean(this.finalTranscript.trim()) });
      if (this.state === SR_STATE.STOPPING || this.state === SR_STATE.LISTENING || this.state === SR_STATE.STARTING) {
        this.isRecording = false;
        this._setState(SR_STATE.ENDED);
        this.onEnd({ final: this.finalTranscript.trim() });
      }
    };

    return recognition;
  }

  /**
   * ONE attempt: tear down any previous instance, wait for it to fully end, create
   * a fresh recognition, start. Success or failure — never a second automatic start.
   */
  async _attemptStart() {
    const previous = this.recognition;
    this.recognition = null;
    if (previous) {
      try { previous.abort(); } catch (e) { this._log('abort of previous instance threw', { error: String(e) }); }
      await this._waitForEnd(previous);
    }

    const recognition = this.initRecognition();
    if (!recognition) {
      this._setState(SR_STATE.ERROR);
      this.onError({
        code: 'UNSUPPORTED',
        message: 'Speech recognition is not supported in this browser environment.'
      });
      return;
    }
    this.recognition = recognition;

    this._startedAt = performance.now();
    this._log('start requested', { lang: this.language });
    this._setState(SR_STATE.STARTING);
    try {
      recognition.start();
    } catch (e) {
      // Synchronous failure (e.g. InvalidStateError: already started). One attempt
      // means we surface this instead of automatically restarting.
      this._log('start() threw synchronously', { error: (e && e.message) || String(e) });
      this.isRecording = false;
      this._setState(SR_STATE.ERROR);
      this.onError({
        code: 'aborted',
        message: friendlyError('aborted'),
        error: (e && e.name) || 'start-failed',
        rawMessage: (e && e.message) || null
      });
    }
  }

  setLanguage(lang) {
    this.language = lang;
    if (this.recognition) {
      this.recognition.lang = lang;
    }
    this._log('setLanguage', { lang });
  }

  /**
   * Public start — ONE attempt per call. A second call while STARTING or LISTENING
   * is ignored (single active instance guarantee; no stacked sessions).
   */
  start() {
    if (this.state === SR_STATE.STARTING || this.state === SR_STATE.LISTENING) {
      this._log('start() ignored — session already active', { state: this.state });
      return;
    }
    this.finalTranscript = '';
    this.interimTranscript = '';
    this._attemptStart();
  }

  stop() {
    if (this.state !== SR_STATE.LISTENING && this.state !== SR_STATE.STARTING) return;
    this._setState(SR_STATE.STOPPING);
    try {
      if (this.recognition) this.recognition.stop();
    } catch (e) {
      this._log('stop() threw', { error: (e && e.message) || String(e) });
    }
  }

  abort() {
    try {
      if (this.recognition) this.recognition.abort();
    } catch (e) {
      this._log('abort() threw', { error: (e && e.message) || String(e) });
    }
    this.isRecording = false;
    this._setState(SR_STATE.ENDED);
  }
}
