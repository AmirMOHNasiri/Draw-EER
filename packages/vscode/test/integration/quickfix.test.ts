/**
 * Quick Fixes as VS Code offers them (the light bulb and Ctrl+.): open a
 * file with an error, wait for its diagnostic, ask for code actions at the
 * error and apply the fix.
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'mocha';
import * as vscode from 'vscode';
import { activate, openEer, waitFor } from './helpers';

/**
 * The Quick Fixes offered for `range`, as the light bulb asks for them.
 * VS Code adds its own actions (such as Copilot's, kind `quickfix.copilot`),
 * and the command's result leaves out `diagnostics`, so ours are picked by kind.
 */
async function quickFixes(uri: vscode.Uri, range: vscode.Range): Promise<vscode.CodeAction[]> {
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    'vscode.executeCodeActionProvider',
    uri,
    range,
    vscode.CodeActionKind.QuickFix.value,
  );
  return actions.filter((a) => a.kind?.value === vscode.CodeActionKind.QuickFix.value);
}

/** Opens `text`, applies the Quick Fix offered at its first error, returns the new text. */
async function fixed(text: string, title?: string): Promise<string> {
  const { document } = await openEer(text);
  const diagnostic = await waitFor(
    () => vscode.languages.getDiagnostics(document.uri)[0],
    `a diagnostic in ${JSON.stringify(text)}`,
  );
  const ours = await quickFixes(document.uri, diagnostic.range);
  assert.equal(ours.length, 1, `one fix for: ${diagnostic.message}`);
  const action = ours[0]!;
  if (title) assert.equal(action.title, title);
  assert.equal(action.isPreferred, true);
  assert.ok(await vscode.workspace.applyEdit(action.edit!));
  return document.getText();
}

describe('quick fixes', () => {
  before(activate);

  it('replaces a misspelled or unfinished keyword', async () => {
    assert.equal(await fixed('en A { a }', "Change to 'entity'"), 'entity A { a }');
    assert.equal(await fixed('entity A { id: mutli }'), 'entity A { id: multi }');
    assert.equal(await fixed('rel R { A N totl }'), 'rel R { A N total }');
    assert.equal(await fixed('specialize E disjiont { A }'), 'specialize E disjoint { A }');
  });

  it("adds a missing ':' or ','", async () => {
    assert.equal(await fixed('entity A { id key }', "Add ':'"), 'entity A { id: key }');
    assert.equal(await fixed('rel R { Professor Course }'), 'rel R { Professor, Course }');
  });

  it('quotes a name with symbols', async () => {
    assert.equal(await fixed('entity A { سال-ترم }'), 'entity A { "سال-ترم" }');
  });

  it("adds a missing '}'", async () => {
    assert.equal(await fixed('entity A {\n  a\n'), 'entity A {\n  a\n}\n');
  });

  it('removes the diagnostic once the fix is applied', async () => {
    const { document } = await openEer('entiy A');
    await waitFor(() => vscode.languages.getDiagnostics(document.uri)[0], 'the diagnostic');
    // The cursor right after the word, as when typing stops.
    const [action] = await quickFixes(document.uri, new vscode.Range(0, 5, 0, 5));
    assert.ok(action && (await vscode.workspace.applyEdit(action.edit!)));
    await waitFor(
      () => (vscode.languages.getDiagnostics(document.uri).length === 0 ? true : undefined),
      'the diagnostic to go away',
    );
  });
});
