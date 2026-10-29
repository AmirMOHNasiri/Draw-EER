import { describe, expect, it } from 'vitest';
import { parse, type Fix } from '../src';
import { errorMessages } from './helpers';

/** Applies a fix's edits to `source` (from the end, so earlier offsets stay valid). */
function apply(source: string, fix: Fix): string {
  const edits = [...fix.edits].sort((a, b) => b.range.start.offset - a.range.start.offset);
  let result = source;
  for (const edit of edits) {
    result =
      result.slice(0, edit.range.start.offset) + edit.newText + result.slice(edit.range.end.offset);
  }
  return result;
}

/** The source has one error; its fix turns the source into `fixed`, which has none. */
function expectFix(source: string, fixed: string) {
  const { errors } = parse(source);
  expect(errors, source).toHaveLength(1);
  const fix = errors[0]!.fix;
  expect(fix, `no fix for: ${errors[0]!.message}`).toBeDefined();
  expect(apply(source, fix!)).toBe(fixed);
  expect(
    parse(fixed).errors.map((e) => e.message),
    fixed,
  ).toEqual([]);
}

describe('did you mean', () => {
  it('completes unfinished keywords', () => {
    expect(errorMessages('en A')).toEqual(["Unknown declaration 'en'. Did you mean 'entity'?"]);
    expect(errorMessages('spec E { A }')).toEqual([
      "Unknown declaration 'spec'. Did you mean 'specialize'?",
    ]);
    expect(errorMessages('entity A { id: mul }')).toEqual([
      "Unknown attribute flag 'mul'. Did you mean 'multi'?",
    ]);
    expect(errorMessages('rel R { A N to }')).toEqual([
      "Unknown word 'to' after participant \"A\". Did you mean 'total'?",
    ]);
  });

  it('prefers the shortest keyword only when it starts all the others', () => {
    // `ke` starts both key and key2; key is the prefix of key2.
    expect(errorMessages('entity A { id: ke }')).toEqual([
      "Unknown attribute flag 'ke'. Did you mean 'key'?",
    ]);
  });

  it('does not take a capitalized name or a single letter for a keyword', () => {
    expect(errorMessages('rel R { A 1 To }')[0]).toMatch(/^Unexpected 'To'/);
    expect(errorMessages('e A')[0]).toMatch(/^Expected a declaration/);
  });

  it('suggests keywords after weak, identifying, show and inside aggregate', () => {
    expect(errorMessages('weak entiy A')).toEqual([
      "Expected 'entity' after 'weak'. Did you mean 'entity'?",
    ]);
    expect(errorMessages('show A agian as B')).toEqual([
      "Expected 'again' after show A. Did you mean 'again'?",
    ]);
    expect(errorMessages('aggregate S { relation R { A, B } }')).toEqual([
      "Expected 'rel' inside aggregate \"S\". Did you mean 'rel'?",
    ]);
  });
});

describe('quick fixes', () => {
  it('replaces misspelled or unfinished declaration keywords', () => {
    expectFix('en A { a }', 'entity A { a }');
    expectFix('entiy A', 'entity A');
    expectFix('spec E { A }', 'specialize E { A }');
    expectFix('relationship R { A, B }', 'rel R { A, B }');
    expectFix('weak entiy A { a: partial }', 'weak entity A { a: partial }');
    expectFix('identifying re R { A, B }', 'identifying rel R { A, B }');
    expectFix('entity A inherit B', 'entity A inherits B');
    expectFix('aggregate S { relation R { A, B } }', 'aggregate S { rel R { A, B } }');
  });

  it('adds a missing keyword', () => {
    expectFix('weak A { a: partial }', 'weak entity A { a: partial }');
    expectFix('identifying R { A, B }', 'identifying rel R { A, B }');
    expectFix('show Course', 'show Course again');
    expectFix('show Course as C2', 'show Course again as C2');
  });

  it('replaces misspelled attribute flags and key kinds', () => {
    expectFix('entity A { id: mutli }', 'entity A { id: multi }');
    expectFix('entity A { id: der }', 'entity A { id: derived }');
    expectFix('entity A { (a, b): ky }', 'entity A { (a, b): key }');
    expectFix('entity A { (a, b): pa }', 'entity A { (a, b): partial }');
  });

  it('repairs colons', () => {
    expectFix('entity A { id key }', 'entity A { id: key }');
    expectFix('entity A { (a, b) partial }', 'entity A { (a, b): partial }');
    expectFix('entity A { (a, b) }', 'entity A { (a, b): key }');
    expectFix('entity A { id: }', 'entity A { id }');
  });

  it('removes repeated or unneeded flags', () => {
    expectFix('entity A { id: multi multi }', 'entity A { id: multi }');
    expectFix('entity A { id: key key }', 'entity A { id: key }');
    expectFix('entity A { name: composite { a, b } }', 'entity A { name { a, b } }');
    expectFix('entity A { name: multi composite { a } }', 'entity A { name: multi { a } }');
    expectFix('specialize E total total { A }', 'specialize E total { A }');
  });

  it('adds missing commas', () => {
    expectFix('entity A { a b }', 'entity A { a, b }');
    expectFix('entity A { (a b): key }', 'entity A { (a, b): key }');
    expectFix('rel R { Professor Course }', 'rel R { Professor, Course }');
    expectFix('specialize E { A B }', 'specialize E { A, B }');
  });

  it('replaces participant, specialization and category words', () => {
    expectFix('rel R { A totl }', 'rel R { A total }');
    expectFix('rel R { A par }', 'rel R { A partial }');
    expectFix('rel R { A 1 sa boss }', 'rel R { A 1 as boss }');
    expectFix('rel R { A, B\n  attr { x } }', 'rel R { A, B\n  attrs { x } }');
    expectFix('specialize E disjiont { A }', 'specialize E disjoint { A }');
    expectFix('specialize E over { A }', 'specialize E overlapping { A }');
    expectFix('category C to { A }', 'category C total { A }');
    expectFix('partof Car az "Has" { Wheel }', 'partof Car as "Has" { Wheel }');
    expectFix('show A again az B', 'show A again as B');
  });

  it('quotes invalid names and replaces Persian commas', () => {
    expectFix('entity A { سال-ترم }', 'entity A { "سال-ترم" }');
    expectFix('entity A { 2nd }', 'entity A { "2nd" }');
    expectFix('rel R { A 1، B N }', 'rel R { A 1, B N }');
  });

  it('closes strings, comments and blocks', () => {
    expectFix('entity "Big A\n', 'entity "Big A"\n');
    expectFix('/* note\nentity A', '/* note */\nentity A');
    expectFix('entity A {\n  a\n', 'entity A {\n  a\n}\n');
    expectFix('  entity A {\n    a', '  entity A {\n    a\n  }');
    expectFix('entity A { a, b\n\nentity B { c }', 'entity A { a, b }\n\nentity B { c }');
    expectFix(
      'entity A {\n  name { first, last\n  age\n}',
      'entity A {\n  name { first, last }\n  age\n}',
    );
    expectFix('aggregate S { rel R { A, B }\nentity X', 'aggregate S { rel R { A, B } }\nentity X');
  });

  it('moves a second declaration to its own line', () => {
    expectFix('rel R { A, B } entity C', 'rel R { A, B }\nentity C');
  });
});
