import type { Range } from './ast';

/** A syntax error, shown in VS Code as a red squiggle. */
export interface ParseError {
  message: string;
  range: Range;
}

/**
 * Returns the candidate closest to `word`, if it is close enough to be a
 * likely typo (for example `mutli` → `multi`, `entiy` → `entity`).
 */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
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
