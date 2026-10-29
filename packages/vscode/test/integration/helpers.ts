import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

const folder = mkdtempSync(path.join(tmpdir(), 'draw-eer-test-'));
let count = 0;

/**
 * Writes `text` to a new .eer file and opens it in an editor. A `|` in the
 * text marks the cursor; it is removed and its position returned.
 */
export async function openEer(
  text: string,
): Promise<{ document: vscode.TextDocument; position: vscode.Position }> {
  const offset = text.indexOf('|');
  const content = offset === -1 ? text : text.slice(0, offset) + text.slice(offset + 1);
  const file = path.join(folder, `case-${++count}.eer`);
  writeFileSync(file, content);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'eer', '.eer files get the eer language');
  return { document, position: document.positionAt(offset === -1 ? 0 : offset) };
}

/** Activates the extension (opening an .eer file would too, but not before the first test runs). */
export async function activate(): Promise<void> {
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'draw-eer');
  assert.ok(extension, 'the extension is loaded');
  await extension.activate();
}

/** Waits until `check` returns a value other than undefined, or fails after `ms`. */
export async function waitFor<T>(check: () => T | undefined, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
