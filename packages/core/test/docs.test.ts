import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from '../src';

// Keeps docs/language.md honest: every untagged code block in it must parse.
const docPath = fileURLToPath(new URL('../../../docs/language.md', import.meta.url));
const blocks = [...readFileSync(docPath, 'utf8').matchAll(/^```\n([\s\S]*?)^```/gm)].map(
  (match) => match[1]!,
);

describe('docs/language.md examples', () => {
  it('has examples', () => {
    expect(blocks.length).toBeGreaterThan(3);
  });

  it.each(blocks.map((block, i) => [i + 1, block]))('example %i parses', (_, block) => {
    expect(parse(block).errors).toEqual([]);
  });
});
