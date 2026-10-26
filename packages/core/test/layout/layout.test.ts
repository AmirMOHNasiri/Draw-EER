import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDiagram, layoutDiagram, parse, sizeDiagram } from '../../src';
import type { AttributeNode, SizedDiagram, TextMeasurer } from '../../src';
import { createNodeMeasurer } from '../../src/node';
import { boxAround, boxesOverlap } from '../../src/geometry/collide';

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
    const layout = await layoutDiagram(s);
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
    const first = await layoutDiagram(sized(source));
    const second = await layoutDiagram(sized(source));
    expect([...second]).toEqual([...first]);
  });
});

describe('attribute placement', () => {
  it('keeps the attributes of a composite key side by side on one row', async () => {
    const s = sized('entity C { (code, term, section): key, title }');
    const layout = await layoutDiagram(s);
    const ys = ['code', 'term', 'section'].map((n) => layout.get(`attr:entity:C/${n}`)!.y);
    expect(new Set(ys).size).toBe(1);
    const xs = ['code', 'term', 'section'].map((n) => layout.get(`attr:entity:C/${n}`)!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('places composite children further from the owner than their parent', async () => {
    const s = sized('entity E { name { first, last } }');
    const layout = await layoutDiagram(s);
    const owner = layout.get('entity:E')!;
    const distance = (id: string) => {
      const p = layout.get(id)!;
      return Math.hypot(p.x - owner.x, p.y - owner.y);
    };
    const parent = distance('attr:entity:E/name');
    expect(distance('attr:attr:entity:E/name/first')).toBeGreaterThan(parent);
    expect(distance('attr:attr:entity:E/name/last')).toBeGreaterThan(parent);
  });

  it('keeps attributes off the line of a binary relationship', async () => {
    const s = sized('entity A { a1, a2, a3 }\nentity B { b1, b2 }\nrel R { A, B, attrs { r1 } }');
    const layout = await layoutDiagram(s);
    // Relationship lines run left to right, so nothing sits between A and R or R and B.
    const a = layout.get('entity:A')!;
    const r = layout.get('rel:R(A,B)')!;
    const b = layout.get('entity:B')!;
    expect(a.x).toBeLessThan(r.x);
    expect(r.x).toBeLessThan(b.x);
    for (const [id, p] of layout) {
      if (!id.startsWith('attr:')) continue;
      const between = p.x > a.x && p.x < b.x && Math.abs(p.y - r.y) < 20;
      expect(between, id).toBe(false);
    }
  });
});
