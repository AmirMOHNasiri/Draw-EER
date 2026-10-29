/**
 * The preview page: shows the SVG drawn by the worker, follows the VS Code
 * theme, zooms and pans, and lets the user drag shapes and attributes.
 *
 * - Mouse wheel zooms around the pointer; dragging the background pans.
 * - Dragging a shape or an attribute moves it (its attributes come along);
 *   it snaps into line with the shapes it is joined to unless Alt is held,
 *   and Escape cancels. The extension saves the result in the layout file.
 * - Toolbar and keys: + and - zoom, 0 shows actual size, F fits the window
 *   (double-click does too). Export and reset are toolbar buttons; undo and
 *   redo are VS Code keybindings (Ctrl+Z, Ctrl+Shift+Z) handled by the
 *   extension.
 * - Until the user zooms, pans or drags, the diagram keeps fitting the
 *   window as it grows; after that, the view stays where the user put it.
 */
import type { Positions, Theme } from '@draw-eer/core';
import type { FromWebview, FromWorker, Move, PreviewState, ToWebview, ToWorker } from './protocol';

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
/** How close (in screen px) a dragged element must come to lining up with a neighbour to snap. */
const SNAP = 8;
/** A press that moves less than this (in screen px) is a click, not a drag. */
const DRAG_START = 3;

let view = vscode.getState()?.view ?? { scale: 1, x: 0, y: 0, fitted: true };
let source: string | null = null;
/** The positions drawn: the layout file's, with new elements placed around them. */
let positions: Positions = { nodes: {}, attributes: {} };
/** The positions the extension has (sent by it, or saved through it), as JSON. */
let saved = JSON.stringify(positions);
let requestId = 0;
let shownId = 0;
/** Top left corner of the diagram shown, in diagram coordinates (its viewBox). */
let origin: { x: number; y: number } | null = null;

/** The element being dragged. */
let moving: {
  id: string;
  /** Pointer position when the drag started, in screen px. */
  startX: number;
  startY: number;
  /** The positions when the drag started; the move is drawn relative to them. */
  base: Positions;
  move: Move | null;
  /** The pointer was released; waiting for the last frame to come back. */
  dropped: boolean;
} | null = null;

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
    case 'rendered': {
      // An older drawing finishing late must not replace a newer one.
      if (message.id < shownId) return;
      shownId = message.id;
      const before = origin;
      canvas.innerHTML = message.svg;
      origin = viewBoxOrigin();
      if (view.fitted) {
        fit();
      } else {
        // The drawing's bounds change when a shape is dragged past its edge
        // or something is added above or to the left; keep the rest still.
        if (before && origin) {
          view = {
            ...view,
            x: view.x + (origin.x - before.x) * view.scale,
            y: view.y + (origin.y - before.y) * view.scale,
          };
        }
        apply();
      }
      if (moving?.dropped && message.id === requestId) {
        drop(message.positions);
      } else if (!moving) {
        // Elements added to or deleted from the text: keep their places, and
        // save them once the text is free of syntax errors.
        positions = message.positions;
        const json = JSON.stringify(positions);
        if (message.errors === 0 && json !== saved) {
          saved = json;
          vscode.postMessage({ type: 'placed', positions });
        }
      }
      showStatus(
        message.errors === 0
          ? ''
          : `${message.errors} syntax ${message.errors === 1 ? 'error' : 'errors'} (see Problems)`,
      );
      break;
    }
    case 'failed':
      moving = null;
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
    positions: moving ? moving.base : positions,
    ...(moving?.move ? { move: moving.move } : {}),
  };
  void worker.then((w) => w.postMessage(message));
}

function viewBoxOrigin(): { x: number; y: number } | null {
  const box = canvas.querySelector('svg')?.viewBox.baseVal;
  return box ? { x: box.x, y: box.y } : null;
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

// ---------------------------------------------------------------------------
// Panning, and dragging shapes and attributes
// ---------------------------------------------------------------------------

let pan: { x: number; y: number } | null = null;
viewport.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || moving) return;
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('dragging');
  const element = (event.target as Element).closest('#canvas [data-id]');
  if (element) {
    moving = {
      id: element.getAttribute('data-id')!,
      startX: event.clientX,
      startY: event.clientY,
      base: positions,
      move: null,
      dropped: false,
    };
  } else {
    pan = { x: event.clientX - view.x, y: event.clientY - view.y };
  }
});
viewport.addEventListener('pointermove', (event) => {
  if (pan) {
    view = { ...view, x: event.clientX - pan.x, y: event.clientY - pan.y, fitted: false };
    apply();
  } else if (moving && !moving.dropped) {
    const dx = event.clientX - moving.startX;
    const dy = event.clientY - moving.startY;
    if (!moving.move && Math.hypot(dx, dy) < DRAG_START) return;
    // From here on the view stays put instead of refitting as the drawing changes.
    view = { ...view, fitted: false };
    moving.move = {
      id: moving.id,
      dx: dx / view.scale,
      dy: dy / view.scale,
      snap: event.altKey ? 0 : SNAP / view.scale,
    };
    render();
  }
});
const endDrag = () => {
  pan = null;
  viewport.classList.remove('dragging');
  if (!moving || moving.dropped) return;
  if (!moving.move) {
    moving = null; // only a click
  } else {
    moving.dropped = true;
    // Saved when the last frame comes back (see onWorkerMessage), so the file
    // gets exactly what is shown; if it is already shown, ask for it again.
    if (shownId === requestId) render();
  }
};
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);
viewport.addEventListener('dblclick', fit);

function drop(dropped: Positions): void {
  moving = null;
  positions = dropped;
  saved = JSON.stringify(positions);
  vscode.postMessage({ type: 'moved', positions });
}

function cancelMove(): void {
  if (!moving) return;
  moving = null;
  viewport.classList.remove('dragging');
  render();
}

document.getElementById('zoom-in')!.addEventListener('click', () => zoomCenter(1.25));
document.getElementById('zoom-out')!.addEventListener('click', () => zoomCenter(0.8));
document.getElementById('zoom-reset')!.addEventListener('click', actualSize);
document.getElementById('zoom-fit')!.addEventListener('click', fit);
for (const [button, command] of [
  ['export-svg', 'exportSvg'],
  ['export-png', 'exportPng'],
  ['reset-layout', 'resetLayout'],
] as const) {
  document
    .getElementById(button)!
    .addEventListener('click', () => vscode.postMessage({ type: 'command', command }));
}
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancelMove();
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
  const message = event.data;
  if (message.type === 'source') {
    source = message.text;
  } else {
    // A change to the layout file wins over a drag in progress.
    moving = null;
    positions = message.positions;
    saved = JSON.stringify(positions);
  }
  render();
});

showStatus('');
apply();
vscode.postMessage({ type: 'ready' });
