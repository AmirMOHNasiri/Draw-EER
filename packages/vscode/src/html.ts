/**
 * The preview page's HTML, including its Content Security Policy. Kept free
 * of VS Code imports so scripts/webview-check.mjs can load the very same
 * page in a real browser.
 */

export interface PageOptions {
  /** The webview's resource origin (`webview.cspSource`). */
  cspSource: string;
  /** URL of a built file in dist/, as the webview may load it. */
  asset: (path: string) => string;
  nonce: string;
  /** The previewed document's URI, remembered for restoring the preview. */
  document: string;
}

export function previewHtml({ cspSource, asset, nonce, document }: PageOptions): string {
  // The worker script is fetched and started from a blob: URL, because a
  // webview may not start a worker from its resource origin directly.
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data: blob:`,
    // Diagrams are inline SVG with their own <style>.
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    // The worker inherits this policy, and compiling HarfBuzz's WebAssembly
    // needs 'wasm-unsafe-eval' (which allows WebAssembly only, not eval).
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    'worker-src blob:',
    `connect-src ${cspSource}`,
  ].join('; ');
  const config = {
    uri: document,
    worker: asset('worker.js'),
    wasm: asset('harfbuzz.wasm'),
    fonts: {
      regular: asset('fonts/Vazirmatn-Regular.ttf'),
      bold: asset('fonts/Vazirmatn-Bold.ttf'),
    },
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('preview.css')}">
<style>
@font-face { font-family: 'Vazirmatn'; font-weight: 400; src: url('${config.fonts.regular}') format('truetype'); }
@font-face { font-family: 'Vazirmatn'; font-weight: 700; src: url('${config.fonts.bold}') format('truetype'); }
</style>
<title>EER Preview</title>
</head>
<body>
<div id="viewport"><div id="canvas"></div></div>
<div id="toolbar" role="toolbar" aria-label="Zoom">
  <button id="zoom-out" title="Zoom out (-)" aria-label="Zoom out">−</button>
  <button id="zoom-reset" title="Actual size (0)" aria-label="Actual size">100%</button>
  <button id="zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
  <button id="zoom-fit" title="Fit to window (F)" aria-label="Fit to window">Fit</button>
</div>
<div id="status" role="status"></div>
<script nonce="${nonce}" id="config" type="application/json">${escapeJson(config)}</script>
<script nonce="${nonce}" src="${asset('preview.js')}"></script>
</body>
</html>`;
}

/** JSON that is safe inside a <script> element. */
function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
  return nonce;
}
