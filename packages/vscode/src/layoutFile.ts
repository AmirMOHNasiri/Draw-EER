/**
 * The layout file of one diagram: `<name>.eer.layout.json` next to it, with
 * the positions the user set by dragging in the preview (see `Positions` in
 * core for what is stored). Moves, undo, redo and reset all go through here
 * and are written to the file at once, so the file is always what the
 * preview shows. Untitled documents keep their positions in memory only.
 *
 * Changes made outside the preview (editing the file by hand, a git
 * checkout, deleting it) are picked up by a file watcher.
 */
import * as vscode from 'vscode';
import {
  isEmpty,
  NO_POSITIONS,
  parseLayoutFile,
  serializeLayoutFile,
  type Positions,
} from '@draw-eer/core';

/** Most steps that can be undone, per diagram. */
const UNDO_LIMIT = 100;

export class LayoutFile implements vscode.Disposable {
  private current: Positions = NO_POSITIONS;
  private readonly undoStack: Positions[] = [];
  private readonly redoStack: Positions[] = [];
  /** The text last written, so the watcher can tell our own writes from other changes. */
  private written: string | null = null;
  private readonly changed = new vscode.EventEmitter<Positions>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private warned = false;

  /** Fires when the positions change for any reason other than `move`. */
  readonly onDidChange = this.changed.event;
  /** The file, or null for documents that are not saved anywhere yet. */
  readonly uri: vscode.Uri | null;

  constructor(document: vscode.Uri) {
    this.uri = layoutFileUri(document);
    if (this.uri) {
      const folder = vscode.Uri.joinPath(this.uri, '..');
      const name = this.uri.path.slice(this.uri.path.lastIndexOf('/') + 1);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, name),
      );
      const reload = () => void this.reload();
      this.disposables.push(
        watcher,
        watcher.onDidCreate(reload),
        watcher.onDidChange(reload),
        watcher.onDidDelete(reload),
      );
    }
  }

  get positions(): Positions {
    return this.current;
  }

  /** Reads the file (again); called once at the start and by the watcher. */
  async reload(): Promise<void> {
    const text = await readLayoutText(this.uri);
    if (text === this.written) return;
    this.written = text;
    const { positions, error } =
      text === null ? { positions: NO_POSITIONS, error: null } : parseLayoutFile(text);
    if (error && !this.warned) {
      // Once per file, so a half-saved hand edit does not raise a stream of warnings.
      this.warned = true;
      void vscode.window.showWarningMessage(`${error} Using the automatic layout instead.`);
    }
    this.current = positions;
    this.changed.fire(positions);
  }

  /** The user dropped something in the preview, which already shows `positions`. */
  async move(positions: Positions): Promise<void> {
    await this.set(positions, false);
  }

  /**
   * New elements were placed around the pinned ones, or deleted ones
   * dropped, as the text changed. Saved, but not a step to undo: undoing a
   * move afterwards places such elements again.
   */
  async place(positions: Positions): Promise<void> {
    await this.write(positions, false);
  }

  /** Back to the automatic layout (can be undone). */
  async reset(): Promise<void> {
    if (!isEmpty(this.current)) await this.set(NO_POSITIONS, true);
  }

  async undo(): Promise<void> {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.current);
    await this.write(previous, true);
  }

  async redo(): Promise<void> {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.current);
    await this.write(next, true);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private async set(positions: Positions, notify: boolean): Promise<void> {
    this.undoStack.push(this.current);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    await this.write(positions, notify);
  }

  private async write(positions: Positions, notify: boolean): Promise<void> {
    this.current = positions;
    if (notify) this.changed.fire(positions);
    if (!this.uri) return;
    // No moves left: no file, rather than one that says nothing.
    const text = isEmpty(positions) ? null : serializeLayoutFile(positions);
    this.written = text;
    try {
      if (text === null) {
        await vscode.workspace.fs.delete(this.uri);
      } else {
        await vscode.workspace.fs.writeFile(this.uri, new TextEncoder().encode(text));
      }
    } catch (error) {
      if (text !== null || !(error instanceof vscode.FileSystemError)) {
        void vscode.window.showErrorMessage(`Could not save the layout file: ${error}`);
      }
    }
  }
}

/** `<name>.eer.layout.json` next to the document, or null for an untitled one. */
export function layoutFileUri(document: vscode.Uri): vscode.Uri | null {
  if (document.scheme === 'untitled') return null;
  return document.with({ path: `${document.path}.layout.json` });
}

/** The positions in a diagram's layout file, without watching it (for exports). */
export async function readPositions(document: vscode.Uri): Promise<Positions> {
  const text = await readLayoutText(layoutFileUri(document));
  return text === null ? NO_POSITIONS : parseLayoutFile(text).positions;
}

async function readLayoutText(uri: vscode.Uri | null): Promise<string | null> {
  if (!uri) return null;
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}
