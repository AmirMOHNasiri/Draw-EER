/**
 * The preview's Web Worker: parse → layout → SVG, off the page's thread,
 * so typing and zooming stay smooth even when layout takes a while.
 *
 * Only the newest request matters: if several arrive while a diagram is
 * being drawn, the older ones are dropped.
 */
import { renderDiagram, type TextMeasurer } from '@draw-eer/core';
import { createMeasurer } from '../src/harfbuzz';
import type { FromWorker, ToWorker } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

let measurer: TextMeasurer | null = null;
let pending: Extract<ToWorker, { type: 'render' }> | null = null;
let busy = false;

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
      const { svg, errors } = renderDiagram(request.text, measurer!, { theme: request.theme });
      self.postMessage({
        type: 'rendered',
        id: request.id,
        svg,
        errors: errors.length,
        ms: performance.now() - start,
      });
    } catch (error) {
      self.postMessage({ type: 'failed', id: request.id, message: String(error) });
    }
    busy = false;
    drain();
  }, 0);
}
