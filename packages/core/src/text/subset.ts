/**
 * Font subsetting, for exported SVGs: they embed the fonts so Persian text
 * looks right on any computer, and embedding only the characters a diagram
 * uses shrinks a file from about 330 KB to a few KB.
 *
 * This uses HarfBuzz's own subsetter, `harfbuzz-subset.wasm`, which ships
 * with harfbuzzjs. It keeps the font's shaping rules (GSUB and GPOS) for the
 * characters it keeps, including the glyphs they turn into, so joined
 * Persian letter forms and ligatures such as «لا» still work.
 *
 * harfbuzzjs has no JavaScript API for it, but the .wasm needs no imports
 * and exports HarfBuzz's C functions, so it is driven through those here.
 */

export interface Subsetter {
  /** `font` with only the glyphs needed to draw the characters of `text`. */
  subset(font: Uint8Array, text: string): Uint8Array;
}

/**
 * The WebAssembly API used. Core's tsconfig has no DOM library, which is
 * where its types come from, but Node, browsers and workers all have it.
 */
declare const WebAssembly: {
  instantiate(bytes: Uint8Array | ArrayBuffer): Promise<{ instance: { exports: unknown } }>;
};

/** The C functions used, as exported by harfbuzz-subset.wasm (pointers are numbers). */
interface Exports {
  memory: { buffer: ArrayBuffer };
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(data: number, length: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

/** HarfBuzz reads the font from our copy in WebAssembly memory without copying it again. */
const HB_MEMORY_MODE_WRITABLE = 2;

/** Loads the subsetter from the bytes of harfbuzz-subset.wasm. */
export async function createSubsetter(wasm: Uint8Array | ArrayBuffer): Promise<Subsetter> {
  const { instance } = await WebAssembly.instantiate(wasm);
  const hb = instance.exports as unknown as Exports;
  return {
    subset(font, text) {
      // Memory can grow during the calls below, so get a fresh view each time.
      const heap = () => new Uint8Array(hb.memory.buffer);
      const fontPointer = hb.malloc(font.byteLength);
      heap().set(font, fontPointer);
      const blob = hb.hb_blob_create(fontPointer, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
      const face = hb.hb_face_create(blob, 0);
      hb.hb_blob_destroy(blob);
      const input = hb.hb_subset_input_create_or_fail();
      let result = 0;
      try {
        if (input === 0) throw new Error('HarfBuzz could not start subsetting.');
        const unicodes = hb.hb_subset_input_unicode_set(input);
        for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0)!);
        result = hb.hb_subset_or_fail(face, input);
        if (result === 0) throw new Error('HarfBuzz could not subset the font.');
        const out = hb.hb_face_reference_blob(result);
        const data = hb.hb_blob_get_data(out, 0);
        const bytes = heap().slice(data, data + hb.hb_blob_get_length(out));
        hb.hb_blob_destroy(out);
        return bytes;
      } finally {
        if (input !== 0) hb.hb_subset_input_destroy(input);
        if (result !== 0) hb.hb_face_destroy(result);
        hb.hb_face_destroy(face);
        hb.free(fontPointer);
      }
    },
  };
}
