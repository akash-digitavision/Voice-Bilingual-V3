# vendor/ — bundled browser runtimes (do not delete)

These files are part of the extension package. Manifest V3 forbids loading executable
code from a remote server, so the Transformers.js runtime, the ONNX Runtime Web wasm
loader, and the wasm binary must all ship inside the extension.

| File | Purpose |
| --- | --- |
| `transformers.js` | Transformers.js v3.3.3 (ESM bundle) used for `pipeline('automatic-speech-recognition', ...)`. Loaded via dynamic `import(chrome.runtime.getURL('vendor/transformers.js'))`. |
| `ort-wasm-simd-threaded.jsep.mjs` | ONNX Runtime Web's **Emscripten JS loader** (JSEP build, ~49 KB). The bundle `import()`s this module to instantiate the ORT wasm runtime. |
| `ort-wasm-simd-threaded.jsep.wasm` | ONNX Runtime Web wasm binary (JSEP build, ~23 MB). Fetched by the `.mjs` loader above, from the same directory. |

## Why BOTH `.mjs` and `.wasm` are committed here

The bundled `transformers.js` hardcodes ONNX Runtime Web's wasm directory to a remote
CDN at import time:

```js
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${env.version}/dist/`;
```

That URL is blocked by this extension's Manifest V3 content security policy and would
violate MV3 remote-code rules. `modules/local-stt-engine.js` re-points the backend
before any pipeline is created:

```js
ort.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
```

This makes ONNX Runtime resolve **two** packaged assets relative to `vendor/`:

1. the dynamically imported loader — `vendor/ort-wasm-simd-threaded.jsep.mjs`
2. the wasm binary that loader fetches — `vendor/ort-wasm-simd-threaded.jsep.wasm`

If either file is missing, the pipeline fails with exactly:

```
no available backend found. ERR: [<provider>] TypeError: Failed to fetch dynamically
imported module: chrome-extension://<id>/vendor/ort-wasm-simd-threaded.jsep.mjs
```

(The `.mjs` loader resolves the `.wasm` path from `import.meta.url`, i.e. relative to
`vendor/`; `wasmPaths` supplies the directory prefix used for the dynamic import.)

## Updating

If `transformers.js` is ever upgraded, re-download BOTH files from the same package
version:

```
https://cdn.jsdelivr.net/npm/@huggingface/transformers@<version>/dist/ort-wasm-simd-threaded.jsep.mjs
https://cdn.jsdelivr.net/npm/@huggingface/transformers@<version>/dist/ort-wasm-simd-threaded.jsep.wasm
```

Then confirm the new bundle still references the filename
`ort-wasm-simd-threaded.jsep` (search the bundle for `ort-wasm-simd-threaded`). If the
bundle references a different suffix (e.g. `.wasm` without `.jsep`, or an
`asyncify`/`mjs` variant), vendor that exact filename instead and update the
`ORT_WASM_FILE` / `ORT_LOADER_FILE` constants in `modules/local-stt-engine.js`.

Keep `vendor/*.mjs` and `vendor/*.wasm` in the `web_accessible_resources` entry of
`manifest.json`.
