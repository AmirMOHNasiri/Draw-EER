/**
 * Syntax highlighting as VS Code renders it: the real tokenizer and the
 * built-in themes. `_workbench.captureSyntaxTokens` is the internal command
 * VS Code's own colorization tests use; for each token it returns the text,
 * the scopes and the color each built-in theme gives it.
 *
 * test/grammar.test.ts checks the scopes in detail (fast, no VS Code); this
 * checks that the result looks the same in the editor.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import { openEer } from './helpers';

interface CapturedToken {
  /** The token's text. */
  c: string;
  /** Its scopes, outermost first, separated by spaces. */
  t: string;
  /** Per built-in theme, the matching rule and color, like "entity.name.type: #4EC9B0". */
  r: Record<string, string>;
}

async function capture(text: string): Promise<CapturedToken[]> {
  const { document } = await openEer(text);
  return vscode.commands.executeCommand<CapturedToken[]>(
    '_workbench.captureSyntaxTokens',
    document.uri,
  );
}

/** The Dark Modern color of each token whose text is `word` (quotes stripped). */
function colors(tokens: CapturedToken[], word: string): string[] {
  const matches = tokens.filter((t) => t.c.trim().replace(/^"|"$/g, '') === word);
  assert.ok(matches.length > 0, `no token '${word}' in ${tokens.map((t) => t.c).join('|')}`);
  return matches.map((t) => t.r['dark_modern'] ?? t.r['dark_plus']!);
}

describe('highlighting', () => {
  it('colors every participant of a relationship alike', async () => {
    const tokens = await capture(
      [
        'rel مبدا { پرواز N total, فرودگاه 1 }',
        'rel R {',
        '  "پرواز روزانه" 1,',
        '  صندلی N total',
        '}',
      ].join('\n'),
    );
    const expected = colors(tokens, 'پرواز')[0]!;
    assert.match(expected, /^entity\.name\.type/);
    for (const name of ['فرودگاه', 'پرواز روزانه', 'صندلی']) {
      assert.deepEqual(colors(tokens, name), [expected], name);
    }
  });

  it('colors attribute names alike, quoted or not', async () => {
    const tokens = await capture('entity A { a: key, "b c", d }');
    const expected = colors(tokens, 'a')[0];
    assert.deepEqual(colors(tokens, 'b c'), [expected]);
    assert.deepEqual(colors(tokens, 'd'), [expected]);
  });

  it('colors specialization and category members alike', async () => {
    const tokens = await capture(
      'specialize E disjoint { A, "B C",\n  D }\ncategory U { A, "B C" }',
    );
    const expected = colors(tokens, 'A')[0];
    for (const name of ['B C', 'D']) {
      assert.ok(
        colors(tokens, name).every((c) => c === expected),
        name,
      );
    }
  });
});
