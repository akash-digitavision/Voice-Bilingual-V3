/**
 * In-Page Content Script & Draggable Floating Overlay Widget
 * Movable anywhere on screen with permanent position memory in chrome.storage.local.
 * Activated by Ctrl + Shift + X or extension commands.
 */

(function () {
  if (window.__voiceBilingualExtensionInjected) return;
  window.__voiceBilingualExtensionInjected = true;

  let overlayHost = null;
  let shadowRoot = null;
  let recognition = null;
  let isRecording = false;
  let currentTranscript = '';
  let timerInterval = null;
  let startTime = null;

  // Draggable state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  async function createOverlay() {
    if (overlayHost) return;

    // Load saved position
    let savedPos = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const stored = await new Promise((res) => chrome.storage.local.get(['overlayPos', 'provider'], res));
        if (stored && stored.overlayPos) {
          savedPos = stored.overlayPos;
        }
      }
    } catch (e) {
      console.warn('Could not read overlayPos:', e);
    }

    overlayHost = document.createElement('div');
    overlayHost.id = 'voice-bilingual-professionalizer-host';
    overlayHost.style.position = 'fixed';
    overlayHost.style.zIndex = '2147483647';
    overlayHost.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    // Position setup: restored from memory or clamped default
    if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
      const maxX = Math.max(10, window.innerWidth - 380);
      const maxY = Math.max(10, window.innerHeight - 320);
      const clampedX = Math.min(Math.max(10, savedPos.x), maxX);
      const clampedY = Math.min(Math.max(10, savedPos.y), maxY);
      overlayHost.style.left = clampedX + 'px';
      overlayHost.style.top = clampedY + 'px';
    } else {
      // Default: bottom-right
      overlayHost.style.right = '24px';
      overlayHost.style.bottom = '24px';
    }

    shadowRoot = overlayHost.attachShadow({ mode: 'closed' });

    shadowRoot.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .widget {
          width: 360px;
          background: #eef2f7;
          border: 1px solid rgba(255, 255, 255, 0.95);
          border-radius: 18px;
          box-shadow: -10px -10px 24px #ffffff, 12px 14px 28px rgba(166, 180, 200, 0.45);
          color: #1e293b;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: floatIn 0.2s ease-out;
          font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
        }
        @keyframes floatIn {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(166, 180, 200, 0.25);
          padding-bottom: 8px;
          cursor: grab;
          user-select: none;
        }
        .header:active { cursor: grabbing; }
        .title-left {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .title {
          font-size: 13px;
          font-weight: 700;
          color: #1e293b;
        }
        .move-pill {
          font-size: 10px;
          padding: 2px 7px;
          border-radius: 6px;
          background: linear-gradient(145deg, #ffffff, #e1e7f0);
          color: #0369a1;
          border: 1px solid rgba(255, 255, 255, 0.9);
          box-shadow: -1.5px -1.5px 4px #ffffff, 1.5px 2px 4px rgba(166, 180, 200, 0.35);
          font-weight: 600;
        }
        .close-btn {
          background: linear-gradient(145deg, #ffffff, #e3e9f2);
          border: 1px solid rgba(255, 255, 255, 0.9);
          color: #64748b;
          font-size: 15px;
          cursor: pointer;
          padding: 2px 7px;
          border-radius: 6px;
          box-shadow: -1.5px -1.5px 4px #ffffff, 1.5px 2px 4px rgba(166, 180, 200, 0.35);
          transition: all 0.15s ease;
        }
        .close-btn:hover { color: #0f172a; transform: translateY(-0.5px); }
        .close-btn:active { box-shadow: inset 2px 2px 4px rgba(166, 180, 200, 0.45); transform: translateY(0); }
        
        .api-badge {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #e8eef6;
          border: 1px solid rgba(166, 180, 200, 0.25);
          box-shadow: inset 0 1px 2px rgba(166, 180, 200, 0.15);
          border-radius: 8px;
          padding: 5px 10px;
          font-size: 10.5px;
        }
        .live-dot {
          display: inline-block;
          width: 6.5px;
          height: 6.5px;
          border-radius: 50%;
          background: #10b981;
          margin-right: 5px;
          box-shadow: 0 0 6px #10b981;
        }
        .api-name { font-weight: 700; color: #059669; }
        .shortcut-hint { font-size: 10px; color: #64748b; font-family: monospace; }

        .recording-box {
          display: flex;
          align-items: center;
          gap: 10px;
          background: linear-gradient(145deg, #f8fafd, #e8eef6);
          padding: 7px 12px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.95);
          box-shadow: -3px -3px 8px #ffffff, 3px 4px 10px rgba(166, 180, 200, 0.35);
        }
        .rec-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #e11d48;
          animation: blink 1s infinite;
        }
        @keyframes blink { 50% { opacity: 0.3; } }
        .timer { font-family: monospace; font-size: 13px; font-weight: 700; color: #0284c7; text-shadow: 0 1px 1px #ffffff; }

        .transcript-container {
          display: flex;
          flex-direction: column;
          background: #edf2f8;
          border: 1px solid rgba(255, 255, 255, 0.95);
          border-radius: 12px;
          box-shadow: -4px -4px 10px #ffffff, 4px 5px 12px rgba(166, 180, 200, 0.3);
          overflow: hidden;
        }
        .transcript-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 10px;
          background: linear-gradient(180deg, #f9fbfd 0%, #edf2f8 100%);
          border-bottom: 1px solid rgba(166, 180, 200, 0.25);
          font-size: 9.5px;
          font-weight: 700;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .header-btns {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .mini-copy, .mini-expand {
          background: linear-gradient(145deg, #ffffff, #e5ebf4);
          border: 1px solid rgba(255, 255, 255, 0.9);
          box-shadow: -1.5px -1.5px 4px #ffffff, 1.5px 2px 4px rgba(166, 180, 200, 0.35);
          color: #0284c7;
          cursor: pointer;
          font-size: 9.5px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 5px;
          transition: all 0.15s ease;
        }
        .mini-copy:hover, .mini-expand:hover { color: #0369a1; transform: translateY(-0.5px); }
        .mini-copy:active, .mini-expand:active { box-shadow: inset 2px 2px 4px rgba(166, 180, 200, 0.45); transform: translateY(0); }
        .transcript {
          margin: 6px;
          padding: 8px 10px;
          font-size: 11.5px;
          line-height: 1.4;
          min-height: 34px;
          max-height: 38px;
          overflow-y: hidden;
          color: #1e293b;
          background-color: #e4eaf2;
          border: 1px solid rgba(166, 180, 200, 0.25);
          border-radius: 9px;
          box-shadow: inset 3px 3px 6px rgba(166, 180, 200, 0.45), inset -3px -3px 6px #ffffff;
          user-select: text;
          transition: all 0.2s ease;
        }
        .transcript-container.is-expanded .transcript {
          min-height: 110px;
          max-height: 170px;
          overflow-y: auto;
        }

        .controls-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 7px;
        }
        .btn-col {
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .btn-row {
          display: flex;
          gap: 7px;
        }
        .btn {
          width: 100%;
          padding: 8px 10px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.02em;
          cursor: pointer;
          border: 1px solid rgba(255, 255, 255, 0.95);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          background: linear-gradient(145deg, #ffffff, #e5ebf4);
          color: #1e293b;
          box-shadow: -3px -3px 7px #ffffff, 3px 4px 8px rgba(166, 180, 200, 0.42);
          transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: -4px -4px 9px #ffffff, 4px 6px 11px rgba(166, 180, 200, 0.48); }
        .btn:active:not(:disabled) { transform: translateY(0); box-shadow: inset 2px 2px 4px rgba(166, 180, 200, 0.45), inset -2px -2px 4px #ffffff; }
        .btn-stop { background: linear-gradient(145deg, #fff1f2, #ffe4e6); border: 1px solid rgba(244, 63, 94, 0.3); color: #e11d48; }
        .btn-copy { background: linear-gradient(145deg, #ffffff, #e6ecf5); color: #0369a1; }
        .btn-refine { background: linear-gradient(145deg, #0284c7, #0369a1); color: #fff; border: 1px solid rgba(255, 255, 255, 0.3); box-shadow: -2px -2px 6px #ffffff, 3px 4px 9px rgba(2, 132, 199, 0.4); }
        .btn-refine:hover:not(:disabled) { background: linear-gradient(145deg, #0369a1, #075985); }
        .btn-cancel { background: linear-gradient(145deg, #ffffff, #e5ebf4); color: #64748b; }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; background: #e2e8f0; color: #94a3b8; transform: none !important; }

        .results {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .card {
          background: #edf2f8;
          border: 1px solid rgba(255, 255, 255, 0.95);
          border-radius: 12px;
          box-shadow: -4px -4px 10px #ffffff, 4px 5px 12px rgba(166, 180, 200, 0.3);
          padding: 8px 10px;
        }
        .card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        .lang-tag { font-size: 11px; font-weight: 700; color: #1e293b; }
        .copy-pill {
          background: linear-gradient(145deg, #ffffff, #e5ebf4);
          border: 1px solid rgba(255, 255, 255, 0.9);
          box-shadow: -1.5px -1.5px 4px #ffffff, 1.5px 2px 4px rgba(166, 180, 200, 0.35);
          color: #0284c7;
          font-size: 10.5px;
          font-weight: 700;
          padding: 2.5px 7px;
          border-radius: 6px;
          cursor: pointer;
        }
        .copy-pill:hover { color: #0369a1; transform: translateY(-0.5px); }
        .copy-pill:active { box-shadow: inset 2px 2px 4px rgba(166, 180, 200, 0.45); transform: translateY(0); }
        .card-text {
          font-size: 12px;
          line-height: 1.4;
          color: #1e293b;
          background-color: #e4eaf2;
          border: 1px solid rgba(166, 180, 200, 0.25);
          border-radius: 8px;
          padding: 6px 8px;
          box-shadow: inset 3px 3px 6px rgba(166, 180, 200, 0.45), inset -3px -3px 6px #ffffff;
        }
      </style>
      <div class="widget">
        <!-- Draggable Header -->
        <div class="header" id="widget-header" title="Drag to move this popup anywhere on screen">
          <div class="title-left">
            <span class="title">🎙 Voice Professionalizer</span>
            <span class="move-pill">Movable ⤢</span>
          </div>
          <button class="close-btn" id="close-widget">&times;</button>
        </div>

        <!-- Active Running API Bar -->
        <div class="api-badge">
          <div>
            <span class="live-dot"></span>
            <span>Running API Key: <strong id="widget-api-name" class="api-name">Active</strong></span>
          </div>
          <span class="shortcut-hint">Ctrl+Shift+X</span>
        </div>

        <!-- Recording Section -->
        <div id="rec-section">
          <div class="recording-box">
            <div class="rec-dot" id="widget-rec-dot"></div>
            <span class="timer" id="widget-timer">00:00</span>
          </div>

          <div class="transcript-container is-expanded" id="widget-transcript-box" style="margin-top: 8px;">
            <div class="transcript-header">
              <span>Voice Input</span>
              <div class="header-btns">
                <button class="mini-copy" id="widget-copy-orig-header" title="Copy original voice">📋 Copy</button>
                <button class="mini-expand" id="widget-expand-transcript" title="Collapse text view">⤡</button>
              </div>
            </div>
            <div class="transcript" id="widget-transcript"></div>
          </div>

          <div class="controls-grid" style="margin-top: 8px;">
            <!-- Left Column: Copy & Refine -->
            <div class="btn-col">
              <button class="btn btn-copy" id="widget-copy-orig">📋 Copy</button>
              <button class="btn btn-refine" id="widget-refine">✨ Refine</button>
            </div>
            <!-- Right Column: Stop & Cancel -->
            <div class="btn-col">
              <button class="btn btn-stop" id="widget-stop">■ Stop</button>
              <button class="btn btn-cancel" id="widget-cancel">✕ Cancel</button>
            </div>
          </div>
          <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); display: flex; justify-content: space-between; align-items: center; font-size: 9.5px; color: #94a3b8;">
            <span>Developed by <strong style="color: #38bdf8;">Akash</strong></span>
            <span style="font-family: monospace; font-size: 8.5px; color: #64748b;">Ctrl+Shift+X</span>
          </div>
        </div>

        <!-- Results Section -->
        <div id="res-section" style="display: none;">
          <div class="results">
            <div class="card">
              <div class="card-top">
                <span class="lang-tag">🇧🇩 Bangla Professional</span>
                <button class="copy-pill" id="copy-bn">Copy</button>
              </div>
              <div class="card-text" id="text-bn"></div>
            </div>
            <div class="card">
              <div class="card-top">
                <span class="lang-tag">🇬🇧 English Professional</span>
                <button class="copy-pill" id="copy-en">Copy</button>
              </div>
              <div class="card-text" id="text-en"></div>
            </div>
          </div>
          <div class="btn-row" style="margin-top: 8px;">
            <button class="btn btn-refine" id="widget-again">↻ Record Again</button>
            <button class="btn btn-copy" id="copy-both">Copy Both</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlayHost);

    // Bind Dragging on header
    const headerEl = shadowRoot.getElementById('widget-header');
    headerEl.addEventListener('mousedown', onDragStart);

    // Bind actions
    shadowRoot.getElementById('close-widget').addEventListener('click', closeOverlay);
    shadowRoot.getElementById('widget-stop').addEventListener('click', handleWidgetStop);
    shadowRoot.getElementById('widget-refine').addEventListener('click', handleWidgetRefine);
    shadowRoot.getElementById('widget-copy-orig').addEventListener('click', copyOriginalVoice);
    shadowRoot.getElementById('widget-copy-orig-header').addEventListener('click', copyOriginalVoice);
    shadowRoot.getElementById('widget-cancel').addEventListener('click', closeOverlay);

    const expandBtn = shadowRoot.getElementById('widget-expand-transcript');
    const transcriptBoxEl = shadowRoot.getElementById('widget-transcript-box');
    let isWidgetTranscriptExpanded = true;
    if (expandBtn && transcriptBoxEl) {
      expandBtn.addEventListener('click', () => {
        isWidgetTranscriptExpanded = !isWidgetTranscriptExpanded;
        transcriptBoxEl.classList.toggle('is-expanded', isWidgetTranscriptExpanded);
        expandBtn.textContent = isWidgetTranscriptExpanded ? '⤡' : '⤢';
        expandBtn.title = isWidgetTranscriptExpanded ? 'Collapse text view' : 'Expand full text view';
      });
    }

    shadowRoot.getElementById('widget-again').addEventListener('click', () => {
      shadowRoot.getElementById('res-section').style.display = 'none';
      shadowRoot.getElementById('rec-section').style.display = 'block';
      startRecording();
    });

    // Populate active API name in overlay
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['provider', 'geminiKey', 'openaiKey', 'customKey', 'openaiModel', 'geminiModel', 'customModel'], (res) => {
        const isGoogle = Boolean(res.geminiKey && res.geminiKey.trim().length > 0);
        const isOpenAI = Boolean(res.openaiKey && res.openaiKey.trim().length > 0);
        const isCustom = Boolean(res.customKey && res.customKey.trim().length > 0);

        let effective = 'none';
        if (res.provider === 'gemini' && isGoogle) effective = 'gemini';
        else if (res.provider === 'openai' && isOpenAI) effective = 'openai';
        else if (res.provider === 'custom' && isCustom) effective = 'custom';
        else if (isGoogle) effective = 'gemini';
        else if (isOpenAI) effective = 'openai';
        else if (isCustom) effective = 'custom';

        const nameEl = shadowRoot.getElementById('widget-api-name');
        const liveDot = shadowRoot.querySelector('.api-badge .live-dot');
        const nameMap = { openai: 'OpenAI', gemini: 'Google Gemini', custom: 'Custom API' };

        if (nameEl) {
          if (effective === 'none') {
            nameEl.textContent = 'None (Configure in Settings)';
            nameEl.style.color = '#94a3b8';
            if (liveDot) {
              liveDot.style.background = '#64748b';
              liveDot.style.boxShadow = 'none';
            }
          } else {
            nameEl.textContent = nameMap[effective] || effective;
            nameEl.style.color = '#34d399';
            if (liveDot) {
              liveDot.style.background = '#10b981';
              liveDot.style.boxShadow = '0 0 6px #10b981';
            }
          }
        }
      });
    }
  }

  function onDragStart(e) {
    if (e.button !== 0) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = overlayHost.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    // Switch to explicit left/top coordinates
    overlayHost.style.right = 'auto';
    overlayHost.style.bottom = 'auto';
    overlayHost.style.left = initialLeft + 'px';
    overlayHost.style.top = initialTop + 'px';

    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (!isDragging || !overlayHost) return;
    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    const newLeft = Math.max(10, Math.min(window.innerWidth - 380, initialLeft + deltaX));
    const newTop = Math.max(10, Math.min(window.innerHeight - 300, initialTop + deltaY));

    overlayHost.style.left = newLeft + 'px';
    overlayHost.style.top = newTop + 'px';
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);

    // Save exact position permanently in chrome.storage.local
    if (overlayHost) {
      const finalX = parseInt(overlayHost.style.left, 10);
      const finalY = parseInt(overlayHost.style.top, 10);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ overlayPos: { x: finalX, y: finalY } });
      }
    }
  }

  function copyOriginalVoice() {
    if (!currentTranscript.trim()) return;
    navigator.clipboard.writeText(currentTranscript).then(() => {
      const btn = shadowRoot.getElementById('widget-copy-orig');
      const headerBtn = shadowRoot.getElementById('widget-copy-orig-header');
      if (btn) btn.textContent = 'Copied ✓';
      if (headerBtn) headerBtn.textContent = 'Copied ✓';
      setTimeout(() => {
        if (btn) btn.textContent = '📋 Copy Voice';
        if (headerBtn) headerBtn.textContent = 'Copy';
      }, 1500);
    });
  }

  function handleWidgetStop() {
    if (recognition && isRecording) {
      recognition.stop();
    }
    isRecording = false;
    clearInterval(timerInterval);

    const statusEl = shadowRoot.getElementById('widget-status');
    const recDot = shadowRoot.getElementById('widget-rec-dot');
    if (statusEl) statusEl.textContent = 'Recording stopped. Copy voice or click Refine.';
    if (recDot) recDot.style.animation = 'none';
  }

  function handleWidgetRefine() {
    if (recognition && isRecording) {
      recognition.stop();
      isRecording = false;
      clearInterval(timerInterval);
    }

    if (!currentTranscript.trim()) {
      alert('Please speak before refining.');
      return;
    }

    const statusEl = shadowRoot.getElementById('widget-status');
    if (statusEl) statusEl.textContent = 'Polishing into Bangla & English...';

    chrome.runtime.sendMessage(
      { type: 'REFINE_TRANSCRIPT', transcript: currentTranscript },
      (response) => {
        if (response && response.bangla && response.english) {
          shadowRoot.getElementById('rec-section').style.display = 'none';
          shadowRoot.getElementById('res-section').style.display = 'block';
          shadowRoot.getElementById('text-bn').textContent = response.bangla;
          shadowRoot.getElementById('text-en').textContent = response.english;

          shadowRoot.getElementById('copy-bn').onclick = () => {
            navigator.clipboard.writeText(response.bangla);
            shadowRoot.getElementById('copy-bn').textContent = 'Copied ✓';
            setTimeout(() => { shadowRoot.getElementById('copy-bn').textContent = 'Copy'; }, 1500);
          };

          shadowRoot.getElementById('copy-en').onclick = () => {
            navigator.clipboard.writeText(response.english);
            shadowRoot.getElementById('copy-en').textContent = 'Copied ✓';
            setTimeout(() => { shadowRoot.getElementById('copy-en').textContent = 'Copy'; }, 1500);
          };

          shadowRoot.getElementById('copy-both').onclick = () => {
            const combined = `🇧🇩 বাংলা:\n${response.bangla}\n\n🇬🇧 English:\n${response.english}`;
            navigator.clipboard.writeText(combined);
            shadowRoot.getElementById('copy-both').textContent = 'Both Copied ✓';
            setTimeout(() => { shadowRoot.getElementById('copy-both').textContent = 'Copy Both'; }, 1500);
          };
        } else {
          if (statusEl) statusEl.textContent = response?.error || 'Refinement failed.';
        }
      }
    );
  }

  function startRecording() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }

    currentTranscript = '';
    const transcriptEl = shadowRoot.getElementById('widget-transcript');
    const statusEl = shadowRoot.getElementById('widget-status');
    const recDot = shadowRoot.getElementById('widget-rec-dot');
    if (transcriptEl) transcriptEl.textContent = 'Listening...';
    if (statusEl) statusEl.textContent = 'Recording voice...';
    if (recDot) recDot.style.animation = 'blink 1s infinite';

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'bn-BD';

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      currentTranscript = (final + ' ' + interim).trim();
      if (transcriptEl) transcriptEl.textContent = currentTranscript || 'Listening...';
    };

    recognition.onerror = (e) => {
      console.warn('In-page STT error:', e);
    };

    recognition.onend = () => {
      isRecording = false;
      clearInterval(timerInterval);
    };

    try {
      recognition.start();
      isRecording = true;
      startTime = Date.now();
      timerInterval = setInterval(() => {
        const secs = Math.floor((Date.now() - startTime) / 1000);
        const m = String(Math.floor(secs / 60)).padStart(2, '0');
        const s = String(secs % 60).padStart(2, '0');
        const timerEl = shadowRoot.getElementById('widget-timer');
        if (timerEl) timerEl.textContent = `${m}:${s}`;
      }, 500);
    } catch (e) {
      console.warn('Could not start recognition:', e);
    }
  }

  function closeOverlay() {
    if (recognition && isRecording) {
      recognition.abort();
    }
    isRecording = false;
    clearInterval(timerInterval);
    if (overlayHost) {
      overlayHost.remove();
      overlayHost = null;
      shadowRoot = null;
    }
  }

  // Global Keyboard Shortcut: Ctrl + Shift + X (or Cmd + Shift + X)
  // In-page fallback: if the browser consumed the key as an extension command, this
  // never fires. If it fires in Shift Browser, Shift did NOT intercept the shortcut.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
      console.log('[Shortcut] in-page Ctrl+Shift+X captured (browser did not consume it)');
      e.preventDefault();
      if (overlayHost) {
        closeOverlay();
      } else {
        createOverlay().then(startRecording);
      }
    }
  });

  // Listen for messages from background service worker
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'TOGGLE_VOICE_OVERLAY') {
        if (overlayHost) {
          closeOverlay();
        } else {
          createOverlay().then(startRecording);
        }
        sendResponse({ success: true });
      }
    });
  }
})();
