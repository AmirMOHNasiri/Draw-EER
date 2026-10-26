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
export type Context =
  | { block: 'top'; item: string }
  | { block: 'entity'; item: string }
  | { block: 'relationship'; item: string }
  | { block: 'names'; item: string };

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

const SPECIALIZE_WORDS: Suggestion[] = [
  { label: 'disjoint', kind: 'keyword', detail: 'Disjoint subclasses (D in a circle)' },
  { label: 'overlapping', kind: 'keyword', detail: 'Overlapping subclasses (O in a circle)' },
  { label: 'total', kind: 'keyword', detail: 'Total specialization (double line)' },
  { label: 'partial', kind: 'keyword', detail: 'Partial specialization' },
];

/** Suggestions at `offset` (UTF-16 code units) in `source`. */
export function suggestionsAt(source: string, offset: number): Suggestion[] {
  const context = contextAt(source, offset);
  const words = context.item.trim().split(/\s+/).filter(Boolean);

  switch (context.block) {
    case 'top': {
      if (words[0] === 'specialize' && words.length >= 2) return SPECIALIZE_WORDS;
      if ((words[0] === 'show' && words.length >= 2) || words[0] === 'show') {
        return words.length >= 2 ? [{ label: 'again as', kind: 'keyword' }] : entityNames(source);
      }
      if (words.length >= 1 && words.at(-1) !== 'weak' && words.at(-1) !== 'identifying') return [];
      return STATEMENTS;
    }
    case 'entity':
      // After `name:` come flags; before it, the attribute's name is free text.
      return context.item.includes(':') ? ATTRIBUTE_FLAGS : [];
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
      return PARTICIPANT_WORDS;
    case 'names':
      return entityNames(source);
  }
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
 * last newline, comma or brace), skipping strings and comments.
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
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? offset : end + 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < offset && source[j] !== '"' && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      item += source.slice(i, Math.min(j + 1, offset));
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      headers.push(item.trim());
      item = '';
    } else if (ch === '}') {
      headers.pop();
      item = '';
    } else if (ch === '\n' || ch === ',') {
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
        return { block: 'top', item };
      default:
        // A composite attribute's braces: keep looking outward.
        continue;
    }
  }
  return { block: 'top', item };
}
