/**
 * Messages between the extension, the preview page and its worker. Shared
 * by both sides so they cannot drift apart.
 */
import type { Positions, Theme } from '@draw-eer/core';

/** Extension → preview page. */
export type ToWebview =
  | { type: 'source'; text: string; version: number }
  /** The layout file changed: loaded, edited outside, undo, redo or reset. */
  | { type: 'positions'; positions: Positions };

/** Preview page → extension. */
export type FromWebview =
  | { type: 'ready' }
  /** The user dropped a shape or attribute; the page already shows `positions`. */
  | { type: 'moved'; positions: Positions }
  /**
   * The text changed: new elements were placed around the pinned ones, or
   * deleted ones dropped. Saved, but not as a step to undo.
   */
  | { type: 'placed'; positions: Positions }
  | { type: 'command'; command: 'exportSvg' | 'exportPng' | 'resetLayout' };

/** What the preview page remembers across reloads (`vscode.setState`). */
export interface PreviewState {
  /** The previewed document, so the preview can come back after a restart. */
  uri: string;
  view?: { scale: number; x: number; y: number; fitted: boolean };
}

/**
 * An element being dragged: moved by (dx, dy) from where it was when the
 * drag started, in diagram px. `snap` is how close (in diagram px) it must
 * come to lining up with a neighbour to snap to it; 0 turns snapping off.
 */
export interface Move {
  id: string;
  dx: number;
  dy: number;
  snap: number;
}

/** Preview page → worker. */
export type ToWorker =
  | { type: 'init'; wasm: ArrayBuffer; regular: ArrayBuffer; bold: ArrayBuffer }
  | {
      type: 'render';
      id: number;
      text: string;
      theme: Theme;
      positions: Positions;
      move?: Move;
    };

/** Worker → preview page. */
export type FromWorker =
  | { type: 'ready' }
  | {
      type: 'rendered';
      id: number;
      svg: string;
      errors: number;
      ms: number;
      /**
       * The positions drawn: those sent, plus new elements placed around them
       * and the move applied; those of deleted elements are dropped when the
       * text has no syntax errors.
       */
      positions: Positions;
    }
  | { type: 'failed'; id: number; message: string };
