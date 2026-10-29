import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildDiagram,
  createHarfBuzzMeasurer,
  diagramText,
  exportSvg,
  layoutDiagram,
  parse,
  renderPng,
  sizeDiagram,
  STYLE,
  type FontData,
  type ResvgModule,
  type Subsetter,
  type TextMeasurer,
} from '../../src';
import { loadFonts, loadResvg, loadSubsetter } from '../../src/node';

let hb: Parameters<typeof createHarfBuzzMeasurer>[0];
let fonts: FontData;
let subsetter: Subsetter;
let resvg: ResvgModule;
let measurer: TextMeasurer;
beforeAll(async () => {
  [hb, fonts, subsetter, resvg] = await Promise.all([
    import('harfbuzzjs'),
    loadFonts(),
    loadSubsetter(),
    loadResvg(),
  ]);
  measurer = createHarfBuzzMeasurer(hb, fonts);
});

function exported(source: string): string {
  const sized = sizeDiagram(buildDiagram(parse(source).file), measurer);
  return exportSvg(sized, layoutDiagram(sized), fonts, subsetter);
}

describe('font subsetting', () => {
  // Joined forms, a ZWNJ, a hamza and the «لا» ligature.
  const words = ['منبع کتابخانه\u200cای', 'مجموع تأخیرها', 'کلاس', 'Student 1 N'];

  it('keeps Persian text shaping exactly as with the full font', () => {
    const text = words.join('');
    const subset = {
      regular: subsetter.subset(fonts.regular, text),
      bold: subsetter.subset(fonts.bold, text),
    };
    const small = createHarfBuzzMeasurer(hb, subset);
    for (const word of words) {
      for (const bold of [false, true]) {
        expect(small.width(word, { size: 16, bold }), word).toBe(
          measurer.width(word, { size: 16, bold }),
        );
      }
    }
    expect(subset.regular.length).toBeLessThan(fonts.regular.length / 4);
  });

  it('collects every character the diagram draws', () => {
    const sized = sizeDiagram(
      buildDiagram(parse('entity الف { ب }\nrel ج { الف (0,N) as دال, X 1 }').file),
      measurer,
    );
    const chars = new Set(diagramText(sized));
    for (const ch of 'الفبجدX01N(),') expect(chars.has(ch), ch).toBe(true);
  });
});

describe('exportSvg', () => {
  it('draws black on white and embeds only the characters used', () => {
    const svg = exported('entity "عضو کتابخانه" { نام, "کد ملی": key }');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke: #000000');
    expect(svg.split('@font-face').length - 1).toBe(2);
    // The full fonts alone would be about 330 KB in base64.
    expect(svg.length).toBeLessThan(40_000);
  });
});

describe('renderPng', () => {
  const LABEL = 'کتابخانه مرکزی';

  /** Dark pixels inside the entity, away from its outline: the label's pixels. */
  function labelInk(png: { width: number; height: number; pixels: Uint8Array }, scale: number) {
    const inset = (STYLE.margin + 8) * scale;
    let dark = 0;
    for (let y = Math.ceil(inset); y < png.height - inset; y++) {
      for (let x = Math.ceil(inset); x < png.width - inset; x++) {
        if (png.pixels[(y * png.width + x) * 4]! < 128) dark++;
      }
    }
    return dark;
  }

  it('draws a Persian label with the bundled font, at the requested scale', () => {
    const svg = exported(`entity "${LABEL}"`);
    const png = decodePng(renderPng(svg, resvg, fonts, 3));
    const width = Number(/width="([\d.]+)"/.exec(svg)![1]);
    expect(png.width).toBe(Math.round(width * 3));
    expect(labelInk(png, 3)).toBeGreaterThan(500);
    // White background, not transparent.
    expect([...png.pixels.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it('would catch a missing font: without it, resvg leaves the label out', () => {
    const svg = exported(`entity "${LABEL}"`);
    const image = new resvg.Resvg(svg, {
      font: { loadSystemFonts: false },
      fitTo: { mode: 'zoom', value: 3 },
    });
    const png = decodePng(image.render().asPng());
    expect(labelInk(png, 3)).toBe(0);
  });
});

/**
 * Minimal PNG decoder for resvg's output (8-bit RGBA, not interlaced), so
 * the test can look at pixels without another dependency.
 */
function decodePng(data: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  expect([data[24], data[25], data[28]]).toEqual([8, 6, 0]); // bit depth, RGBA, no interlace
  const chunks: Uint8Array[] = [];
  for (let at = 8; at < data.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    if (type === 'IDAT') chunks.push(data.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      pixels[y * stride + x] = (line[x]! + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
