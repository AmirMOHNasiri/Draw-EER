import { beforeAll, describe, expect, it } from 'vitest';
import { createNodeMeasurer } from '../../src/node';
import { splitRuns, type TextMeasurer } from '../../src/text/measure';

const ZWNJ = '\u200C';

/**
 * Reference widths at 14 px, measured with canvas `measureText` in headless
 * Chromium (the engine behind VS Code's webviews) with the bundled Vazirmatn
 * files: [text, regular, bold].
 *
 * For the record, opentype.js was compared on the same strings: 2.0.0 threw
 * "lookupType: 6 - substFormat: 2 is not yet supported" for every string
 * (even Latin), and 1.3.4 was off by -0.48 px on «پیش‌نیازی» and +1.30 px
 * on «گروه آموزشی».
 */
const CHROMIUM: [string, number, number][] = [
  ['دانشجو', 41.53, 42.42],
  ['عضو خانواده', 69.06, 70.55],
  [`پیش${ZWNJ}نیازی`, 54.64, 55.75],
  ['لاله', 19.25, 19.94],
  ['لا', 7.96, 8.28],
  ['گروه آموزشی', 68.68, 70.45],
  ['کد ملی', 38.42, 38.74],
  ['سال-ترم', 47.12, 48.51],
  ['Employee', 60.76, 61.46],
  ['StudentID', 61.24, 62.42],
  ['WAVE AV To', 78.17, 78.7],
  ['Student دانشجو', 93.53, 95.17],
  ['ID دانشجو', 58.28, 59.14],
  ['(1,N)', 30.18, 31.2],
  ['شماره ۱۲۳', 57.3, 58.79],
  ['Course_2', 58.39, 59.04],
];

describe('HarfBuzz text measurement', () => {
  let measurer: TextMeasurer;
  beforeAll(async () => {
    measurer = await createNodeMeasurer();
  });

  it.each(CHROMIUM)('measures %j like Chromium', (text, regular, bold) => {
    expect(Math.abs(measurer.width(text, { size: 14 }) - regular)).toBeLessThan(0.05);
    expect(Math.abs(measurer.width(text, { size: 14, bold: true }) - bold)).toBeLessThan(0.05);
  });

  it('shapes the لا ligature as one glyph narrower than its letters', () => {
    const separate = measurer.width('ل', { size: 14 }) + measurer.width('ا', { size: 14 });
    expect(measurer.width('لا', { size: 14 })).toBeLessThan(separate);
  });

  it('scales linearly with the font size', () => {
    const at14 = measurer.width('دانشجو', { size: 14 });
    expect(measurer.width('دانشجو', { size: 28 })).toBeCloseTo(at14 * 2, 6);
  });
});

describe('splitRuns', () => {
  it('splits at spaces and at script changes, keeping neutrals in the run', () => {
    expect(splitRuns('Student دانشجو')).toEqual(['Student', ' ', 'دانشجو']);
    expect(splitRuns('IDدانشجو')).toEqual(['ID', 'دانشجو']);
    expect(splitRuns('سال-ترم')).toEqual(['سال-ترم']);
    expect(splitRuns(`پیش${ZWNJ}نیازی`)).toEqual([`پیش${ZWNJ}نیازی`]);
  });
});
