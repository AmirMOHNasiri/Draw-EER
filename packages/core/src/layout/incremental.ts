import {
  boxAround,
  boxesOverlap,
  segmentHitsShape,
  shapesOverlap,
  type Box,
} from '../geometry/collide';
import type { Point, Shape } from '../geometry/shapes';
import type { AttributeNode, MainNode } from '../model/types';
import { STYLE } from '../render/style';
import { placeAttributes } from './attributes';
import { layoutDiagram, readsRightToLeft, type Layout } from './layout';
import { isEmpty, pinAll, type Positions } from './positions';
import type { SizedDiagram } from './size';

/**
 * The layout of a diagram that has a layout file.
 *
 * Without a layout file, everything is placed by the automatic layout
 * (`auto`). Once there is one, every element in it is pinned: it stays
 * exactly where the file says, whatever the text says around it. Elements
 * not in the file yet (just added to the text) are placed around the pinned
 * ones by `placeAround`. The returned positions list every element, the new
 * ones included, so the caller can save them and pin those too.
 */
export function arrange(
  sized: SizedDiagram,
  positions: Positions,
  auto: () => Layout = () => layoutDiagram(sized),
): { layout: Layout; positions: Positions } {
  if (isEmpty(positions)) return { layout: auto(), positions };
  const layout = placeAround(sized, positions);
  const all = pinAll(sized.diagram, layout);
  // What the file says wins (it is what `layout` shows); entries for
  // elements not in the diagram stay until the caller prunes them.
  return {
    layout,
    positions: {
      nodes: { ...all.nodes, ...positions.nodes },
      attributes: { ...all.attributes, ...positions.attributes },
    },
  };
}

/** Space between a new shape and anything else. */
const SHAPE_GAP = STYLE.layout.gap;
/** Space between a new attribute and anything else. */
const ATTRIBUTE_GAP = STYLE.attributeGap.between;
/** Space between a new element and a line that passes it. */
const LINE_GAP = 8;
/** Length of a new line between shapes, outline to outline (room for a cardinality). */
const LINE = STYLE.layout.minLine + 24;
/** How much further out each ring of candidate spots for a new shape is. */
const RING_STEP = 40;
const RINGS = 12;
/** Candidates checked in full (with their attributes) before falling back to a free-space search. */
const FULL_CHECKS = 40;
/** Step of the free-space search, px. */
const SCAN_STEP = 20;
/** The 8 directions a new shape can sit in from a partner: straight ones first. */
const DIRECTIONS: Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: -1 },
];

/** Something already placed that new elements must keep clear of. */
interface Obstacle {
  id: string;
  center: Point;
  shape: Shape;
  /** The line from its owner, for an attribute. */
  connector?: [Point, Point];
}

/**
 * Places the elements missing from `positions` around the pinned ones,
 * which never move:
 *
 * 1. New attributes of a pinned shape (or composite attribute) go in its
 *    free angles, around its existing attributes.
 * 2. A new shape joined to placed shapes is tried at line-length distances
 *    in the 8 directions around each of them, then further out ring by
 *    ring. The cheapest free spot wins: short, straight lines that cross
 *    nothing. Its attributes are then fanned out; if they do not fit, the
 *    next spot is tried.
 * 3. A group of new shapes joined to nothing placed (say, a new
 *    relationship between two new entities) is laid out on its own by the
 *    automatic layout and put where it grows the drawing least.
 *
 * Nothing new may overlap anything: when no spot nearby is free, a shape
 * goes further out. New positions are whole pixels, like saved ones.
 */
export function placeAround(sized: SizedDiagram, positions: Positions): Layout {
  return new Placer(sized, positions).run();
}

class Placer {
  private readonly layout: Layout = new Map();
  private readonly obstacles: Obstacle[] = [];
  /** Relationship lines between placed shapes, center to center. */
  private readonly lines: [Point, Point][] = [];
  private readonly partners = new Map<string, string[]>();
  private readonly rtl: boolean;

  constructor(
    private readonly sized: SizedDiagram,
    private readonly positions: Positions,
  ) {
    this.rtl = readsRightToLeft(sized);
    for (const node of sized.diagram.nodes) this.partners.set(node.id, []);
    for (const link of sized.diagram.links) {
      this.partners.get(link.entity)?.push(link.relationship);
      this.partners.get(link.relationship)?.push(link.entity);
    }
  }

  run(): Layout {
    const { nodes } = this.sized.diagram;
    const pinned = nodes.filter((n) => this.positions.nodes[n.id]);
    for (const node of pinned) this.put(node.id, round(this.positions.nodes[node.id]!));

    // Pinned attributes; the new ones wait for their owner's turn.
    const waiting: { ownerId: string; attributes: AttributeNode[] }[] = [];
    const visit = (ownerId: string, attributes: AttributeNode[]) => {
      const fresh: AttributeNode[] = [];
      for (const attribute of attributes) {
        const offset = this.positions.attributes[attribute.id];
        if (!offset) {
          fresh.push(attribute);
          continue;
        }
        this.put(attribute.id, add(this.layout.get(ownerId)!, offset), ownerId);
        visit(attribute.id, attribute.children);
      }
      if (fresh.length > 0) waiting.push({ ownerId, attributes: fresh });
    };
    for (const node of pinned) visit(node.id, node.attributes);
    this.addLines();

    // 1. New attributes of pinned owners.
    for (const { ownerId, attributes } of waiting) this.placeAttributesOf(ownerId, attributes);

    // 2 and 3. New shapes: those joined to the most placed shapes first.
    for (;;) {
      const unplaced = nodes.filter((n) => !this.layout.has(n.id));
      if (unplaced.length === 0) break;
      const placedPartners = (n: MainNode) =>
        new Set(this.partners.get(n.id)!.filter((p) => this.layout.has(p))).size;
      let next = unplaced[0]!;
      for (const n of unplaced) if (placedPartners(n) > placedPartners(next)) next = n;
      if (placedPartners(next) > 0) this.placeShape(next);
      else this.placeGroup(next);
      this.addLines();
    }
    return this.layout;
  }

  // -------------------------------------------------------------------------
  // New shapes
  // -------------------------------------------------------------------------

  private placeShape(node: MainNode): void {
    const shape = this.shapeOf(node.id);
    const partners = [...new Set(this.partners.get(node.id)!.filter((p) => this.layout.has(p)))];
    const scored = this.candidates(node.id, partners)
      .filter((c) => this.isFree(c, shape, SHAPE_GAP))
      .map((c) => ({ c, cost: this.cost(node.id, c, partners) }))
      .sort((a, b) => a.cost - b.cost);
    for (const { c } of scored.slice(0, FULL_CHECKS)) {
      const cluster = this.fanAt(node, c, partners);
      if (cluster) {
        this.commit(node, c, cluster);
        return;
      }
    }
    // Nothing free nearby: the free spot closest to the partners, with the
    // attributes fanned out as if alone.
    const target = centroid(partners.map((p) => this.layout.get(p)!));
    const origin = { x: 0, y: 0 };
    const alone = this.fanAt(node, origin, [], false)!;
    const offset = round(
      this.freeOffset([{ id: node.id, center: origin, shape }, ...alone], (o) =>
        distance(o, target),
      ),
    );
    this.commit(node, offset, shiftItems(alone, offset));
  }

  /** Spots for a new shape: line-length distances around each placed partner, ring by ring. */
  private candidates(id: string, partners: string[]): Point[] {
    const shape = this.shapeOf(id);
    const result: Point[] = [];
    for (const partner of partners) {
      const p = this.layout.get(partner)!;
      const ps = this.shapeOf(partner);
      const reachX = ps.width / 2 + shape.width / 2 + LINE;
      const reachY = ps.height / 2 + shape.height / 2 + LINE;
      for (let ring = 0; ring <= RINGS; ring++) {
        for (const d of DIRECTIONS) {
          const k = d.x !== 0 && d.y !== 0 ? Math.SQRT1_2 : 1;
          result.push(
            round({
              x: p.x + d.x * (reachX * k + ring * RING_STEP),
              y: p.y + d.y * (reachY * k + ring * RING_STEP),
            }),
          );
        }
      }
    }
    // Between two partners: a new relationship between two placed entities.
    for (let i = 0; i < partners.length; i++) {
      for (let j = i + 1; j < partners.length; j++) {
        result.push(
          round(centroid([this.layout.get(partners[i]!)!, this.layout.get(partners[j]!)!])),
        );
      }
    }
    return result;
  }

  /** Lower is better: short, straight lines that cross nothing and run through no shape. */
  private cost(id: string, c: Point, partners: string[]): number {
    let cost = 0;
    for (const partner of partners) {
      const p = this.layout.get(partner)!;
      cost += distance(c, p);
      if (Math.abs(c.x - p.x) > 0.5 && Math.abs(c.y - p.y) > 0.5) cost += 80;
      for (const [a, b] of this.lines) if (cross(c, p, a, b)) cost += 300;
      for (const o of this.obstacles) {
        if (o.id === partner || o.id === id) continue;
        if (o.connector && cross(c, p, o.connector[0], o.connector[1])) cost += 300;
        if (segmentHitsShape(c, p, o.shape, o.center)) cost += 2000;
      }
    }
    return cost;
  }

  /**
   * Fans out the attributes of a new shape at `c`, around everything placed.
   * Returns them (absolute), or null if one would overlap something. With
   * `check` false, they are fanned out with nothing around (for the
   * free-space fallback, relative to the shape).
   */
  private fanAt(node: MainNode, c: Point, partners: string[], check = true): Obstacle[] | null {
    if (node.attributes.length === 0) return [];
    const shape = this.shapeOf(node.id);
    const arms = partners.map((p) => angle(c, this.layout.get(p)!));
    const relative = (p: Point) => sub(p, c);
    const lines = check
      ? [
          ...partners.map((p): [Point, Point] => [{ x: 0, y: 0 }, relative(this.layout.get(p)!)]),
          ...this.lines.map(([a, b]): [Point, Point] => [relative(a), relative(b)]),
        ]
      : [];
    const cluster = placeAttributes(shape, node.attributes, arms, this.sized.geometry, lines, {
      rtl: this.rtl,
      partners: arms,
      ...(check ? { occupied: this.occupiedAround(c) } : {}),
    });
    const placed = this.attributeItems(node.attributes, c, cluster.positions, round);
    if (check && placed.some((item) => !this.isFree(item.center, item.shape, ATTRIBUTE_GAP))) {
      return null;
    }
    return placed;
  }

  private commit(node: MainNode, c: Point, attributes: Obstacle[]): void {
    this.put(node.id, c);
    for (const item of attributes) {
      this.layout.set(item.id, item.center);
      this.obstacles.push(item);
    }
  }

  /**
   * A group of new shapes joined to nothing placed: laid out on its own,
   * then moved to the free spot where the drawing grows least.
   */
  private placeGroup(start: MainNode): void {
    const ids = new Set([start.id]);
    for (const queue = [start.id]; queue.length > 0;) {
      for (const p of this.partners.get(queue.pop()!)!) {
        if (!ids.has(p) && !this.layout.has(p)) {
          ids.add(p);
          queue.push(p);
        }
      }
    }
    const { diagram } = this.sized;
    const group: SizedDiagram = {
      ...this.sized,
      diagram: {
        nodes: diagram.nodes.filter((n) => ids.has(n.id)),
        links: diagram.links.filter((l) => ids.has(l.entity) && ids.has(l.relationship)),
      },
    };
    const own = layoutDiagram(group);
    const items: Obstacle[] = [...own].map(([id, center]) => ({
      id,
      center,
      shape: this.shapeOf(id),
    }));
    const drawn = this.bounds();
    const offset = round(
      this.freeOffset(items, (o) => {
        // Area of the drawing with the group added: a free corner costs nothing.
        const b = shift(boundsOf(items), o);
        const width = Math.max(drawn.maxX, b.maxX) - Math.min(drawn.minX, b.minX);
        const height = Math.max(drawn.maxY, b.maxY) - Math.min(drawn.minY, b.minY);
        return width * height;
      }),
    );
    for (const node of group.diagram.nodes) {
      this.put(node.id, round(add(own.get(node.id)!, offset)));
      const visit = (ownerId: string, attributes: AttributeNode[]) => {
        for (const a of attributes) {
          const relative = round(sub(own.get(a.id)!, own.get(ownerId)!));
          this.put(a.id, add(this.layout.get(ownerId)!, relative), ownerId);
          visit(a.id, a.children);
        }
      };
      visit(node.id, node.attributes);
    }
  }

  // -------------------------------------------------------------------------
  // New attributes of placed owners
  // -------------------------------------------------------------------------

  /** Fans out new attributes of a placed shape or composite attribute, around everything placed. */
  private placeAttributesOf(ownerId: string, attributes: AttributeNode[]): void {
    const c = this.layout.get(ownerId)!;
    const relative = (p: Point) => sub(p, c);
    const owner = this.obstacles.find((o) => o.id === ownerId)!;
    // The directions lines leave the owner in: to its partners, or to its own owner.
    const arms = owner.connector
      ? [angle(c, owner.connector[0])]
      : (this.partners.get(ownerId) ?? [])
          .filter((p) => this.layout.has(p))
          .map((p) => angle(c, this.layout.get(p)!));
    const lines = this.lines.map(([a, b]): [Point, Point] => [relative(a), relative(b)]);
    const cluster = placeAttributes(owner.shape, attributes, arms, this.sized.geometry, lines, {
      rtl: this.rtl,
      partners: arms,
      occupied: this.occupiedAround(c, ownerId),
    });
    for (const attribute of attributes) {
      // Each one with its children, at the nearest free spot around the owner.
      const proposed = this.attributeItems([attribute], c, cluster.positions, round);
      for (const item of this.nearestFreeSpot(proposed, ownerId, c, owner.shape)) {
        this.layout.set(item.id, item.center);
        this.obstacles.push(item);
      }
    }
  }

  /**
   * Where a new attribute (with its children) goes around a placed owner:
   * the nearest free spot, tried every 5° from just clear of the owner
   * outward, preferring the fan's direction (where the fan put it counts
   * too). A spot is free if the attribute keeps clear of everything and
   * its line to the owner crosses no other line and runs through no shape.
   */
  private nearestFreeSpot(items: Obstacle[], ownerId: string, c: Point, ownerShape: Shape) {
    const ids = new Set(items.map((i) => i.id));
    const fits = (moved: Obstacle[]) => {
      if (!moved.every((item) => this.isFree(item.center, item.shape, ATTRIBUTE_GAP))) return false;
      const end = moved[0]!.center;
      const crossed = (line: [Point, Point]) => cross(c, end, line[0], line[1]);
      return (
        !this.lines.some(crossed) &&
        !this.obstacles.some(
          (o) =>
            (o.connector && crossed(o.connector)) ||
            (o.id !== ownerId && !ids.has(o.id) && segmentHitsShape(c, end, o.shape, o.center)),
        )
      );
    };
    const top = items[0]!;
    const preferred = angle(c, top.center);
    // The fan's spot competes on distance like any other: it can be far out.
    let best: Obstacle[] | null = fits(items) ? items : null;
    let bestCost = best ? distance(c, top.center) : Infinity;
    for (let i = 0; i < 72; i++) {
      const t = (i / 72) * 2 * Math.PI;
      const u = { x: Math.cos(t), y: Math.sin(t) };
      let r = 0;
      while (
        shapesOverlap(ownerShape, c, top.shape, add(c, scale(u, r)), STYLE.attributeGap.fromOwner)
      ) {
        r += 4;
      }
      for (let ring = 0; ring < 15; ring++, r += SCAN_STEP) {
        const cost = r + 40 * angleBetween(t, preferred);
        if (cost >= bestCost) break;
        const moved = shiftItems(items, round(sub(add(c, scale(u, r)), top.center)), c);
        if (fits(moved)) {
          [best, bestCost] = [moved, cost];
          break;
        }
      }
    }
    if (best) return best;
    // Nowhere near: straight out from the owner until it is clear.
    const away = unit(sub(top.center, c));
    let moved = items;
    for (let step = SCAN_STEP; step <= 2000 && !fits(moved); step += SCAN_STEP) {
      moved = shiftItems(items, round(scale(away, step)), c);
    }
    return moved;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** The attributes (and their children) at `c` + their offsets, as obstacles with their lines. */
  private attributeItems(
    attributes: AttributeNode[],
    c: Point,
    offsets: Map<string, Point>,
    snapTo: (p: Point) => Point,
  ): Obstacle[] {
    const items: Obstacle[] = [];
    const visit = (parent: Point, list: AttributeNode[]) => {
      for (const a of list) {
        const center = add(c, snapTo(offsets.get(a.id)!));
        items.push({ id: a.id, center, shape: this.shapeOf(a.id), connector: [parent, center] });
        visit(center, a.children);
      }
    };
    visit(c, attributes);
    return items;
  }

  /** Everything placed, relative to `c`, as `placeAttributes` takes it. */
  private occupiedAround(c: Point, except?: string) {
    const relative = (p: Point) => sub(p, c);
    return this.obstacles
      .filter((o) => o.id !== except)
      .map((o) => ({
        center: relative(o.center),
        shape: o.shape,
        ...(o.connector
          ? { connector: [relative(o.connector[0]), relative(o.connector[1])] as [Point, Point] }
          : {}),
      }));
  }

  /**
   * True if a new element at `center` keeps `gap` from every placed element
   * and no line runs through it: neither a relationship line nor the line
   * to an attribute.
   */
  private isFree(center: Point, shape: Shape, gap: number): boolean {
    if (this.obstacles.some((o) => shapesOverlap(shape, center, o.shape, o.center, gap))) {
      return false;
    }
    const grown = { ...shape, width: shape.width + LINE_GAP, height: shape.height + LINE_GAP };
    const hit = ([a, b]: [Point, Point]) => segmentHitsShape(a, b, grown, center);
    return !this.lines.some(hit) && !this.obstacles.some((o) => o.connector && hit(o.connector));
  }

  /**
   * The offset for `items` (centered on 0, 0) with the lowest `cost` among
   * those where none of them comes near anything placed. Searched on a grid
   * over the drawing and a margin around it, which always has room.
   */
  private freeOffset(items: Obstacle[], cost: (offset: Point) => number): Point {
    const drawn = this.bounds();
    const own = boundsOf(items);
    const margin = STYLE.layout.componentSpacing;
    let best: Point | null = null;
    let bestCost = Infinity;
    const boxes = this.obstacles.map((o) => boxAround(o.center, o.shape.width, o.shape.height));
    for (
      let x = drawn.minX - own.maxX - margin;
      x <= drawn.maxX - own.minX + margin;
      x += SCAN_STEP
    ) {
      for (
        let y = drawn.minY - own.maxY - margin;
        y <= drawn.maxY - own.minY + margin;
        y += SCAN_STEP
      ) {
        const offset = { x, y };
        const value = cost(offset);
        if (value >= bestCost) continue;
        const clear = items.every((item) => {
          const box = boxAround(
            add(item.center, offset),
            item.shape.width,
            item.shape.height,
            margin / 2,
          );
          return boxes.every((b) => !boxesOverlap(box, b));
        });
        if (clear) [best, bestCost] = [offset, value];
      }
    }
    return best ?? { x: drawn.maxX - own.minX + margin, y: drawn.minY - own.minY };
  }

  /** Bounds of everything placed (a point at 0, 0 when nothing is). */
  private bounds(): Box {
    return this.obstacles.length > 0
      ? boundsOf(this.obstacles)
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  private put(id: string, center: Point, ownerId?: string): void {
    this.layout.set(id, center);
    const owner = ownerId === undefined ? undefined : this.layout.get(ownerId)!;
    this.obstacles.push({
      id,
      center,
      shape: this.shapeOf(id),
      ...(owner ? { connector: [owner, center] as [Point, Point] } : {}),
    });
  }

  /** Records the relationship lines whose two ends are now placed. */
  private addLines(): void {
    this.lines.length = 0;
    for (const link of this.sized.diagram.links) {
      const a = this.layout.get(link.entity);
      const b = this.layout.get(link.relationship);
      if (a && b && link.entity !== link.relationship) this.lines.push([a, b]);
    }
  }

  private shapeOf(id: string): Shape {
    return this.sized.geometry.get(id)!.shape;
  }
}

/**
 * Attributes (from `attributeItems`) moved by `offset`, with their lines.
 * If their owner stays where it is (`fixedOwner`), the lines from it start
 * there; otherwise every line moves along.
 */
function shiftItems(items: Obstacle[], offset: Point, fixedOwner?: Point): Obstacle[] {
  return items.map((item) => {
    const [from] = item.connector!;
    const center = add(item.center, offset);
    const start = from === fixedOwner ? from : add(from, offset);
    return { ...item, center, connector: [start, center] };
  });
}

function boundsOf(items: Obstacle[]): Box {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { center, shape } of items) {
    b.minX = Math.min(b.minX, center.x - shape.width / 2);
    b.maxX = Math.max(b.maxX, center.x + shape.width / 2);
    b.minY = Math.min(b.minY, center.y - shape.height / 2);
    b.maxY = Math.max(b.maxY, center.y + shape.height / 2);
  }
  return b;
}

function shift(b: Box, o: Point): Box {
  return { minX: b.minX + o.x, maxX: b.maxX + o.x, minY: b.minY + o.y, maxY: b.maxY + o.y };
}

/** True if two segments cross at a point inside both. */
function cross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(c, d, a) * side(c, d, b) < -1e-6 && side(a, b, c) * side(a, b, d) < -1e-6;
}

function centroid(points: Point[]): Point {
  const n = points.length || 1;
  return {
    x: points.reduce((s, p) => s + p.x, 0) / n,
    y: points.reduce((s, p) => s + p.y, 0) / n,
  };
}

/** The smaller angle between two directions, 0 to π. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

function angle(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function unit(p: Point): Point {
  const length = Math.hypot(p.x, p.y);
  return length === 0 ? { x: 0, y: -1 } : { x: p.x / length, y: p.y / length };
}

function add(p: Point, q: Point): Point {
  return { x: p.x + q.x, y: p.y + q.y };
}

function sub(p: Point, q: Point): Point {
  return { x: p.x - q.x, y: p.y - q.y };
}

function scale(p: Point, k: number): Point {
  return { x: p.x * k, y: p.y * k };
}

function round(p: Point): Point {
  return { x: Math.round(p.x) + 0, y: Math.round(p.y) + 0 };
}

function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** Space kept between a dragged shape and other shapes. */
const DRAG_GAP = 4;

/**
 * Where a dragged shape may go: `to`, or the nearest spot to it where the
 * shape does not overlap another shape. Shapes never overlap, even when the
 * user drags one onto another; attributes are not pushed away, since they
 * are easy to move aside afterwards.
 */
export function clearOfShapes(sized: SizedDiagram, layout: Layout, id: string, to: Point): Point {
  const { nodes } = sized.diagram;
  if (!nodes.some((n) => n.id === id)) return to;
  const shape = sized.geometry.get(id)!.shape;
  const others = nodes
    .filter((n) => n.id !== id && layout.has(n.id))
    .map((n) => ({ center: layout.get(n.id)!, shape: sized.geometry.get(n.id)!.shape }));
  const free = (c: Point) =>
    others.every((o) => !shapesOverlap(shape, c, o.shape, o.center, DRAG_GAP));
  if (free(to)) return to;
  // Rings of growing radius, 32 directions each; the first free spot is the nearest.
  for (let r = 4; r <= 600; r += 4) {
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * 2 * Math.PI;
      const c = { x: to.x + r * Math.cos(t), y: to.y + r * Math.sin(t) };
      if (free(c)) return c;
    }
  }
  return to;
}
