import type { Range } from './ast';

/** A syntax error, shown in VS Code as a red squiggle. */
export interface ParseError {
  message: string;
  range: Range;
  /** A one-click repair, offered in VS Code as a Quick Fix (the light bulb). */
  fix?: Fix;
}

/** Text edits that repair an error, applied together. */
export interface Fix {
  /** Short label for the light bulb menu, like "Change to 'entity'". */
  title: string;
  edits: TextEdit[];
}

/** Replaces `range` with `newText`; an empty range inserts. */
export interface TextEdit {
  range: Range;
  newText: string;
}

/**
 * Returns the candidate the user most likely meant by `word`: a likely typo
 * (`mutli` → `multi`, `entiy` → `entity`) or an unfinished word (`en` →
 * `entity`, `spec` → `specialize`).
 */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
  return closest(word, candidates) ?? completion(word, candidates);
}

/** The candidate within a small edit distance of `word`. */
function closest(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase();
  // Allow one edit for short words, two for longer ones.
  const maxDistance = lower.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate);
    if (distance <= maxDistance && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The candidate that `word` is the start of. At least two letters, and case
 * matters, so a participant called `To` is not taken for `total`. When
 * several fit, the shortest wins only if it starts all the others (`ke` →
 * `key`, not `key2`); otherwise the word is ambiguous and nothing is suggested.
 */
function completion(word: string, candidates: readonly string[]): string | undefined {
  if (word.length < 2) return undefined;
  const fits = candidates
    .filter((c) => c.length > word.length && c.startsWith(word))
    .sort((a, b) => a.length - b.length);
  const shortest = fits[0];
  return shortest !== undefined && fits.every((c) => c.startsWith(shortest)) ? shortest : undefined;
}

/**
 * Edit distance where swapping two neighbouring letters counts as one edit
 * ("optimal string alignment"), so `mutli` is one edit away from `multi`.
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
    }
  }
  return d[a.length]![b.length]!;
}
