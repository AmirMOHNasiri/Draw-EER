/**
 * Completion suggestions for `.eer` files, worked out from the text alone
 * (no VS Code types here, so this can be tested directly).
 *
 * The context is found with a light scan of the text before the cursor,
 * skipping strings and comments: which block the cursor is in (an entity's
 * attributes, a relationship's participants, `attrs { }`, …) and what is
 * already written in the current item. That is enough to offer the right
 * keywords, flags and entity names; it does not need a full parse.
 */
import { parse, type Statement } from '@draw-eer/core';

export type SuggestionKind = 'keyword' | 'entity' | 'snippet' | 'value';

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  /** Text to insert, in VS Code snippet syntax when `kind` is `snippet`. */
  insertText?: string;
  detail?: string;
}

/** Where the cursor is, as far as completion cares. */
export interface Context {
  /** The innermost block that decides what can be written: `none` inside a comment or string. */
  block: 'top' | 'entity' | 'relationship' | 'names' | 'aggregate' | 'none';
  /** The current item up to the cursor: since the last newline, brace or (inside a block) comma. */
  item: string;
}

/** A name being typed, matched like the language's word pattern. */
const TYPING_RE = /(?:[\p{L}_][\p{L}\p{M}\p{N}_\u200c\u200d]*|\p{N}+)$/u;
/** A finished word of the item: a quoted name (perhaps unclosed) or a run of non-spaces. */
const WORD_RE = /"(?:[^"\\]|\\.)*"?|[^\s"]+/g;

const STATEMENTS: Suggestion[] = [
  {
    label: 'entity',
    kind: 'snippet',
    insertText: 'entity ${1:Name} {\n\t${2:id}: key\n}',
    detail: 'Entity with attributes',
  },
  {
    label: 'weak entity',
    kind: 'snippet',
    insertText: 'weak entity ${1:Name} {\n\t${2:name}: partial\n}',
    detail: 'Weak entity with a partial key',
  },
  {
    label: 'rel',
    kind: 'snippet',
    insertText: 'rel ${1:Name} {\n\t${2:A} ${3:1}\n\t${4:B} ${5:N}\n}',
    detail: 'Relationship',
  },
  {
    label: 'identifying rel',
    kind: 'snippet',
    insertText: 'identifying rel ${1:Name} {\n\t${2:Owner} 1\n\t${3:Weak} N total\n}',
    detail: 'Identifying relationship of a weak entity',
  },
  {
    label: 'specialize',
    kind: 'snippet',
    insertText:
      'specialize ${1:Super} ${2|disjoint,overlapping|} ${3|total,partial|} { ${4:Sub1}, ${5:Sub2} }',
    detail: 'Specialization',
  },
  {
    label: 'category',
    kind: 'snippet',
    insertText: 'category ${1:Name} { ${2:A}, ${3:B} }',
    detail: 'Category (union type)',
  },
  {
    label: 'partof',
    kind: 'snippet',
    insertText: 'partof ${1:Whole} { ${2:Part} }',
    detail: 'Part-of',
  },
  {
    label: 'aggregate',
    kind: 'snippet',
    insertText: 'aggregate ${1:Name} {\n\trel ${2:Rel} { ${3:A}, ${4:B} }\n}',
    detail: 'Aggregation',
  },
  {
    label: 'show again',
    kind: 'snippet',
    insertText: 'show ${1:Entity} again as ${2:Alias}',
    detail: 'Draw a second copy of an entity',
  },
];

const ATTRIBUTE_FLAGS: Suggestion[] = [
  { label: 'key', kind: 'keyword', detail: 'Primary key (underlined)' },
  { label: 'key2', kind: 'keyword', detail: 'Secondary key (double underline)' },
  { label: 'partial', kind: 'keyword', detail: 'Partial key of a weak entity (dashed underline)' },
  { label: 'multi', kind: 'keyword', detail: 'Multi-valued (double ellipse)' },
  { label: 'derived', kind: 'keyword', detail: 'Derived (dashed ellipse)' },
];

const PARTICIPANT_WORDS: Suggestion[] = [
  { label: 'total', kind: 'keyword', detail: 'Total participation (double line)' },
  { label: 'partial', kind: 'keyword', detail: 'Partial participation (single line)' },
  { label: 'as', kind: 'keyword', detail: 'Role name on the line' },
  { label: '1', kind: 'value', detail: 'Cardinality' },
  { label: 'N', kind: 'value', detail: 'Cardinality' },
  { label: 'M', kind: 'value', detail: 'Cardinality' },
  { label: '(0,N)', kind: 'value', detail: '(min,max) cardinality' },
  { label: '(1,N)', kind: 'value', detail: '(min,max) cardinality' },
];

const PARTICIPATION_WORDS: Suggestion[] = [
  { label: 'total', kind: 'keyword', detail: 'Total (double line)' },
  { label: 'partial', kind: 'keyword', detail: 'Partial (single line)' },
];

const SPECIALIZE_WORDS: Suggestion[] = [
  { label: 'disjoint', kind: 'keyword', detail: 'Disjoint subclasses (D in a circle)' },
  { label: 'overlapping', kind: 'keyword', detail: 'Overlapping subclasses (O in a circle)' },
  { label: 'total', kind: 'keyword', detail: 'Total specialization (double line)' },
  { label: 'partial', kind: 'keyword', detail: 'Partial specialization' },
];

/** Suggestions at `offset` (UTF-16 code units) in `source`. */
export function suggestionsAt(source: string, offset: number): Suggestion[] {
  const context = contextAt(source, offset);
  // The word being typed (`en` in `en|`) is only what VS Code filters the list
  // by; what fits is decided by the finished words before it.
  const typing = TYPING_RE.exec(context.item)?.[0] ?? '';
  const words = context.item.slice(0, context.item.length - typing.length).match(WORD_RE) ?? [];
  const unused = (options: Suggestion[]) => without(options, words);

  switch (context.block) {
    case 'none':
      return [];
    case 'top':
      return topLevel(source, words);
    case 'aggregate':
      return words.length === 0 ? STATEMENTS.filter((s) => s.label.endsWith('rel')) : [];
    case 'entity': {
      // After `name:` come flags; before it, the attribute's name is free text.
      const colon = context.item.indexOf(':');
      if (colon === -1) return [];
      return without(ATTRIBUTE_FLAGS, context.item.slice(colon + 1).match(WORD_RE) ?? []);
    }
    case 'relationship':
      if (words.length === 0)
        return [
          ...entityNames(source),
          {
            label: 'attrs',
            kind: 'snippet',
            insertText: 'attrs { ${1:name} }',
            detail: 'Attributes of the relationship',
          },
        ];
      if (words.at(-1) === 'as') return [];
      return unused(PARTICIPANT_WORDS).filter(
        // One cardinality per participant.
        (s) => s.kind !== 'value' || !words.slice(1).some(isCardinality),
      );
    case 'names':
      return entityNames(source);
  }
}

/** Suggestions outside any block, from the words already written on the line. */
function topLevel(source: string, words: string[]): Suggestion[] {
  if (words.length === 0) return STATEMENTS;
  const [first, ...rest] = words;
  switch (first) {
    case 'weak':
      return rest.length === 0 ? STATEMENTS.filter((s) => s.label === 'entity') : entityStatement();
    case 'identifying':
      return rest.length === 0 ? STATEMENTS.filter((s) => s.label === 'rel') : [];
    case 'entity':
      return entityStatement();
    case 'specialize':
      return rest.length === 0 ? entityNames(source) : without(SPECIALIZE_WORDS, rest);
    case 'category':
      return rest.length === 0 ? [] : without(PARTICIPATION_WORDS, rest);
    case 'partof':
      if (rest.length === 0) return entityNames(source);
      return rest.length === 1
        ? [{ label: 'as', kind: 'keyword', detail: 'Label of the hexagon' }]
        : [];
    case 'show':
      if (rest.length === 0) return entityNames(source);
      if (rest.length === 1) {
        return [
          {
            label: 'again as',
            kind: 'snippet',
            insertText: 'again as ${1:Alias}',
            detail: 'Name the copy',
          },
          { label: 'again', kind: 'keyword' },
        ];
      }
      return rest.length === 2 && rest[1] === 'again' ? [{ label: 'as', kind: 'keyword' }] : [];
    default:
      return [];
  }

  /** `entity Name |` → `inherits`; `entity Name inherits |` → entity names. */
  function entityStatement(): Suggestion[] {
    const afterKeyword = words.slice(words.indexOf('entity') + 1);
    if (afterKeyword.includes('inherits')) return entityNames(source);
    return afterKeyword.length === 1
      ? [{ label: 'inherits', kind: 'keyword', detail: 'Supertypes of this entity' }]
      : [];
  }
}

/**
 * `options` minus words already written, and minus the other choice of a
 * pair that excludes each other (total/partial, disjoint/overlapping).
 */
function without(options: Suggestion[], written: string[]): Suggestion[] {
  const pairs = [
    ['total', 'partial'],
    ['disjoint', 'overlapping'],
    ['key', 'key2', 'partial'],
  ];
  const taken = new Set(written);
  for (const pair of pairs) {
    if (pair.some((w) => taken.has(w))) pair.forEach((w) => taken.add(w));
  }
  return options.filter((s) => !taken.has(s.label));
}

function isCardinality(word: string): boolean {
  return /^(?:\p{N}+|\p{L}|\*|\(.*)$/u.test(word);
}

/** Names of all entities declared or used in the file, for completion. */
function entityNames(source: string): Suggestion[] {
  const names = new Set<string>();
  const visit = (statements: Statement[]) => {
    for (const s of statements) {
      switch (s.kind) {
        case 'entity':
          names.add(s.name.text);
          break;
        case 'relationship':
          for (const p of s.participants) names.add(p.name.text);
          break;
        case 'show':
          names.add((s.alias ?? s.entity).text);
          break;
        case 'aggregate':
          names.add(s.name.text);
          if (s.relationship) visit([s.relationship]);
          break;
        default:
          break;
      }
    }
  };
  visit(parse(source).file.statements);
  return [...names].sort().map((name) => ({
    label: name,
    kind: 'entity' as const,
    insertText: /^[\p{L}_][\p{L}\p{M}\p{N}_\u200c\u200d]*$/u.test(name)
      ? name
      : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  }));
}

/**
 * The block the cursor is in and the text of the current item (since the
 * last newline, brace or comma), skipping strings and comments.
 */
export function contextAt(source: string, offset: number): Context {
  /** For each open brace: the words before it, like "rel Enroll" or "attrs". */
  const headers: string[] = [];
  let item = '';
  let i = 0;
  while (i < offset) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < offset && source[i] !== '\n') i++;
      if (i === offset) return { block: 'none', item: '' };
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1 || end + 2 > offset) return { block: 'none', item: '' };
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < offset && source[j] !== '"' && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      if (j >= offset) return { block: 'none', item: '' };
      item += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      headers.push(item.trim());
      item = '';
    } else if (ch === '}') {
      headers.pop();
      item = '';
    } else if (ch === '\n' || (ch === ',' && headers.length > 0)) {
      // A comma outside braces belongs to `inherits A, B`, which stays one item.
      item = '';
    } else {
      item += ch;
    }
    i++;
  }

  // The nearest enclosing block that a statement opened, or `attrs`.
  for (let k = headers.length - 1; k >= 0; k--) {
    const first = headers[k]!.split(/\s+/)[0];
    switch (first) {
      case 'entity':
      case 'weak':
      case 'attrs':
        return { block: 'entity', item };
      case 'rel':
      case 'identifying':
        return { block: 'relationship', item };
      case 'specialize':
      case 'category':
      case 'partof':
        return { block: 'names', item };
      case 'aggregate':
        return { block: 'aggregate', item };
      default:
        // A composite attribute's braces: keep looking outward.
        continue;
    }
  }
  return { block: 'top', item };
}
