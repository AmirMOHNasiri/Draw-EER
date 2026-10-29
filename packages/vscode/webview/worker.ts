/**
 * The preview's Web Worker: parse → layout → SVG, off the page's thread,
 * so typing and zooming stay smooth even when layout takes a while.
 *
 * Only the newest request matters: if several arrive while a diagram is
 * being drawn, the older ones are dropped.
 *
 * With a layout file, pinned elements stay put and new ones are placed
 * around them (`arrange` in core). The parsed text and its automatic layout
 * are kept, so that while the user drags a shape (same text, new positions)
 * each frame only applies the positions and draws, which takes milliseconds.
 */
import {
  arrange,
  buildDiagram,
  clearOfShapes,
  layoutDiagram,
  moveTo,
  parse,
  prunePositions,
  renderSvg,
  sizeDiagram,
  snap,
  type Layout,
  type Positions,
  type SizedDiagram,
  type TextMeasurer,
} from '@draw-eer/core';
import { createMeasurer } from '../src/harfbuzz';
import type { FromWorker, Move, ToWorker } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

type RenderRequest = Extract<ToWorker, { type: 'render' }>;

let measurer: TextMeasurer | null = null;
let pending: RenderRequest | null = null;
let busy = false;
/** The last text drawn, with its automatic layout once it was needed. */
let cached: { text: string; sized: SizedDiagram; auto: Layout | null; errors: number } | null =
  null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    void createMeasurer(new Uint8Array(message.wasm), {
      regular: new Uint8Array(message.regular),
      bold: new Uint8Array(message.bold),
    }).then(
      (m) => {
        measurer = m;
        self.postMessage({ type: 'ready' });
        drain();
      },
      // A failure here would otherwise vanish inside the worker.
      (error: unknown) =>
        self.postMessage({ type: 'failed', id: 0, message: `HarfBuzz did not load: ${error}` }),
    );
    return;
  }
  pending = message;
  drain();
};

function drain(): void {
  if (busy || !measurer || !pending) return;
  busy = true;
  // Let newer messages arrive first, so a burst of edits draws only the last.
  setTimeout(() => {
    const request = pending!;
    pending = null;
    const start = performance.now();
    try {
      self.postMessage({
        ...draw(request),
        type: 'rendered',
        id: request.id,
        ms: performance.now() - start,
      });
    } catch (error) {
      self.postMessage({ type: 'failed', id: request.id, message: String(error) });
    }
    busy = false;
    drain();
  }, 0);
}

function draw(request: RenderRequest): { svg: string; errors: number; positions: Positions } {
  if (cached?.text !== request.text) {
    const { file, errors } = parse(request.text);
    cached = {
      text: request.text,
      sized: sizeDiagram(buildDiagram(file), measurer!),
      auto: null,
      errors: errors.length,
    };
  }
  const entry = cached;
  const { sized, errors } = entry;
  const auto = () => (entry.auto ??= layoutDiagram(sized));
  let { layout, positions } = arrange(sized, request.positions, auto);
  if (request.move) {
    positions = moved(sized, layout, positions, request.move);
    layout = arrange(sized, positions, auto).layout;
  }
  // Positions of elements no longer in the text are dropped, but not while
  // the text has syntax errors: a half-typed edit can hide an element for a
  // moment, and it must not lose its place.
  if (errors === 0) positions = prunePositions(sized.diagram, positions);
  return { svg: renderSvg(sized, layout, { theme: request.theme }), errors, positions };
}

/** The positions with `move` applied to what is shown (`layout`). */
function moved(sized: SizedDiagram, layout: Layout, positions: Positions, move: Move): Positions {
  const from = layout.get(move.id);
  if (!from) return positions;
  let to = { x: from.x + move.dx, y: from.y + move.dy };
  if (move.snap > 0) to = snap(sized.diagram, layout, move.id, to, move.snap);
  to = clearOfShapes(sized, layout, move.id, to);
  return moveTo(sized.diagram, layout, positions, move.id, to);
}
