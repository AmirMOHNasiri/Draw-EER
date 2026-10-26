import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDiagram, layoutDiagram, parse, sizeDiagram } from '../../src';
import type { AttributeNode, SizedDiagram, TextMeasurer } from '../../src';
import type { Point } from '../../src/geometry/shapes';
import { createNodeMeasurer } from '../../src/node';
import { boxAround, boxesOverlap, segmentHitsBox } from '../../src/geometry/collide';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.eer'));

let measurer: TextMeasurer;
beforeAll(async () => {
  measurer = await createNodeMeasurer();
});

function sized(source: string): SizedDiagram {
  return sizeDiagram(buildDiagram(parse(source).file), measurer);
}

function allIds(s: SizedDiagram): string[] {
  const ids: string[] = [];
  const visit = (attributes: AttributeNode[]) => {
    for (const a of attributes) {
      ids.push(a.id);
      visit(a.children);
    }
  };
  for (const node of s.diagram.nodes) {
    ids.push(node.id);
    visit(node.attributes);
  }
  return ids;
}

describe.each(fixtures)('layout of %s', (fixture) => {
  const source = readFileSync(fixturesDir + fixture, 'utf8');

  it('positions every node and attribute without overlaps', async () => {
    const s = sized(source);
    const layout = layoutDiagram(s);
    const ids = allIds(s);
    expect([...layout.keys()].sort()).toEqual([...ids].sort());

    // Bounding boxes, shrunk a little so shapes that only touch do not count.
    const boxes = ids.map((id) => {
      const { width, height } = s.geometry.get(id)!.shape;
      return { id, box: boxAround(layout.get(id)!, width, height, -2) };
    });
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxesOverlap(boxes[i]!.box, boxes[j]!.box))
          overlaps.push(`${boxes[i]!.id} / ${boxes[j]!.id}`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('is deterministic', async () => {
    const first = layoutDiagram(sized(source));
    const second = layoutDiagram(sized(source));
    expect([...second]).toEqual([...first]);
  });
});

describe('attribute placement', () => {
  it('keeps the attributes of a composite key side by side on one row', async () => {
    const s = sized('entity C { (code, term, section): key, title }');
    const layout = layoutDiagram(s);
    const ys = ['code', 'term', 'section'].map((n) => layout.get(`attr:entity:C/${n}`)!.y);
    expect(new Set(ys).size).toBe(1);
    const xs = ['code', 'term', 'section'].map((n) => layout.get(`attr:entity:C/${n}`)!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('places composite children further from the owner than their parent', async () => {
    const s = sized('entity E { name { first, last } }');
    const layout = layoutDiagram(s);
    const owner = layout.get('entity:E')!;
    const distance = (id: string) => {
      const p = layout.get(id)!;
      return Math.hypot(p.x - owner.x, p.y - owner.y);
    };
    const parent = distance('attr:entity:E/name');
    expect(distance('attr:attr:entity:E/name/first')).toBeGreaterThan(parent);
    expect(distance('attr:attr:entity:E/name/last')).toBeGreaterThan(parent);
  });

  it('keeps attributes off the lines of a binary relationship', async () => {
    const s = sized('entity A { a1, a2, a3 }\nentity B { b1, b2 }\nrel R { A, B, attrs { r1 } }');
    const layout = layoutDiagram(s);
    const a = layout.get('entity:A')!;
    const r = layout.get('rel:R(A,B)')!;
    const b = layout.get('entity:B')!;
    for (const [id, p] of layout) {
      if (!id.startsWith('attr:')) continue;
      const { width, height } = s.geometry.get(id)!.shape;
      const box = boxAround(p, width, height);
      expect(segmentHitsBox(a, r, box), id).toBe(false);
      expect(segmentHitsBox(r, b, box), id).toBe(false);
    }
  });
});

describe('grid structure', () => {
  const straight = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01;

  it('puts a binary relationship exactly between its entities, on one straight line', async () => {
    const layout = layoutDiagram(sized('entity A { x }\nentity B { y }\nrel R { A 1, B N }'));
    const a = layout.get('entity:A')!;
    const r = layout.get('rel:R(A,B)')!;
    const b = layout.get('entity:B')!;
    expect(straight(a, r) && straight(r, b)).toBe(true);
    // R lies between A and B.
    expect((r.x - a.x) * (b.x - r.x) + (r.y - a.y) * (b.y - r.y)).toBeGreaterThan(0);
  });

  it('draws a ternary relationship as a T', async () => {
    const layout = layoutDiagram(sized('rel T { A, B, C }'));
    const r = layout.get('rel:T(A,B,C)')!;
    const arms = ['A', 'B', 'C'].map((n) => layout.get(`entity:${n}`)!);
    for (const p of arms) expect(straight(p, r)).toBe(true);
    const directions = arms.map((p) => Math.atan2(p.y - r.y, p.x - r.x));
    const opposite = directions.some((d, i) =>
      directions.some((e, j) => i < j && Math.abs(Math.abs(d - e) - Math.PI) < 0.01),
    );
    expect(opposite).toBe(true);
  });

  it('keeps every binary relationship of a weak-entity chain straight', async () => {
    const layout = layoutDiagram(
      sized(
        'entity A\nweak entity B\nweak entity C\nidentifying rel R1 { A 1, B N total }\nidentifying rel R2 { B 1, C N total }',
      ),
    );
    for (const [rel, from, to] of [
      ['rel:R1(A,B)', 'entity:A', 'entity:B'],
      ['rel:R2(B,C)', 'entity:B', 'entity:C'],
    ] as const) {
      const r = layout.get(rel)!;
      const p = layout.get(from)!;
      const q = layout.get(to)!;
      expect(straight(p, r) && straight(r, q)).toBe(true);
      expect(
        Math.abs(p.x - r.x) < 0.01 ? Math.abs(q.x - r.x) < 0.01 : Math.abs(q.y - r.y) < 0.01,
      ).toBe(true);
    }
  });

  it('places a unary relationship right beside, above or below its entity', async () => {
    const layout = layoutDiagram(sized('entity C { code: key }\nrel P { C N, C M }'));
    expect(straight(layout.get('entity:C')!, layout.get('rel:P(C,C)')!)).toBe(true);
  });
});

describe.each(fixtures)('lines in %s', (fixture) => {
  it('never run through an attribute', async () => {
    const s = sized(readFileSync(fixturesDir + fixture, 'utf8'));
    const layout = layoutDiagram(s);
    const counts = new Map<string, number>();
    for (const link of s.diagram.links) {
      const key = `${link.relationship}|${link.entity}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const hits: string[] = [];
    for (const link of s.diagram.links) {
      if (counts.get(`${link.relationship}|${link.entity}`)! > 1) continue; // unary loops are drawn to corners
      const from = layout.get(link.entity)!;
      const to = layout.get(link.relationship)!;
      for (const [id, p] of layout) {
        if (!id.startsWith('attr:')) continue;
        const { width, height } = s.geometry.get(id)!.shape;
        if (segmentHitsBox(from, to, boxAround(p, width * 0.9, height * 0.9)))
          hits.push(`${link.id} / ${id}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('are never crossed by the line of an attribute', async () => {
    const s = sized(readFileSync(fixturesDir + fixture, 'utf8'));
    const layout = layoutDiagram(s);
    const counts = new Map<string, number>();
    for (const link of s.diagram.links) {
      const key = `${link.relationship}|${link.entity}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Attribute lines, from parent center to attribute center.
    const connectors: [string, Point, Point][] = [];
    const visit = (parent: string, attributes: AttributeNode[]) => {
      for (const a of attributes) {
        connectors.push([a.id, layout.get(parent)!, layout.get(a.id)!]);
        visit(a.id, a.children);
      }
    };
    for (const node of s.diagram.nodes) visit(node.id, node.attributes);

    const crossings: string[] = [];
    for (const link of s.diagram.links) {
      if (counts.get(`${link.relationship}|${link.entity}`)! > 1) continue;
      const p = layout.get(link.entity)!;
      const q = layout.get(link.relationship)!;
      for (const [id, a, b] of connectors)
        if (cross(p, q, a, b)) crossings.push(`${link.id} / ${id}`);
    }
    expect(crossings).toEqual([]);
  });
});

function cross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(c, d, a) * side(c, d, b) < -1e-6 && side(a, b, c) * side(a, b, d) < -1e-6;
}
