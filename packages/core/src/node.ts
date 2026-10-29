/**
 * Node.js helpers for scripts and tests: load the bundled fonts and HarfBuzz
 * from disk. Not used by the VS Code extension or the browser, which load
 * these assets their own way.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ResvgModule } from './render/export';
import type { FontData, TextMeasurer } from './text/measure';
import { createHarfBuzzMeasurer } from './text/measure';
import { createSubsetter, type Subsetter } from './text/subset';

const require = createRequire(import.meta.url);

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

/** HarfBuzz's font subsetter, from the .wasm that ships with harfbuzzjs. */
export async function loadSubsetter(): Promise<Subsetter> {
  return createSubsetter(await readFile(require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm')));
}

let resvg: Promise<ResvgModule> | null = null;

/** @resvg/resvg-wasm, initialized once (its WebAssembly can only be loaded once). */
export function loadResvg(): Promise<ResvgModule> {
  resvg ??= (async () => {
    const module = await import('@resvg/resvg-wasm');
    await module.initWasm(await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    return module;
  })();
  return resvg;
}
