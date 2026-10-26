import type { Position, Range } from './ast';
import type { ParseError } from './errors';

export type TokenKind =
  'ident' | 'string' | 'number' | '{' | '}' | '(' | ')' | ',' | ':' | '*' | 'newline' | 'eof';

export interface Token {
  kind: TokenKind;
  /**
   * The token's value. For strings this is the unquoted, unescaped text;
   * for everything else it is the source text.
   */
  text: string;
  range: Range;
  /**
   * Set on a word that is not a valid identifier, such as `سال-ترم` or `S#`.
   * The lexer has already reported it, and the parser treats it as a name so
   * that the rest of the diagram still renders.
   */
  invalid?: true;
}

const PUNCTUATION = new Set(['{', '}', '(', ')', ',', ':', '*']);

/** Identifier: starts with a letter or `_`; then letters, marks, digits, `_`, ZWNJ or ZWJ. */
const IDENT_RE = /^[\p{L}_][\p{L}\p{M}\p{Nd}\p{Pc}\u200C\u200D]*$/u;
/** Any decimal digits, including Persian ones such as `۱`. */
const NUMBER_RE = /^\p{Nd}+$/u;
/**
 * Characters treated as plain spacing between tokens. Besides ordinary spaces
 * this covers the byte order mark and the invisible direction marks (LRM/RLM)
 * that some editors insert into right-to-left text.
 */
const SPACE_RE = /[\p{Zs}\t\uFEFF\u200E\u200F]/u;
/**
 * Zero-width (non-)joiners are part of Persian words such as «پیش‌نیازی», so they
 * never end a word. A stray one between tokens is skipped like a space.
 */
const JOINER_RE = /[\u200C\u200D]/u;

export interface LexResult {
  tokens: Token[];
  errors: ParseError[];
}

/**
 * Splits source text into tokens. Newlines are tokens because they separate
 * items inside `{ }` blocks; other whitespace and comments are skipped.
 */
export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const errors: ParseError[] = [];

  let offset = 0;
  let line = 0;
  let lineStart = 0;

  const position = (at: number): Position => ({ line, column: at - lineStart, offset: at });
  const push = (kind: TokenKind, text: string, start: Position, extra?: { invalid: true }) => {
    tokens.push({ kind, text, range: { start, end: position(offset) }, ...extra });
  };
  /** Moves past a line break starting at `offset`, updating line bookkeeping. */
  const consumeLineBreak = () => {
    offset += source[offset] === '\r' && source[offset + 1] === '\n' ? 2 : 1;
    line++;
    lineStart = offset;
  };

  while (offset < source.length) {
    const ch = source[offset]!;
    const start = position(offset);

    if (ch === '\n' || ch === '\r') {
      consumeLineBreak();
      tokens.push({ kind: 'newline', text: '\n', range: { start, end: start } });
      continue;
    }
    if (SPACE_RE.test(ch) || JOINER_RE.test(ch)) {
      offset++;
      continue;
    }

    // Comments
    if (ch === '/' && source[offset + 1] === '/') {
      while (offset < source.length && source[offset] !== '\n' && source[offset] !== '\r') {
        offset++;
      }
      continue;
    }
    if (ch === '/' && source[offset + 1] === '*') {
      offset += 2;
      let spansLines = false;
      let closed = false;
      while (offset < source.length) {
        if (source[offset] === '*' && source[offset + 1] === '/') {
          offset += 2;
          closed = true;
          break;
        }
        if (source[offset] === '\n' || source[offset] === '\r') {
          consumeLineBreak();
          spansLines = true;
        } else {
          offset++;
        }
      }
      if (!closed) {
        errors.push({
          message: "Unterminated comment: add '*/' to close it.",
          range: { start, end: { ...start, column: start.column + 2, offset: start.offset + 2 } },
        });
      }
      // A comment that spans lines still separates the lines around it.
      if (spansLines) push('newline', '\n', position(offset));
      continue;
    }

    if (PUNCTUATION.has(ch)) {
      offset++;
      push(ch as TokenKind, ch, start);
      continue;
    }

    if (ch === '"') {
      offset++;
      let value = '';
      let closed = false;
      while (offset < source.length) {
        const c = source[offset]!;
        if (c === '"') {
          offset++;
          closed = true;
          break;
        }
        if (c === '\n' || c === '\r') break;
        if (c === '\\' && (source[offset + 1] === '"' || source[offset + 1] === '\\')) {
          value += source[offset + 1];
          offset += 2;
          continue;
        }
        value += c;
        offset++;
      }
      push('string', value, start);
      if (!closed) {
        errors.push({
          message: "Unterminated string: add a closing '\"' on the same line.",
          range: { start, end: position(offset) },
        });
      }
      continue;
    }

    // A "word": everything up to whitespace, punctuation, a quote or a comment.
    while (offset < source.length && !endsWord(source, offset)) {
      offset += codePointLength(source, offset);
    }
    const word = source.slice(start.offset, offset);
    if (NUMBER_RE.test(word)) {
      push('number', word, start);
    } else if (IDENT_RE.test(word)) {
      push('ident', word, start);
    } else {
      push('ident', word, start, { invalid: true });
      errors.push({ message: invalidWordMessage(word), range: { start, end: position(offset) } });
    }
  }

  push('eof', '', position(offset));
  return { tokens, errors };
}

function endsWord(source: string, offset: number): boolean {
  const ch = source[offset]!;
  if (ch === '\n' || ch === '\r' || ch === '"' || PUNCTUATION.has(ch) || SPACE_RE.test(ch)) {
    return true;
  }
  return ch === '/' && (source[offset + 1] === '/' || source[offset + 1] === '*');
}

function codePointLength(source: string, offset: number): number {
  return (source.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
}

function invalidWordMessage(word: string): string {
  if (/^\p{Nd}/u.test(word)) {
    return `'${word}' is not a valid name: names cannot start with a digit. Put it in double quotes, like "${word}".`;
  }
  return `'${word}' is not a valid name. Put names that contain spaces or symbols in double quotes, like "${word}".`;
}
