import { describe, expect, it } from 'vitest';
import { contextAt, suggestionsAt } from '../src/completion';

/** Suggestions where `|` is in the text (the `|` itself is removed). */
function at(text: string) {
  const offset = text.indexOf('|');
  return suggestionsAt(text.slice(0, offset) + text.slice(offset + 1), offset);
}
const labels = (text: string) => at(text).map((s) => s.label);

describe('completion', () => {
  it('offers statements at the top level', () => {
    expect(labels('|')).toEqual(
      expect.arrayContaining(['entity', 'weak entity', 'rel', 'specialize']),
    );
    expect(labels('entity A { a }\n|')).toContain('rel');
  });

  it('offers attribute flags after a colon, and nothing for a name', () => {
    expect(labels('entity A {\n  id: |\n}')).toEqual([
      'key',
      'key2',
      'partial',
      'multi',
      'derived',
    ]);
    expect(labels('entity A {\n  i|\n}')).toEqual([]);
    // Inside a composite attribute's braces, still inside the entity.
    expect(labels('entity A {\n  name { first: |')).toContain('key');
  });

  it('offers entities and attrs at the start of a participant, then cardinalities', () => {
    const source = 'entity Student\nentity "Course Unit"\nrel Takes {\n  |\n}';
    expect(labels(source)).toEqual(expect.arrayContaining(['Student', 'Course Unit', 'attrs']));
    expect(labels('entity Student\nrel Takes {\n  Student |\n}')).toEqual(
      expect.arrayContaining(['total', 'partial', 'as', '1', 'N']),
    );
    expect(labels('rel Takes { Student 1, |')).toContain('attrs');
  });

  it('quotes entity names that need it', () => {
    const course = at('entity "Course Unit"\nrel R { | }').find((s) => s.label === 'Course Unit');
    expect(course?.insertText).toBe('"Course Unit"');
    const persian = at('entity دانشجو\nrel R { | }').find((s) => s.label === 'دانشجو');
    expect(persian?.insertText).toBe('دانشجو');
  });

  it('offers entity names inside specialize, category and partof', () => {
    expect(labels('entity Person\nspecialize Person { |')).toContain('Person');
    expect(labels('entity Person\ncategory Owner { Person, |')).toContain('Person');
  });

  it('offers specialization options after the supertype', () => {
    expect(labels('specialize Employee |')).toEqual(
      expect.arrayContaining(['disjoint', 'overlapping', 'total']),
    );
  });

  it('ignores braces inside strings and comments', () => {
    expect(contextAt('entity A { "x{" // }\n  y: ', 31).block).toBe('entity');
    expect(contextAt('/* rel R { */\n', 14).block).toBe('top');
  });
});
