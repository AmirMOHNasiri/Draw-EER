import { describe, expect, it } from 'vitest';
import { parse } from '../src';
import { errorMessages } from './helpers';

/** Each case: source → the single expected error message. */
function expectError(source: string, message: string) {
  expect(errorMessages(source)).toEqual([message]);
}

describe('statement errors', () => {
  it('suggests the closest keyword for a typo', () => {
    expectError('entiy A', "Unknown declaration 'entiy'. Did you mean 'entity'?");
    expectError(
      'specialise A { B }',
      "Unknown declaration 'specialise'. Did you mean 'specialize'?",
    );
  });

  it('maps words from other notations to the DSL keyword', () => {
    expectError(
      'relationship R { A, B }',
      "Unknown declaration 'relationship'. Did you mean 'rel'?",
    );
    expectError('union U { A }', "Unknown declaration 'union'. Did you mean 'category'?");
  });

  it('explains what a declaration looks like', () => {
    expectError(
      'foo bar',
      "Expected a declaration such as 'entity', 'rel' or 'specialize', but found 'foo'.",
    );
    expectError(
      '}',
      "Expected a declaration such as 'entity', 'rel' or 'specialize', but found '}'.",
    );
  });

  it('reports missing names and keywords', () => {
    expectError('entity { a }', "Expected a name after 'entity', but found '{'.");
    expectError('weak A', "Expected 'entity' after 'weak', but found 'A'.");
    expectError('identifying R { A }', "Expected 'rel' after 'identifying', but found 'R'.");
    expectError('entity "" { a }', 'Names cannot be empty.');
  });

  it('requires each statement to end its line', () => {
    expectError(
      'entity A key',
      'Expected a new line after entity "A", but found \'key\'. Attributes go inside braces: entity A { ... }.',
    );
    expectError(
      'rel R { A, B } entity C',
      'Expected a new line after relationship "R", but found \'entity\'.',
    );
  });
});

describe('attribute errors', () => {
  it('suggests the closest flag', () => {
    expectError('entity A { id: mutli }', "Unknown attribute flag 'mutli'. Did you mean 'multi'?");
  });

  it('lists the valid flags when nothing is close', () => {
    expectError(
      'entity A { id: banana }',
      "Unknown attribute flag 'banana'. Expected key, key2, partial, multi or derived.",
    );
  });

  it('notices a missing colon', () => {
    expectError('entity A { id key }', "Missing ':' before 'key'. Write it as id: key.");
  });

  it('requires a flag after a colon', () => {
    expectError(
      'entity A { id: }',
      "Expected an attribute flag after ':' (key, key2, partial, multi or derived).",
    );
  });

  it("explains that 'composite' is implied by braces", () => {
    expectError(
      'entity A { name: composite { a, b } }',
      "'composite' is not needed: braces make an attribute composite, like name { first, last }.",
    );
  });

  it('rejects conflicting or repeated flags', () => {
    expectError(
      'entity A { id: key key2 }',
      'An attribute can have only one of key, key2 or partial.',
    );
    expectError('entity A { id: multi multi }', "Duplicate flag 'multi'.");
  });

  it('requires a separator between attributes', () => {
    expectError(
      'entity A { a b }',
      "Expected ',' or a new line between attributes, but found 'b'.",
    );
  });

  it('reports broken key groups', () => {
    expectError(
      'entity A { (a, b) }',
      "Expected ':' and a key kind after the key group, like (a, b): key.",
    );
    expectError('entity A { (a b): key }', "Expected ',' or ')' in the key group, but found 'b'.");
    expectError(
      'entity A { (a, b): primary }',
      'Expected a key kind (key, key2 or partial) after the key group, like (a, b): key.',
    );
    expectError('entity A { (a, b): ky }', "Unknown key kind 'ky'. Did you mean 'key'?");
    expectError('entity A { (): key }', "Expected an attribute name inside '( )', but found ')'.");
  });

  it('suggests quoting names with symbols', () => {
    expectError(
      'entity A { سال-ترم }',
      `'سال-ترم' is not a valid name. Put names that contain spaces or symbols in double quotes, like "سال-ترم".`,
    );
  });
});

describe('relationship errors', () => {
  it('requires a body', () => {
    expectError(
      'rel R',
      'Expected \'{\' with the participants of relationship "R", like rel R { A, B }.',
    );
  });

  it('reports repeated modifiers', () => {
    expectError('rel R { A N M }', 'Cardinality is given twice for participant "A".');
    expectError(
      'rel R { A 1 total partial }',
      'Participation (total or partial) is given twice for participant "A".',
    );
  });

  it('suggests total/partial for typos', () => {
    expectError(
      'rel R { A totl }',
      "Unknown word 'totl' after participant \"A\". Did you mean 'total'?",
    );
  });

  it('explains a missing separator between participants', () => {
    expectError(
      'rel R { Professor Course }',
      "Unexpected 'Course' after participant \"Professor\". Put ',' or a new line between participants. A cardinality is a number, a single letter or *, like 1, N or (0,N).",
    );
  });

  it('reports a malformed (min,max)', () => {
    const message =
      'Expected a (min,max) cardinality like (0,N) or (1,*). Each bound is a number, a single letter or *.';
    expectError('rel R { A (1 N) }', message);
    expectError('rel R { A (1,N, B }', message);
  });

  it('requires a role name after as', () => {
    expectError('rel R { A as }', "Expected a role name after 'as', but found '}'.");
  });
});

describe('EER errors', () => {
  it('rejects contradicting specialization flags', () => {
    expectError(
      'specialize E disjoint overlapping { A }',
      "Use either 'disjoint' or 'overlapping', not both.",
    );
    expectError('category C total partial { A }', "Use either 'total' or 'partial', not both.");
  });

  it('suggests specialization and category flags', () => {
    expectError('specialize E disjiont { A }', "Unknown word 'disjiont'. Did you mean 'disjoint'?");
    expectError('category C totl { A }', "Unknown word 'totl'. Did you mean 'total'?");
  });

  it('notices subtypes written without braces', () => {
    expect(errorMessages('specialize E total Male')).toEqual([
      "Unexpected 'Male'. Expected disjoint, overlapping, total or partial, or '{'.",
      'Expected \'{\' with the subtypes of "E", like specialize E disjoint total { A, B }.',
    ]);
  });

  it('requires exactly one relationship in an aggregate', () => {
    const example = 'like aggregate S { rel R { A, B } }.';
    expectError('aggregate S { }', `Aggregate "S" needs a relationship inside, ${example}`);
    expectError('aggregate S', `Expected '{' with a relationship inside, ${example}`);
    expectError('aggregate S { entity X }', `Expected 'rel' inside aggregate "S", ${example}`);
    expectError(
      'aggregate S { rel A { x }, rel B { y } }',
      'An aggregate contains exactly one relationship. Move "B" outside aggregate "S".',
    );
  });

  it('requires again after show', () => {
    expectError(
      'show Course',
      "Expected 'again' after show Course, like show Course again as Course2.",
    );
    expectError(
      'show Course again as',
      "Expected a name for the copy after 'as', but found the end of the file.",
    );
  });
});

describe('unclosed braces', () => {
  it('points at the opening brace when the file ends', () => {
    const { errors } = parse('entity A {\n  a\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('Missing \'}\' to close entity "A" (opened on line 1).');
    expect(errors[0]!.range.start).toMatchObject({ line: 0, column: 9 });
  });

  it('stops at the next declaration instead of swallowing the rest of the file', () => {
    const { errors, file } = parse('entity A {\n  a\n  b\n\nentity B { c }');
    expect(errors.map((e) => e.message)).toEqual([
      'Missing \'}\' to close entity "A" (opened on line 1).',
    ]);
    expect(
      file.statements.map((s) => s.kind === 'entity' && [s.name.text, s.attributes.length]),
    ).toEqual([
      ['A', 2],
      ['B', 1],
    ]);
  });

  it('uses indentation to blame the inner block that was left open', () => {
    const { errors } = parse('entity A {\n  name { first, last\n  age\n}');
    expect(errors.map((e) => e.message)).toEqual([
      'Missing \'}\' to close composite attribute "name" (opened on line 2).',
    ]);
    expect(errors[0]!.range.start).toMatchObject({ line: 1, column: 7 });
  });

  it('does not complain about closing braces at the same indentation', () => {
    expect(parse('entity A {\nname { first,\nlast\n}\n}').errors).toEqual([]);
    expect(parse('entity A {\n  name { first, last\n  }\n}').errors).toEqual([]);
  });
});

describe('recovery', () => {
  it('reports every error in the file and keeps the valid statements', () => {
    const { errors, file } = parse(
      ['entiy A { x }', 'entity B { y: mutli }', 'rel R { B totl }', 'entity C'].join('\n'),
    );
    expect(errors.map((e) => [e.range.start.line, e.message])).toEqual([
      [0, "Unknown declaration 'entiy'. Did you mean 'entity'?"],
      [1, "Unknown attribute flag 'mutli'. Did you mean 'multi'?"],
      [2, "Unknown word 'totl' after participant \"B\". Did you mean 'total'?"],
    ]);
    expect(file.statements.map((s) => s.kind)).toEqual(['entity', 'relationship', 'entity']);
  });

  it('keeps an attribute with an invalid name so the diagram still renders', () => {
    const { file } = parse('entity A { سال-ترم: key }');
    const entity = file.statements[0];
    expect(entity?.kind === 'entity' && entity.attributes[0]).toMatchObject({
      kind: 'attribute',
      name: { text: 'سال-ترم' },
      key: 'primary',
    });
  });

  it('never throws, even on garbage', () => {
    const inputs = [
      '{{{{',
      '}}}}',
      '(((',
      'entity',
      'rel R {',
      '"',
      '/*',
      ': : :',
      'entity A { ( }',
    ];
    for (const input of inputs) {
      expect(() => parse(input)).not.toThrow();
      expect(parse(input).errors.length).toBeGreaterThan(0);
    }
  });

  it('error ranges always lie inside the source', () => {
    const source = 'entity A {\n  (a, \n  b: mutli {\nrel R { X (1, }\nshow';
    for (const error of parse(source).errors) {
      expect(error.range.start.offset).toBeGreaterThanOrEqual(0);
      expect(error.range.end.offset).toBeLessThanOrEqual(source.length);
      expect(error.range.end.offset).toBeGreaterThanOrEqual(error.range.start.offset);
    }
  });
});
