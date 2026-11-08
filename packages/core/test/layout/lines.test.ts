/**
 * Rules for lines as they are drawn (`drawnLines`: every stroke of every
 * line, attribute lines and recursive loops included), on every fixture:
 *
 * - no line passes through or touches a shape, circle or attribute it does
 *   not join;
 * - nothing sits inside the loop of a recursive relationship;
 * - no two lines run along each other, close and almost parallel, where they
 *   could be read as one line or a double line;
 * - every subset symbol keeps `STYLE.subset.gap` from every outline;
 * - a line meets a box on a side, past its rounded corners;
 * - a line down a tree slopes at least `STYLE.tree.minSlope`;
 * - a line keeps `STYLE.lineClearance` from every shape and circle it passes,
 *   and a relationship or tree line from every attribute it passes (lines
 *   inside an attribute fan are not held to it yet).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDiagram, drawnLines, layoutDiagram, parse, renderSvg, sizeDiagram } from '../../src';
import type { AttributeNode, DrawnLine, Layout, SizedDiagram, TextMeasurer } from '../../src';
import { contains, type Point, type Shape } from '../../src/geometry/shapes';
import { createNodeMeasurer } from '../../src/node';
import { findHierarchies } from '../../src/layout/tree';
import { STYLE } from '../../src/render/style';
import { itUnlessKnown } from '../known-issues';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.eer'));

/** A line closer than this to a shape it does not join touches it, px. */
const TOUCH = 1.5;
/** Lines closer than this to each other, px, and within `ALONG_ANGLE` of parallel... */
const ALONG_DISTANCE = 6;
const ALONG_ANGLE = (10 * Math.PI) / 180;
/** ...for at least this long, px, run along each other. */
const ALONG_LENGTH = 15;

let measurer: TextMeasurer;
beforeAll(async () => {
  measurer = await createNodeMeasurer();
});

interface Drawn {
  sized: SizedDiagram;
  layout: Layout;
  lines: DrawnLine[];
  /** Every element with its outline: shapes, circles and attributes. */
  elements: { id: string; shape: Shape; center: Point }[];
}

const cache = new Map<string, Drawn>();
function draw(fixture: string): Drawn {
  if (cache.has(fixture)) return cache.get(fixture)!;
  const source = readFileSync(fixturesDir + fixture, 'utf8');
  const sized = sizeDiagram(buildDiagram(parse(source).file), measurer);
  const layout = layoutDiagram(sized);
  const elements: Drawn['elements'] = [];
  const visit = (attributes: AttributeNode[]) => {
    for (const a of attributes) {
      elements.push({
        id: a.id,
        shape: sized.geometry.get(a.id)!.shape,
        center: layout.get(a.id)!,
      });
      visit(a.children);
    }
  };
  for (const node of sized.diagram.nodes) {
    // The point where an unmarked specialization splits is not drawn.
    if (!(node.kind === 'circle' && node.symbol === null)) {
      elements.push({
        id: node.id,
        shape: sized.geometry.get(node.id)!.shape,
        center: layout.get(node.id)!,
      });
    }
    visit(node.attributes);
  }
  const drawn = { sized, layout, lines: drawnLines(sized, layout), elements };
  cache.set(fixture, drawn);
  return drawn;
}

/** True if the segment comes within `margin` of the shape (sampled every pixel). */
function touches(a: Point, b: Point, shape: Shape, center: Point, margin: number): boolean {
  const grown = { ...shape, width: shape.width + 2 * margin, height: shape.height + 2 * margin };
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(length));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (contains(grown, center, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }))
      return true;
  }
  return false;
}

function inPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = [polygon[i]!, polygon[j]!];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Points around a shape's outline (`count` of them), and its center. */
function samples(shape: Shape, center: Point, count = 32): Point[] {
  const points = [center];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * 2 * Math.PI;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    const k =
      shape.kind === 'ellipse'
        ? 1
        : shape.kind === 'diamond'
          ? 1 / (Math.abs(c) + Math.abs(s))
          : 1 / Math.max(Math.abs(c), Math.abs(s));
    points.push({
      x: center.x + (shape.width / 2) * c * k,
      y: center.y + (shape.height / 2) * s * k,
    });
  }
  return points;
}

const key = (joins: [string, string]) => [...joins].sort().join('|');

/** Distance from a point outside a shape to its outline (0 inside). */
function outlineDistance(shape: Shape, center: Point, p: Point): number {
  if (contains(shape, center, p)) return 0;
  const [a, b] = [shape.width / 2, shape.height / 2];
  const [x, y] = [Math.abs(p.x - center.x), Math.abs(p.y - center.y)];
  if (shape.kind === 'rect') return Math.hypot(Math.max(0, x - a), Math.max(0, y - b));
  // A diamond's edge, or an ellipse's outline sampled finely: the nearest point.
  const outline =
    shape.kind === 'diamond'
      ? Array.from({ length: 201 }, (_, i) => ({ x: (a * i) / 200, y: b * (1 - i / 200) }))
      : Array.from({ length: 201 }, (_, i) => {
          const t = (i / 200) * (Math.PI / 2);
          return { x: a * Math.cos(t), y: b * Math.sin(t) };
        });
  return Math.min(...outline.map((q) => Math.hypot(x - q.x, y - q.y)));
}

describe.each(fixtures)('drawn lines in %s', (fixture) => {
  it('never pass through or touch a shape, circle or attribute they do not join', () => {
    const { lines, elements } = draw(fixture);
    const hits: string[] = [];
    for (const line of lines) {
      for (const e of elements) {
        if (line.joins.includes(e.id)) continue;
        if (touches(line.from, line.to, e.shape, e.center, TOUCH)) {
          hits.push(`${line.joins.join(' – ')} / ${e.id}`);
        }
      }
    }
    expect([...new Set(hits)]).toEqual([]);
  });

  it('leave the loop of a recursive relationship empty', () => {
    const { lines, elements } = draw(fixture);
    const loops = new Map<string, DrawnLine[]>();
    for (const line of lines) {
      if (line.kind !== 'link') continue;
      loops.set(key(line.joins), [...(loops.get(key(line.joins)) ?? []), line]);
    }
    const inside: string[] = [];
    for (const pair of loops.values()) {
      // A recursive relationship: two lines between the same entity and diamond.
      const [first, second] = pair;
      if (pair.length !== 2 || !first || !second || first.joins[0] !== second.joins[0]) continue;
      const loop = [first.from, first.to, second.to, second.from];
      for (const e of elements) {
        if (first.joins.includes(e.id)) continue;
        if (samples(e.shape, e.center).some((p) => inPolygon(p, loop))) {
          inside.push(`${first.joins.join(' – ')} / ${e.id}`);
        }
      }
    }
    expect(inside).toEqual([]);
  });

  it('never run along each other', () => {
    const { lines } = draw(fixture);
    const along: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const [p, q] = [lines[i]!, lines[j]!];
        // The strokes of a double line, a loop's two lines, parallel lines
        // between the same two shapes: meant to be side by side.
        if (key(p.joins) === key(q.joins)) continue;
        if (runAlong(p, q)) along.push(`${p.joins.join(' – ')} / ${q.joins.join(' – ')}`);
      }
    }
    expect(along).toEqual([]);
  });

  // A shared subtype's lines from its second and later supertypes (EER lines
  // between shapes of one tree that are not its edges) only need
  // `STYLE.tree.sharedSlope`.
  itUnlessKnown(fixture, 'slope')('slope down a tree at least STYLE.tree.minSlope', () => {
    const { sized, lines } = draw(fixture);
    const eer = sized.diagram.links.filter(
      (l) => l.kind === 'specialization' || l.kind === 'category' || l.kind === 'partOf',
    );
    const shared = new Set<string>();
    for (const h of findHierarchies(sized.diagram)) {
      const edges = new Set<string>();
      for (const [parent, kids] of h.children)
        for (const kid of kids) edges.add(key([parent, kid]));
      for (const [kid, parents] of h.above) for (const p of parents) edges.add(key([p, kid]));
      for (const l of eer) {
        const inTree = h.members.includes(l.from) && h.members.includes(l.to);
        if (l.kind !== 'partOf' && inTree && !edges.has(key([l.from, l.to])))
          shared.add(key([l.from, l.to]));
      }
    }
    const tree = new Set(eer.map((l) => key([l.from, l.to])));
    const flat: string[] = [];
    for (const line of lines) {
      if (line.kind !== 'link' || !tree.has(key(line.joins))) continue;
      const [dx, dy] = [Math.abs(line.to.x - line.from.x), Math.abs(line.to.y - line.from.y)];
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const least = shared.has(key(line.joins)) ? STYLE.tree.sharedSlope : STYLE.tree.minSlope;
      if (angle < least - 0.5) flat.push(`${line.joins.join(' – ')} ${angle.toFixed(1)}°`);
    }
    expect([...new Set(flat)]).toEqual([]);
  });

  it('pass every attribute by at least STYLE.lineClearance (relationship and tree lines)', () => {
    const { sized, lines, elements } = draw(fixture);
    const attributes = elements.filter((e) => !sized.diagram.nodes.some((n) => n.id === e.id));
    const close: string[] = [];
    for (const line of lines) {
      if (line.kind !== 'link') continue;
      const length = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
      for (const e of attributes) {
        let distance = Infinity;
        for (let i = 0, n = Math.ceil(length); i <= n; i++) {
          const t = i / n;
          const point = {
            x: line.from.x + (line.to.x - line.from.x) * t,
            y: line.from.y + (line.to.y - line.from.y) * t,
          };
          distance = Math.min(distance, outlineDistance(e.shape, e.center, point));
        }
        if (distance < STYLE.lineClearance - 0.5)
          close.push(`${line.joins.join(' – ')} / ${e.id} ${distance.toFixed(1)}`);
      }
    }
    expect([...new Set(close)]).toEqual([]);
  });

  itUnlessKnown(fixture, 'clearance')(
    'pass every shape and circle by at least STYLE.lineClearance',
    () => {
      const { sized, lines, elements } = draw(fixture);
      const shapes = elements.filter((e) => sized.diagram.nodes.some((n) => n.id === e.id));
      const close: string[] = [];
      for (const line of lines) {
        if (line.kind !== 'link') continue;
        const length = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
        for (const e of shapes) {
          if (line.joins.includes(e.id)) continue;
          let distance = Infinity;
          for (let i = 0, n = Math.ceil(length); i <= n; i++) {
            const t = i / n;
            const point = {
              x: line.from.x + (line.to.x - line.from.x) * t,
              y: line.from.y + (line.to.y - line.from.y) * t,
            };
            distance = Math.min(distance, outlineDistance(e.shape, e.center, point));
          }
          if (distance < STYLE.lineClearance - 0.5)
            close.push(`${line.joins.join(' – ')} / ${e.id} ${distance.toFixed(1)}`);
        }
      }
      expect([...new Set(close)]).toEqual([]);
    },
  );

  it('meet a box on a side, never on a rounded corner', () => {
    const { lines, elements } = draw(fixture);
    const boxes = new Map(elements.filter((e) => e.shape.kind === 'rect').map((e) => [e.id, e]));
    const corners: string[] = [];
    for (const line of lines) {
      if (line.kind !== 'link') continue;
      for (const end of [line.from, line.to]) {
        for (const id of line.joins) {
          const box = boxes.get(id);
          if (!box) continue;
          const [a, b] = [box.shape.width / 2, box.shape.height / 2];
          const [x, y] = [Math.abs(end.x - box.center.x), Math.abs(end.y - box.center.y)];
          // On or just off the outline (one stroke of a double line), within
          // the rounded corner's reach of both sides.
          const r = STYLE.entity.cornerRadius;
          if (x <= a + 3 && y <= b + 3 && x > a - r && y > b - r)
            corners.push(`${line.joins.join(' – ')} at ${id}`);
        }
      }
    }
    expect(corners).toEqual([]);
  });

  it('keep every subset symbol clear of every outline', () => {
    const { sized, layout, elements } = draw(fixture);
    const n = String.raw`(-?[\d.]+)`;
    const pattern = new RegExp(
      `<path class="line" d="M${n},${n} A${n},${n} 0 0 ([01]) ${n},${n}"`,
      'g',
    );
    const close: string[] = [];
    for (const m of renderSvg(sized, layout).matchAll(pattern)) {
      const [px, py, r, , sweep, qx, qy] = m.slice(1).map(Number) as number[];
      // The half circle from p to q, as SVG draws it (sweep 1: increasing angle).
      const center = { x: (px! + qx!) / 2, y: (py! + qy!) / 2 };
      const from = Math.atan2(py! - center.y, px! - center.x);
      const arc = Array.from({ length: 25 }, (_, i) => {
        const a = from + (sweep ? 1 : -1) * Math.PI * (i / 24);
        return { x: center.x + r! * Math.cos(a), y: center.y + r! * Math.sin(a) };
      });
      for (const e of elements) {
        const outline = samples(e.shape, e.center, 720).slice(1);
        const distance = Math.min(
          ...arc.flatMap((a) => outline.map((o) => Math.hypot(a.x - o.x, a.y - o.y))),
        );
        if (distance < STYLE.subset.gap) close.push(`${m[0]} / ${e.id} ${distance.toFixed(1)}`);
      }
    }
    expect(close).toEqual([]);
  });
});

/**
 * True if `q` runs within `ALONG_DISTANCE` of `p`, within `ALONG_ANGLE` of
 * its direction, over at least `ALONG_LENGTH` of it.
 */
function runAlong(p: DrawnLine, q: DrawnLine): boolean {
  const d = { x: p.to.x - p.from.x, y: p.to.y - p.from.y };
  const length = Math.hypot(d.x, d.y);
  const e = { x: q.to.x - q.from.x, y: q.to.y - q.from.y };
  const other = Math.hypot(e.x, e.y);
  if (length < ALONG_LENGTH || other < ALONG_LENGTH) return false;
  const cos = Math.abs(d.x * e.x + d.y * e.y) / (length * other);
  if (cos < Math.cos(ALONG_ANGLE)) return false;
  const u = { x: d.x / length, y: d.y / length };
  // q's ends, in p's frame: along p and across it.
  const frame = (r: Point) => {
    const v = { x: r.x - p.from.x, y: r.y - p.from.y };
    return { along: v.x * u.x + v.y * u.y, across: v.x * -u.y + v.y * u.x };
  };
  const [a, b] = [frame(q.from), frame(q.to)];
  // The stretch where both lines are, and how far apart they are there.
  const lo = Math.max(0, Math.min(a.along, b.along));
  const hi = Math.min(length, Math.max(a.along, b.along));
  if (hi - lo < ALONG_LENGTH) return false;
  const acrossAt = (t: number) =>
    a.across + ((b.across - a.across) * (t - a.along)) / (b.along - a.along || 1);
  return Math.abs(acrossAt(lo)) < ALONG_DISTANCE && Math.abs(acrossAt(hi)) < ALONG_DISTANCE;
}
