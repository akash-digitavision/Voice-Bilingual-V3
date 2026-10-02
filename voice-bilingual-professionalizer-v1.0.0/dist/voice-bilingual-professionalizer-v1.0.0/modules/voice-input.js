/**
 * Voice Input API — separate transcription provider system (Part 3).
 *
 * IMPORTANT SEPARATION (§ settings separation): this system has its OWN settings
 * namespace (voiceInput.*) and its OWN credentials. It NEVER reads the Refine API
 * keys, and the Refine path never reads these. The Voice API only replaces the
 * speech-to-text stage — the transcript always flows into the existing Bilingual
 * Assistant unchanged.
 *
 * All providers implement the common contract:
 *   isConfigured(cfg) -> boolean
 *   transcribe(audioBlob, cfg) -> Promise<{ text, provider, raw? }>
 *
 * Recording model (§ recording model): bounded recording → Blob → upload → text.
 * These implementations are BATCH transcription (no continuous upload, no fake
 * streaming). Language hints are passed when the provider supports them
 * (bn / en / auto), and the transcript is never translated during STT.
 */

const PROVIDERS = {
  browser: { name: 'Browser Speech', needsKey: false },
  openai: { name: 'OpenAI', needsKey: true },
  google: { name: 'Google Cloud Speech-to-Text', needsKey: true },
  deepgram: { name: 'Deepgram', needsKey: true },
  assemblyai: { name: 'AssemblyAI', needsKey: true },
  custom: { name: 'Custom API', needsKey: false } // validated via endpoint presence
};

export function providerName(id) {
  return (PROVIDERS[id] && PROVIDERS[id].name) || id;
}

export function providerNeedsKey(id) {
  return Boolean(PROVIDERS[id] && PROVIDERS[id].needsKey);
}

/** Map the extension language preference to a provider language hint. */
function languageHint(language) {
  const v = String(language || 'auto').toLowerCase();
  if (v === 'bn' || v.startsWith('bn')) return 'bn';
  if (v === 'en' || v.startsWith('en')) return 'en';
  return 'auto';
}

/**
 * Resolves a dot path ('text', 'results.channels.0.alternatives.0.transcript')
 * against a JSON response. Numeric segments index arrays.
 */
export function resolvePath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    const idx = /^\d+$/.test(key) ? Number(key) : key;
    return acc[idx];
  }, obj);
}

function languageCode(lang, { google = false } = {}) {
  const hint = languageHint(lang);
  if (hint === 'auto') return null;
  if (google) return hint === 'bn' ? 'bn-BD' : 'en-US';
  return hint;
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// --------------------------------------------------------------- Providers

const OpenAIProvider = {
  id: 'openai',
  isConfigured: (cfg) => Boolean(cfg.openaiKey),
  async transcribe(blob, cfg) {
    if (!this.isConfigured(cfg)) {
      throw new Error('Voice API key is missing (OpenAI).');
    }
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', cfg.openaiModel || 'whisper-1');
    const lang = languageCode(cfg.language);
    if (lang) form.append('language', lang);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${String(cfg.openaiKey).trim()}` },
      body: form
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Voice API authentication failed (HTTP 401).');
      throw new Error(`Voice API endpoint returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    return { text: String(data.text || '').trim(), provider: 'openai' };
  }
};

const GoogleProvider = {
  id: 'google',
  isConfigured: (cfg) => Boolean(cfg.googleKey),
  async transcribe(blob, cfg) {
    if (!this.isConfigured(cfg)) {
      throw new Error('Voice API key is missing (Google Cloud Speech-to-Text).');
    }
    const content = await blobToBase64(blob);
    const body = {
      config: { encoding: 'WEBM_OPUS' },
      audio: { content }
    };
    const lc = languageCode(cfg.language, { google: true });
    if (lc) body.config.languageCode = lc;

    const response = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(String(cfg.googleKey).trim())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Voice API authentication failed.');
      throw new Error(`Voice API endpoint returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    const text = data.results?.[0]?.alternatives?.[0]?.transcript || '';
    return { text: String(text).trim(), provider: 'google' };
  }
};

const DeepgramProvider = {
  id: 'deepgram',
  isConfigured: (cfg) => Boolean(cfg.deepgramKey),
  async transcribe(blob, cfg) {
    if (!this.isConfigured(cfg)) {
      throw new Error('Voice API key is missing (Deepgram).');
    }
    const params = new URLSearchParams();
    params.set('model', cfg.deepgramModel || 'nova-2');
    const lang = languageCode(cfg.language);
    if (lang) params.set('language', lang);
    params.set('punctuate', 'true');

    const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${String(cfg.deepgramKey).trim()}`,
        'Content-Type': 'audio/webm'
      },
      body: blob
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Voice API authentication failed.');
      throw new Error(`Voice API endpoint returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    return { text: String(text).trim(), provider: 'deepgram' };
  }
};

const AssemblyAIProvider = {
  id: 'assemblyai',
  isConfigured: (cfg) => Boolean(cfg.assemblyaiKey),
  async transcribe(blob, cfg) {
    if (!this.isConfigured(cfg)) {
      throw new Error('Voice API key is missing (AssemblyAI).');
    }
    const key = String(cfg.assemblyaiKey).trim();

    // 1. Upload → upload_url
    const up = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { 'authorization': key },
      body: blob
    });
    if (!up.ok) {
      if (up.status === 401 || up.status === 403) throw new Error('Voice API authentication failed.');
      throw new Error(`Voice API upload returned HTTP ${up.status}.`);
    }
    const { upload_url: uploadUrl } = await up.json();

    // 2. Create transcript
    const createBody = { audio_url: uploadUrl };
    const lang = languageCode(cfg.language);
    if (lang) createBody.language_code = lang;
    const create = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody)
    });
    if (!create.ok) throw new Error(`Voice API transcript creation returned HTTP ${create.status}.`);
    const created = await create.json();

    // 3. Poll the transcript lifecycle (bounded).
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${created.id}`, {
        headers: { 'authorization': key }
      });
      if (!poll.ok) throw new Error(`Voice API polling returned HTTP ${poll.status}.`);
      const data = await poll.json();
      if (data.status === 'completed') {
        return { text: String(data.text || '').trim(), provider: 'assemblyai' };
      }
      if (data.status === 'error') {
        throw new Error('Voice transcription failed (AssemblyAI reported an error).');
      }
    }
    throw new Error('Voice transcription timed out.');
  }
};

const CustomProvider = {
  id: 'custom',
  isConfigured: (cfg) => Boolean(cfg.customEndpoint),
  async transcribe(blob, cfg) {
    if (!cfg.customEndpoint) {
      throw new Error('Custom Voice API endpoint is missing.');
    }
    const headers = {};
    const key = cfg.customKey ? String(cfg.customKey).trim() : '';
    const authType = cfg.customAuthType || 'bearer';
    if (key && authType === 'bearer') headers['Authorization'] = `Bearer ${key}`;
    if (key && authType === 'apiKeyHeader') headers[cfg.customAuthHeaderName || 'x-api-key'] = key;
    if (key && authType === 'customHeader' && cfg.customAuthHeaderName) headers[cfg.customAuthHeaderName] = key;

    const method = (cfg.customMethod || 'POST').toUpperCase();
    let body;
    if (method === 'POST') {
      const form = new FormData();
      form.append(cfg.customAudioField || 'file', blob, 'audio.webm');
      if (cfg.customModel) form.append(cfg.customModelField || 'model', cfg.customModel);
      const lang = languageHint(cfg.language);
      if (lang !== 'auto' && cfg.customLanguageField !== '') {
        form.append(cfg.customLanguageField || 'language', lang);
      }
      body = form;
    } else {
      throw new Error('Only POST is supported for Custom Voice API transcription.');
    }

    const response = await fetch(cfg.customEndpoint, { method, headers, body });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Voice API authentication failed.');
      throw new Error(`Voice API endpoint returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    const text = resolvePath(data, cfg.customResponsePath || 'text');
    if (text == null) throw new Error(`Response text path "${cfg.customResponsePath || 'text'}" not found in the API response.`);
    return { text: String(text).trim(), provider: 'custom' };
  }
};

const IMPLEMENTATIONS = {
  openai: OpenAIProvider,
  google: GoogleProvider,
  deepgram: DeepgramProvider,
  assemblyai: AssemblyAIProvider,
  custom: CustomProvider
};

/**
 * Entry point: transcribe an audio Blob with the configured provider.
 * cfg comes from settings.voiceInput (see storage.js) plus resolved language.
 */
export async function transcribeWithVoiceInput(blob, cfg) {
  const impl = IMPLEMENTATIONS[cfg.provider];
  if (!impl) throw new Error(`Unknown Voice API provider: ${cfg.provider}`);
  return await impl.transcribe(blob, cfg);
}

export function isVoiceInputConfigured(cfg) {
  if (!cfg || !cfg.provider) return false;
  const impl = IMPLEMENTATIONS[cfg.provider];
  if (!impl) return false;
  return impl.isConfigured(cfg);
}

export function listVoiceInputProviders() {
  return Object.keys(PROVIDERS).map((id) => ({ id, name: PROVIDERS[id].name }));
}
