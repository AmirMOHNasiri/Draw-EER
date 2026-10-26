import type { Point } from '../geometry/shapes';
import type { MainNode } from '../model/types';
import { STYLE } from '../render/style';
import { placeAttributes, type AttributeCluster, type Bounds } from './attributes';
import { placeOnGrid, type Cell } from './grid';
import type { SizedDiagram } from './size';

/** Most rounds of arranging attributes and spacing the grid (see `layoutPart`). */
const MAX_ROUNDS = 5;

/** Center of every node and attribute, by id. */
export type Layout = Map<string, Point>;

/**
 * Automatic layout.
 *
 * 1. Entities and relationships go into grid cells (see grid.ts), so that
 *    related shapes line up in rows and columns.
 * 2. Each shape's attributes are fanned out in the directions its lines
 *    leave free (see attributes.ts).
 * 3. Grid rows and columns become pixel positions. Shapes in one row share
 *    one center line (and likewise for columns), so lines between them are
 *    perfectly straight. Rows and columns are then pushed as close together
 *    as the shapes, attributes and lines that actually face each other
 *    allow ("compaction"), so one tall attribute fan does not stretch the
 *    whole row.
 * 4. Diagonal lines change angle in step 3, so attributes are placed once
 *    more with the real angles and step 3 repeats.
 *
 * Separate parts of the diagram (shapes with no line between them) are laid
 * out on their own and then packed side by side in rows.
 *
 * ELK's layered algorithm was used before this. It makes every line run in
 * one main direction, so it cannot put a participant above a relationship
 * (as in a ternary relationship's third arm), which textbook figures do all
 * the time.
 */
export function layoutDiagram(sized: SizedDiagram): Layout {
  const parts = placeOnGrid(sized.diagram).map((cells) => layoutPart(sized, cells));
  return pack(parts);
}

interface Part {
  layout: Layout;
  bounds: Bounds;
}

function layoutPart(sized: SizedDiagram, cells: Map<string, Cell>): Part {
  const nodes = sized.diagram.nodes.filter((node) => cells.has(node.id));
  const neighbours = neighbourMap(sized);

  // Attributes are arranged for the grid directions first, then again for
  // the real positions, until the positions stop changing (the arrangement
  // decides the spacing, and the spacing can change the arrangement).
  let centers = new Map([...cells].map(([id, c]) => [id, { x: c.col, y: c.row }]));
  let clusters = new Map<string, AttributeCluster>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const previous = centers;
    clusters = new Map(
      nodes.map((node) => {
        const { arms, lines } = obstaclesFor(sized, node, centers, neighbours, round > 0);
        const shape = sized.geometry.get(node.id)!.shape;
        return [node.id, placeAttributes(shape, node.attributes, arms, sized.geometry, lines)];
      }),
    );
    centers = toPixels(sized, cells, clusters, neighbours);
    if (round > 0 && [...centers].every(([id, p]) => distance(p, previous.get(id)!) < 0.5)) break;
  }

  const layout: Layout = new Map();
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const node of nodes) {
    const center = centers.get(node.id)!;
    const cluster = clusters.get(node.id)!;
    layout.set(node.id, center);
    for (const [id, offset] of cluster.positions) {
      layout.set(id, { x: center.x + offset.x, y: center.y + offset.y });
    }
    bounds.minX = Math.min(bounds.minX, center.x + cluster.bounds.minX);
    bounds.maxX = Math.max(bounds.maxX, center.x + cluster.bounds.maxX);
    bounds.minY = Math.min(bounds.minY, center.y + cluster.bounds.minY);
    bounds.maxY = Math.max(bounds.maxY, center.y + cluster.bounds.maxY);
  }
  return { layout, bounds };
}

/**
 * What a node's attributes must avoid: the directions (angles) of its
 * relationship lines, which decide the free ranges, and the lines
 * themselves as segments relative to the node's center.
 *
 * Before real positions are known (`measured` false, grid directions only),
 * lines are long rays. Afterwards they are the real segments, a close
 * neighbour blocks the whole angle its shape covers, and a unary
 * relationship's two lines run from a quarter of the entity's side to the
 * diamond's corners, enclosing a loop that must stay empty.
 */
function obstaclesFor(
  sized: SizedDiagram,
  node: MainNode,
  centers: Map<string, Point>,
  neighbours: Map<string, Map<string, number>>,
  measured: boolean,
): { arms: number[]; lines: [Point, Point][] } {
  const here = centers.get(node.id)!;
  const arms: number[] = [];
  const lines: [Point, Point][] = [];
  const origin = { x: 0, y: 0 };
  for (const [other, count] of neighbours.get(node.id)!) {
    const there = centers.get(other)!;
    const offset = { x: there.x - here.x, y: there.y - here.y };
    const angle = Math.atan2(offset.y, offset.x);

    if (!measured) {
      const spread = count >= 2 ? (25 * Math.PI) / 180 : 0;
      for (const a of spread ? [angle - spread, angle + spread] : [angle]) {
        arms.push(a);
        lines.push([origin, { x: Math.cos(a) * 2000, y: Math.sin(a) * 2000 }]);
      }
      continue;
    }

    if (count >= 2) {
      for (const [from, to] of unaryLines(sized, node, other, offset)) {
        lines.push([from, to]);
        arms.push(Math.atan2(from.y, from.x), Math.atan2(to.y, to.x));
      }
    } else {
      lines.push([origin, offset]);
      arms.push(angle);
    }
    const { width, height } = sized.geometry.get(other)!.shape;
    const across =
      Math.abs(Math.sin(angle)) * (width / 2) + Math.abs(Math.cos(angle)) * (height / 2);
    const extent = Math.atan2(across, Math.hypot(offset.x, offset.y));
    arms.push(angle - extent, angle + extent);
  }
  // Lines between other shapes nearby are obstacles too (but do not decide the free ranges).
  if (measured) {
    for (const link of sized.diagram.links) {
      if (link.entity === node.id || link.relationship === node.id) continue;
      const from = centers.get(link.entity);
      const to = centers.get(link.relationship);
      if (!from || !to) continue;
      lines.push([
        { x: from.x - here.x, y: from.y - here.y },
        { x: to.x - here.x, y: to.y - here.y },
      ]);
    }
  }
  return { arms, lines };
}

/**
 * The two lines of a unary relationship, relative to `node` (the entity or
 * the diamond), as the renderer draws them: from a quarter of the entity's
 * side off center to the diamond's two opposite corners.
 */
function unaryLines(
  sized: SizedDiagram,
  node: MainNode,
  other: string,
  offset: Point,
): [Point, Point][] {
  const [entityId, relId, toRel] =
    node.kind === 'entity'
      ? [node.id, other, offset]
      : [other, node.id, { x: -offset.x, y: -offset.y }];
  const entity = sized.geometry.get(entityId)!.shape;
  const rel = sized.geometry.get(relId)!.shape;
  const sideways = Math.abs(toRel.x) >= Math.abs(toRel.y);
  // Positions relative to the entity's center.
  const pairs = [-1, 1].map((sign): [Point, Point] => {
    const corner = sideways
      ? { x: toRel.x, y: toRel.y + (sign * rel.height) / 2 }
      : { x: toRel.x + (sign * rel.width) / 2, y: toRel.y };
    const start = sideways
      ? { x: (Math.sign(toRel.x) * entity.width) / 2, y: (sign * entity.height) / 4 }
      : { x: (sign * entity.width) / 4, y: (Math.sign(toRel.y) * entity.height) / 2 };
    return [start, corner];
  });
  if (node.kind === 'entity') return pairs;
  // Seen from the diamond instead.
  return pairs.map(([a, b]) => [
    { x: b.x - toRel.x, y: b.y - toRel.y },
    { x: a.x - toRel.x, y: a.y - toRel.y },
  ]);
}

/** For each node, its neighbours and how many lines join them. */
function neighbourMap(sized: SizedDiagram): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const node of sized.diagram.nodes) map.set(node.id, new Map());
  for (const link of sized.diagram.links) {
    const a = map.get(link.entity)!;
    const b = map.get(link.relationship)!;
    a.set(link.relationship, (a.get(link.relationship) ?? 0) + 1);
    b.set(link.entity, (b.get(link.entity) ?? 0) + 1);
  }
  return map;
}

/** A box that must not overlap the boxes of other shapes, relative to its row and column. */
interface Obstacle {
  owner: string;
  col: number;
  row: number;
  /** Relative to the owner's center (or, for lines, to their row and column). */
  box: Bounds;
  /** A straight line between two shapes in one row or column: ends at another band. */
  line?: { toCol: number; toRow: number };
}

/**
 * Turns grid cells into pixel centers: first each band (column or row) as
 * wide as everything in it, then compacted until nothing more moves.
 */
function toPixels(
  sized: SizedDiagram,
  cells: Map<string, Cell>,
  clusters: Map<string, AttributeCluster>,
  neighbours: Map<string, Map<string, number>>,
): Map<string, Point> {
  const obstacles = obstaclesOf(sized, cells, clusters);
  // Widest cardinality label on the line(s) between each pair of shapes.
  const labelWidths = new Map<string, number>();
  for (const link of sized.diagram.links) {
    if (link.cardinality === null) continue;
    const width = sized.measurer.width(link.cardinality, { size: STYLE.font.smallSize });
    const key = [link.entity, link.relationship].sort().join('|');
    labelWidths.set(key, Math.max(labelWidths.get(key) ?? 0, width));
  }
  const links = [...cells.keys()].flatMap((id) =>
    [...neighbours.get(id)!]
      .filter(([n]) => id < n && cells.has(n))
      .map(([n, count]) => ({
        a: id,
        b: n,
        unary: count >= 2,
        label: labelWidths.get([id, n].sort().join('|')) ?? 0,
      })),
  );

  let xs = bandPositions(cells, clusters, 'col');
  let ys = bandPositions(cells, clusters, 'row');
  for (let pass = 0; pass < 4; pass++) {
    const nextYs = compact(sized, cells, obstacles, links, 'row', xs, ys);
    const nextXs = compact(sized, cells, obstacles, links, 'col', xs, nextYs);
    const stable = same(nextXs, xs) && same(nextYs, ys);
    xs = nextXs;
    ys = nextYs;
    if (stable) break;
  }
  ys = compact(sized, cells, obstacles, links, 'row', xs, ys);
  return new Map([...cells].map(([id, c]) => [id, { x: xs.get(c.col)!, y: ys.get(c.row)! }]));
}

/** Every shape, attribute ellipse and straight line, as boxes that must keep apart. */
function obstaclesOf(
  sized: SizedDiagram,
  cells: Map<string, Cell>,
  clusters: Map<string, AttributeCluster>,
): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const boxOf = (center: Point, width: number, height: number): Bounds => ({
    minX: center.x - width / 2,
    maxX: center.x + width / 2,
    minY: center.y - height / 2,
    maxY: center.y + height / 2,
  });
  for (const [id, cell] of cells) {
    const { width, height } = sized.geometry.get(id)!.shape;
    obstacles.push({ owner: id, ...cell, box: boxOf({ x: 0, y: 0 }, width, height) });
    for (const [attributeId, offset] of clusters.get(id)!.positions) {
      const shape = sized.geometry.get(attributeId)!.shape;
      obstacles.push({
        owner: id,
        ...cell,
        box: boxOf(offset, shape.width, shape.height + 2 * STYLE.keyGroupLineOffset),
      });
    }
  }
  // Straight lines between shapes in one row or column.
  for (const link of sized.diagram.links) {
    const a = cells.get(link.entity);
    const b = cells.get(link.relationship);
    if (!a || !b || (a.col !== b.col && a.row !== b.row)) continue;
    const half = STYLE.doubleGap;
    obstacles.push({
      owner: `${link.entity}|${link.relationship}`,
      col: a.col,
      row: a.row,
      box: { minX: -half, maxX: half, minY: -half, maxY: half },
      line: { toCol: b.col, toRow: b.row },
    });
  }
  return obstacles;
}

/**
 * One compaction pass along an axis. Bands are placed in order; each one as
 * close after the earlier bands as allowed by every pair of obstacles that
 * overlap across the axis (with a gap). Shapes joined by a line keep a
 * minimum distance, so the line has room for its label.
 */
function compact(
  sized: SizedDiagram,
  cells: Map<string, Cell>,
  obstacles: Obstacle[],
  links: { a: string; b: string; unary: boolean; label: number }[],
  axis: 'col' | 'row',
  xs: Map<number, number>,
  ys: Map<number, number>,
): Map<number, number> {
  const along = axis === 'col' ? xs : ys;
  const across = axis === 'col' ? ys : xs;
  const crossAxis = axis === 'col' ? 'row' : 'col';
  const gap = STYLE.layout.gap;

  /** Extent along the axis (relative to the band) and across it (absolute). */
  const extents = obstacles.flatMap((o) => {
    const [lo, hi, clo, chi] =
      axis === 'col'
        ? [o.box.minX, o.box.maxX, o.box.minY, o.box.maxY]
        : [o.box.minY, o.box.maxY, o.box.minX, o.box.maxX];
    if (o.line) {
      // A line along this axis stretches with the bands; only lines across it are obstacles.
      const fromBand = o[axis];
      const toBand = o.line[axis === 'col' ? 'toCol' : 'toRow'];
      if (fromBand !== toBand) return [];
      const a = across.get(o[crossAxis])!;
      const b = across.get(o.line[crossAxis === 'col' ? 'toCol' : 'toRow'])!;
      return [{ owner: o.owner, band: fromBand, lo, hi, clo: Math.min(a, b), chi: Math.max(a, b) }];
    }
    const base = across.get(o[crossAxis])!;
    return [{ owner: o.owner, band: o[axis], lo, hi, clo: base + clo, chi: base + chi }];
  });

  const bands = [...along.keys()].sort((a, b) => a - b);
  const byBand = new Map<number, typeof extents>(bands.map((b) => [b, []]));
  for (const e of extents) byBand.get(e.band)?.push(e);

  const result = new Map<number, number>();
  bands.forEach((band, i) => {
    if (i === 0) {
      result.set(band, 0);
      return;
    }
    let position = result.get(bands[i - 1]!)! + 1;
    for (const earlier of bands.slice(0, i)) {
      for (const a of byBand.get(earlier)!) {
        for (const b of byBand.get(band)!) {
          if (a.owner === b.owner) continue;
          if (a.clo - gap >= b.chi || b.clo - gap >= a.chi) continue;
          position = Math.max(position, result.get(earlier)! + a.hi + gap - b.lo);
        }
      }
    }
    result.set(band, position);
  });

  // Joined shapes keep room for the line between them.
  for (let changed = true, guard = 0; changed && guard < 50; guard++) {
    changed = false;
    for (const { a, b, unary, label } of links) {
      const ca = cells.get(a)!;
      const cb = cells.get(b)!;
      if (ca[axis] === cb[axis]) continue;
      const [first, second] = ca[axis] < cb[axis] ? [a, b] : [b, a];
      const sa = sized.geometry.get(first)!.shape;
      const sb = sized.geometry.get(second)!.shape;
      const half = (s: { width: number; height: number }) =>
        (axis === 'col' ? s.width : s.height) / 2;
      // A unary relationship sits closer, so its two lines to the diamond's
      // corners are steep enough to read as a loop.
      const straight = ca[crossAxis] === cb[crossAxis];
      // A labelled line is long enough for its label to sit on it with room to spare.
      const line = unary
        ? STYLE.layout.unaryLine
        : Math.max(straight ? STYLE.layout.minLine : STYLE.layout.minLine / 2, label + 40);
      const minimum = half(sa) + half(sb) + line;
      const p = result.get(cells.get(first)![axis])!;
      const q = result.get(cells.get(second)![axis])!;
      if (q - p < minimum - 1e-6) {
        const shift = minimum - (q - p);
        // Push this band and every later one.
        for (const band of bands)
          if (band >= cells.get(second)![axis]) result.set(band, result.get(band)! + shift);
        changed = true;
      }
    }
  }
  return result;
}

function same(a: Map<number, number>, b: Map<number, number>): boolean {
  for (const [k, v] of a) if (Math.abs((b.get(k) ?? NaN) - v) > 0.01) return false;
  return true;
}

/** Starting positions: each band as wide as the widest shape-plus-attributes in it. */
function bandPositions(
  cells: Map<string, Cell>,
  clusters: Map<string, AttributeCluster>,
  axis: 'col' | 'row',
): Map<number, number> {
  const before = new Map<number, number>();
  const after = new Map<number, number>();
  for (const [id, cell] of cells) {
    const b = clusters.get(id)!.bounds;
    const index = cell[axis];
    const [low, high] = axis === 'col' ? [-b.minX, b.maxX] : [-b.minY, b.maxY];
    before.set(index, Math.max(before.get(index) ?? 0, low));
    after.set(index, Math.max(after.get(index) ?? 0, high));
  }
  const indices = [...before.keys()].sort((a, b) => a - b);
  const positions = new Map<number, number>();
  let position = 0;
  indices.forEach((index, i) => {
    if (i > 0) position += after.get(indices[i - 1]!)! + STYLE.layout.gap + before.get(index)!;
    positions.set(index, position);
  });
  return positions;
}

/** Packs separate parts left to right in rows, roughly as wide as tall. */
function pack(parts: Part[]): Layout {
  const spacing = STYLE.layout.componentSpacing;
  const area = parts.reduce(
    (sum, p) => sum + (p.bounds.maxX - p.bounds.minX) * (p.bounds.maxY - p.bounds.minY),
    0,
  );
  const widest = Math.max(0, ...parts.map((p) => p.bounds.maxX - p.bounds.minX));
  const rowWidth = Math.max(widest, Math.sqrt(area) * 1.5);

  const layout: Layout = new Map();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const part of parts) {
    const width = part.bounds.maxX - part.bounds.minX;
    const height = part.bounds.maxY - part.bounds.minY;
    if (x > 0 && x + width > rowWidth) {
      x = 0;
      y += rowHeight + spacing;
      rowHeight = 0;
    }
    for (const [id, p] of part.layout) {
      layout.set(id, { x: p.x - part.bounds.minX + x, y: p.y - part.bounds.minY + y });
    }
    x += width + spacing;
    rowHeight = Math.max(rowHeight, height);
  }
  return layout;
}

function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}
