import type * as HarfBuzz from 'harfbuzzjs';

/**
 * Text measurement.
 *
 * Shapes are sized from the width of their labels, and underlines are drawn
 * as separate lines, so widths must be exact. Persian letters change shape
 * (and width) depending on their neighbours, and pairs like «لا» become one
 * glyph, so a simple table of character widths is not enough: text has to be
 * run through a real shaping engine. We use HarfBuzz (compiled to WebAssembly),
 * the same engine Chromium uses, with the bundled Vazirmatn font. Widths are
 * then identical in the preview, in exports and in tests, on every platform.
 *
 * opentype.js was evaluated first and rejected: version 2.0 throws on a lookup
 * type that Vazirmatn uses, and 1.3.4 is off by up to 1.3 px on Persian text.
 * See `test/text/measure.test.ts` for widths checked against Chromium.
 */

export interface TextStyle {
  /** Font size in px. */
  size: number;
  bold?: boolean;
}

export interface TextMeasurer {
  /** Advance width of a single line of text, in px. */
  width(text: string, style: TextStyle): number;
}

/**
 * The parts of the `harfbuzzjs` module we use. Callers import the module
 * themselves (`await import('harfbuzzjs')`) because it loads WebAssembly at
 * import time, which only some environments can do.
 */
export type HarfBuzzModule = Pick<typeof HarfBuzz, 'Blob' | 'Face' | 'Font' | 'Buffer' | 'shape'>;

export interface FontData {
  regular: Uint8Array;
  bold: Uint8Array;
}

/** Creates a measurer that shapes text with HarfBuzz. Results are cached. */
export function createHarfBuzzMeasurer(hb: HarfBuzzModule, fonts: FontData): TextMeasurer {
  const regular = new ShapedFont(hb, fonts.regular);
  const bold = new ShapedFont(hb, fonts.bold);
  return {
    width: (text, style) => (style.bold ? bold : regular).width(text) * style.size,
  };
}

/**
 * A rough measurer that needs no font: every character is 0.55 em wide.
 * Only for tests that check geometry and must not depend on font details.
 */
export function createApproximateMeasurer(): TextMeasurer {
  return {
    width: (text, style) => {
      let em = 0;
      for (const ch of text) em += ch === ' ' ? 0.28 : 0.55;
      return em * style.size;
    },
  };
}

/** One font face, measuring in em units (1 = the font size). */
class ShapedFont {
  private readonly font: HarfBuzz.Font;
  private readonly unitsPerEm: number;
  private readonly cache = new Map<string, number>();
  private readonly hb: HarfBuzzModule;

  constructor(hb: HarfBuzzModule, data: Uint8Array) {
    this.hb = hb;
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const face = new hb.Face(new hb.Blob(bytes as ArrayBuffer));
    this.font = new hb.Font(face);
    this.unitsPerEm = face.upem;
  }

  width(text: string): number {
    let total = 0;
    for (const run of splitRuns(text)) total += this.runWidth(run);
    return total;
  }

  private runWidth(run: string): number {
    const cached = this.cache.get(run);
    if (cached !== undefined) return cached;
    const buffer = new this.hb.Buffer();
    buffer.addText(run);
    buffer.guessSegmentProperties();
    this.hb.shape(this.font, buffer);
    let units = 0;
    for (const position of buffer.getGlyphPositions()) units += position.xAdvance;
    const width = units / this.unitsPerEm;
    this.cache.set(run, width);
    return width;
  }
}

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࡰ-ࣿﭐ-﷿ﹰ-\uFEFF]/u;
const STRONG = /[\p{L}\p{N}]/u;

/**
 * Splits text into pieces that are shaped separately, the way browsers do:
 * each space on its own, and words split where the script changes between
 * Arabic-script letters and everything else. Shaping a mixed string such as
 * "Student دانشجو" in one piece would treat the Persian letters as Latin and
 * leave them unjoined (and about 10 px too wide).
 */
export function splitRuns(text: string): string[] {
  const runs: string[] = [];
  let current = '';
  let currentArabic: boolean | null = null;

  const flush = () => {
    if (current) runs.push(current);
    current = '';
    currentArabic = null;
  };

  for (const ch of text) {
    if (/\s/u.test(ch)) {
      flush();
      runs.push(ch);
      continue;
    }
    if (STRONG.test(ch)) {
      const arabic = ARABIC_SCRIPT.test(ch);
      if (currentArabic !== null && currentArabic !== arabic) flush();
      currentArabic = arabic;
    }
    // Neutral characters (punctuation, marks, ZWNJ) stay with the current run.
    current += ch;
  }
  flush();
  return runs;
}
