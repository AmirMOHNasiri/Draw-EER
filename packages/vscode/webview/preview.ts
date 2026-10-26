/**
 * The preview page: shows the SVG drawn by the worker, follows the VS Code
 * theme, and zooms and pans.
 *
 * - Mouse wheel zooms around the pointer; dragging pans.
 * - Toolbar and keys: + and - zoom, 0 shows actual size, F fits the window
 *   (double-click does too).
 * - Until the user zooms or pans, the diagram keeps fitting the window as
 *   it grows; after that, the view stays where the user put it.
 */
import type { Theme } from '@draw-eer/core';
import type { FromWebview, FromWorker, PreviewState, ToWebview, ToWorker } from './protocol';

interface Config {
  uri: string;
  worker: string;
  wasm: string;
  fonts: { regular: string; bold: string };
}

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebview): void;
  getState(): PreviewState | undefined;
  setState(state: PreviewState): void;
};

const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('config')!.textContent!) as Config;
const viewport = document.getElementById('viewport')!;
const canvas = document.getElementById('canvas')!;
const status = document.getElementById('status')!;

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const FIT_MARGIN = 16;

let view = vscode.getState()?.view ?? { scale: 1, x: 0, y: 0, fitted: true };
let source: string | null = null;
let requestId = 0;
let shownId = 0;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const worker = startWorker();

async function startWorker(): Promise<Worker> {
  const fetchBytes = (url: string) => fetch(url).then((r) => r.arrayBuffer());
  const [script, wasm, regular, bold] = await Promise.all([
    fetch(config.worker).then((r) => r.text()),
    fetchBytes(config.wasm),
    fetchBytes(config.fonts.regular),
    fetchBytes(config.fonts.bold),
  ]);
  const w = new Worker(URL.createObjectURL(new Blob([script], { type: 'text/javascript' })));
  w.onmessage = (event: MessageEvent<FromWorker>) => onWorkerMessage(event.data);
  const init: ToWorker = { type: 'init', wasm, regular, bold };
  w.postMessage(init, [wasm, regular, bold]);
  return w;
}

function onWorkerMessage(message: FromWorker): void {
  switch (message.type) {
    case 'ready':
      // Nothing to do: the worker keeps the newest request until it is ready.
      break;
    case 'rendered':
      // An older drawing finishing late must not replace a newer one.
      if (message.id < shownId) return;
      shownId = message.id;
      canvas.innerHTML = message.svg;
      if (view.fitted) fit();
      else apply();
      showStatus(
        message.errors === 0
          ? ''
          : `${message.errors} syntax ${message.errors === 1 ? 'error' : 'errors'} (see Problems)`,
      );
      break;
    case 'failed':
      showStatus(`Could not draw the diagram: ${message.message}`);
      break;
  }
}

function render(): void {
  if (source === null) return;
  const message: ToWorker = {
    type: 'render',
    id: ++requestId,
    text: source,
    theme: currentTheme(),
  };
  void worker.then((w) => w.postMessage(message));
}

function showStatus(text: string): void {
  status.textContent = text;
  status.hidden = text === '';
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** Colors from the VS Code theme. Shapes are filled with the background so lines behind them are hidden. */
function currentTheme(): Theme {
  const style = getComputedStyle(document.body);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const foreground = color('--vscode-editor-foreground', '#000000');
  return {
    stroke: foreground,
    text: foreground,
    fill: color('--vscode-editor-background', '#ffffff'),
    background: null,
  };
}

// VS Code changes the body's class (vscode-light, vscode-dark, …) when the theme changes.
new MutationObserver(render).observe(document.body, {
  attributes: true,
  attributeFilter: ['class'],
});

// ---------------------------------------------------------------------------
// Zoom and pan
// ---------------------------------------------------------------------------

function apply(): void {
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  vscode.setState({ uri: config.uri, view });
  document.getElementById('zoom-reset')!.textContent = `${Math.round(view.scale * 100)}%`;
}

function diagramSize(): { width: number; height: number } | null {
  const svg = canvas.querySelector('svg');
  if (!svg) return null;
  return {
    width: Number(svg.getAttribute('width')) || 1,
    height: Number(svg.getAttribute('height')) || 1,
  };
}

function fit(): void {
  const size = diagramSize();
  if (!size) return;
  const width = viewport.clientWidth - 2 * FIT_MARGIN;
  const height = viewport.clientHeight - 2 * FIT_MARGIN;
  // Never enlarge a small diagram past its actual size when fitting.
  const scale = clamp(Math.min(width / size.width, height / size.height, 1));
  view = {
    scale,
    x: (viewport.clientWidth - size.width * scale) / 2,
    y: (viewport.clientHeight - size.height * scale) / 2,
    fitted: true,
  };
  apply();
}

/** Zooms by `factor`, keeping the point (px, py) of the viewport in place. */
function zoomAt(factor: number, px: number, py: number): void {
  const scale = clamp(view.scale * factor);
  const k = scale / view.scale;
  view = { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k, fitted: false };
  apply();
}

function zoomCenter(factor: number): void {
  zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
}

function actualSize(): void {
  zoomCenter(1 / view.scale);
}

function clamp(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

viewport.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    // Trackpad pinches arrive as wheel events with ctrlKey; both zoom.
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
  },
  { passive: false },
);

let drag: { x: number; y: number } | null = null;
viewport.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { x: event.clientX - view.x, y: event.clientY - view.y };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('dragging');
});
viewport.addEventListener('pointermove', (event) => {
  if (!drag) return;
  view = { ...view, x: event.clientX - drag.x, y: event.clientY - drag.y, fitted: false };
  apply();
});
const endDrag = () => {
  drag = null;
  viewport.classList.remove('dragging');
};
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);
viewport.addEventListener('dblclick', fit);

document.getElementById('zoom-in')!.addEventListener('click', () => zoomCenter(1.25));
document.getElementById('zoom-out')!.addEventListener('click', () => zoomCenter(0.8));
document.getElementById('zoom-reset')!.addEventListener('click', actualSize);
document.getElementById('zoom-fit')!.addEventListener('click', fit);
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '+' || event.key === '=') zoomCenter(1.25);
  else if (event.key === '-') zoomCenter(0.8);
  else if (event.key === '0') actualSize();
  else if (event.key === 'f' || event.key === 'F') fit();
});
window.addEventListener('resize', () => {
  if (view.fitted) fit();
});

// ---------------------------------------------------------------------------
// Messages from the extension
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  if (event.data.type === 'source') {
    source = event.data.text;
    render();
  }
});

showStatus('');
apply();
vscode.postMessage({ type: 'ready' });
