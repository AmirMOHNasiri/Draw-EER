/**
 * Export and the layout file, through the extension's commands: export a
 * diagram with a Persian label to SVG and PNG, apply positions from its
 * layout file, and, with a preview open, save new elements as the text
 * changes, then reset, undo and redo.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { before, describe, it } from 'mocha';
import * as vscode from 'vscode';
import { activate, openEer, waitFor } from './helpers';

const SOURCE = 'entity دانشجو { نام: key }\nentity B\nrel R { دانشجو 1, B N }';

/** Exports `document` to a file next to it and returns the file's contents. */
async function exported(document: vscode.TextDocument, format: 'svg' | 'png'): Promise<Buffer> {
  const target = vscode.Uri.file(document.uri.fsPath.replace(/\.eer$/, `.${format}`));
  const written = await vscode.commands.executeCommand<vscode.Uri | undefined>(
    `drawEer.export${format === 'svg' ? 'Svg' : 'Png'}`,
    document.uri,
    target,
  );
  assert.equal(written?.fsPath, target.fsPath);
  return readFileSync(target.fsPath);
}

/** The x of the center of entity `id` in an exported SVG, rounded. */
function centerX(svg: string, id: string): number {
  const at = svg.indexOf(`data-id="${id}"`);
  assert.ok(at > 0, `${id} is drawn`);
  const rect = /<rect [^>]*\bx="([-\d.]+)"[^>]*\bwidth="([\d.]+)"/.exec(svg.slice(at))!;
  return Math.round(Number(rect[1]) + Number(rect[2]) / 2);
}

/** Where entity B is drawn in an export, which uses the positions an open preview holds. */
async function bAt(document: vscode.TextDocument): Promise<number> {
  return centerX((await exported(document, 'svg')).toString('utf8'), 'entity:B');
}

const layoutFile = (document: vscode.TextDocument) => `${document.uri.fsPath}.layout.json`;

/** A layout file that pins only B, centered at (x, 0). */
function writeLayout(document: vscode.TextDocument, x: number): void {
  const text = `{\n  "version": 1,\n  "nodes": {\n    "entity:B": { "x": ${x}, "y": 0 }\n  },\n  "attributes": {}\n}\n`;
  writeFileSync(layoutFile(document), text);
}

const layoutText = (document: vscode.TextDocument) =>
  existsSync(layoutFile(document)) ? readFileSync(layoutFile(document), 'utf8') : '';

describe('export', () => {
  before(activate);

  it('exports an SVG on white with the fonts embedded, cut down to the characters used', async () => {
    const { document } = await openEer(SOURCE);
    const svg = (await exported(document, 'svg')).toString('utf8');
    assert.ok(svg.includes('دانشجو'));
    assert.ok(svg.includes('fill="#ffffff"'), 'white background');
    assert.equal(svg.split('@font-face').length - 1, 2);
    assert.ok(svg.length < 40_000, `${svg.length} bytes`);
  });

  it('exports a PNG three times the size of the SVG', async () => {
    const { document } = await openEer(SOURCE);
    const svg = (await exported(document, 'svg')).toString('utf8');
    const png = await exported(document, 'png');
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    const width = Number(/width="([\d.]+)"/.exec(svg)![1]);
    assert.equal(png.readUInt32BE(16), Math.round(width * 3));
  });

  it('draws pinned shapes where the layout file says, and the others around them', async () => {
    const { document } = await openEer(SOURCE);
    writeLayout(document, 300);
    const svg = (await exported(document, 'svg')).toString('utf8');
    assert.equal(centerX(svg, 'entity:B'), 300);
    assert.ok(svg.includes('data-id="entity:دانشجو"'));
    // An export never writes the layout file.
    assert.ok(!layoutText(document).includes('دانشجو'));
  });
});

describe('layout file with a preview open', () => {
  before(activate);

  it('saves new elements, follows outside changes, and resets, undoes and redoes', async () => {
    const { document } = await openEer(SOURCE);
    const auto = await bAt(document);
    writeLayout(document, 120);
    await vscode.commands.executeCommand('drawEer.openPreview', document.uri);
    await poll(async () => (await bAt(document)) === 120, 'the preview to load the layout file');
    // The elements the file did not have are placed around B and saved.
    await waitFor(
      () => (layoutText(document).includes('"entity:دانشجو"') ? true : undefined),
      'the other elements to be saved',
    );

    // A new entity in the text is placed and saved; B stays put.
    const end = document.positionAt(document.getText().length);
    const add = new vscode.WorkspaceEdit();
    add.insert(document.uri, end, '\nentity C { x }');
    await vscode.workspace.applyEdit(add);
    await waitFor(
      () => (layoutText(document).includes('"entity:C"') ? true : undefined),
      'the new entity to be saved',
    );
    assert.equal(await bAt(document), 120);
    // Deleted again: dropped from the file.
    const remove = new vscode.WorkspaceEdit();
    remove.delete(
      document.uri,
      new vscode.Range(end, document.positionAt(document.getText().length)),
    );
    await vscode.workspace.applyEdit(remove);
    await waitFor(
      () => (layoutText(document).includes('"entity:C"') ? undefined : true),
      'the deleted entity to be dropped',
    );

    // Edited outside VS Code (by hand, or a git checkout): picked up by the watcher.
    writeLayout(document, 200);
    await poll(async () => (await bAt(document)) === 200, 'the change to the layout file');

    await vscode.commands.executeCommand('drawEer.resetLayout', document.uri);
    await waitFor(() => (existsSync(layoutFile(document)) ? undefined : true), 'the file to go');
    assert.equal(await bAt(document), auto);

    // The preview is the active editor, so undo and redo apply to it.
    await vscode.commands.executeCommand('drawEer.undoLayoutChange');
    await waitFor(() => (existsSync(layoutFile(document)) ? true : undefined), 'the file back');
    await poll(async () => (await bAt(document)) === 200, 'the undone layout');
    await vscode.commands.executeCommand('drawEer.redoLayoutChange');
    await waitFor(() => (existsSync(layoutFile(document)) ? undefined : true), 'the file to go');

    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    rmSync(layoutFile(document), { force: true });
  });

  it('resets a layout file without a preview, too', async () => {
    const { document } = await openEer(SOURCE);
    writeLayout(document, 50);
    await vscode.commands.executeCommand('drawEer.resetLayout', document.uri);
    assert.equal(existsSync(layoutFile(document)), false);
  });
});

/** Like waitFor, for an async check. */
async function poll(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
