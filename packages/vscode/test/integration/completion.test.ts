/**
 * Completion as VS Code asks for it: open an .eer file and request
 * suggestions at a position, through the same command the editor uses.
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'mocha';
import * as vscode from 'vscode';
import { activate, openEer } from './helpers';

/** Labels of the suggestions at the `|` in `text`. */
async function labels(text: string): Promise<string[]> {
  const { document, position } = await openEer(text);
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    position,
  );
  return list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
}

const has = (list: string[], ...expected: string[]) =>
  assert.ok(
    expected.every((label) => list.includes(label)),
    `expected ${expected.join(', ')} in [${list.join(', ')}]`,
  );

describe('completion', () => {
  before(async () => {
    await activate();
    // VS Code falls back to words from the file when a provider offers
    // nothing; switch that off so the tests see only what this extension offers.
    await vscode.workspace
      .getConfiguration('editor')
      .update('wordBasedSuggestions', 'off', vscode.ConfigurationTarget.Global);
  });

  it('offers declarations at the start of a line', async () => {
    has(await labels('|'), 'entity', 'weak entity', 'rel', 'specialize', 'category');
    has(await labels('entity A { a }\n\n|\n\nentity B { b }'), 'entity', 'rel');
  });

  it('offers entity while it is being typed between declarations', async () => {
    // The reported bug: `en` on an empty line offered nothing.
    has(await labels('entity A { a }\nen|\nentity B { b }'), 'entity');
    has(await labels('spec|'), 'specialize');
  });

  it('offers no keywords for an attribute name inside an entity block', async () => {
    const list = await labels('entity A {\n  id: key\n  |\n}');
    assert.deepEqual(list, []);
  });

  it('offers attribute flags after the colon', async () => {
    assert.deepEqual(await labels('entity A {\n  id: |\n}'), [
      'key',
      'key2',
      'partial',
      'multi',
      'derived',
    ]);
    has(await labels('entity A {\n  id: mu|\n}'), 'multi');
    // Inside a composite attribute's braces.
    has(await labels('entity A {\n  name { first: |\n}'), 'key');
  });

  it('offers entity names and attrs at the start of a participant line', async () => {
    const source = 'entity دانشجو\nentity "Course Unit"\nrel Takes {\n  |\n}';
    has(await labels(source), 'دانشجو', 'Course Unit', 'attrs');
    has(await labels('entity Student\nrel Takes {\n  Stu|\n}'), 'Student');
    has(await labels('entity Student\nrel Takes { Student 1, |'), 'Student', 'attrs');
  });

  it('offers cardinalities and participation after a participant name', async () => {
    const list = await labels('entity Student\nrel Takes {\n  Student |\n}');
    has(list, 'total', 'partial', 'as', '1', 'N');
    has(await labels('entity Student\nrel Takes {\n  Student N to|\n}'), 'total');
  });

  it('quotes entity names that need it', async () => {
    const { document, position } = await openEer('entity "Course Unit"\nrel R { | }');
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      position,
    );
    const course = list.items.find((item) => item.label === 'Course Unit');
    assert.equal(course?.insertText, '"Course Unit"');
  });
});
