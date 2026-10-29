/**
 * Layout rules for aggregates, on every fixture that has one. The box is
 * read from the rendered SVG, so these check what is actually drawn.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDiagram, layoutDiagram, parse, renderSvg, sizeDiagram } from '../../src';
import type { Aggregate, AttributeNode, Layout, SizedDiagram, TextMeasurer } from '../../src';
import { boxAround, boxesOverlap, segmentHitsBox, type Box } from '../../src/geometry/collide';
import type { Point } from '../../src/geometry/shapes';
import { createNodeMeasurer } from '../../src/node';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.eer'))
  .filter((f) => /^\s*aggregate\b/m.test(readFileSync(fixturesDir + f, 'utf8')));

let measurer: TextMeasurer;
beforeAll(async () => {
  measurer = await createNodeMeasurer();
});

interface Drawn {
  sized: SizedDiagram;
  layout: Layout;
  svg: string;
}

function draw(fixture: string): Drawn {
  const source = readFileSync(fixturesDir + fixture, 'utf8');
  const sized = sizeDiagram(buildDiagram(parse(source).file), measurer);
  const layout = layoutDiagram(sized);
  return { sized, layout, svg: renderSvg(sized, layout) };
}

const number = '(-?[\\d.]+)';

/** The dashed box of each aggregate, as drawn. */
function boxes(svg: string): Map<string, Box> {
  const result = new Map<string, Box>();
  const pattern = new RegExp(
    `<g class="aggregate" data-id="([^"]+)"><rect class="outline dashed" x="${number}" y="${number}" width="${number}" height="${number}"`,
    'g',
  );
  for (const m of svg.matchAll(pattern)) {
    const [x, y, w, h] = [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number];
    result.set(m[1]!, { minX: x, minY: y, maxX: x + w, maxY: y + h });
  }
  return result;
}

/** The aggregate's shapes and all their attributes. */
function inside(sized: SizedDiagram, aggregate: Aggregate): Set<string> {
  const ids = new Set(aggregate.members);
  const visit = (attributes: AttributeNode[]) => {
    for (const a of attributes) {
      ids.add(a.id);
      visit(a.children);
    }
  };
  for (const node of sized.diagram.nodes) if (ids.has(node.id)) visit(node.attributes);
  return ids;
}

function within(box: Box, p: Point, tolerance = 0): boolean {
  return (
    p.x >= box.minX - tolerance &&
    p.x <= box.maxX + tolerance &&
    p.y >= box.minY - tolerance &&
    p.y <= box.maxY + tolerance
  );
}

function onBorder(box: Box, p: Point, tolerance = 0.05): boolean {
  if (!within(box, p, tolerance)) return false;
  return (
    Math.abs(p.x - box.minX) <= tolerance ||
    Math.abs(p.x - box.maxX) <= tolerance ||
    Math.abs(p.y - box.minY) <= tolerance ||
    Math.abs(p.y - box.maxY) <= tolerance
  );
}

it('runs on the fixtures with aggregates', () => {
  expect(fixtures).toEqual(expect.arrayContaining(['slide61.eer', 'slide62.eer', 'mixed-eer.eer']));
});

describe.each(fixtures)('aggregates in %s', (fixture) => {
  it('keep every other shape, attribute and circle out of the box, not even touching it', () => {
    const { sized, layout, svg } = draw(fixture);
    const drawn = boxes(svg);
    const hits: string[] = [];
    for (const aggregate of sized.diagram.aggregates) {
      const box = drawn.get(aggregate.id)!;
      const own = inside(sized, aggregate);
      for (const [id, p] of layout) {
        if (own.has(id)) continue;
        const { width, height } = sized.geometry.get(id)!.shape;
        // Grown by a pixel: touching the border counts.
        if (boxesOverlap(boxAround(p, width, height, 1), box)) hits.push(`${aggregate.id} / ${id}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('let lines from outside cross the border once, to reach a shape inside', () => {
    const { sized, layout, svg } = draw(fixture);
    const drawn = boxes(svg);
    const faults: string[] = [];
    for (const aggregate of sized.diagram.aggregates) {
      const box = drawn.get(aggregate.id)!;
      const members = new Set(aggregate.members);
      for (const link of sized.diagram.links) {
        const [a, b] = [layout.get(link.from)!, layout.get(link.to)!];
        const [inA, inB] = [members.has(link.from), members.has(link.to)];
        if (inA && inB) continue;
        if (inA || inB) {
          // A straight line from a point inside a box to one outside it
          // crosses its border exactly once.
          const [member, other] = inA ? [a, b] : [b, a];
          if (!within(box, member) || within(box, other)) faults.push(`${link.id} crosses ≠ 1`);
        } else if (segmentHitsBox(a, b, box)) {
          faults.push(`${link.id} runs through ${aggregate.id}`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it('never put a subset symbol on the border', () => {
    const { svg } = draw(fixture);
    const drawn = [...boxes(svg).values()];
    const pattern = new RegExp(
      `<path class="line" d="M${number},${number} A${number},${number} 0 0 [01] ${number},${number}"`,
      'g',
    );
    const faults: string[] = [];
    for (const m of svg.matchAll(pattern)) {
      const [px, py, r, , qx, qy] = m.slice(1).map(Number) as number[];
      const cup = boxAround({ x: (px! + qx!) / 2, y: (py! + qy!) / 2 }, 2 * r!, 2 * r!);
      for (const box of drawn) {
        const fullyInside =
          cup.minX >= box.minX &&
          cup.maxX <= box.maxX &&
          cup.minY >= box.minY &&
          cup.maxY <= box.maxY;
        if (boxesOverlap(cup, box) && !fullyInside) faults.push(m[0]);
      }
    }
    expect(faults).toEqual([]);
  });

  it('dash the line from the relationship inside only within the box', () => {
    const { svg } = draw(fixture);
    const drawn = [...boxes(svg).values()];
    const lines = (cls: string) =>
      [
        ...svg.matchAll(
          new RegExp(
            `<line class="${cls}" x1="${number}" y1="${number}" x2="${number}" y2="${number}"`,
            'g',
          ),
        ),
      ].map((m) => {
        const [x1, y1, x2, y2] = m.slice(1).map(Number) as number[];
        return [
          { x: x1!, y: y1! },
          { x: x2!, y: y2! },
        ] as [Point, Point];
      });
    const dashed = lines('line dashed');
    const solid = lines('line');
    expect(dashed.length).toBeGreaterThan(0);
    for (const [start, exit] of dashed) {
      const box = drawn.find((b) => within(b, start, 0.05) && within(b, exit, 0.05));
      expect(box, 'dashed part inside a box').toBeDefined();
      expect(onBorder(box!, exit), 'dashed part ends on the border').toBe(true);
      // Long enough to see: the box's padding keeps it clear of the diamond.
      expect(Math.hypot(exit.x - start.x, exit.y - start.y)).toBeGreaterThanOrEqual(10);
      // The solid rest of the line starts there and stays outside.
      const rest = solid.find(([a]) => Math.hypot(a.x - exit.x, a.y - exit.y) < 0.05);
      expect(rest, 'solid part from the border').toBeDefined();
      expect(within(box!, rest![1], -0.05)).toBe(false);
    }
  });
});
