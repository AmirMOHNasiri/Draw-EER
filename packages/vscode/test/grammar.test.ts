/**
 * Tokenizes .eer text with the TextMate grammar, using the same engine as
 * VS Code (vscode-textmate with Oniguruma), and checks the scopes.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';

const require = createRequire(import.meta.url);
let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () =>
      textmate.parseRawGrammar(
        readFileSync(new URL('../syntaxes/eer.tmLanguage.json', import.meta.url), 'utf8'),
        'eer.tmLanguage.json',
      ),
  });
  grammar = (await registry.loadGrammar('source.eer'))!;
});

/** Each token's text with its scopes (without `source.eer` and the `.eer` suffixes), across all lines. */
function scopedTokens(source: string): [string, string[]][] {
  let state = textmate.INITIAL;
  const result: [string, string[]][] = [];
  for (const line of source.split('\n')) {
    const { tokens: lineTokens, ruleStack } = grammar.tokenizeLine(line, state);
    for (const token of lineTokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text.trim() === '') continue;
      result.push([text, token.scopes.slice(1).map((s) => s.replace(/\.eer$/, ''))]);
    }
    state = ruleStack;
  }
  return result;
}

/** Each token's text with its innermost scope, the one that decides its color. */
function tokens(source: string): [string, string][] {
  return scopedTokens(source).map(([text, scopes]) => [text, scopes.at(-1)!]);
}

/** In order, the text of every token whose innermost scope is `scope`. */
function textsWith(source: string, scope: string): string[] {
  return tokens(source)
    .filter(([, s]) => s === scope)
    .map(([text]) => text);
}

const scopeOf = (source: string, text: string) => tokens(source).find(([t]) => t === text)?.[1];

describe('grammar', () => {
  it('colors entity declarations, attributes and their flags', () => {
    const source = 'weak entity Dependent {\n  name: partial\n  age: derived\n  total\n}';
    expect(scopeOf(source, 'weak')).toBe('storage.modifier');
    expect(scopeOf(source, 'entity')).toBe('storage.type.entity');
    expect(scopeOf(source, 'Dependent')).toBe('entity.name.type');
    expect(scopeOf(source, 'name')).toBe('variable.other.property');
    expect(scopeOf(source, 'partial')).toBe('storage.modifier.flag');
    expect(scopeOf(source, 'derived')).toBe('storage.modifier.flag');
    // A keyword elsewhere is just a name here.
    expect(scopeOf(source, 'total')).toBe('variable.other.property');
  });

  it('colors relationships: participants, cardinalities, participation and roles', () => {
    const source =
      'identifying rel Has {\n  Employee 1 as boss\n  Dependent N total\n  Course (0,M)\n}';
    expect(scopeOf(source, 'identifying')).toBe('storage.modifier');
    expect(scopeOf(source, 'Has')).toBe('entity.name.function.relationship');
    expect(scopeOf(source, 'Employee')).toBe('entity.name.type');
    expect(scopeOf(source, '1')).toBe('constant.numeric.cardinality');
    expect(scopeOf(source, 'boss')).toBe('variable.parameter.role');
    expect(scopeOf(source, 'N')).toBe('constant.numeric.cardinality');
    expect(scopeOf(source, 'total')).toBe('storage.modifier.participation');
    expect(scopeOf(source, '(0,M)')).toBe('constant.numeric.cardinality');
  });

  it('treats a one-letter participant as an entity and the letter after it as a cardinality', () => {
    const result = tokens('rel R { A 1, B N }');
    expect(result).toContainEqual(['A', 'entity.name.type']);
    expect(result).toContainEqual(['B', 'entity.name.type']);
    expect(result).toContainEqual(['N', 'constant.numeric.cardinality']);
  });

  it('colors attributes of a relationship', () => {
    const source = 'rel R {\n  A, B\n  attrs { grade: multi }\n}';
    expect(scopeOf(source, 'attrs')).toBe('keyword.other.attrs');
    expect(scopeOf(source, 'grade')).toBe('variable.other.property');
    expect(scopeOf(source, 'multi')).toBe('storage.modifier.flag');
  });

  it('handles Persian names with a zero-width non-joiner, and quoted names', () => {
    const source =
      'entity "عضو کتابخانه" {\n  تاریخ\u200cعضویت: key\n}\nrel پیش\u200cنیازی { درس N, درس M }';
    expect(scopeOf(source, '"عضو کتابخانه"')).toBe('entity.name.type');
    expect(scopeOf(source, 'تاریخ\u200cعضویت')).toBe('variable.other.property');
    expect(scopeOf(source, 'پیش\u200cنیازی')).toBe('entity.name.function.relationship');
    expect(scopeOf(source, 'درس')).toBe('entity.name.type');
  });

  it('colors comments, specializations, categories and repeated entities', () => {
    const source = [
      '// a comment',
      'specialize Employee disjoint total { Secretary, Engineer }',
      'category Owner partial { Person, Bank }',
      'show Course again as Course2',
      '/* block */',
    ].join('\n');
    expect(scopeOf(source, '// a comment')).toBe('comment.line.double-slash');
    expect(scopeOf(source, 'disjoint')).toBe('storage.modifier');
    expect(scopeOf(source, 'Secretary')).toBe('entity.name.type');
    expect(scopeOf(source, 'Owner')).toBe('entity.name.type');
    expect(scopeOf(source, 'again')).toBe('keyword.other.show');
    expect(scopeOf(source, 'Course2')).toBe('entity.name.type');
    expect(tokens(source).find(([t]) => t.includes('block'))?.[1]).toBe('comment.block');
  });

  describe('names get the same color wherever they are', () => {
    // Each test lists every token with the scope, in order, so a name that
    // is missing (colored differently) or one too many fails it.
    it('every participant of a relationship, first or after a comma, on any line, quoted or not', () => {
      const source = [
        'rel مبدا { پرواز N total, فرودگاه 1 }',
        'identifying rel اجرا { پرواز 1, "پرواز روزانه" N total }',
        'rel R {',
        '  Student (0,N) as learner, Course (1,1)',
        '  "Big Room" 1',
        '  Teacher',
        '  , Desk',
        '  attrs { grade }',
        '}',
        'rel Pair { Person 1 as head,Person N as member }',
      ].join('\n');
      expect(textsWith(source, 'entity.name.type')).toEqual([
        'پرواز',
        'فرودگاه',
        'پرواز',
        '"پرواز روزانه"',
        'Student',
        'Course',
        '"Big Room"',
        'Teacher',
        'Desk',
        'Person',
        'Person',
      ]);
      expect(textsWith(source, 'variable.parameter.role')).toEqual(['learner', 'head', 'member']);
      expect(textsWith(source, 'variable.other.property')).toEqual(['grade']);
    });

    it('a cardinality letter after a name is not taken for a participant', () => {
      const source = 'rel R {\n  A N, B M\n  C 1 total\n}';
      expect(textsWith(source, 'entity.name.type')).toEqual(['A', 'B', 'C']);
      expect(textsWith(source, 'constant.numeric.cardinality')).toEqual(['N', 'M', '1']);
    });

    it('every attribute name, quoted or not, simple, composite or in a key group', () => {
      const source = [
        'entity A { a: key, "b c", d }',
        'entity B {',
        '  "e f": multi',
        '  g { h, "i j" }',
        '  (k, "l m"): partial',
        '}',
      ].join('\n');
      expect(textsWith(source, 'variable.other.property')).toEqual([
        'a',
        '"b c"',
        'd',
        '"e f"',
        'g',
        'h',
        '"i j"',
        'k',
        '"l m"',
      ]);
    });

    it('every member of a specialization, category or part-of, on any line', () => {
      const source = [
        'specialize E disjoint total { A, "B C",',
        '  D',
        '}',
        'category U partial { A, "B C" }',
        'partof Car as "Has" { Wheel, "Steering Wheel" }',
      ].join('\n');
      expect(textsWith(source, 'entity.name.type')).toEqual([
        'E',
        'A',
        '"B C"',
        'D',
        'U',
        'A',
        '"B C"',
        'Car',
        'Wheel',
        '"Steering Wheel"',
      ]);
    });

    it('declared names, quoted or not', () => {
      const source =
        'entity "Big A" { x }\nentity B { y }\nrel "R S" { "Big A", B }\nrel T { B, B }';
      expect(textsWith(source, 'entity.name.type')).toEqual([
        '"Big A"',
        'B',
        '"Big A"',
        'B',
        'B',
        'B',
      ]);
      expect(textsWith(source, 'entity.name.function.relationship')).toEqual(['"R S"', 'T']);
    });

    it('keeps quoted names inside a string scope, so the editor treats them as strings', () => {
      const quoted = scopedTokens('rel R { "Big A" 1 }').find(([t]) => t === '"Big A"');
      expect(quoted?.[1]).toEqual(['string.quoted.double', 'entity.name.type']);
    });
  });

  it('tokenizes every fixture without leaving the root scope stuck', () => {
    // After a whole file, the state must be back at the top level (every
    // block it entered has ended), or the next statement would be colored wrong.
    for (const name of ['library', 'slide31', 'hospital', 'employee', 'airline', 'shop']) {
      const source = readFileSync(
        new URL(`../../core/test/fixtures/${name}.eer`, import.meta.url),
        'utf8',
      );
      let state = textmate.INITIAL;
      for (const line of source.split('\n')) state = grammar.tokenizeLine(line, state).ruleStack;
      const last = grammar.tokenizeLine('entity Probe', state).tokens;
      expect(
        last.some((t) => t.scopes.includes('storage.type.entity.eer')),
        name,
      ).toBe(true);
    }
  });
});
