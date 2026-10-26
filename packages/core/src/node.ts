/**
 * Node.js helpers for scripts and tests: load the bundled fonts and HarfBuzz
 * from disk. Not used by the VS Code extension or the browser, which load
 * these assets their own way.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FontData, TextMeasurer } from './text/measure';
import { createHarfBuzzMeasurer } from './text/measure';

const fontsDir = new URL('../assets/fonts/', import.meta.url);

export async function loadFonts(): Promise<FontData> {
  const [regular, bold] = await Promise.all([
    readFile(fileURLToPath(new URL('Vazirmatn-Regular.ttf', fontsDir))),
    readFile(fileURLToPath(new URL('Vazirmatn-Bold.ttf', fontsDir))),
  ]);
  return { regular, bold };
}

export async function createNodeMeasurer(): Promise<TextMeasurer> {
  const [hb, fonts] = await Promise.all([import('harfbuzzjs'), loadFonts()]);
  return createHarfBuzzMeasurer(hb, fonts);
}
