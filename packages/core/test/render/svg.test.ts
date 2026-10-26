import { beforeAll, describe, expect, it } from 'vitest';
import { renderDiagram } from '../../src';
import type { TextMeasurer } from '../../src';
import { createNodeMeasurer, loadFonts } from '../../src/node';
import { base64 } from '../../src/render/base64';

let measurer: TextMeasurer;
beforeAll(async () => {
  measurer = await createNodeMeasurer();
});

async function svg(source: string): Promise<string> {
  return renderDiagram(source, measurer).svg;
}

/** The SVG markup of the element with this data-id. */
function element(markup: string, id: string): string {
  const start = markup.indexOf(`data-id="${id}"`);
  expect(start, `element ${id}`).toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf('</g>', start));
}

const count = (text: string, pattern: string) => text.split(pattern).length - 1;

describe('renderSvg', () => {
  it('draws strong and weak entities and repeated copies', async () => {
    const out = await svg('entity A\nweak entity B\nshow A again as A2');
    expect(count(element(out, 'entity:A'), '<rect')).toBe(1);
    expect(count(element(out, 'entity:B'), '<rect')).toBe(2);
    const copy = element(out, 'copy:A2');
    expect(count(copy, '<rect')).toBe(1);
    expect(count(copy, '<line')).toBe(1);
  });

  it('draws relationships as single or double diamonds', async () => {
    const out = await svg('rel R { A }\nidentifying rel I { A }');
    expect(count(element(out, 'rel:R(A)'), '<polygon')).toBe(1);
    expect(count(element(out, 'rel:I(A)'), '<polygon')).toBe(2);
  });

  it('draws every kind of attribute', async () => {
    const out = await svg('entity E { k: key, s: key2, p: partial, m: multi, d: derived, plain }');
    const attr = (name: string) => element(out, `attr:entity:E/${name}`);
    expect(count(attr('k'), '<line')).toBe(1);
    expect(count(attr('s'), '<line')).toBe(2);
    expect(attr('p')).toContain('stroke-dasharray');
    expect(count(attr('m'), '<ellipse')).toBe(2);
    expect(attr('d')).toContain('class="shape dashed"');
    expect(count(attr('plain'), '<line')).toBe(0);
    expect(count(attr('plain'), '<ellipse')).toBe(1);
  });

  it('draws total participation as a double line', async () => {
    const single = await svg('rel R { A, B }');
    const double = await svg('rel R { A total, B }');
    const lines = (s: string) =>
      count(s.slice(s.indexOf('class="lines"'), s.indexOf('class="shapes"')), '<line');
    expect(lines(double)).toBe(lines(single) + 1);
  });

  it('puts cardinality labels on their line, breaking it with a knockout', async () => {
    const out = await svg('entity A\nentity B\nrel R { A 1, B N }');
    expect(count(out, 'class="knockout"')).toBe(2);
    // Each label's center lies on the straight line between A and R or R and B.
    const texts = [
      ...out.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" font-size="\d+"[^>]*>(1|N)</g),
    ];
    expect(texts).toHaveLength(2);
  });

  it('draws the two lines of a unary relationship apart, ending on the diamond', async () => {
    const out = await svg('entity C\nrel P { C N, C M }');
    const lines = out.slice(out.indexOf('class="lines"'), out.indexOf('class="shapes"'));
    const ends = [...lines.matchAll(/x2="([\d.-]+)" y2="([\d.-]+)"/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    expect(ends).toHaveLength(2);
    // Far enough apart to read as two lines, not as one double line.
    expect(Math.hypot(ends[0]!.x - ends[1]!.x, ends[0]!.y - ends[1]!.y)).toBeGreaterThan(20);
    // Both end on the diamond's outline: |x - cx| / a + |y - cy| / b = 1.
    const points = /<polygon class="shape" points="([^"]+)"/
      .exec(out.slice(out.indexOf('data-id="rel:')))![1]!
      .split(' ')
      .map((p) => p.split(',').map(Number) as [number, number]);
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const [cx, cy] = [
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
    ];
    const [a, b] = [
      (Math.max(...xs) - Math.min(...xs)) / 2,
      (Math.max(...ys) - Math.min(...ys)) / 2,
    ];
    for (const end of ends) {
      expect(Math.abs(end.x - cx) / a + Math.abs(end.y - cy) / b).toBeCloseTo(1, 1);
    }
  });

  it('writes cardinalities and roles as labels', async () => {
    const out = await svg('rel R { A (1,N) as boss, B M }');
    expect(out).toContain('>(1,N)</text>');
    expect(out).toContain('>M</text>');
    expect(out).toMatch(/font-style="italic"[^>]*>boss</);
  });

  it('marks right-to-left labels and keeps Persian text intact', async () => {
    const out = await svg('entity "عضو خانواده" { نام: partial }');
    expect(out).toMatch(/direction="rtl">عضو خانواده</);
    expect(out).toMatch(/direction="rtl">نام</);
  });

  it('escapes special characters', async () => {
    const out = await svg('entity "A & <B>"');
    expect(out).toContain('>A &amp; &lt;B&gt;</text>');
    expect(out).not.toContain('<B>');
  });

  it('embeds the fonts only when asked', async () => {
    expect(await svg('entity A')).not.toContain('@font-face');
    const fonts = await loadFonts();
    const embedded = renderDiagram('entity A', measurer, { embedFont: fonts }).svg;
    expect(count(embedded, '@font-face')).toBe(2);
  });

  it('renders an empty file as an empty drawing', async () => {
    const out = await svg('');
    expect(out).toMatch(/^<svg [^>]*viewBox="0 0 100 100"/);
  });

  it('still draws what parsed when there are syntax errors', async () => {
    const { svg: out, errors } = renderDiagram('entity A { x: mutli }\nentiy B', measurer);
    expect(errors).toHaveLength(2);
    expect(out).toContain('data-id="attr:entity:A/x"');
  });
});

describe('base64', () => {
  it('matches Node for every padding length', () => {
    for (const bytes of [[], [1], [1, 2], [1, 2, 3], [255, 0, 128, 7, 9]]) {
      const data = new Uint8Array(bytes);
      expect(base64(data)).toBe(Buffer.from(data).toString('base64'));
    }
  });
});
