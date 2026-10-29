import { unaryLineEnds, type Point, type Shape } from '../geometry/shapes';
import type { AttributeNode, MainNode } from '../model/types';
import { boxAround, segmentHitsBox } from '../geometry/collide';
import { STYLE } from '../render/style';
import { isRightToLeft } from '../text/direction';
import { placeAttributes, type AttributeCluster, type Bounds } from './attributes';
import { placeOnGrid, type Cell } from './grid';
import { findHierarchies, treeOffsets, type Hierarchy } from './tree';
import type { SizedDiagram } from './size';

/** Shapes and attributes beyond which a diagram gets a cheaper search (see `layoutDiagram`). */
const LARGE_DIAGRAM = 150;
/** Most rounds of arranging attributes and spacing the grid (see `layoutPart`). */
const MAX_ROUNDS = 3;
/** Lines between other shapes further than this (px) from a shape do not affect its attributes. */
const NEARBY = 600;
/** Smallest share of its grid slope that a slanted line keeps (see `Compactor.solve`). */
const MIN_SLOPE = 0.6;

/** Blocked directions (screen angles, y down) that keep attributes off a shape's upper side. */
const UPPER_SIDE = Array.from({ length: 9 }, (_, i) => ((210 + 15 * i) * Math.PI) / 180);

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
  const aggregates = aggregateBlocks(sized, quick);
  const detached = new Set(aggregates.flatMap((a) => [...a.variants[0]!.cells.keys()]));
  const hierarchies = findHierarchies(sized.diagram, detached);
  const grid = placeOnGrid(
    sized.diagram,
    hierarchies,
    aggregates.map((a) => ({ inner: a.inner, variants: a.variants.map((v) => v.cells) })),
    quick,
  );
  const parts = grid.map((cells) =>
    layoutPart(
      sized,
      cells,
      hierarchies.filter((h) => cells.has(h.members[0]!)),
      aggregates.filter((a) => cells.has(a.inner)).map((a) => chosenVariant(a, cells)),
      quick,
    ),
  );
  return pack(parts);
}

/** The ways to lay out one aggregate (see `arrangements`). */
interface AggregateVariants {
  inner: string;
  variants: AggregateBlock[];
}

/**
 * An aggregate laid out on its own (see `aggregateBlocks`), relative to the
 * relationship inside it.
 */
interface AggregateBlock {
  inner: string;
  cells: Map<string, Cell>;
  offsets: Map<string, Point>;
  /** Attributes of the shapes inside, fixed. */
  clusters: Map<string, AttributeCluster>;
  /** The dashed box, padding included. */
  box: Bounds;
}

/**
 * Each aggregate is laid out first, on its own: the relationship inside,
 * its participants around it (none below it, where the line to the
 * relationship outside leaves) and all their attributes, as compact as a
 * diagram of its own. The rest of the layout then moves it as one rigid
 * block, and keeps everything else out of its box. It is laid out in
 * several arrangements of its participants (see `arrangements`, attributes
 * placed anew for each); the grid uses whichever suits the lines from
 * outside. A shape that two aggregates share stays in the first one.
 */
function aggregateBlocks(sized: SizedDiagram, quick: boolean): AggregateVariants[] {
  const claimed = new Set<string>();
  const result: AggregateVariants[] = [];
  for (const aggregate of sized.diagram.aggregates) {
    const inner = aggregate.relationship;
    if (claimed.has(inner)) continue;
    const members = new Set(aggregate.members.filter((m) => m === inner || !claimed.has(m)));
    for (const m of members) claimed.add(m);
    const diagram = {
      nodes: sized.diagram.nodes.filter((n) => members.has(n.id)),
      links: sized.diagram.links.filter(
        (l) => l.from === inner && l.to !== inner && members.has(l.to),
      ),
      aggregates: [{ ...aggregate, members: [...members] }],
    };
    const own: SizedDiagram = { ...sized, diagram };
    // Shapes with lines to the outside keep their outer side free of
    // attributes, so those lines can come in there (see `COST.intoBox`).
    const outside = new Set(
      sized.diagram.links.flatMap((l) =>
        members.has(l.from) !== members.has(l.to) ? [members.has(l.from) ? l.from : l.to] : [],
      ),
    );
    const cells = placeOnGrid(diagram, [], [], quick)[0]!;
    const variants = arrangements(cells, inner).map((v) =>
      aggregateVariant(own, inner, v, outside, quick),
    );
    result.push({ inner, variants });
  }
  return result;
}

/**
 * Ways to arrange an aggregate's participants around its relationship: the
 * places the grid found for them, taken in turn around the diamond, given
 * to the participants in every rotation and in both directions (for three
 * participants, every arrangement).
 */
function arrangements(cells: Map<string, Cell>, inner: string): Map<string, Cell>[] {
  const at = cells.get(inner)!;
  const angle = (c: Cell) => Math.atan2(c.row - at.row, c.col - at.col);
  const participants = [...cells.keys()].filter((id) => id !== inner);
  const slots = participants.map((id) => cells.get(id)!).sort((a, b) => angle(a) - angle(b));
  const inTurn = [...participants].sort((a, b) => angle(cells.get(a)!) - angle(cells.get(b)!));
  const result: Map<string, Cell>[] = [];
  const seen = new Set<string>();
  for (const order of [inTurn, [...inTurn].reverse()]) {
    for (let shift = 0; shift < Math.max(1, order.length); shift++) {
      const variant = new Map<string, Cell>([[inner, at]]);
      order.forEach((id, i) => variant.set(id, slots[(i + shift) % slots.length]!));
      const key = [...variant].map(([id, c]) => `${id}@${c.col},${c.row}`).join('|');
      if (!seen.has(key)) {
        seen.add(key);
        result.push(variant);
      }
    }
  }
  return result;
}

/** One way to lay out an aggregate, from its grid cells. */
function aggregateVariant(
  own: SizedDiagram,
  inner: string,
  cells: Map<string, Cell>,
  outside: Set<string>,
  quick: boolean,
): AggregateBlock {
  const originCell = cells.get(inner)!;
  const relative = new Map(
    [...cells].map(([id, c]) => [id, { col: c.col - originCell.col, row: c.row - originCell.row }]),
  );
  const outward = new Map<string, number>();
  for (const id of outside) {
    const c = relative.get(id)!;
    outward.set(id, id === inner ? Math.PI / 2 : Math.atan2(c.row, c.col));
  }
  const part = layoutPart(own, cells, [], [], quick, outward);
  const origin = part.layout.get(inner)!;
  const { padding } = STYLE.aggregate;
  return {
    inner,
    cells: relative,
    offsets: new Map(
      [...cells.keys()].map((id) => {
        const p = part.layout.get(id)!;
        return [id, { x: p.x - origin.x, y: p.y - origin.y }];
      }),
    ),
    clusters: part.clusters,
    box: {
      minX: part.bounds.minX - origin.x - padding,
      maxX: part.bounds.maxX - origin.x + padding,
      minY: part.bounds.minY - origin.y - padding,
      maxY: part.bounds.maxY - origin.y + padding,
    },
  };
}

/** The variant of an aggregate that the grid placed. */
function chosenVariant(aggregate: AggregateVariants, cells: Map<string, Cell>): AggregateBlock {
  const at = cells.get(aggregate.inner)!;
  return (
    aggregate.variants.find((v) =>
      [...v.cells].every(([id, c]) => {
        const placed = cells.get(id)!;
        return placed.col - at.col === c.col && placed.row - at.row === c.row;
      }),
    ) ?? aggregate.variants[0]!
  );
}

interface Part {
  layout: Layout;
  bounds: Bounds;
  clusters: Map<string, AttributeCluster>;
}

function layoutPart(
  sized: SizedDiagram,
  cells: Map<string, Cell>,
  hierarchies: Hierarchy[],
  aggregates: AggregateBlock[],
  quick: boolean,
  /** Directions kept free of each shape's attributes (an aggregate's outer sides). */
  outward = new Map<string, number>(),
): Part {
  const nodes = sized.diagram.nodes.filter((node) => cells.has(node.id));
  const neighbours = neighbourMap(sized);
  const rtl = readsRightToLeft(sized);
  const hanging = new Set(hierarchies.flatMap((h) => [...h.hanging]));
  // The attributes inside an aggregate were placed with it and stay put.
  const fixed = new Map(aggregates.flatMap((a) => [...a.clusters]));

  // Attributes are arranged for the grid directions first, then again for
  // the real positions, until the positions stop changing (the arrangement
  // decides the spacing, and the spacing can change the arrangement).
  let centers = new Map([...cells].map(([id, c]) => [id, { x: c.col, y: c.row }]));
  let clusters = new Map<string, AttributeCluster>();
  for (let round = 0; round < (quick ? 2 : MAX_ROUNDS); round++) {
    const previous = centers;
    clusters = new Map(
      nodes.map((node) => {
        if (fixed.has(node.id)) return [node.id, fixed.get(node.id)!];
        const { arms, lines, partners, walls } = obstaclesFor(
          sized,
          node,
          centers,
          neighbours,
          round > 0,
          hanging,
          outward,
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
    centers = toPixels(sized, cells, clusters, neighbours, hierarchies, aggregates, quick);
    if (round > 0 && [...centers].every(([id, p]) => distance(p, previous.get(id)!) < 0.5)) break;
  }

  repairAttributes(
    sized,
    nodes,
    centers,
    clusters,
    neighbours,
    cells,
    rtl,
    hanging,
    fixed,
    outward,
  );

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
  // Room for the boxes of aggregates.
  for (const a of aggregates) {
    const c = centers.get(a.inner)!;
    bounds.minX = Math.min(bounds.minX, c.x + a.box.minX);
    bounds.maxX = Math.max(bounds.maxX, c.x + a.box.maxX);
    bounds.minY = Math.min(bounds.minY, c.y + a.box.minY);
    bounds.maxY = Math.max(bounds.maxY, c.y + a.box.maxY);
  }
  return { layout, bounds, clusters };
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
 *
 * A shape that hangs below its parent in a hierarchy keeps its attributes
 * off its upper side (`hanging`): to the sides or below, clear of the tree.
 * A shape inside an aggregate keeps the direction of its outer side free
 * (`outward`) when lines from outside will come in there.
 */
function obstaclesFor(
  sized: SizedDiagram,
  node: MainNode,
  centers: Map<string, Point>,
  neighbours: Map<string, Map<string, number>>,
  measured: boolean,
  hanging: Set<string>,
  outward: Map<string, number>,
): { arms: number[]; lines: [Point, Point][]; partners: number[]; walls: [Point, Point][] } {
  const here = centers.get(node.id)!;
  const arms: number[] = hanging.has(node.id) ? [...UPPER_SIDE] : [];
  const partners: number[] = [];
  const walls: [Point, Point][] = [];
  const lines: [Point, Point][] = [];
  const origin = { x: 0, y: 0 };
  // An outer side kept free for a line that will come in from outside.
  const free = outward.get(node.id);
  if (free !== undefined) {
    arms.push(free);
    lines.push([origin, { x: Math.cos(free) * 2000, y: Math.sin(free) * 2000 }]);
  }
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
      if (link.to === node.id || link.from === node.id) continue;
      const from = centers.get(link.from);
      const to = centers.get(link.to);
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
  hanging: Set<string>,
  fixed: Map<string, AttributeCluster>,
  outward: Map<string, number>,
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
    if (node.attributes.length === 0 || fixed.has(node.id)) continue;
    if (!attributesInTheWay(sized, node, centers, clusters, lines)) continue;
    const {
      arms,
      lines: near,
      partners,
    } = obstaclesFor(sized, node, centers, neighbours, true, hanging, outward);
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
  const links = sized.diagram.links.filter((l) => l.from === relId && l.to === entityId);
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
    const a = map.get(link.to)!;
    const b = map.get(link.from)!;
    a.set(link.from, (a.get(link.from) ?? 0) + 1);
    b.set(link.to, (b.get(link.to) ?? 0) + 1);
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
  hierarchies: Hierarchy[],
  aggregates: AggregateBlock[],
  quick: boolean,
): Map<string, Point> {
  // Each hierarchy is laid out as a tree around its shapes' attributes, and
  // then moves as one rigid block, like each aggregate.
  const blocks = [
    ...hierarchies.map((h) => treeOffsets(h, sized, (id) => clusters.get(id)!.bounds)),
    ...aggregates.map((a) => a.offsets),
  ];

  // Widest cardinality label on the line(s) between each pair of shapes.
  const labelWidths = new Map<string, number>();
  const roles = new Set<string>();
  for (const link of sized.diagram.links) {
    if (link.role !== null) roles.add([link.to, link.from].sort().join('|'));
    if (link.cardinality === null) continue;
    const width = sized.measurer.width(link.cardinality, { size: STYLE.font.smallSize });
    const key = [link.to, link.from].sort().join('|');
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

  // An aggregate's box keeps everything else at a distance, like a shape.
  for (const a of aggregates) obstacles.push({ owner: a.inner, box: a.box });

  const solver = new Compactor(sized, cells, obstacles, links, blocks);
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
  /** For each axis, the group of every shape (shapes in one group move together). */
  private readonly groups: Record<Axis, Map<string, string>>;
  /** For each axis, how far each shape sits from its group's coordinate. */
  private readonly offsets: Record<Axis, Map<string, number>>;

  constructor(
    private readonly sized: SizedDiagram,
    private readonly cells: Map<string, Cell>,
    private readonly obstacles: Obstacle[],
    private readonly links: Link[],
    /** Each hierarchy's shapes, at fixed offsets from each other. */
    private readonly blocks: Map<string, Point>[],
  ) {
    const x = this.groupsAlong('x');
    const y = this.groupsAlong('y', x.groups);
    this.groups = { x: x.groups, y: y.groups };
    this.offsets = { x: x.offsets, y: y.offsets };
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
   * horizontal for y) belong together, at offset 0 from each other; the
   * shapes of a hierarchy or an aggregate belong together at their offsets
   * in its block. Groups are named after their first shape.
   *
   * Two blocks already together in x (`xGroups`) are never put together in
   * y as well: they would be welded into one rigid piece, with nothing left
   * to keep them apart.
   */
  private groupsAlong(
    axis: Axis,
    xGroups?: Map<string, string>,
  ): { groups: Map<string, string>; offsets: Map<string, number> } {
    const index = axis === 'x' ? 'col' : 'row';
    // coordinate(id) = coordinate(parent) + delta(id)
    const parent = new Map([...this.cells.keys()].map((id) => [id, id]));
    const delta = new Map([...this.cells.keys()].map((id) => [id, 0]));
    const find = (id: string): [string, number] => {
      let d = 0;
      while (parent.get(id) !== id) {
        d += delta.get(id)!;
        id = parent.get(id)!;
      }
      return [id, d];
    };
    // For each group, the x-groups of the blocks in it.
    const blocksIn = new Map<string, Set<string>>();
    /** Joins `a` and `b` so that coordinate(b) − coordinate(a) = `distance`. */
    const join = (a: string, b: string, distance: number) => {
      const [ra, da] = find(a);
      const [rb, db] = find(b);
      if (ra === rb) return;
      const [pa, pb] = [blocksIn.get(ra), blocksIn.get(rb)];
      if (pa && pb && [...pa].some((g) => pb.has(g))) return;
      const merged = new Set([...(pa ?? []), ...(pb ?? [])]);
      if (merged.size > 0) blocksIn.set(ra < rb ? ra : rb, merged);
      const rootDistance = distance + da - db; // coordinate(rb) − coordinate(ra)
      if (ra < rb) {
        parent.set(rb, ra);
        delta.set(rb, rootDistance);
      } else {
        parent.set(ra, rb);
        delta.set(ra, -rootDistance);
      }
    };
    for (const block of this.blocks) {
      const [first, ...rest] = [...block.keys()];
      for (const id of rest) join(first!, id, block.get(id)![axis] - block.get(first!)![axis]);
      if (xGroups) {
        const root = find(first!)[0];
        blocksIn.set(root, new Set([...(blocksIn.get(root) ?? []), xGroups.get(first!)!]));
      }
    }
    for (const { a, b } of this.links) {
      if (this.cells.get(a)![index] === this.cells.get(b)![index]) join(a, b, 0);
    }
    const groups = new Map<string, string>();
    const offsets = new Map<string, number>();
    for (const id of this.cells.keys()) {
      const [root, d] = find(id);
      groups.set(id, root);
      offsets.set(id, d);
    }
    return { groups, offsets };
  }

  /**
   * New coordinates along `axis` for every shape, given the coordinates
   * across it (which this pass does not change).
   */
  solve(axis: Axis, along: Map<string, number>, across: Map<string, number>): Map<string, number> {
    const index = axis === 'x' ? 'col' : 'row';
    const otherIndex = axis === 'x' ? 'row' : 'col';
    const groupOf = this.groups[axis];
    const offset = this.offsets[axis];
    const gap = STYLE.layout.gap;

    // Everything that takes up room, along the axis relative to its group and across it absolutely.
    const extents = this.obstacles.map((o) => {
      const [lo, hi, clo, chi] =
        axis === 'x'
          ? [o.box.minX, o.box.maxX, o.box.minY, o.box.maxY]
          : [o.box.minY, o.box.maxY, o.box.minX, o.box.maxX];
      const base = across.get(o.owner)!;
      const shift = offset.get(o.owner)!;
      return {
        owner: o.owner,
        group: groupOf.get(o.owner)!,
        lo: lo + shift,
        hi: hi + shift,
        clo: base + clo,
        chi: base + chi,
      };
    });
    // A straight line across the axis stays put with its group and blocks
    // whatever would slide onto it. Lines along the axis just stretch.
    for (const { a, b } of this.links) {
      if (this.cells.get(a)![index] !== this.cells.get(b)![index]) continue;
      if (groupOf.get(a) !== groupOf.get(b) || offset.get(a) !== offset.get(b)) continue;
      const [p, q] = [across.get(a)!, across.get(b)!];
      const half = STYLE.doubleGap;
      extents.push({
        owner: a,
        group: groupOf.get(a)!,
        lo: offset.get(a)! - half,
        hi: offset.get(a)! + half,
        clo: Math.min(p, q),
        chi: Math.max(p, q),
      });
    }

    // Pairs that face each other across the axis (sorted across it, so each
    // one is only compared with those that start before it ends).
    extents.sort((e, f) => e.clo - f.clo);
    const facing: [number, number][] = [];
    for (let i = 0; i < extents.length; i++) {
      for (let j = i + 1; j < extents.length; j++) {
        if (extents[j]!.clo - gap >= extents[i]!.chi) break;
        if (extents[i]!.group !== extents[j]!.group) facing.push([i, j]);
      }
    }
    const order = this.groupOrder(
      axis,
      along,
      facing.map(([i, j]) => [extents[i]!.owner, extents[j]!.owner]),
    );
    const rank = new Map(order.map((g, i) => [g, i]));

    // Smallest distance from one group to a later one: `minimum[g]` holds [later group, distance].
    const minimum = new Map<string, Map<string, number>>(order.map((g) => [g, new Map()]));
    const keepApart = (first: string, second: string, distance: number) => {
      const map = minimum.get(first)!;
      map.set(second, Math.max(map.get(second) ?? -Infinity, distance));
    };
    for (const [i, j] of facing) {
      let e = extents[i]!;
      let f = extents[j]!;
      if (rank.get(e.group)! > rank.get(f.group)!) [e, f] = [f, e];
      keepApart(e.group, f.group, e.hi + gap - f.lo);
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
      // Between the groups' coordinates rather than the two shapes'.
      length += offset.get(p)! - offset.get(q)!;
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

    return new Map([...groupOf].map(([id, group]) => [id, position.get(group)! + offset.get(id)!]));
  }

  /**
   * The order of the groups along the axis. Two shapes that face each other
   * keep their grid order (then their current order); a group whose shapes
   * span several grid columns (a hierarchy) goes before or after another
   * group as most of their facing shapes say. Groups with no say between
   * them keep their grid order. Without hierarchies this is simply the grid
   * order of the groups.
   */
  private groupOrder(axis: Axis, along: Map<string, number>, facing: [string, string][]): string[] {
    const index = axis === 'x' ? 'col' : 'row';
    const groupOf = this.groups[axis];
    const offset = this.offsets[axis];
    const first = new Map<string, string>();
    for (const [id, group] of groupOf) if (!first.has(group)) first.set(group, id);
    const shapeKey = (id: string): [number, number] => [this.cells.get(id)![index], along.get(id)!];
    const compareKeys = (a: [number, number], b: [number, number], g: string, h: string) =>
      a[0] - b[0] || a[1] - b[1] || (g < h ? -1 : g > h ? 1 : 0);
    const groupKey = (g: string): [number, number] => {
      const id = first.get(g)!;
      return [this.cells.get(id)![index], along.get(id)! - offset.get(id)!];
    };
    const compareGroups = (g: string, h: string) => compareKeys(groupKey(g), groupKey(h), g, h);

    // Votes: positive when the first group of the pair (by name) goes first.
    const votes = new Map<string, number>();
    const vote = (p: string, q: string) => {
      const [g, h] = [groupOf.get(p)!, groupOf.get(q)!];
      if (g === h) return;
      const before = compareKeys(shapeKey(p), shapeKey(q), g, h) < 0;
      const [a, b] = g < h ? [g, h] : [h, g];
      const k = `${a}|${b}`;
      votes.set(k, (votes.get(k) ?? 0) + (g < h === before ? 1 : -1));
    };
    for (const [p, q] of facing) vote(p, q);
    for (const { a, b } of this.links) vote(a, b);

    const after = new Map<string, Set<string>>([...first.keys()].map((g) => [g, new Set()]));
    for (const [k, v] of votes) {
      const [a, b] = k.split('|') as [string, string];
      const aFirst = v > 0 || (v === 0 && compareGroups(a, b) < 0);
      if (aFirst) after.get(b)!.add(a);
      else after.get(a)!.add(b);
    }
    // Earliest group whose predecessors are all placed; if a cycle leaves
    // none, the earliest remaining group (its constraints still hold, in
    // this order).
    const remaining = new Set(first.keys());
    const result: string[] = [];
    while (remaining.size > 0) {
      let pick: string | null = null;
      let fallback: string | null = null;
      for (const g of remaining) {
        if (fallback === null || compareGroups(g, fallback) < 0) fallback = g;
        if ([...after.get(g)!].some((p) => remaining.has(p))) continue;
        if (pick === null || compareGroups(g, pick) < 0) pick = g;
      }
      const g = pick ?? fallback!;
      remaining.delete(g);
      result.push(g);
    }
    return result;
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
