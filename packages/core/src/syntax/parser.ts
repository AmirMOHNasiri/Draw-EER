import type {
  AggregateDecl,
  AttributeDecl,
  AttributeItem,
  Cardinality,
  CategoryDecl,
  Disjointness,
  EntityDecl,
  KeyGroupDecl,
  KeyKind,
  Name,
  Participant,
  Participation,
  PartOfDecl,
  Position,
  Range,
  RelationshipDecl,
  ShowDecl,
  SourceFile,
  SpecializeDecl,
  Statement,
} from './ast';
import { suggest, type ParseError } from './errors';
import { lex, type Token } from './lexer';

export interface ParseResult {
  file: SourceFile;
  /** Syntax errors, in source order. An empty array means the file is valid. */
  errors: ParseError[];
}

/**
 * Parses `.eer` source text.
 *
 * Parsing never throws. On a syntax error the parser records it, skips ahead
 * to a safe point (the end of the item or statement) and carries on, so every
 * error in the file is reported at once and everything else is still in the AST.
 */
export function parse(source: string): ParseResult {
  const { tokens, errors } = lex(source);
  const file = new Parser(tokens, errors).parseFile();
  errors.sort((a, b) => a.range.start.offset - b.range.start.offset);
  return { file, errors };
}

// ---------------------------------------------------------------------------
// Keywords
//
// Keywords are contextual: they only mean something in the position where
// they are expected, so `key` or `total` can still be used as names elsewhere.
// A quoted name is never treated as a keyword.
// ---------------------------------------------------------------------------

const STATEMENT_KEYWORDS = [
  'entity',
  'weak',
  'rel',
  'identifying',
  'specialize',
  'category',
  'partof',
  'aggregate',
  'show',
];

/** Words from other notations that people are likely to try. */
const STATEMENT_ALIASES = new Map([
  ['relationship', 'rel'],
  ['relation', 'rel'],
  ['specialise', 'specialize'],
  ['specialization', 'specialize'],
  ['isa', 'specialize'],
  ['union', 'category'],
  ['aggregation', 'aggregate'],
  ['has', 'partof'],
]);

const KEY_FLAGS = new Map<string, KeyKind>([
  ['key', 'primary'],
  ['key2', 'secondary'],
  ['partial', 'partial'],
]);
const ATTRIBUTE_FLAGS = ['key', 'key2', 'partial', 'multi', 'derived'];
const SPECIALIZE_FLAGS = ['disjoint', 'overlapping', 'total', 'partial'];
const PARTICIPATION_FLAGS = ['total', 'partial'];

const ATTRIBUTE_FLAG_LIST = 'key, key2, partial, multi or derived';

class Parser {
  private index = 0;
  /** How many `{ }` blocks enclose the item being parsed. */
  private blockDepth = 0;
  /** End of the last consumed token other than a newline; used to close node ranges. */
  private lastEnd: Position;

  constructor(
    private readonly tokens: Token[],
    private readonly errors: ParseError[],
  ) {
    this.lastEnd = this.current.range.start;
  }

  // -------------------------------------------------------------------------
  // File and statements
  // -------------------------------------------------------------------------

  parseFile(): SourceFile {
    const start = this.current.range.start;
    const statements: Statement[] = [];
    this.skipNewlines();
    while (!this.is('eof')) {
      const statement = this.parseStatement();
      if (statement) {
        statements.push(statement);
        this.expectEndOfStatement(statement);
      }
      this.skipNewlines();
    }
    return { statements, range: { start, end: this.current.range.end } };
  }

  private parseStatement(): Statement | null {
    const token = this.current;
    const word = this.keywordText(token);

    switch (word) {
      case 'entity':
        return this.parseEntity(token.range.start, false);
      case 'rel':
        return this.parseRelationship(token.range.start, false);
      case 'weak':
      case 'identifying': {
        const next = word === 'weak' ? 'entity' : 'rel';
        this.advance();
        if (!this.isWord(next)) {
          this.error(
            `Expected '${next}' after '${word}', but found ${describe(this.current)}.`,
            this.current.range,
          );
          this.recoverToNextStatement();
          return null;
        }
        return next === 'entity'
          ? this.parseEntity(token.range.start, true)
          : this.parseRelationship(token.range.start, true);
      }
      case 'specialize':
        return this.parseSpecialize();
      case 'category':
        return this.parseCategory();
      case 'partof':
        return this.parsePartOf();
      case 'aggregate':
        return this.parseAggregate();
      case 'show':
        return this.parseShow();
    }

    if (token.kind === 'ident' && !token.invalid) {
      const hint =
        STATEMENT_ALIASES.get(token.text.toLowerCase()) ?? suggest(token.text, STATEMENT_KEYWORDS);
      this.error(
        hint
          ? `Unknown declaration '${token.text}'. Did you mean '${hint}'?`
          : `Expected a declaration such as 'entity', 'rel' or 'specialize', but found '${token.text}'.`,
        token.range,
      );
    } else if (token.kind !== 'ident') {
      // Invalid words were already reported by the lexer.
      this.error(
        `Expected a declaration such as 'entity', 'rel' or 'specialize', but found ${describe(token)}.`,
        token.range,
      );
    }
    this.recoverToNextStatement();
    return null;
  }

  /** Each statement must end its line (or the file). */
  private expectEndOfStatement(statement: Statement): void {
    if (this.is('newline') || this.is('eof') || this.atDeclarationStart()) return;
    let message = `Expected a new line after ${describeStatement(statement)}, but found ${describe(this.current)}.`;
    if (statement.kind === 'entity' && statement.attributes.length === 0) {
      message += ` Attributes go inside braces: entity ${statement.name.text} { ... }.`;
    }
    this.error(message, this.current.range);
    this.recoverToNextStatement();
  }

  // -------------------------------------------------------------------------
  // Entities and attributes
  // -------------------------------------------------------------------------

  /** `[weak] entity Name [inherits A, B] [{ attributes }]`; the current token is `entity`. */
  private parseEntity(start: Position, weak: boolean): EntityDecl | null {
    this.advance();
    const name = this.expectName("a name after 'entity'");
    if (!name) {
      this.recoverToNextStatement();
      return null;
    }

    let inherits: Name[] = [];
    if (this.isWord('inherits')) {
      this.advance();
      inherits = this.parseInlineNames("a supertype name after 'inherits'");
    }

    let attributes: AttributeItem[] = [];
    if (this.atBlockStart()) {
      attributes = this.parseAttributeBlock(`entity "${name.text}"`);
    }
    return { kind: 'entity', weak, name, inherits, attributes, range: this.rangeFrom(start) };
  }

  /** `{ item, item ... }`; the current token is `{`. */
  private parseAttributeBlock(owner: string): AttributeItem[] {
    const items: AttributeItem[] = [];
    this.parseBlock(owner, 'attributes', () => {
      const item = this.parseAttributeItem();
      if (item) items.push(item);
      return item !== null;
    });
    return items;
  }

  private parseAttributeItem(): AttributeItem | null {
    if (this.is('(')) return this.parseKeyGroup();

    const name = this.expectName('an attribute name');
    if (!name) return null;

    let key: KeyKind | null = null;
    let multivalued = false;
    let derived = false;

    const missingColon = !this.is(':') && this.isFlagWord(ATTRIBUTE_FLAGS);
    if (this.is(':') || missingColon) {
      if (missingColon) {
        this.error(
          `Missing ':' before '${this.current.text}'. Write it as ${name.text}: ${this.current.text}.`,
          this.current.range,
        );
      }
      const colon = missingColon ? null : this.advance();
      let flagCount = 0;
      while (this.is('ident')) {
        const token = this.advance();
        flagCount++;
        const word = token.invalid ? '' : token.text;
        const keyKind = KEY_FLAGS.get(word);
        if (keyKind) {
          if (key !== null) {
            this.error(
              key === keyKind
                ? `Duplicate flag '${word}'.`
                : 'An attribute can have only one of key, key2 or partial.',
              token.range,
            );
          } else {
            key = keyKind;
          }
        } else if (word === 'multi' || word === 'derived') {
          const already = word === 'multi' ? multivalued : derived;
          if (already) this.error(`Duplicate flag '${word}'.`, token.range);
          if (word === 'multi') multivalued = true;
          else derived = true;
        } else if (word === 'composite') {
          this.error(
            `'composite' is not needed: braces make an attribute composite, like ${name.text} { first, last }.`,
            token.range,
          );
        } else if (!token.invalid) {
          const hint = suggest(word, ATTRIBUTE_FLAGS);
          this.error(
            hint
              ? `Unknown attribute flag '${word}'. Did you mean '${hint}'?`
              : `Unknown attribute flag '${word}'. Expected ${ATTRIBUTE_FLAG_LIST}.`,
            token.range,
          );
        }
      }
      if (colon && flagCount === 0 && !this.is('{')) {
        this.error(`Expected an attribute flag after ':' (${ATTRIBUTE_FLAG_LIST}).`, colon.range);
      }
    }

    let children: AttributeItem[] = [];
    if (this.is('{')) {
      children = this.parseAttributeBlock(`composite attribute "${name.text}"`);
    }

    return {
      kind: 'attribute',
      name,
      key,
      multivalued,
      derived,
      children,
      range: this.rangeFrom(name.range.start),
    } satisfies AttributeDecl;
  }

  /** `(a, b): key`; the current token is `(`. */
  private parseKeyGroup(): KeyGroupDecl | null {
    const start = this.advance().range.start;
    const names: Name[] = [];
    for (;;) {
      const name = this.expectName("an attribute name inside '( )'");
      if (!name) return this.abandonParenthesized();
      names.push(name);
      if (this.is(',')) {
        this.advance();
        continue;
      }
      if (this.is(')')) {
        this.advance();
        break;
      }
      this.error(
        `Expected ',' or ')' in the key group, but found ${describe(this.current)}.`,
        this.current.range,
      );
      return this.abandonParenthesized();
    }

    const example = `(${names.map((n) => n.text).join(', ')}): key`;
    if (!this.is(':')) {
      this.error(
        `Expected ':' and a key kind after the key group, like ${example}.`,
        this.current.range,
      );
      return null;
    }
    this.advance();

    const token = this.current;
    const key = token.kind === 'ident' ? KEY_FLAGS.get(token.text) : undefined;
    if (!key) {
      const hint = token.kind === 'ident' ? suggest(token.text, [...KEY_FLAGS.keys()]) : undefined;
      this.error(
        hint
          ? `Unknown key kind '${token.text}'. Did you mean '${hint}'?`
          : `Expected a key kind (key, key2 or partial) after the key group, like ${example}.`,
        token.range,
      );
      if (token.kind === 'ident') this.advance();
      return null;
    }
    this.advance();
    return { kind: 'keyGroup', names, key, range: this.rangeFrom(start) };
  }

  // -------------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------------

  /** `[identifying] rel Name { participants, attrs { } }`; the current token is `rel`. */
  private parseRelationship(start: Position, identifying: boolean): RelationshipDecl | null {
    this.advance();
    const name = this.expectName("a name after 'rel'");
    if (!name) {
      this.recoverToNextStatement();
      return null;
    }

    const participants: Participant[] = [];
    const attributes: AttributeItem[] = [];
    if (!this.atBlockStart()) {
      this.error(
        `Expected '{' with the participants of relationship "${name.text}", like rel ${name.text} { A, B }.`,
        this.current.range,
      );
      this.recoverToNextStatement();
    } else {
      this.parseBlock(`relationship "${name.text}"`, 'participants', () => {
        if (this.isWord('attrs') && this.peek().kind === '{') {
          this.advance();
          attributes.push(...this.parseAttributeBlock(`attrs of relationship "${name.text}"`));
          return true;
        }
        const participant = this.parseParticipant();
        if (participant) participants.push(participant);
        return participant !== null;
      });
    }

    return {
      kind: 'relationship',
      identifying,
      name,
      participants,
      attributes,
      range: this.rangeFrom(start),
    };
  }

  /** `Entity [cardinality] [total|partial] [as role]`, modifiers in any order. */
  private parseParticipant(): Participant | null {
    const name = this.expectName('an entity name');
    if (!name) return null;

    let cardinality: Cardinality | null = null;
    let participation: Participation | null = null;
    let role: Name | null = null;
    const duplicate = (what: string, range: Range) =>
      this.error(`${what} is given twice for participant "${name.text}".`, range);

    for (;;) {
      const token = this.current;
      const word = this.keywordText(token);

      if (token.kind === '(') {
        const minMax = this.parseMinMax();
        if (minMax) {
          if (cardinality) duplicate('Cardinality', minMax.range);
          else cardinality = minMax;
        }
      } else if (isCardinalityLabel(token)) {
        this.advance();
        if (cardinality) duplicate('Cardinality', token.range);
        else cardinality = { kind: 'ratio', label: token.text, range: token.range };
      } else if (word === 'total' || word === 'partial') {
        this.advance();
        if (participation) duplicate('Participation (total or partial)', token.range);
        else participation = word;
      } else if (word === 'as') {
        this.advance();
        const roleName = this.expectName("a role name after 'as'");
        if (!roleName) break;
        if (role) duplicate('Role', roleName.range);
        else role = roleName;
      } else if (token.kind === 'ident' && !token.invalid) {
        // Any other word: most likely a typo or a missing separator.
        this.advance();
        const hint = suggest(token.text, [...PARTICIPATION_FLAGS, 'as']);
        this.error(
          hint
            ? `Unknown word '${token.text}' after participant "${name.text}". Did you mean '${hint}'?`
            : `Unexpected '${token.text}' after participant "${name.text}". Put ',' or a new line between participants. A cardinality is a number, a single letter or *, like 1, N or (0,N).`,
          token.range,
        );
      } else {
        break;
      }
    }

    return {
      name,
      cardinality,
      participation: participation ?? 'partial',
      role,
      range: this.rangeFrom(name.range.start),
    };
  }

  /** `(min, max)`; the current token is `(`. */
  private parseMinMax(): Cardinality | null {
    const start = this.advance().range.start;
    const min = this.current;
    const comma = this.peek(1);
    const max = this.peek(2);
    const close = this.peek(3);
    if (
      isCardinalityLabel(min) &&
      comma.kind === ',' &&
      isCardinalityLabel(max) &&
      close.kind === ')'
    ) {
      this.index += 3;
      this.advance();
      return { kind: 'minMax', min: min.text, max: max.text, range: this.rangeFrom(start) };
    }
    this.error(
      'Expected a (min,max) cardinality like (0,N) or (1,*). Each bound is a number, a single letter or *.',
      { start, end: this.current.range.end },
    );
    this.abandonParenthesized();
    return null;
  }

  // -------------------------------------------------------------------------
  // EER constructs
  // -------------------------------------------------------------------------

  /** `specialize Super [disjoint|overlapping] [total|partial] { Sub, ... }` */
  private parseSpecialize(): SpecializeDecl | null {
    const start = this.advance().range.start;
    const supertype = this.expectName("the supertype name after 'specialize'");
    if (!supertype) {
      this.recoverToNextStatement();
      return null;
    }

    let disjointness: Disjointness | null = null;
    let participation: Participation | null = null;
    while (this.is('ident')) {
      const token = this.advance();
      const word = token.invalid ? '' : token.text;
      if (word === 'disjoint' || word === 'overlapping') {
        if (disjointness === word) this.error(`Duplicate '${word}'.`, token.range);
        else if (disjointness)
          this.error("Use either 'disjoint' or 'overlapping', not both.", token.range);
        else disjointness = word;
      } else if (word === 'total' || word === 'partial') {
        if (participation === word) this.error(`Duplicate '${word}'.`, token.range);
        else if (participation)
          this.error("Use either 'total' or 'partial', not both.", token.range);
        else participation = word;
      } else if (!token.invalid) {
        this.unknownFlag(token, SPECIALIZE_FLAGS, 'disjoint, overlapping, total or partial');
      }
    }

    const example = `specialize ${supertype.text} disjoint total { A, B }`;
    const subtypes = this.parseNameBlock(
      `specialization of "${supertype.text}"`,
      'subtypes',
      `Expected '{' with the subtypes of "${supertype.text}", like ${example}.`,
    );
    return {
      kind: 'specialize',
      supertype,
      disjointness,
      participation: participation ?? 'partial',
      subtypes,
      range: this.rangeFrom(start),
    };
  }

  /** `category Name [total|partial] { Super, ... }` */
  private parseCategory(): CategoryDecl | null {
    const start = this.advance().range.start;
    const name = this.expectName("a name after 'category'");
    if (!name) {
      this.recoverToNextStatement();
      return null;
    }
    const participation = this.parseParticipationFlags();
    const superclasses = this.parseNameBlock(
      `category "${name.text}"`,
      'superclasses',
      `Expected '{' with the superclasses of category "${name.text}", like category ${name.text} total { A, B }.`,
    );
    return { kind: 'category', name, participation, superclasses, range: this.rangeFrom(start) };
  }

  /** `partof Whole [as "Label"] { Part, ... }` */
  private parsePartOf(): PartOfDecl | null {
    const start = this.advance().range.start;
    const whole = this.expectName("the name of the whole after 'partof'");
    if (!whole) {
      this.recoverToNextStatement();
      return null;
    }
    let label: Name | null = null;
    if (this.isWord('as')) {
      this.advance();
      label = this.expectName("a label after 'as'");
    }
    const parts = this.parseNameBlock(
      `partof "${whole.text}"`,
      'parts',
      `Expected '{' with the parts of "${whole.text}", like partof ${whole.text} { A, B }.`,
    );
    return { kind: 'partOf', whole, label, parts, range: this.rangeFrom(start) };
  }

  /** `aggregate Name { rel ... }`: exactly one relationship inside. */
  private parseAggregate(): AggregateDecl | null {
    const start = this.advance().range.start;
    const name = this.expectName("a name after 'aggregate'");
    if (!name) {
      this.recoverToNextStatement();
      return null;
    }
    const example = `aggregate ${name.text} { rel R { A, B } }`;
    if (!this.atBlockStart()) {
      this.error(`Expected '{' with a relationship inside, like ${example}.`, this.current.range);
      this.recoverToNextStatement();
      return { kind: 'aggregate', name, relationship: null, range: this.rangeFrom(start) };
    }

    const open = this.advance();
    let relationship: RelationshipDecl | null = null;
    let reported = false;
    for (;;) {
      while (this.isSeparator()) this.advance();
      if (this.is('}')) {
        this.advance();
        break;
      }
      const token = this.current;
      if (this.isWord('rel') || (this.isWord('identifying') && this.isWord('rel', this.peek()))) {
        const identifying = this.isWord('identifying');
        if (identifying) this.advance();
        const rel = this.parseRelationship(token.range.start, identifying);
        if (rel && relationship) {
          this.error(
            `An aggregate contains exactly one relationship. Move "${rel.name.text}" outside aggregate "${name.text}".`,
            rel.name.range,
          );
          reported = true;
        } else if (rel) {
          relationship = rel;
        }
        continue;
      }
      if (this.is('eof') || this.atDeclarationStart()) {
        this.error(
          `Missing '}' to close aggregate "${name.text}" (opened on line ${open.range.start.line + 1}).`,
          open.range,
        );
        reported = true;
        break;
      }
      this.error(`Expected 'rel' inside aggregate "${name.text}", like ${example}.`, token.range);
      reported = true;
      this.recoverToItemEnd();
    }

    if (!relationship && !reported) {
      this.error(
        `Aggregate "${name.text}" needs a relationship inside, like ${example}.`,
        name.range,
      );
    }
    return { kind: 'aggregate', name, relationship, range: this.rangeFrom(start) };
  }

  /** `show Entity again [as Alias]` */
  private parseShow(): ShowDecl | null {
    const start = this.advance().range.start;
    const entity = this.expectName("the entity name after 'show'");
    if (!entity) {
      this.recoverToNextStatement();
      return null;
    }
    if (!this.isWord('again')) {
      this.error(
        `Expected 'again' after show ${entity.text}, like show ${entity.text} again as ${entity.text}2.`,
        this.current.range,
      );
      return { kind: 'show', entity, alias: null, range: this.rangeFrom(start) };
    }
    this.advance();
    let alias: Name | null = null;
    if (this.isWord('as')) {
      this.advance();
      alias = this.expectName("a name for the copy after 'as'");
    }
    return { kind: 'show', entity, alias, range: this.rangeFrom(start) };
  }

  // -------------------------------------------------------------------------
  // Shared pieces
  // -------------------------------------------------------------------------

  /**
   * Parses the items of a `{ }` block; the current token must be `{` (or
   * newlines followed by `{`, see `atBlockStart`). Items are separated by
   * newlines or commas; blank lines and trailing commas are fine.
   *
   * `parseItem` parses one item and returns false if it failed (after
   * reporting the error itself).
   */
  private parseBlock(owner: string, itemNoun: string, parseItem: () => boolean): void {
    this.skipNewlines();
    const openIndex = this.index;
    const open = this.advance();
    for (;;) {
      while (this.isSeparator()) this.advance();
      if (this.is('}')) {
        if (this.blockDepth > 0 && this.closesOuterBlock(openIndex)) {
          this.error(
            `Missing '}' to close ${owner} (opened on line ${open.range.start.line + 1}).`,
            open.range,
          );
          return;
        }
        this.advance();
        return;
      }
      if (this.is('eof') || this.atDeclarationStart()) {
        this.error(
          `Missing '}' to close ${owner} (opened on line ${open.range.start.line + 1}).`,
          open.range,
        );
        return;
      }
      this.blockDepth++;
      const ok = parseItem();
      this.blockDepth--;
      if (!this.isSeparator() && !this.is('}') && !this.is('eof') && !this.atDeclarationStart()) {
        if (ok) {
          this.error(
            `Expected ',' or a new line between ${itemNoun}, but found ${describe(this.current)}.`,
            this.current.range,
          );
        }
        this.recoverToItemEnd();
      }
    }
  }

  /** `{ Name, Name ... }` used by specialize, category and partof. */
  private parseNameBlock(owner: string, itemNoun: string, missingBraceMessage: string): Name[] {
    const names: Name[] = [];
    if (!this.atBlockStart()) {
      this.error(missingBraceMessage, this.current.range);
      this.recoverToNextStatement();
      return names;
    }
    this.parseBlock(owner, itemNoun, () => {
      const name = this.expectName(`a name in the list of ${itemNoun}`);
      if (name) names.push(name);
      return name !== null;
    });
    return names;
  }

  /** `A, B, C` on one line (used by `inherits`). */
  private parseInlineNames(what: string): Name[] {
    const names: Name[] = [];
    for (;;) {
      const name = this.expectName(what);
      if (!name) break;
      names.push(name);
      if (!this.is(',')) break;
      this.advance();
    }
    return names;
  }

  /** Optional `total` or `partial` (used by category). */
  private parseParticipationFlags(): Participation {
    let participation: Participation | null = null;
    while (this.is('ident')) {
      const token = this.advance();
      const word = token.invalid ? '' : token.text;
      if (word === 'total' || word === 'partial') {
        if (participation === word) this.error(`Duplicate '${word}'.`, token.range);
        else if (participation)
          this.error("Use either 'total' or 'partial', not both.", token.range);
        else participation = word;
      } else if (!token.invalid) {
        this.unknownFlag(token, PARTICIPATION_FLAGS, 'total or partial');
      }
    }
    return participation ?? 'partial';
  }

  private unknownFlag(token: Token, candidates: string[], expected: string): void {
    const hint = suggest(token.text, candidates);
    this.error(
      hint
        ? `Unknown word '${token.text}'. Did you mean '${hint}'?`
        : `Unexpected '${token.text}'. Expected ${expected}, or '{'.`,
      token.range,
    );
  }

  private expectName(what: string): Name | null {
    const token = this.current;
    if (token.kind !== 'ident' && token.kind !== 'string') {
      this.error(`Expected ${what}, but found ${describe(token)}.`, token.range);
      return null;
    }
    this.advance();
    if (token.kind === 'string' && token.text.trim() === '') {
      this.error('Names cannot be empty.', token.range);
    }
    return { text: token.text, quoted: token.kind === 'string', range: token.range };
  }

  // -------------------------------------------------------------------------
  // Error recovery
  // -------------------------------------------------------------------------

  /**
   * True when the current token starts a new top-level declaration at the
   * beginning of a line, such as `entity Foo`. Used to notice a missing `}`
   * early instead of swallowing the rest of the file into one block.
   */
  private atDeclarationStart(): boolean {
    const token = this.current;
    const previous = this.tokens[this.index - 1];
    if (previous && previous.kind !== 'newline') return false;
    const word = this.keywordText(token);
    const next = this.peek();
    switch (word) {
      case 'weak':
        return this.isWord('entity', next);
      case 'identifying':
        return this.isWord('rel', next);
      case 'entity':
      case 'rel':
      case 'specialize':
      case 'category':
      case 'partof':
      case 'aggregate':
      case 'show':
        return next.kind === 'ident' || next.kind === 'string';
      default:
        return false;
    }
  }

  /**
   * Indentation check for a nested block: a `}` that starts its line and is
   * indented less than the line where this block opened most likely belongs
   * to an outer block. For example, the last `}` below closes the entity, so
   * the error belongs on `name`, which was never closed:
   *
   *     entity A {
   *       name { first, last
   *       age
   *     }
   */
  private closesOuterBlock(openIndex: number): boolean {
    const close = this.current;
    if (this.tokens[this.index - 1]?.kind !== 'newline') return false;
    return close.range.start.column < this.lineIndent(openIndex);
  }

  /** Column of the first token on the line of the token at `index`. */
  private lineIndent(index: number): number {
    let first = index;
    while (first > 0 && this.tokens[first - 1]!.kind !== 'newline') first--;
    return this.tokens[first]!.range.start.column;
  }

  /** Skips to the end of the current line, past any nested braces. */
  private recoverToNextStatement(): void {
    let depth = 0;
    while (!this.is('eof')) {
      if (this.atDeclarationStart()) return;
      const kind = this.current.kind;
      if (kind === 'newline' && depth === 0) return;
      if (kind === '{') depth++;
      if (kind === '}') depth = Math.max(0, depth - 1);
      this.advance();
    }
  }

  /** Skips to the next separator or closing `}` of the current block. */
  private recoverToItemEnd(): void {
    let depth = 0;
    while (!this.is('eof')) {
      if (this.atDeclarationStart()) return;
      const kind = this.current.kind;
      if (depth === 0 && (kind === 'newline' || kind === ',' || kind === '}')) return;
      if (kind === '{' || kind === '(') depth++;
      if (kind === '}' || kind === ')') depth = Math.max(0, depth - 1);
      this.advance();
    }
  }

  /** Skips past the closing `)` of a broken group, stopping at the end of the line. */
  private abandonParenthesized(): null {
    while (!this.is('eof') && !this.is('newline') && !this.is('}')) {
      if (this.advance().kind === ')') break;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private get current(): Token {
    return this.tokens[this.index]!;
  }

  private peek(ahead = 1): Token {
    return this.tokens[Math.min(this.index + ahead, this.tokens.length - 1)]!;
  }

  private advance(): Token {
    const token = this.current;
    if (token.kind !== 'eof') this.index++;
    if (token.kind !== 'newline') this.lastEnd = token.range.end;
    return token;
  }

  private is(kind: Token['kind']): boolean {
    return this.current.kind === kind;
  }

  /** The keyword a token spells, if it is a bare (unquoted, valid) identifier. */
  private keywordText(token: Token): string | undefined {
    return token.kind === 'ident' && !token.invalid ? token.text : undefined;
  }

  private isWord(word: string, token: Token = this.current): boolean {
    return this.keywordText(token) === word;
  }

  private isFlagWord(words: string[]): boolean {
    const word = this.keywordText(this.current);
    return word !== undefined && words.includes(word);
  }

  private isSeparator(): boolean {
    return this.is('newline') || this.is(',');
  }

  private skipNewlines(): void {
    while (this.is('newline')) this.advance();
  }

  /** True if a `{` follows, possibly on the next line. Moves to the `{` if so. */
  private atBlockStart(): boolean {
    let ahead = 0;
    while (this.peek(ahead).kind === 'newline') ahead++;
    if (this.peek(ahead).kind !== '{') return false;
    this.skipNewlines();
    return true;
  }

  private rangeFrom(start: Position): Range {
    return { start, end: this.lastEnd };
  }

  private error(message: string, range: Range): void {
    // One error per position is enough; later ones are usually follow-on noise.
    if (this.errors.some((e) => e.range.start.offset === range.start.offset)) return;
    this.errors.push({ message, range });
  }
}

/** A cardinality label: a number, `*` or a single letter (`N`, `M`, `ن`). */
function isCardinalityLabel(token: Token): boolean {
  if (token.kind === 'number' || token.kind === '*') return true;
  return token.kind === 'ident' && !token.invalid && /^\p{L}$/u.test(token.text);
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'newline':
      return 'the end of the line';
    case 'eof':
      return 'the end of the file';
    case 'string':
      return `"${token.text}"`;
    default:
      return `'${token.text}'`;
  }
}

function describeStatement(statement: Statement): string {
  switch (statement.kind) {
    case 'entity':
      return `entity "${statement.name.text}"`;
    case 'relationship':
      return `relationship "${statement.name.text}"`;
    case 'specialize':
      return `the specialization of "${statement.supertype.text}"`;
    case 'category':
      return `category "${statement.name.text}"`;
    case 'partOf':
      return `partof "${statement.whole.text}"`;
    case 'aggregate':
      return `aggregate "${statement.name.text}"`;
    case 'show':
      return `show "${statement.entity.text}"`;
  }
}
