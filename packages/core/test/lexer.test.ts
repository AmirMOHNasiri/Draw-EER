import { describe, expect, it } from 'vitest';
import { lex } from '../src/syntax/lexer';

const ZWNJ = '\u200C';

function kinds(source: string) {
  return lex(source).tokens.map((t) => (t.kind === 'ident' ? `ident:${t.text}` : t.kind));
}

describe('lexer', () => {
  it('splits punctuation, identifiers and numbers', () => {
    expect(kinds('entity A { x: key }')).toEqual([
      'ident:entity',
      'ident:A',
      '{',
      'ident:x',
      ':',
      'ident:key',
      '}',
      'eof',
    ]);
    expect(kinds('(0,*)')).toEqual(['(', 'number', ',', '*', ')', 'eof']);
  });

  it('emits newline tokens and skips comments', () => {
    expect(kinds('a // comment\nb /* c */ c')).toEqual([
      'ident:a',
      'newline',
      'ident:b',
      'ident:c',
      'eof',
    ]);
  });

  it('keeps a newline for a block comment that spans lines', () => {
    expect(kinds('a /* one\ntwo */ b')).toEqual(['ident:a', 'newline', 'ident:b', 'eof']);
  });

  it('accepts Persian identifiers, including the zero-width non-joiner', () => {
    const word = `پیش${ZWNJ}نیازی`;
    const { tokens, errors } = lex(`دانشجو ${word} کد_ملی`);
    expect(errors).toEqual([]);
    expect(tokens.map((t) => t.text)).toEqual(['دانشجو', word, 'کد_ملی', '']);
  });

  it('treats Persian digits as numbers', () => {
    expect(lex('۱ ۲۳').tokens.map((t) => t.kind)).toEqual(['number', 'number', 'eof']);
  });

  it('reads quoted names with escapes', () => {
    const { tokens, errors } = lex('"عضو خانواده" "say \\"hi\\"" "a\\\\b"');
    expect(errors).toEqual([]);
    expect(tokens.slice(0, 3).map((t) => [t.kind, t.text])).toEqual([
      ['string', 'عضو خانواده'],
      ['string', 'say "hi"'],
      ['string', 'a\\b'],
    ]);
  });

  it('ignores direction marks and a byte order mark', () => {
    expect(kinds('\uFEFFa\u200Fb')).toEqual(['ident:a', 'ident:b', 'eof']);
  });

  it('tracks 0-based line and column, with CRLF line endings', () => {
    const { tokens } = lex('a\r\n  bb\rc');
    const b = tokens.find((t) => t.text === 'bb')!;
    const c = tokens.find((t) => t.text === 'c')!;
    expect(b.range.start).toEqual({ line: 1, column: 2, offset: 5 });
    expect(b.range.end).toEqual({ line: 1, column: 4, offset: 7 });
    expect(c.range.start).toEqual({ line: 2, column: 0, offset: 8 });
  });

  it('measures columns in UTF-16 code units', () => {
    const { tokens } = lex('😀x y');
    // The emoji is two UTF-16 units, so "y" starts at column 4.
    expect(tokens[1]!.range.start.column).toBe(4);
  });

  it('reports invalid words once and still returns them as names', () => {
    const { tokens, errors } = lex('سال-ترم S#');
    expect(tokens[0]).toMatchObject({ kind: 'ident', text: 'سال-ترم', invalid: true });
    expect(tokens[1]).toMatchObject({ kind: 'ident', text: 'S#', invalid: true });
    expect(errors.map((e) => e.message)).toEqual([
      `'سال-ترم' is not a valid name. Put names that contain spaces or symbols in double quotes, like "سال-ترم".`,
      `'S#' is not a valid name. Put names that contain spaces or symbols in double quotes, like "S#".`,
    ]);
  });

  it('explains that names cannot start with a digit', () => {
    expect(lex('2nd').errors[0]!.message).toMatch(/cannot start with a digit/);
  });

  it('reports unterminated strings and comments', () => {
    expect(lex('"abc\nx').errors[0]!.message).toMatch(/Unterminated string/);
    expect(lex('/* abc').errors[0]!.message).toMatch(/Unterminated comment/);
  });
});
