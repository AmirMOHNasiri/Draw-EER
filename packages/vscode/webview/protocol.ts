/**
 * Messages between the extension, the preview page and its worker. Shared
 * by both sides so they cannot drift apart.
 */
import type { Theme } from '@draw-eer/core';

/** Extension → preview page. */
export type ToWebview = { type: 'source'; text: string; version: number };

/** Preview page → extension. */
export type FromWebview = { type: 'ready' };

/** What the preview page remembers across reloads (`vscode.setState`). */
export interface PreviewState {
  /** The previewed document, so the preview can come back after a restart. */
  uri: string;
  view?: { scale: number; x: number; y: number; fitted: boolean };
}

/** Preview page → worker. */
export type ToWorker =
  | { type: 'init'; wasm: ArrayBuffer; regular: ArrayBuffer; bold: ArrayBuffer }
  | { type: 'render'; id: number; text: string; theme: Theme };

/** Worker → preview page. */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'rendered'; id: number; svg: string; errors: number; ms: number }
  | { type: 'failed'; id: number; message: string };
