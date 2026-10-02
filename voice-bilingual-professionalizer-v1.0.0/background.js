/**
 * Chrome Extension Service Worker (Phase 2 & Phase 3)
 * Coordinates lifecycle, commands, and extension views.
 */

import { getSettings, DEFAULT_SETTINGS } from './modules/storage.js';
import { normalizeTranscript } from './modules/normalizer.js';
import { generateBilingualOutput } from './modules/ai-providers.js';

function enforceMicrophoneContentSettings() {
  // Chrome MV3 restricts contentSettings.microphone default to 'ask' or 'block';
  // microphone permission is cleanly acquired and persisted via getUserMedia in mic-setup.html
}

function syncActionPopupMode() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(['windowMode'], (res) => {
    if (res && res.windowMode === 'detached') {
      if (chrome.action && chrome.action.setPopup) {
        chrome.action.setPopup({ popup: '' }).catch(() => {});
      }
    } else {
      if (chrome.action && chrome.action.setPopup) {
        chrome.action.setPopup({ popup: 'popup.html' }).catch(() => {});
      }
    }
  });
}

// Ensure popup mode is always in sync with stored user preference whenever service worker starts
syncActionPopupMode();

// Log the ACTUAL registered shortcuts. Manifest defaults stop applying once a command
// has been customized/cleared in Chrome's UI, so this is the ground truth for
// "Ctrl+Shift+X does nothing" reports. Visible via chrome://extensions → service
// worker "Inspect" console.
if (typeof chrome !== 'undefined' && chrome.commands && chrome.commands.getAll) {
  chrome.commands.getAll((cmds) => {
    for (const c of cmds || []) {
      console.log(`[Shortcuts] ${c.name} → ${c.shortcut || '(UNASSIGNED)'}`);
    }
  });
}

let activeDetachedWinId = null;

async function openOrFocusDetachedWindow() {
  if (typeof chrome === 'undefined' || !chrome.windows) return;
  chrome.storage.local.get(['detachedWindowPos', 'detachedWindowId'], async (res) => {
    const targetWinId = activeDetachedWinId || res.detachedWindowId;
    if (targetWinId) {
      try {
        const existing = await chrome.windows.get(targetWinId);
        if (existing) {
          await chrome.windows.update(targetWinId, { focused: true, drawAttention: true });
          return;
        }
      } catch (e) {
        // window closed — fall through and create a new one
      }
    }

    const pos = res.detachedWindowPos || { left: 140, top: 140, width: 320, height: 430 };
    const createArgs = {
      url: chrome.runtime.getURL('popup.html?mode=detached'),
      type: 'popup',
      // FIXED MAXIMUM SIZE (§ layout fix): the detached window may be smaller but is
      // never created larger than the complete 320 × 430 layout.
      width: Math.min(Math.max(290, pos.width || 320), 320),
      height: Math.min(Math.max(200, pos.height || 430), 430),
      focused: true
    };

    // A stale saved position (e.g. from a monitor that no longer exists) could place
    // the window completely off-screen and make the shortcut look dead. Clamp, and
    // fall back to default placement if creation still fails.
    const safeLeft = Math.min(Math.max(10, typeof pos.left === 'number' ? pos.left : 140), 4000);
    const safeTop = Math.min(Math.max(10, typeof pos.top === 'number' ? pos.top : 140), 4000);

    try {
      const win = await chrome.windows.create({ ...createArgs, left: safeLeft, top: safeTop });
      activeDetachedWinId = win.id;
      chrome.storage.local.set({ detachedWindowId: win.id });
    } catch (err) {
      console.warn('[Shortcuts] detached window creation failed, retrying with default position:', err);
      try { await chrome.storage.local.remove('detachedWindowPos'); } catch (e2) {}
      try {
        const win = await chrome.windows.create(createArgs);
        activeDetachedWinId = win.id;
        chrome.storage.local.set({ detachedWindowId: win.id });
      } catch (err2) {
        console.error('[Shortcuts] detached window could not be created:', err2);
      }
    }
  });
}

// Track detached window movement so position is saved continuously
if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener((win) => {
    chrome.storage.local.get(['detachedWindowId'], (res) => {
      if ((win.id === activeDetachedWinId || res.detachedWindowId === win.id) && typeof win.left === 'number' && typeof win.top === 'number') {
        chrome.storage.local.set({
          detachedWindowPos: {
            left: win.left,
            top: win.top,
            width: win.width,
            height: win.height
          }
        });
      }
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((winId) => {
    if (winId === activeDetachedWinId) {
      activeDetachedWinId = null;
    }
    chrome.storage.local.get(['detachedWindowId'], (res) => {
      if (res.detachedWindowId === winId) {
        chrome.storage.local.remove('detachedWindowId');
      }
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async () => {
    // Only fires when NO popup is set (detached mode). When the popup is set, the
    // browser opens it natively for _execute_action without this event.
    console.log('[Shortcut] browser action activated (onClicked — no popup set)');
    chrome.storage.local.get(['windowMode'], (res) => {
      if (res && res.windowMode === 'detached') {
        openOrFocusDetachedWindow();
      } else {
        if (chrome.action.openPopup) {
          chrome.action.openPopup().catch(() => {});
        }
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  // Automatically and forcefully allow microphone access
  enforceMicrophoneContentSettings();
  syncActionPopupMode();

  chrome.storage.local.get(['micAutoAllowed'], (res) => {
    if (!res.micAutoAllowed || details.reason === 'install') {
      console.log('Voice Bilingual Professionalizer extension initialized. Opening mic auto-grant setup.');
      chrome.tabs.create({
        url: chrome.runtime.getURL('mic-setup.html'),
        active: true
      });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  enforceMicrophoneContentSettings();
  syncActionPopupMode();
});

// Periodic alarm to ensure clean service worker responsiveness
if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create('vbp-keep-alive', { periodInMinutes: 4.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'vbp-keep-alive') {
      syncActionPopupMode();
    }
  });
}

// Configure Side Panel behavior (Chrome 114+)
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

// Handle Keyboard Commands
// NOTE: _execute_action (Ctrl+Shift+X) is a reserved command handled natively by the
// browser and is NEVER dispatched here — only named commands arrive. If Ctrl+Shift+X
// appears dead, check (a) chrome://extensions/shortcuts for the actual binding and
// (b) whether the host browser (e.g. Shift) intercepts the keys before the extension.
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Shortcut] command received:', command);
  if (command === 'toggle-voice-overlay') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id && !tab.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_VOICE_OVERLAY' }).catch((err) => {
          console.warn('Could not send message to tab, injecting overlay script:', err);
        });
      }
    } catch (e) {
      console.warn('Command execution error:', e);
    }
  }
});

// ---- Offscreen Whisper recorder (persistent mic capture + local STT) ----
// MV3 popup pages are destroyed on blur, which kills the AudioContext mid-recording.
// Recording therefore runs in an offscreen document that survives popup focus loss.
const OFFSCREEN_RECORDER_PAGE = 'offscreen.html';

async function ensureWhisperOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    throw new Error('chrome.offscreen API is unavailable in this context.');
  }
  let exists = false;
  try {
    exists = await chrome.offscreen.hasDocument();
  } catch (e) {
    exists = false;
  }
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_RECORDER_PAGE,
      reasons: ['USER_MEDIA'],
      justification: 'On-device Whisper: microphone capture and local speech-to-text inference that must survive popup focus loss.'
    });
  }
}

// Background Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_WINDOW_MODE') {
    chrome.storage.local.set({ windowMode: message.mode });
    if (message.mode === 'detached') {
      if (chrome.action && chrome.action.setPopup) {
        chrome.action.setPopup({ popup: '' }).catch(() => {});
      }
    } else {
      if (chrome.action && chrome.action.setPopup) {
        chrome.action.setPopup({ popup: 'popup.html' }).catch(() => {});
      }
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'OPEN_DETACHED_WINDOW') {
    openOrFocusDetachedWindow();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'FORCE_ALLOW_MICROPHONE') {
    enforceMicrophoneContentSettings();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'OPEN_SIDEPANEL' && chrome.sidePanel && sender.tab?.windowId) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch((err) => {
      console.warn('Could not open side panel:', err);
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'WHISPER_ENSURE_OFFSCREEN') {
    (async () => {
      try {
        await ensureWhisperOffscreen();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, message: err.message || 'Could not create offscreen recorder.' });
      }
    })();
    return true; // async
  }

  // Relay a recorder command from the popup to the offscreen document and pass the
  // (possibly slow) async response back. The offscreen doc answers asynchronously.
  if (message.type === 'WHISPER_CMD') {
    (async () => {
      try {
        await ensureWhisperOffscreen();
      } catch (err) {
        sendResponse({ ok: false, message: err.message || 'Offscreen recorder unavailable.' });
        return;
      }
      try {
        const { type, ...forward } = message;
        const resp = await chrome.runtime.sendMessage({ target: 'offscreen', ...forward });
        sendResponse(resp || { ok: false, message: 'Offscreen recorder did not respond.' });
      } catch (err) {
        sendResponse({ ok: false, message: (err && err.message) || 'Recorder relay failed.' });
      }
    })();
    return true; // async
  }

  if (message.type === 'REFINE_TRANSCRIPT') {
    (async () => {
      try {
        const settings = await getSettings();
        const cleaned = normalizeTranscript(message.transcript);
        const result = await generateBilingualOutput(cleaned, settings);
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message || 'Refinement failed' });
      }
    })();
    return true; // Keep channel open for async response
  }

  return false;
});

