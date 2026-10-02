/**
 * Extension Options Controller
 * 
 * Rules:
 * 1. Active/Running status is ONLY displayed when an API key has been actually configured for that specific platform.
 * 2. If no API key has been configured for any platform, NO platform shows Running or Active.
 * 3. Moving between tabs does NOT change the active/running status; it only changes which panel is displayed.
 */

import { getSettings, saveSettings, isProviderConfigured, getEffectiveProvider } from './modules/storage.js';
import { generateBilingualOutput } from './modules/ai-providers.js';
import { LocalSTTEngine, STT_STAGE, classifyLocalSttError } from './modules/local-stt-engine.js';
import { runAudioChainDiagnostic, formatMicReport } from './modules/mic-diagnostic.js';
import { transcribeWithVoiceInput, isVoiceInputConfigured } from './modules/voice-input.js';

// DOM Elements - Banner
const optionsActiveBanner = document.getElementById('options-active-banner');
const activeBannerDot = document.getElementById('active-banner-dot');
const activeBannerName = document.getElementById('active-banner-name');
const activeBannerModel = document.getElementById('active-banner-model');
const activeBannerPill = document.getElementById('active-banner-pill');

// DOM Elements - Tabs
const tabBtnGemini = document.getElementById('tab-btn-gemini');
const tabBtnOpenAI = document.getElementById('tab-btn-openai');
const tabBtnCustom = document.getElementById('tab-btn-custom');

const statusPillGemini = document.getElementById('status-pill-gemini');
const statusPillOpenAI = document.getElementById('status-pill-openai');
const statusPillCustom = document.getElementById('status-pill-custom');

// DOM Elements - Panels
const fieldsGemini = document.getElementById('fields-gemini');
const fieldsOpenAI = document.getElementById('fields-openai');
const fieldsCustom = document.getElementById('fields-custom');

const panelBadgeGemini = document.getElementById('panel-badge-gemini');
const panelBadgeOpenAI = document.getElementById('panel-badge-openai');
const panelBadgeCustom = document.getElementById('panel-badge-custom');

// Inputs - Gemini
const geminiKey = document.getElementById('gemini-key');
const geminiModel = document.getElementById('gemini-model');
const btnToggleGemini = document.getElementById('btn-toggle-gemini');
const btnSaveGemini = document.getElementById('btn-save-gemini');
const btnClearGemini = document.getElementById('btn-clear-gemini');

// Inputs - OpenAI
const openaiKey = document.getElementById('openai-key');
const openaiModel = document.getElementById('openai-model');
const btnToggleOpenAI = document.getElementById('btn-toggle-openai');
const btnSaveOpenAI = document.getElementById('btn-save-openai');
const btnClearOpenAI = document.getElementById('btn-clear-openai');

// Inputs - Custom
const customEndpoint = document.getElementById('custom-endpoint');
const customKey = document.getElementById('custom-key');
const customModel = document.getElementById('custom-model');
const btnSaveCustom = document.getElementById('btn-save-custom');
const btnClearCustom = document.getElementById('btn-clear-custom');

// Preferences
const prefLanguage = document.getElementById('pref-language');
const prefAutostart = document.getElementById('pref-autostart');
const prefSpeechEngine = document.getElementById('pref-speech-engine');
const prefLocalModel = document.getElementById('pref-local-model');
const prefAcceleration = document.getElementById('pref-acceleration');
const prefTone = document.getElementById('pref-tone');
const prefConciseness = document.getElementById('pref-conciseness');

// Actions & Status
const btnTestConnection = document.getElementById('btn-test-connection');
const testStatus = document.getElementById('test-status');
const btnSaveSettings = document.getElementById('btn-save-settings');
const saveStatus = document.getElementById('save-status');

// Local controller state
let currentSettings = null;
let currentViewingTab = 'gemini'; // 'gemini' | 'openai' | 'custom'
let latestWhisperEngine = null; // last LocalSTTEngine used by the setup panel (for diagnostics)

function togglePassword(input, btn) {
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

/**
 * Updates banner, tab pills, and badges strictly based on actual configured keys
 */
function renderActiveStatus(settings) {
  const effective = getEffectiveProvider(settings);

  const isGoogle = isProviderConfigured(settings, 'gemini');
  const isOpenAI = isProviderConfigured(settings, 'openai');
  const isCustom = isProviderConfigured(settings, 'custom');

  // 1. Top Banner
  if (effective === 'none') {
    optionsActiveBanner.className = 'active-running-banner no-active';
    activeBannerDot.className = 'live-pulse-dot dot-inactive';
    activeBannerName.textContent = 'None';
    activeBannerModel.textContent = '(No key configured)';
    activeBannerPill.className = 'active-badge-pill pill-inactive';
    activeBannerPill.textContent = 'NO RUNNING ENGINE';
  } else {
    optionsActiveBanner.className = 'active-running-banner';
    activeBannerDot.className = 'live-pulse-dot';
    activeBannerPill.className = 'active-badge-pill';
    activeBannerPill.textContent = '● ACTIVE RUNNING ENGINE';

    if (effective === 'gemini') {
      activeBannerName.textContent = 'Google Gemini';
      activeBannerModel.textContent = `(${settings.geminiModel || 'gemini-3.8-flash'})`;
    } else if (effective === 'openai') {
      activeBannerName.textContent = 'OpenAI';
      activeBannerModel.textContent = `(${settings.openaiModel || 'gpt-4o-mini'})`;
    } else if (effective === 'custom') {
      activeBannerName.textContent = 'Custom API';
      activeBannerModel.textContent = `(${settings.customModel || 'llama3'})`;
    }
  }

  // 2. Google Tab & Panel Status
  tabBtnGemini.classList.remove('is-active-running');
  if (effective === 'gemini') {
    tabBtnGemini.classList.add('is-active-running');
    statusPillGemini.className = 'tab-status-pill status-active';
    statusPillGemini.textContent = '● Active / Running';
    panelBadgeGemini.className = 'panel-header-badge badge-active';
    panelBadgeGemini.innerHTML = '<span>● Google Gemini: Running Active Engine ✓</span>';
    btnClearGemini.style.display = 'inline-block';
  } else if (isGoogle) {
    statusPillGemini.className = 'tab-status-pill status-configured';
    statusPillGemini.textContent = 'Key Configured';
    panelBadgeGemini.className = 'panel-header-badge badge-configured';
    panelBadgeGemini.innerHTML = '<span>Key Saved (Inactive — click Save & Activate below to run)</span>';
    btnClearGemini.style.display = 'inline-block';
  } else {
    statusPillGemini.className = 'tab-status-pill status-empty';
    statusPillGemini.textContent = 'Not Configured';
    panelBadgeGemini.className = 'panel-header-badge badge-empty';
    panelBadgeGemini.innerHTML = '<span>No Key Configured</span>';
    btnClearGemini.style.display = 'none';
  }

  // 3. OpenAI Tab & Panel Status
  tabBtnOpenAI.classList.remove('is-active-running');
  if (effective === 'openai') {
    tabBtnOpenAI.classList.add('is-active-running');
    statusPillOpenAI.className = 'tab-status-pill status-active';
    statusPillOpenAI.textContent = '● Active / Running';
    panelBadgeOpenAI.className = 'panel-header-badge badge-active';
    panelBadgeOpenAI.innerHTML = '<span>● OpenAI: Running Active Engine ✓</span>';
    btnClearOpenAI.style.display = 'inline-block';
  } else if (isOpenAI) {
    statusPillOpenAI.className = 'tab-status-pill status-configured';
    statusPillOpenAI.textContent = 'Key Configured';
    panelBadgeOpenAI.className = 'panel-header-badge badge-configured';
    panelBadgeOpenAI.innerHTML = '<span>Key Saved (Inactive — click Save & Activate below to run)</span>';
    btnClearOpenAI.style.display = 'inline-block';
  } else {
    statusPillOpenAI.className = 'tab-status-pill status-empty';
    statusPillOpenAI.textContent = 'Not Configured';
    panelBadgeOpenAI.className = 'panel-header-badge badge-empty';
    panelBadgeOpenAI.innerHTML = '<span>No Key Configured</span>';
    btnClearOpenAI.style.display = 'none';
  }

  // 4. Custom API Tab & Panel Status
  tabBtnCustom.classList.remove('is-active-running');
  if (effective === 'custom') {
    tabBtnCustom.classList.add('is-active-running');
    statusPillCustom.className = 'tab-status-pill status-active';
    statusPillCustom.textContent = '● Active / Running';
    panelBadgeCustom.className = 'panel-header-badge badge-active';
    panelBadgeCustom.innerHTML = '<span>● Custom API: Running Active Engine ✓</span>';
    btnClearCustom.style.display = 'inline-block';
  } else if (isCustom) {
    statusPillCustom.className = 'tab-status-pill status-configured';
    statusPillCustom.textContent = 'Key Configured';
    panelBadgeCustom.className = 'panel-header-badge badge-configured';
    panelBadgeCustom.innerHTML = '<span>Key Saved (Inactive — click Save & Activate below to run)</span>';
    btnClearCustom.style.display = 'inline-block';
  } else {
    statusPillCustom.className = 'tab-status-pill status-empty';
    statusPillCustom.textContent = 'Not Configured';
    panelBadgeCustom.className = 'panel-header-badge badge-empty';
    panelBadgeCustom.innerHTML = '<span>No Key Configured</span>';
    btnClearCustom.style.display = 'none';
  }
}

/**
 * Changes which settings panel is currently displayed without altering active provider
 */
function switchTab(tab) {
  currentViewingTab = tab;

  tabBtnGemini.classList.toggle('selected-panel', tab === 'gemini');
  tabBtnOpenAI.classList.toggle('selected-panel', tab === 'openai');
  tabBtnCustom.classList.toggle('selected-panel', tab === 'custom');

  fieldsGemini.style.display = tab === 'gemini' ? 'block' : 'none';
  fieldsOpenAI.style.display = tab === 'openai' ? 'block' : 'none';
  fieldsCustom.style.display = tab === 'custom' ? 'block' : 'none';

  testStatus.className = 'test-status';
  testStatus.textContent = '';
}

async function load() {
  currentSettings = await getSettings();

  // Populate field values
  geminiKey.value = currentSettings.geminiKey || '';
  geminiModel.value = (currentSettings.geminiModel === 'gemini-2.5-flash' || !currentSettings.geminiModel)
    ? 'gemini-3.8-flash'
    : currentSettings.geminiModel;

  openaiKey.value = currentSettings.openaiKey || '';
  openaiModel.value = currentSettings.openaiModel || 'gpt-4o-mini';

  customEndpoint.value = currentSettings.customEndpoint || 'http://localhost:11434/v1/chat/completions';
  customKey.value = currentSettings.customKey || '';
  customModel.value = currentSettings.customModel || 'llama3:latest';

  prefLanguage.value = currentSettings.inputLanguage || 'bn-BD';
  prefAutostart.checked = Boolean(currentSettings.autoStartOnOpen);
  if (prefSpeechEngine) prefSpeechEngine.value = currentSettings.speechEngine || 'cloud';
  if (prefLocalModel) prefLocalModel.value = currentSettings.localModel || 'onnx-community/whisper-base';
  if (prefAcceleration) prefAcceleration.value = currentSettings.accelerationPreference || 'auto';
  prefTone.value = currentSettings.tone || 'professional';
  prefConciseness.value = currentSettings.conciseness || 'balanced';

  populateVoiceInput(currentSettings.voiceInput);

  // Detect and display hardware acceleration in options
  const detectedHwName = document.getElementById('detected-hw-name');
  if (detectedHwName) {
    LocalSTTEngine.detectAcceleration().then((acc) => {
      detectedHwName.textContent = acc;
    }).catch(() => {
      detectedHwName.textContent = 'CPU fallback';
    });
  }

  // Determine initial viewing tab: effective active provider or first configured, or gemini
  const effective = getEffectiveProvider(currentSettings);
  if (effective !== 'none') {
    currentViewingTab = effective;
  } else {
    currentViewingTab = 'gemini';
  }

  switchTab(currentViewingTab);
  renderActiveStatus(currentSettings);
}

/**
 * Save & Activate a specific provider
 */
async function handleSaveAndActivate(provider) {
  let keyVal = '';
  if (provider === 'gemini') keyVal = geminiKey.value.trim();
  if (provider === 'openai') keyVal = openaiKey.value.trim();
  if (provider === 'custom') keyVal = customKey.value.trim();

  if (!keyVal) {
    testStatus.className = 'test-status error';
    testStatus.textContent = `Cannot activate ${provider.toUpperCase()}: Please enter an API key first.`;
    return;
  }

  const updatedData = {
    provider,
    geminiKey: geminiKey.value.trim(),
    geminiModel: geminiModel.value,
    openaiKey: openaiKey.value.trim(),
    openaiModel: openaiModel.value,
    customEndpoint: customEndpoint.value.trim(),
    customKey: customKey.value.trim(),
    customModel: customModel.value.trim(),
    inputLanguage: prefLanguage.value,
    autoStartOnOpen: prefAutostart.checked,
    tone: prefTone.value,
    conciseness: prefConciseness.value
  };

  currentSettings = await saveSettings(updatedData);
  renderActiveStatus(currentSettings);

  testStatus.className = 'test-status success';
  testStatus.textContent = `${provider === 'gemini' ? 'Google Gemini' : provider === 'openai' ? 'OpenAI' : 'Custom'} API key configured & running ✓`;
  setTimeout(() => { testStatus.textContent = ''; }, 3500);
}

/**
 * Clear key for a specific provider
 */
async function handleClearKey(provider) {
  if (!confirm(`Are you sure you want to remove your ${provider.toUpperCase()} API key?`)) {
    return;
  }

  const patch = {};
  if (provider === 'gemini') {
    geminiKey.value = '';
    patch.geminiKey = '';
  } else if (provider === 'openai') {
    openaiKey.value = '';
    patch.openaiKey = '';
  } else if (provider === 'custom') {
    customKey.value = '';
    patch.customKey = '';
  }

  // If removing currently running provider, reset provider
  if (currentSettings.provider === provider) {
    patch.provider = 'none';
  }

  currentSettings = await saveSettings(patch);
  renderActiveStatus(currentSettings);

  testStatus.className = 'test-status';
  testStatus.textContent = `${provider.toUpperCase()} key cleared. Platform is no longer active.`;
  setTimeout(() => { testStatus.textContent = ''; }, 2500);
}

/**
 * Save general settings
 */
async function saveGeneralSettings() {
  const updatedData = {
    geminiKey: geminiKey.value.trim(),
    geminiModel: geminiModel.value,
    openaiKey: openaiKey.value.trim(),
    openaiModel: openaiModel.value,
    customEndpoint: customEndpoint.value.trim(),
    customKey: customKey.value.trim(),
    customModel: customModel.value.trim(),
    inputLanguage: prefLanguage.value,
    autoStartOnOpen: prefAutostart.checked,
    speechEngine: prefSpeechEngine ? prefSpeechEngine.value : 'cloud',
    localModel: prefLocalModel ? prefLocalModel.value : 'onnx-community/whisper-base',
    accelerationPreference: prefAcceleration ? prefAcceleration.value : 'auto',
    tone: prefTone.value,
    conciseness: prefConciseness.value,
    voiceInput: collectVoiceInput()
  };

  currentSettings = await saveSettings(updatedData);
  renderActiveStatus(currentSettings);

  saveStatus.textContent = 'Settings saved successfully ✓';
  setTimeout(() => { saveStatus.textContent = ''; }, 2500);
}

/**
 * Test connection for currently viewed tab
 */
async function testConnection() {
  testStatus.className = 'test-status';
  testStatus.textContent = `Testing ${currentViewingTab.toUpperCase()} connection...`;

  let keyToTest = '';
  if (currentViewingTab === 'gemini') keyToTest = geminiKey.value.trim();
  if (currentViewingTab === 'openai') keyToTest = openaiKey.value.trim();
  if (currentViewingTab === 'custom') keyToTest = customKey.value.trim();

  if (!keyToTest) {
    testStatus.className = 'test-status error';
    testStatus.textContent = `Please enter an API key for ${currentViewingTab.toUpperCase()} before testing.`;
    return;
  }

  const testConfig = {
    provider: currentViewingTab,
    openaiKey: openaiKey.value.trim(),
    openaiModel: openaiModel.value,
    geminiKey: geminiKey.value.trim(),
    geminiModel: geminiModel.value,
    customEndpoint: customEndpoint.value.trim(),
    customKey: customKey.value.trim(),
    customModel: customModel.value.trim(),
    tone: 'professional',
    conciseness: 'balanced'
  };

  try {
    const result = await generateBilingualOutput('আমি কাজটি দ্রুত শেষ করতে চাই।', testConfig);
    if (result && result.bangla && result.english) {
      testStatus.className = 'test-status success';
      testStatus.textContent = `Verified! ${currentViewingTab.toUpperCase()} connection and response validated ✓`;
    } else {
      throw new Error('Unexpected response format from provider');
    }
  } catch (err) {
    testStatus.className = 'test-status error';
    testStatus.textContent = `Test failed: ${err.message || 'Check credentials and network'}`;
  }
}

// Event Listeners - Tabs (Click changes view only)
tabBtnGemini.addEventListener('click', () => switchTab('gemini'));
tabBtnOpenAI.addEventListener('click', () => switchTab('openai'));
tabBtnCustom.addEventListener('click', () => switchTab('custom'));

// Event Listeners - Save & Activate
btnSaveGemini.addEventListener('click', () => handleSaveAndActivate('gemini'));
btnSaveOpenAI.addEventListener('click', () => handleSaveAndActivate('openai'));
btnSaveCustom.addEventListener('click', () => handleSaveAndActivate('custom'));

// Event Listeners - Clear Key
btnClearGemini.addEventListener('click', () => handleClearKey('gemini'));
btnClearOpenAI.addEventListener('click', () => handleClearKey('openai'));
btnClearCustom.addEventListener('click', () => handleClearKey('custom'));

// Password toggles
btnToggleGemini.addEventListener('click', () => togglePassword(geminiKey, btnToggleGemini));
btnToggleOpenAI.addEventListener('click', () => togglePassword(openaiKey, btnToggleOpenAI));

// Test & General Save
btnTestConnection.addEventListener('click', testConnection);
btnSaveSettings.addEventListener('click', saveGeneralSettings);

// ---- Voice Input (separate provider namespace) ----
const prefVoiceEngine = document.getElementById('pref-voice-engine');
const prefVoiceLanguage = document.getElementById('pref-voice-language');
const voiceOpenaiKey = document.getElementById('voice-openai-key');
const voiceOpenaiModel = document.getElementById('voice-openai-model');
const voiceGoogleKey = document.getElementById('voice-google-key');
const voiceDeepgramKey = document.getElementById('voice-deepgram-key');
const voiceDeepgramModel = document.getElementById('voice-deepgram-model');
const voiceAssemblyaiKey = document.getElementById('voice-assemblyai-key');
const voiceCustomEndpoint = document.getElementById('voice-custom-endpoint');
const voiceCustomKey = document.getElementById('voice-custom-key');
const voiceCustomAuthType = document.getElementById('voice-custom-auth-type');
const voiceCustomAuthHeader = document.getElementById('voice-custom-auth-header');
const voiceCustomAudioField = document.getElementById('voice-custom-audio-field');
const voiceCustomResponsePath = document.getElementById('voice-custom-response-path');
const voiceCustomModel = document.getElementById('voice-custom-model');
const voiceCustomModelField = document.getElementById('voice-custom-model-field');
const voiceCustomLanguageField = document.getElementById('voice-custom-language-field');
const btnVoiceTest = document.getElementById('btn-voice-test');
const voiceTestStatus = document.getElementById('voice-test-status');

function collectVoiceInput() {
  return {
    engine: prefVoiceEngine ? prefVoiceEngine.value : 'browser',
    provider: prefVoiceEngine ? prefVoiceEngine.value : 'openai',
    openaiKey: voiceOpenaiKey ? voiceOpenaiKey.value.trim() : '',
    openaiModel: voiceOpenaiModel ? voiceOpenaiModel.value.trim() : 'whisper-1',
    googleKey: voiceGoogleKey ? voiceGoogleKey.value.trim() : '',
    deepgramKey: voiceDeepgramKey ? voiceDeepgramKey.value.trim() : '',
    deepgramModel: voiceDeepgramModel ? voiceDeepgramModel.value.trim() : 'nova-2',
    assemblyaiKey: voiceAssemblyaiKey ? voiceAssemblyaiKey.value.trim() : '',
    customEndpoint: voiceCustomEndpoint ? voiceCustomEndpoint.value.trim() : '',
    customKey: voiceCustomKey ? voiceCustomKey.value.trim() : '',
    customAuthType: voiceCustomAuthType ? voiceCustomAuthType.value : 'bearer',
    customAuthHeaderName: voiceCustomAuthHeader ? voiceCustomAuthHeader.value.trim() : 'x-api-key',
    customAudioField: voiceCustomAudioField ? voiceCustomAudioField.value.trim() : 'file',
    customModelField: voiceCustomModelField ? voiceCustomModelField.value.trim() : 'model',
    customLanguageField: voiceCustomLanguageField ? voiceCustomLanguageField.value.trim() : 'language',
    customModel: voiceCustomModel ? voiceCustomModel.value.trim() : '',
    customResponsePath: voiceCustomResponsePath ? voiceCustomResponsePath.value.trim() : 'text',
    language: prefVoiceLanguage ? prefVoiceLanguage.value : 'auto'
  };
}

function applyVoiceInputVisibility(engine) {
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('voice-group-openai', engine === 'openai');
  show('voice-group-google', engine === 'google');
  show('voice-group-deepgram', engine === 'deepgram');
  show('voice-group-assemblyai', engine === 'assemblyai');
  show('voice-group-custom', engine === 'custom');
}

function populateVoiceInput(vi) {
  if (!vi) vi = {};
  if (prefVoiceEngine) prefVoiceEngine.value = vi.engine || 'browser';
  if (prefVoiceLanguage) prefVoiceLanguage.value = vi.language || 'auto';
  if (voiceOpenaiKey) voiceOpenaiKey.value = vi.openaiKey || '';
  if (voiceOpenaiModel) voiceOpenaiModel.value = vi.openaiModel || 'whisper-1';
  if (voiceGoogleKey) voiceGoogleKey.value = vi.googleKey || '';
  if (voiceDeepgramKey) voiceDeepgramKey.value = vi.deepgramKey || '';
  if (voiceDeepgramModel) voiceDeepgramModel.value = vi.deepgramModel || 'nova-2';
  if (voiceAssemblyaiKey) voiceAssemblyaiKey.value = vi.assemblyaiKey || '';
  if (voiceCustomEndpoint) voiceCustomEndpoint.value = vi.customEndpoint || '';
  if (voiceCustomKey) voiceCustomKey.value = vi.customKey || '';
  if (voiceCustomAuthType) voiceCustomAuthType.value = vi.customAuthType || 'bearer';
  if (voiceCustomAuthHeader) voiceCustomAuthHeader.value = vi.customAuthHeaderName || 'x-api-key';
  if (voiceCustomAudioField) voiceCustomAudioField.value = vi.customAudioField || 'file';
  if (voiceCustomModelField) voiceCustomModelField.value = vi.customModelField || 'model';
  if (voiceCustomLanguageField) voiceCustomLanguageField.value = vi.customLanguageField || 'language';
  if (voiceCustomModel) voiceCustomModel.value = vi.customModel || '';
  if (voiceCustomResponsePath) voiceCustomResponsePath.value = vi.customResponsePath || 'text';
  applyVoiceInputVisibility(prefVoiceEngine ? prefVoiceEngine.value : 'browser');
}

function makeTestWav(seconds = 0.6) {
  const rate = 16000;
  const n = Math.floor(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 8000), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

if (prefVoiceEngine) {
  prefVoiceEngine.addEventListener('change', () => {
    applyVoiceInputVisibility(prefVoiceEngine.value);
    // The Voice Input engine drives the master recognition mode (browser → cloud,
    // any API provider → voiceapi). Local Whisper remains in the mode dropdown.
    if (prefSpeechEngine) {
      prefSpeechEngine.value = prefVoiceEngine.value === 'browser' ? 'cloud' : 'voiceapi';
    }
  });
}

if (prefSpeechEngine) {
  prefSpeechEngine.addEventListener('change', () => {
    // Leaving Voice API mode resets the Voice Input engine to Browser Speech
    // (provider/key fields persist so switching back is one click).
    if (prefSpeechEngine.value !== 'voiceapi' && prefVoiceEngine && prefVoiceEngine.value !== 'browser') {
      prefVoiceEngine.value = 'browser';
      applyVoiceInputVisibility('browser');
    }
  });
}

if (btnVoiceTest) {
  btnVoiceTest.addEventListener('click', async () => {
    const cfg = collectVoiceInput();
    if (!isVoiceInputConfigured(cfg)) {
      if (voiceTestStatus) {
        voiceTestStatus.className = 'test-status error';
        voiceTestStatus.textContent = 'Voice API not configured — provider, endpoint, or key is missing.';
      }
      return;
    }
    if (btnVoiceTest) btnVoiceTest.disabled = true;
    if (voiceTestStatus) { voiceTestStatus.className = 'test-status'; voiceTestStatus.textContent = 'Testing voice transcription with a short tone...'; }
    try {
      const wav = makeTestWav(0.6);
      const res = await transcribeWithVoiceInput(wav, cfg);
      if (voiceTestStatus) {
        voiceTestStatus.className = 'test-status success';
        voiceTestStatus.textContent = `Voice connection verified ✓ (${res.provider}${res.text ? `, ${res.text.length} chars` : ', empty result is normal for a tone'})`;
      }
    } catch (err) {
      if (voiceTestStatus) {
        voiceTestStatus.className = 'test-status error';
        voiceTestStatus.textContent = `Voice test failed: ${(err && err.message) || err}`;
      }
    } finally {
      if (btnVoiceTest) btnVoiceTest.disabled = false;
    }
  });
}

// Force Pre-download & Cache Whisper Model
const btnForceDownloadWhisper = document.getElementById('btn-force-download-whisper');
const btnVerifyWhisper = document.getElementById('btn-verify-whisper');
const btnCopyWhisperReport = document.getElementById('btn-copy-whisper-report');
const btnRunMicTest = document.getElementById('btn-run-mic-test');
const micTestStatus = document.getElementById('mic-test-status');
const micTestMsg = document.getElementById('mic-test-msg');
const micTestOutput = document.getElementById('mic-test-output');
const whisperDownloadStatus = document.getElementById('whisper-download-status');
const whisperDownloadMsg = document.getElementById('whisper-download-msg');
const whisperDownloadBar = document.getElementById('whisper-download-bar');
const whisperErrorDetail = document.getElementById('whisper-error-detail');

function showWhisperErrorDetail(text) {
  if (!whisperErrorDetail) return;
  if (!text) {
    whisperErrorDetail.style.display = 'none';
    whisperErrorDetail.textContent = '';
    return;
  }
  whisperErrorDetail.style.display = 'block';
  whisperErrorDetail.textContent = text;
}

/**
 * Stage-aware message rendering for the Whisper setup panel.
 * A finished download is explicitly NOT presented as a ready model.
 */
function renderWhisperStage(stage, message) {
  if (!whisperDownloadMsg) return;
  switch (stage) {
    case STT_STAGE.DOWNLOADING:
      whisperDownloadMsg.style.color = '#cbd5e1';
      if (message) whisperDownloadMsg.textContent = message;
      break;
    case STT_STAGE.DOWNLOAD_COMPLETE:
      whisperDownloadMsg.style.color = '#93c5fd';
      if (whisperDownloadBar) whisperDownloadBar.style.width = '100%';
      whisperDownloadMsg.textContent = message || 'Download complete. Verifying cache & compiling ONNX graph...';
      break;
    case STT_STAGE.INITIALIZING_BACKEND:
      whisperDownloadMsg.style.color = '#93c5fd';
      whisperDownloadMsg.textContent = message || 'Initializing ONNX Runtime execution provider...';
      break;
    case STT_STAGE.INITIALIZING_MODEL:
      whisperDownloadMsg.style.color = '#93c5fd';
      whisperDownloadMsg.textContent = message || 'Initializing Whisper pipeline...';
      break;
    case STT_STAGE.READY:
      whisperDownloadMsg.style.color = '#34d399';
      if (whisperDownloadBar) whisperDownloadBar.style.width = '100%';
      whisperDownloadMsg.textContent = message || 'Local Whisper ready.';
      break;
    default:
      if (message) whisperDownloadMsg.textContent = message;
  }
}

function renderWhisperProgress(prog) {
  if (!prog || prog.progress === undefined) return;
  const pct = Math.round(prog.progress);
  if (whisperDownloadBar) whisperDownloadBar.style.width = `${pct}%`;
  if (!whisperDownloadMsg) return;
  if (pct >= 100) {
    whisperDownloadMsg.style.color = '#93c5fd';
    whisperDownloadMsg.textContent =
      `Downloaded ${prog.file || 'ONNX graph'} (100%). Compiling & creating ONNX session...`;
  } else {
    whisperDownloadMsg.style.color = '#cbd5e1';
    whisperDownloadMsg.textContent = `Downloading ${prog.file || 'weights'}: ${pct}%`;
  }
}

/**
 * Shared setup/verification flow. Downloads (if needed), initializes the ONNX
 * Runtime backend + Whisper pipeline, and reports the exact stage that failed.
 */
async function runWhisperSetup({ verifyOnly = false, button = null } = {}) {
  const targetBtn = button || btnForceDownloadWhisper;
  if (targetBtn) {
    targetBtn.disabled = true;
    targetBtn.textContent = verifyOnly ? '🩺 Verifying runtime...' : '⏳ Initializing Downloader...';
  }
  if (whisperDownloadStatus) whisperDownloadStatus.style.display = 'block';
  showWhisperErrorDetail('');
  renderWhisperStage(STT_STAGE.DOWNLOADING, verifyOnly
    ? 'Verifying packaged ONNX Runtime wasm and local Whisper runtime...'
    : 'Contacting HuggingFace repository...');
  if (whisperDownloadBar) whisperDownloadBar.style.width = '2%';

  const modelId = prefLocalModel ? prefLocalModel.value : 'onnx-community/whisper-base';
  const accel = prefAcceleration ? prefAcceleration.value : 'auto';

  const localEngine = new LocalSTTEngine({
    modelId,
    devicePreference: accel,
    onStatus: (st) => {
      if (st && st.stage) renderWhisperStage(st.stage, st.message);
      else if (st && st.message && whisperDownloadMsg) whisperDownloadMsg.textContent = st.message;
    },
    onProgress: renderWhisperProgress
  });
  latestWhisperEngine = localEngine;

  try {
    await localEngine.forcePreloadModel(renderWhisperProgress);

    const cacheReport = await localEngine.inspectModelCache();
    const files = cacheReport.cachedHubFiles || [];
    const cachedCount = files.filter((f) => f.cached).length;
    const cacheSummary = files.length
      ? `Cached model files detected: ${cachedCount}/${files.length}.`
      : 'Cache storage could not be inspected from this page.';

    const deviceLabel = accel === 'cpu' ? 'CPU/WASM' : accel === 'webgpu' ? 'WebGPU' : 'auto-detected device';
    renderWhisperStage(STT_STAGE.READY,
      `✓ Whisper ${modelId} initialized successfully — pipeline READY (${deviceLabel}). ` +
      `${cacheSummary} Local speech recognition runs on-device and needs no cloud speech API.`);
    if (whisperDownloadBar) whisperDownloadBar.style.width = '100%';
    if (targetBtn) {
      targetBtn.textContent = verifyOnly ? '✓ Runtime Verified — READY' : '✓ Whisper Ready & Cached';
      targetBtn.style.borderColor = '#10b981';
      targetBtn.style.color = '#34d399';
    }
    const report = await localEngine.buildDiagnosticReport();
    console.log('[Whisper] verification report', report);
  } catch (err) {
    // Report the stage that actually failed, and surface the REAL exception text.
    const info = classifyLocalSttError(err);
    const failedStage = (err && err.stage) || info.stage;
    const isDownloadStage = failedStage === STT_STAGE.DOWNLOADING;
    const underlying = (err && err.message) || 'unknown error';

    console.error('[Whisper] setup failed', { failedStage, kind: info.kind, error: err });

    if (whisperDownloadMsg) {
      whisperDownloadMsg.style.color = '#f87171';
      whisperDownloadMsg.textContent =
        `${isDownloadStage ? 'Download failed' : 'Initialization failed'} ` +
        `[${failedStage} / ${info.kind}]: ${underlying}`;
    }
    if (whisperDownloadBar) whisperDownloadBar.style.width = '100%';

    // Show every underlying exception, not just the last one.
    const detailLines = [];
    if (err && err.attempts && err.attempts.length) {
      for (const att of err.attempts) {
        detailLines.push(`[${att.device}] dtype=${JSON.stringify(att.dtype)}\n  ${att.message}`);
      }
    } else {
      detailLines.push(underlying);
    }
    if (err && err.stack) detailLines.push('', String(err.stack).split('\n').slice(0, 6).join('\n'));
    showWhisperErrorDetail(detailLines.join('\n\n'));

    if (targetBtn) {
      targetBtn.disabled = false;
      targetBtn.textContent = isDownloadStage ? 'Retry Whisper Download' : 'Retry Model Initialization';
      targetBtn.style.borderColor = '#f87171';
      targetBtn.style.color = '#f87171';
    }
    // A failure during initialization must not keep a rejected pipeline cached.
    localEngine.resetPipelineCache();
    return false;
  }

  if (targetBtn) {
    targetBtn.disabled = false;
  }
  return true;
}

if (btnForceDownloadWhisper) {
  btnForceDownloadWhisper.addEventListener('click', () => runWhisperSetup({ button: btnForceDownloadWhisper }));
}

if (btnVerifyWhisper) {
  btnVerifyWhisper.addEventListener('click', () => runWhisperSetup({ verifyOnly: true, button: btnVerifyWhisper }));
}

if (btnCopyWhisperReport) {
  btnCopyWhisperReport.addEventListener('click', async () => {
    const engine = latestWhisperEngine || new LocalSTTEngine({
      modelId: prefLocalModel ? prefLocalModel.value : 'onnx-community/whisper-base',
      devicePreference: prefAcceleration ? prefAcceleration.value : 'auto'
    });
    const report = await engine.buildDiagnosticReport();
    let text = LocalSTTEngine.formatDiagnosticReport(report);

    // Recording happens in the offscreen document; its last outcome is persisted in
    // session storage so this report can include the actual transcription attempt.
    try {
      const stored = await chrome.storage.session.get('whisperLastResult');
      const last = stored && stored.whisperLastResult;
      if (last) {
        text += '\n\nLAST RECORDING (offscreen):\n' + JSON.stringify(last, null, 2);
      } else {
        text += '\n\nLAST RECORDING (offscreen): none recorded yet';
      }
    } catch (e) { /* session storage unavailable */ }

    // Include the last microphone audio-chain test result (Shift triage data).
    try {
      const storedMic = await chrome.storage.local.get('lastMicTest');
      const mic = storedMic && storedMic.lastMicTest;
      if (mic) {
        text += '\n\n' + formatMicReport(mic);
      } else {
        text += '\n\nMICROPHONE AUDIO-CHAIN TEST: not run yet (use "🎤 Test Microphone")';
      }
    } catch (e) { /* storage unavailable */ }

    try {
      await navigator.clipboard.writeText(text);
      const original = btnCopyWhisperReport.textContent;
      btnCopyWhisperReport.textContent = '✓ Diagnostics copied';
      setTimeout(() => { btnCopyWhisperReport.textContent = original; }, 2000);
    } catch (e) {
      // Clipboard may be unavailable; fall back to showing it inline.
      showWhisperErrorDetail(text);
    }
    console.log('[Whisper] diagnostics\n' + text);
  });
}

// Microphone / audio-chain diagnostic (Shift triage): finds the FIRST stage of the
// input chain that fails — permission, getUserMedia, stream/track, AudioContext,
// AudioWorklet load, or real frames flowing.
if (btnRunMicTest) {
  btnRunMicTest.addEventListener('click', async () => {
    btnRunMicTest.disabled = true;
    if (micTestStatus) micTestStatus.style.display = 'block';
    if (micTestOutput) micTestOutput.style.display = 'none';
    if (micTestMsg) {
      micTestMsg.style.color = '#facc15';
      micTestMsg.textContent = 'Testing microphone audio chain — allow the microphone prompt if it appears, and SPEAK during the 2.5s capture window.';
    }
    console.log('[MicTest] running full audio-chain diagnostic...');
    try {
      const report = await runAudioChainDiagnostic({ durationMs: 2500 });
      const text = formatMicReport(report);
      if (micTestMsg) {
        micTestMsg.style.color = report.verdict && report.verdict.ok ? '#34d399' : '#f87171';
        micTestMsg.textContent = (report.verdict && report.verdict.summary) || 'Diagnostic finished.';
      }
      if (micTestOutput) {
        micTestOutput.style.display = 'block';
        micTestOutput.textContent = text;
      }
      try { await chrome.storage.local.set({ lastMicTest: report }); } catch (e) { /* ignore */ }
      console.log('[MicTest] report\n' + text);
    } catch (err) {
      if (micTestMsg) {
        micTestMsg.style.color = '#f87171';
        micTestMsg.textContent = `Mic test failed to run: ${(err && err.message) || err}`;
      }
      console.error('[MicTest] crashed:', err);
    } finally {
      btnRunMicTest.disabled = false;
    }
  });
}

window.addEventListener('DOMContentLoaded', load);
