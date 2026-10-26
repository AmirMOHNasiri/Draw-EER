/**
 * Loads HarfBuzz from the .wasm bytes the caller provides.
 *
 * `loadHarfBuzz` does not exist in harfbuzzjs itself: the build adds it in
 * place of the top-level await that would load the WebAssembly on import
 * (see scripts/build.mjs). This file is only used through the bundle.
 */
import * as harfbuzz from 'harfbuzzjs';
import {
  createHarfBuzzMeasurer,
  type FontData,
  type HarfBuzzModule,
  type TextMeasurer,
} from '@draw-eer/core';

interface Loadable {
  loadHarfBuzz(options: { wasmBinary: Uint8Array; locateFile: () => string }): Promise<void>;
}

let loaded: Promise<HarfBuzzModule> | null = null;

/** Loads HarfBuzz once; later calls get the same module. */
export function loadHarfBuzz(wasm: Uint8Array): Promise<HarfBuzzModule> {
  loaded ??= (harfbuzz as unknown as Loadable)
    // `locateFile` keeps Emscripten from working out a URL for the file,
    // which fails where `import.meta.url` is empty.
    .loadHarfBuzz({ wasmBinary: wasm, locateFile: () => 'harfbuzz.wasm' })
    .then(() => harfbuzz);
  return loaded;
}

export async function createMeasurer(wasm: Uint8Array, fonts: FontData): Promise<TextMeasurer> {
  return createHarfBuzzMeasurer(await loadHarfBuzz(wasm), fonts);
}
