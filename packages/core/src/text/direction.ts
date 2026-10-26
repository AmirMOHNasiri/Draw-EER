/**
 * True if `text` starts (at its first letter or digit) with a right-to-left
 * character: Hebrew, Arabic, Persian and related scripts.
 */
export function isRightToLeft(text: string): boolean {
  const firstStrong = /[\p{L}\p{N}]/u.exec(text)?.[0] ?? '';
  return /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(firstStrong);
}
