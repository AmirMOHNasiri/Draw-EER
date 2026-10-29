import { unaryLineEnds, type Point, type Shape } from '../geometry/shapes';
import type { AttributeNode, MainNode } from '../model/types';
import { boxAround, segmentHitsBox } from '../geometry/collide';
import { STYLE } from '../render/style';
import { isRightToLeft } from '../text/direction';
import { placeAttributes, type AttributeCluster, type Bounds } from './attributes';
import { placeOnGrid, type Cell } from './grid';
import type { SizedDiagram } from './size';

/** Shapes and attributes beyond which a diagram gets a cheaper search (see `layoutDiagram`). */
const LARGE_DIAGRAM = 150;
/** Most rounds of arranging attributes and spacing the grid (see `layoutPart`). */
const MAX_ROUNDS = 3;
/** Lines between other shapes further than this (px) from a shape do not affect its attributes. */
const NEARBY = 600;
/** Smallest share of its grid slope that a slanted line keeps (see `Compactor.solve`). */
const MIN_SLOPE = 0.6;

/** Center of every node and attribute, by id. */
export type Layout = Map<string, Point>;

/**
 * Automatic layout.
 *
 * 1. Entities and relationships go into grid cells (see grid.ts), so that
 *    related shapes line up in rows and columns.
 * 2. Each shape's attributes are fanned out in the directions its lines
 *    leave free (see attributes.ts).
 * 3. Grid cells become pixel positions ("compaction", see `toPixels`).
 *    Shapes joined by a straight line keep one center line, so the line
 *    stays straight; everything else moves freely, as close as the shapes,
 *    attributes and lines facing each other allow, with every line pulled
 *    toward one target length.
 * 4. Diagonal lines change angle in step 3, so attributes are placed once
 *    more with the real angles and step 3 repeats (`MAX_ROUNDS` in all).
 * 5. A shape whose attributes ended up under a slanted line gets them
 *    placed once more, with everything else fixed (`repairAttributes`).
 *
 * Separate parts of the diagram (shapes with no line between them) are laid
 * out on their own and then packed side by side in rows.
 *
 * The README's "How the layout works" section explains the whole pipeline.
 */
export function layoutDiagram(sized: SizedDiagram): Layout {
  // Very large diagrams get a cheaper search everywhere, so the preview stays
  // responsive. This depends only on the diagram, never on the clock, so the
  // same text always gives the same picture.
  const quick = sized.geometry.size > LARGE_DIAGRAM;
  const parts = placeOnGrid(sized.diagram, quick).map((cells) => layoutPart(sized, cells, quick));
  return pack(parts);
}

interface Part {
  layout: Layout;
  bounds: Bounds;
}

function layoutPart(sized: SizedDiagram, cells: Map<string, Cell>, quick: boolean): Part {
  const nodes = sized.diagram.nodes.filter((node) => cells.has(node.id));
  const neighbours = neighbourMap(sized);
  const rtl = readsRightToLeft(sized);

  // Attributes are arranged for the grid directions first, then again for
  // the real positions, until the positions stop changing (the arrangement
  // decides the spacing, and the spacing can change the arrangement).
  let centers = new Map([...cells].map(([id, c]) => [id, { x: c.col, y: c.row }]));
  let clusters = new Map<string, AttributeCluster>();
  for (let round = 0; round < (quick ? 2 : MAX_ROUNDS); round++) {
    const previous = centers;
    clusters = new Map(
      nodes.map((node) => {
        const { arms, lines, partners, walls } = obstaclesFor(
          sized,
          node,
          centers,
          neighbours,
          round > 0,
        );
        const crowded = crowdedDirections(node.id, cells, neighbours);
        const shape = sized.geometry.get(node.id)!.shape;
        return [
          node.id,
          placeAttributes(shape, node.attributes, arms, sized.geometry, lines, {
            crowded,
            rtl,
            partners,
            walls: quick ? [] : walls,
          }),
        ];
      }),
    );
    centers = toPixels(sized, cells, clusters, neighbours, quick);
    if (round > 0 && [...centers].every(([id, p]) => distance(p, previous.get(id)!) < 0.5)) break;
  }

  repairAttributes(sized, nodes, centers, clusters, neighbours, cells, rtl);

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
): { arms: number[]; lines: [Point, Point][]; partners: number[]; walls: [Point, Point][] } {
  const here = centers.get(node.id)!;
  const arms: number[] = [];
  const partners: number[] = [];
  const walls: [Point, Point][] = [];
  const lines: [Point, Point][] = [];
  const origin = { x: 0, y: 0 };
  for (const [other, count] of neighbours.get(node.id)!) {
    const there = centers.get(other)!;
    const offset = { x: there.x - here.x, y: there.y - here.y };
    const angle = Math.atan2(offset.y, offset.x);
    // One partner direction per neighbour, toward its center (a unary loop counts once).
    partners.push(angle);
    // A straight line between two shapes is split at its middle: where they
    // fit, each side keeps its attributes on its own half, so the two fans
    // never compete for the same space and the line keeps its target length.
    if (count === 1 && (Math.abs(offset.x) < 0.01 || Math.abs(offset.y) < 0.01)) {
      walls.push(midpointWall(sized.geometry.get(node.id)!.shape, offset));
    }

    if (!measured) {
      const spread = count >= 2 ? (25 * Math.PI) / 180 : 0;
      for (const a of spread ? [angle - spread, angle + spread] : [angle]) {
        arms.push(a);
        lines.push([origin, { x: Math.cos(a) * 2000, y: Math.sin(a) * 2000 }]);
      }
      continue;
    }

    if (count >= 2) {
      const loop = unaryLines(sized, node, other, offset);
      for (const [from, to] of loop) {
        lines.push([from, to]);
        arms.push(Math.atan2(from.y, from.x), Math.atan2(to.y, to.x));
      }
      lines.push(...roleLabelEdges(sized, node, other, loop));
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
  // Lines between other shapes nearby are obstacles too (but do not decide
  // the free ranges). Lines far away cannot meet this shape's attributes, and
  // leaving them out keeps large diagrams fast.
  if (measured) {
    for (const link of sized.diagram.links) {
      if (link.entity === node.id || link.relationship === node.id) continue;
      const from = centers.get(link.entity);
      const to = centers.get(link.relationship);
      if (!from || !to) continue;
      const a = { x: from.x - here.x, y: from.y - here.y };
      const b = { x: to.x - here.x, y: to.y - here.y };
      if (distanceToSegment(origin, a, b) < NEARBY) lines.push([a, b]);
    }
  }
  return { arms, lines, partners, walls };
}

/**
 * A wall across a straight line, halfway along it when the line has its
 * target length (see `lineLength`), relative to the shape's center.
 */
function midpointWall(shape: Shape, offset: Point): [Point, Point] {
  const far = 4000;
  const half = STYLE.layout.minLine / 2;
  if (Math.abs(offset.y) < 0.01) {
    const x = Math.sign(offset.x) * (shape.width / 2 + half);
    return [
      { x, y: -far },
      { x, y: far },
    ];
  }
  const y = Math.sign(offset.y) * (shape.height / 2 + half);
  return [
    { x: -far, y },
    { x: far, y },
  ];
}

/**
 * The two lines of a unary relationship, relative to `node` (the entity or
 * the diamond), as the renderer draws them (see `unaryLineEnds`).
 */
function unaryLines(
  sized: SizedDiagram,
  node: MainNode,
  other: string,
  offset: Point,
): [Point, Point][] {
  // `offset` is the other shape's center relative to `node`'s.
  const origin = { x: 0, y: 0 };
  if (node.kind === 'entity') {
    const entity = sized.geometry.get(node.id)!.shape;
    return unaryLineEnds(entity, origin, sized.geometry.get(other)!.shape, offset);
  }
  const entity = sized.geometry.get(other)!.shape;
  const diamond = sized.geometry.get(node.id)!.shape;
  return unaryLineEnds(entity, offset, diamond, origin).map(([a, b]) => [b, a]);
}

/**
 * The last compaction can move a slanted relationship line (which
 * compaction cannot treat as an obstacle) onto an attribute, or across an
 * attribute's line. Each shape where that happened gets its attributes
 * placed once more, with everything else fixed and in the way.
 */
function repairAttributes(
  sized: SizedDiagram,
  nodes: MainNode[],
  centers: Map<string, Point>,
  clusters: Map<string, AttributeCluster>,
  neighbours: Map<string, Map<string, number>>,
  cells: Map<string, Cell>,
  rtl: boolean,
): void {
  // Relationship lines, center to center (a unary loop is not a straight line).
  const lines: [Point, Point][] = [];
  for (const [id, map] of neighbours) {
    for (const [other, count] of map) {
      if (count === 1 && id < other && centers.has(id) && centers.has(other))
        lines.push([centers.get(id)!, centers.get(other)!]);
    }
  }
  for (const node of nodes) {
    if (node.attributes.length === 0 || !attributesInTheWay(sized, node, centers, clusters, lines))
      continue;
    const { arms, lines: near, partners } = obstaclesFor(sized, node, centers, neighbours, true);
    const shape = sized.geometry.get(node.id)!.shape;
    clusters.set(
      node.id,
      placeAttributes(shape, node.attributes, arms, sized.geometry, near, {
        crowded: crowdedDirections(node.id, cells, neighbours),
        rtl,
        partners,
        occupied: occupiedAround(sized, node.id, nodes, centers, clusters),
      }),
    );
  }
}

/** True if a relationship line runs through one of the node's attributes or crosses an attribute's line. */
function attributesInTheWay(
  sized: SizedDiagram,
  node: MainNode,
  centers: Map<string, Point>,
  clusters: Map<string, AttributeCluster>,
  lines: [Point, Point][],
): boolean {
  const center = centers.get(node.id)!;
  const at = (id: string) => {
    const offset = clusters.get(node.id)!.positions.get(id)!;
    return { x: center.x + offset.x, y: center.y + offset.y };
  };
  const check = (parent: Point, attributes: AttributeNode[]): boolean =>
    attributes.some((attribute) => {
      const p = at(attribute.id);
      const { width, height } = sized.geometry.get(attribute.id)!.shape;
      const box = boxAround(p, width, height, 4);
      for (const [a, b] of lines) {
        if (segmentHitsBox(a, b, box) || segmentsCross(a, b, parent, p)) return true;
      }
      return check(p, attribute.children);
    });
  return check(center, node.attributes);
}

/**
 * Every other shape and attribute (with the line to it), relative to `id`'s
 * center, for `repairAttributes`.
 */
function occupiedAround(
  sized: SizedDiagram,
  id: string,
  nodes: MainNode[],
  centers: Map<string, Point>,
  clusters: Map<string, AttributeCluster>,
): { center: Point; shape: Shape; connector?: [Point, Point] }[] {
  const here = centers.get(id)!;
  const relative = (p: Point) => ({ x: p.x - here.x, y: p.y - here.y });
  const result: { center: Point; shape: Shape; connector?: [Point, Point] }[] = [];
  for (const node of nodes) {
    if (node.id === id) continue;
    const center = centers.get(node.id)!;
    result.push({ center: relative(center), shape: sized.geometry.get(node.id)!.shape });
    const offsets = clusters.get(node.id)!.positions;
    const visit = (parent: Point, attributes: AttributeNode[]) => {
      for (const attribute of attributes) {
        const offset = offsets.get(attribute.id)!;
        const p = { x: center.x + offset.x, y: center.y + offset.y };
        result.push({
          center: relative(p),
          shape: sized.geometry.get(attribute.id)!.shape,
          connector: [relative(parent), relative(p)],
        });
        visit(p, attribute.children);
      }
    };
    visit(center, node.attributes);
  }
  return result;
}

/** True if two segments cross at a point inside both. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(c, d, a) * side(c, d, b) < -1e-6 && side(a, b, c) * side(a, b, d) < -1e-6;
}

/**
 * Directions from a shape to the shapes above, below and beside it in the
 * grid (one or two cells away) that it has no line to. Its attributes should not grow that way (see `FanOptions`).
 */
function crowdedDirections(
  id: string,
  cells: Map<string, Cell>,
  neighbours: Map<string, Map<string, number>>,
): number[] {
  const cell = cells.get(id)!;
  const related = neighbours.get(id)!;
  const result: number[] = [];
  // Grid directions, not pixel ones: a shape in the next row is "above",
  // even when compaction has moved it well to the side. A shape right next
  // to this one counts twice, one two cells away (in a straight line) once.
  for (const [other, c] of cells) {
    if (other === id || related.has(other)) continue;
    const dc = c.col - cell.col;
    const dr = c.row - cell.row;
    const steps = Math.abs(dc) + Math.abs(dr);
    if (steps === 1) result.push(Math.atan2(dr, dc), Math.atan2(dr, dc));
    else if (steps === 2 && (dc === 0 || dr === 0)) result.push(Math.atan2(dr, dc));
  }
  return result;
}

/** True if most names in the diagram are right-to-left (Persian, Arabic, ...). */
export function readsRightToLeft(sized: SizedDiagram): boolean {
  let rtl = 0;
  let total = 0;
  for (const { label } of sized.geometry.values()) {
    total++;
    if (isRightToLeft(label.lines.join(' '))) rtl++;
  }
  return rtl * 2 > total;
}

/**
 * The outline of each role name on a unary loop, as the renderer places it
 * (beside its own line, outside the loop, 60% of the way to the diamond),
 * so attributes keep clear of it.
 */
function roleLabelEdges(
  sized: SizedDiagram,
  node: MainNode,
  other: string,
  loop: [Point, Point][],
): [Point, Point][] {
  const relId = node.kind === 'entity' ? other : node.id;
  const entityId = node.kind === 'entity' ? node.id : other;
  const links = sized.diagram.links.filter(
    (l) => l.relationship === relId && l.entity === entityId,
  );
  const edges: [Point, Point][] = [];
  loop.forEach((line, i) => {
    const role = links[i]?.role;
    if (!role) return;
    // From the entity end to the diamond end, whichever node we are.
    const [start, end] = node.kind === 'entity' ? line : [line[1], line[0]];
    const [otherStart, otherEnd] =
      node.kind === 'entity' ? loop[1 - i]! : [loop[1 - i]![1], loop[1 - i]![0]];
    const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const d = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
    const left = { x: d.y, y: -d.x };
    const middle = { x: (otherStart.x + otherEnd.x) / 2, y: (otherStart.y + otherEnd.y) / 2 };
    const side = (middle.x - start.x) * left.x + (middle.y - start.y) * left.y > 0 ? -1 : 1;
    const size = STYLE.font.smallSize;
    const width = sized.measurer.width(role, { size });
    const height = size * STYLE.label.heightEm;
    const across = (Math.abs(left.x) * width) / 2 + (Math.abs(left.y) * height) / 2 + 5;
    const c = {
      x: start.x + d.x * length * 0.6 + left.x * side * across,
      y: start.y + d.y * length * 0.6 + left.y * side * across,
    };
    const [x0, x1, y0, y1] = [c.x - width / 2, c.x + width / 2, c.y - height / 2, c.y + height / 2];
    edges.push(
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
      ],
      [
        { x: x1, y: y0 },
        { x: x1, y: y1 },
      ],
      [
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
      [
        { x: x0, y: y1 },
        { x: x0, y: y0 },
      ],
      [
        { x: x0, y: y0 },
        { x: x1, y: y1 },
      ],
    );
  });
  return edges;
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

type Axis = 'x' | 'y';

/** A shape or attribute ellipse, as a box relative to the center of the shape it moves with. */
interface Obstacle {
  owner: string;
  box: Bounds;
}

/** A line between two shapes, with what compaction needs to know about it. */
interface Link {
  a: string;
  b: string;
  unary: boolean;
  /** Width of the widest cardinality label on it (0 if none). */
  label: number;
  /** True if a role name is written beside it. */
  role: boolean;
}

/**
 * Turns grid cells into pixel centers ("compaction").
 *
 * Shapes joined by a straight line share a center line: an x-group is a set
 * of shapes joined by vertical lines (one x for all), a y-group the same for
 * horizontal lines. Unlike whole grid columns and rows, groups do not tie
 * unrelated shapes together, so one wide attribute fan does not stretch
 * every line that happens to cross its column.
 *
 * Each axis is then solved on its own, alternately, until nothing moves:
 * groups keep their grid order, keep `STYLE.layout.gap` between everything
 * that faces each other, and are pulled so that every line between shapes is
 * as close as possible to the same target length (`lineLength`).
 */
function toPixels(
  sized: SizedDiagram,
  cells: Map<string, Cell>,
  clusters: Map<string, AttributeCluster>,
  neighbours: Map<string, Map<string, number>>,
  quick: boolean,
): Map<string, Point> {
  // Widest cardinality label on the line(s) between each pair of shapes.
  const labelWidths = new Map<string, number>();
  const roles = new Set<string>();
  for (const link of sized.diagram.links) {
    if (link.role !== null) roles.add([link.entity, link.relationship].sort().join('|'));
    if (link.cardinality === null) continue;
    const width = sized.measurer.width(link.cardinality, { size: STYLE.font.smallSize });
    const key = [link.entity, link.relationship].sort().join('|');
    labelWidths.set(key, Math.max(labelWidths.get(key) ?? 0, width));
  }
  const links: Link[] = [...cells.keys()].flatMap((id) =>
    [...neighbours.get(id)!]
      .filter(([n]) => id < n && cells.has(n))
      .map(([n, count]) => ({
        a: id,
        b: n,
        unary: count >= 2,
        label: labelWidths.get([id, n].sort().join('|')) ?? 0,
        role: roles.has([id, n].sort().join('|')),
      })),
  );

  const obstacles: Obstacle[] = [];
  const boxOf = (center: Point, width: number, height: number): Bounds => ({
    minX: center.x - width / 2,
    maxX: center.x + width / 2,
    minY: center.y - height / 2,
    maxY: center.y + height / 2,
  });
  for (const id of cells.keys()) {
    const { width, height } = sized.geometry.get(id)!.shape;
    obstacles.push({ owner: id, box: boxOf({ x: 0, y: 0 }, width, height) });
    for (const [attributeId, offset] of clusters.get(id)!.positions) {
      const shape = sized.geometry.get(attributeId)!.shape;
      obstacles.push({
        owner: id,
        box: boxOf(offset, shape.width, shape.height + 2 * STYLE.keyGroupLineOffset),
      });
    }
  }

  const solver = new Compactor(sized, cells, obstacles, links);
  // Two shapes whose attributes would collide can be kept apart sideways or
  // up and down; whichever axis is solved first gets to decide. Both orders
  // are tried, and the one with shorter lines wins.
  let best: { centers: Map<string, Point>; length: number } | null = null;
  for (const first of quick ? (['y'] as const) : (['y', 'x'] as const)) {
    const centers = solver.run(first, clusters);
    let length = 0;
    for (const { a, b } of links) length += distance(centers.get(a)!, centers.get(b)!);
    if (best === null || length < best.length - 0.5) best = { centers, length };
  }
  return best!.centers;
}

class Compactor {
  /** For each axis, the group of every shape (shapes in one group share that coordinate). */
  private readonly groups: Record<Axis, Map<string, string>>;

  constructor(
    private readonly sized: SizedDiagram,
    private readonly cells: Map<string, Cell>,
    private readonly obstacles: Obstacle[],
    private readonly links: Link[],
  ) {
    this.groups = { x: this.groupsAlong('x'), y: this.groupsAlong('y') };
  }

  /**
   * Alternates between the axes, starting with `first`, until nothing moves.
   * It starts from uncompacted bands, where nothing overlaps, and every pass
   * keeps it that way.
   */
  run(first: Axis, clusters: Map<string, AttributeCluster>): Map<string, Point> {
    const position: Record<Axis, Map<string, number>> = {
      x: fromBands(this.cells, bandPositions(this.cells, clusters, 'col'), 'col'),
      y: fromBands(this.cells, bandPositions(this.cells, clusters, 'row'), 'row'),
    };
    const second: Axis = first === 'x' ? 'y' : 'x';
    for (let pass = 0; pass < 8; pass++) {
      const a = this.solve(first, position[first], position[second]);
      const b = this.solve(second, position[second], a);
      const stable = same(a, position[first]) && same(b, position[second]);
      position[first] = a;
      position[second] = b;
      if (stable) break;
    }
    return new Map(
      [...this.cells.keys()].map((id) => [id, { x: position.x.get(id)!, y: position.y.get(id)! }]),
    );
  }

  /**
   * Shapes joined by a line that is straight across `axis` (vertical for x,
   * horizontal for y) belong together. Groups are named after their first shape.
   */
  private groupsAlong(axis: Axis): Map<string, string> {
    const index = axis === 'x' ? 'col' : 'row';
    const parent = new Map([...this.cells.keys()].map((id) => [id, id]));
    const find = (id: string): string => {
      while (parent.get(id) !== id) id = parent.get(id)!;
      return id;
    };
    for (const { a, b } of this.links) {
      if (this.cells.get(a)![index] !== this.cells.get(b)![index]) continue;
      const [ra, rb] = [find(a), find(b)].sort();
      parent.set(rb!, ra!);
    }
    return new Map([...this.cells.keys()].map((id) => [id, find(id)]));
  }

  /**
   * New coordinates along `axis` for every shape, given the coordinates
   * across it (which this pass does not change).
   */
  solve(axis: Axis, along: Map<string, number>, across: Map<string, number>): Map<string, number> {
    const index = axis === 'x' ? 'col' : 'row';
    const otherIndex = axis === 'x' ? 'row' : 'col';
    const groupOf = this.groups[axis];
    const gap = STYLE.layout.gap;

    // Groups in grid order; within one grid column (or row), in their current order.
    const members = new Map<string, string>();
    for (const [id, group] of groupOf) if (!members.has(group)) members.set(group, id);
    const order = [...members.keys()].sort((g, h) => {
      const p = members.get(g)!;
      const q = members.get(h)!;
      return (
        this.cells.get(p)![index] - this.cells.get(q)![index] ||
        along.get(p)! - along.get(q)! ||
        (g < h ? -1 : 1)
      );
    });
    const rank = new Map(order.map((g, i) => [g, i]));

    // Everything that takes up room, along the axis relative to its group and across it absolutely.
    const extents = this.obstacles.map((o) => {
      const [lo, hi, clo, chi] =
        axis === 'x'
          ? [o.box.minX, o.box.maxX, o.box.minY, o.box.maxY]
          : [o.box.minY, o.box.maxY, o.box.minX, o.box.maxX];
      const base = across.get(o.owner)!;
      return { group: groupOf.get(o.owner)!, lo, hi, clo: base + clo, chi: base + chi };
    });
    // A straight line across the axis stays put with its group and blocks
    // whatever would slide onto it. Lines along the axis just stretch.
    for (const { a, b } of this.links) {
      if (this.cells.get(a)![index] !== this.cells.get(b)![index]) continue;
      const [p, q] = [across.get(a)!, across.get(b)!];
      const half = STYLE.doubleGap;
      extents.push({
        group: groupOf.get(a)!,
        lo: -half,
        hi: half,
        clo: Math.min(p, q),
        chi: Math.max(p, q),
      });
    }

    // Smallest distance from one group to a later one: `minimum[g]` holds [later group, distance].
    const minimum = new Map<string, Map<string, number>>(order.map((g) => [g, new Map()]));
    const keepApart = (first: string, second: string, distance: number) => {
      const map = minimum.get(first)!;
      map.set(second, Math.max(map.get(second) ?? -Infinity, distance));
    };
    // Sorted across the axis, so each one is only compared with those that
    // start before it ends (the rest cannot overlap it).
    extents.sort((e, f) => e.clo - f.clo);
    for (let i = 0; i < extents.length; i++) {
      for (let j = i + 1; j < extents.length; j++) {
        let e = extents[i]!;
        let f = extents[j]!;
        if (f.clo - gap >= e.chi) break;
        if (e.group === f.group) continue;
        if (rank.get(e.group)! > rank.get(f.group)!) [e, f] = [f, e];
        keepApart(e.group, f.group, e.hi + gap - f.lo);
      }
    }
    // Lines between groups: at least, and ideally exactly, their target length.
    const targets: { first: string; second: string; length: number }[] = [];
    for (const link of this.links) {
      let [first, second] = [groupOf.get(link.a)!, groupOf.get(link.b)!];
      if (first === second) continue;
      let [p, q] = [link.a, link.b];
      if (rank.get(first)! > rank.get(second)!) {
        [first, second] = [second, first];
        [p, q] = [q, p];
      }
      const [cp, cq] = [this.cells.get(p)!, this.cells.get(q)!];
      const straight = cp[otherIndex] === cq[otherIndex];
      let length = this.half(p, axis) + this.half(q, axis) + lineLength(link, straight);
      if (!straight) {
        // A slanted line keeps part of its grid slope (`MIN_SLOPE`), so that
        // it does not flatten out and run through the shapes beside it.
        const slope = Math.abs(cp[index] - cq[index]) / Math.abs(cp[otherIndex] - cq[otherIndex]);
        length = Math.max(length, MIN_SLOPE * slope * Math.abs(across.get(p)! - across.get(q)!));
      }
      keepApart(first, second, length);
      targets.push({ first, second, length });
    }

    const incoming = new Map<string, [string, number][]>(order.map((g) => [g, []]));
    for (const [first, map] of minimum) {
      for (const [second, distance] of map) incoming.get(second)!.push([first, distance]);
    }

    // Everything as early as allowed (a longest path through the constraints)...
    const position = new Map<string, number>();
    for (const g of order) {
      let p = 0;
      for (const [h, distance] of incoming.get(g)!) p = Math.max(p, position.get(h)! + distance);
      position.set(g, p);
    }
    // ...then each group in turn moves to where its lines are closest to
    // their target lengths (the average of what each line wants), as far as
    // its neighbours allow. Alternating directions lets whole chains slide.
    // For each group, its lines: [other group, signed target distance].
    const lines = new Map<string, [string, number][]>(order.map((g) => [g, []]));
    for (const t of targets) {
      lines.get(t.first)!.push([t.second, -t.length]);
      lines.get(t.second)!.push([t.first, t.length]);
    }
    const reversed = [...order].reverse();
    for (let sweep = 0; sweep < 100; sweep++) {
      let moved = 0;
      for (const g of sweep % 2 === 0 ? reversed : order) {
        const own = lines.get(g)!;
        if (own.length === 0) continue;
        let sum = 0;
        for (const [other, length] of own) sum += position.get(other)! + length;
        let low = -Infinity;
        for (const [h, distance] of incoming.get(g)!)
          low = Math.max(low, position.get(h)! + distance);
        let high = Infinity;
        for (const [k, distance] of minimum.get(g)!)
          high = Math.min(high, position.get(k)! - distance);
        const mean = sum / own.length;
        const next = Math.min(high, Math.max(low, mean));
        moved = Math.max(moved, Math.abs(next - position.get(g)!));
        position.set(g, next);
      }
      if (moved < 0.05) break;
    }

    return new Map([...groupOf].map(([id, group]) => [id, position.get(group)!]));
  }

  private half(id: string, axis: Axis): number {
    const { width, height } = this.sized.geometry.get(id)!.shape;
    return (axis === 'x' ? width : height) / 2;
  }
}

/**
 * Target length of a line between two shapes (along one axis; the gap
 * between their outlines): just enough for its cardinality label and a
 * margin on both sides, and the same for every line, so the diagram looks
 * even. A diagonal line is long in both axes, so each axis needs less. A
 * unary relationship's diamond sits close to its entity (see
 * `unaryLineEnds`), unless role names need room beside its lines.
 */
function lineLength(link: Link, straight: boolean): number {
  const { minLine, labelMargin, unaryLine } = STYLE.layout;
  // Role names sit beside the loop's lines, so those lines need more length.
  if (link.unary) return link.role ? minLine : unaryLine;
  const length = Math.max(minLine, link.label + 2 * labelMargin);
  return straight ? length : length * 0.6;
}

function same(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [k, v] of a) if (Math.abs((b.get(k) ?? NaN) - v) > 0.01) return false;
  return true;
}

function fromBands(
  cells: Map<string, Cell>,
  bands: Map<number, number>,
  index: 'col' | 'row',
): Map<string, number> {
  return new Map([...cells].map(([id, cell]) => [id, bands.get(cell[index])!]));
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

/** Distance from `p` to the closest point of the segment from `a` to `b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}
