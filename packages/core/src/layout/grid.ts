import type { AttributeNode, Diagram } from '../model/types';

/**
 * Places entities and relationships in the cells of a grid.
 *
 * Textbook ER diagrams are drawn on an invisible grid: a binary relationship
 * sits between its two entities on one straight line, a ternary one has two
 * participants in line and the third at a right angle, and chains of weak
 * entities run in a row or a column. This module reproduces that by putting
 * shapes into grid cells one at a time and scoring every candidate cell:
 *
 * - straight (horizontal or vertical) lines are free; diagonal lines cost
 *   more, other angles more still, and every extra cell of length a little;
 * - lines that run through another shape or cross another line cost a lot;
 * - a shape with attributes needs an open angle for them, so its lines
 *   should leave a wide enough gap (a hub with many attributes gets its
 *   relationships on one side and its attributes on the other);
 * - the lines leaving one shape should point in different directions, so a
 *   shape with two lines gets them opposite each other (a straight chain);
 * - cells next to unrelated shapes cost a little, which leaves room for
 *   attributes, and cells far from the rest cost a little, which keeps the
 *   drawing compact;
 * - the drawing pays for its area and for not being landscape (diagrams
 *   end up in slides and reports), both while it grows and when finished.
 *
 * The greedy pass runs from a few different starting shapes. Each result is
 * then improved by rotating whole branches (parts of the diagram that hang
 * off a single line) around the shape they hang from, which folds long
 * chains into a compact drawing while keeping their lines straight, and by
 * turning the whole drawing. The cheapest result wins. Cells become pixel positions later (see layout.ts).
 */

export interface Cell {
  col: number;
  row: number;
}

const DIRECTIONS: Cell[] = [
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: -1, row: 0 },
  { col: 0, row: -1 },
  { col: 1, row: 1 },
  { col: -1, row: 1 },
  { col: -1, row: -1 },
  { col: 1, row: -1 },
];

/**
 * Tuned on the test fixtures. For example, two short diagonals (a "V" under
 * two entities, as on slide 19) must beat one straight line plus one long
 * diagonal, so a diagonal costs less than two extra cells of length.
 */
const COST = {
  extraLength: 14,
  diagonal: 22,
  otherAngle: 60,
  throughShape: 1000,
  crossing: 300,
  sameDirection: 1000,
  /** Scaled by (1 + cos angle) between two lines leaving the same shape. */
  spread: 8,
  /**
   * Multiplies `spread` at a relationship: entity–diamond–entity should be one
   * straight line, so a chain may bend at an entity but hardly ever at a diamond.
   */
  relationshipBend: 6,
  crowding: 4,
  distance: 0.5,
  /** Per grid cell of the bounding box, for the finished drawing. */
  area: 2,
  /**
   * The finished drawing should be landscape, like the slides and reports
   * diagrams end up in: between `minAspect` and `maxAspect` (width / height,
   * estimated from the grid). Each unit of ratio outside that costs `tall`
   * or `wide`; too tall is worse.
   */
  aspect: { minAspect: 1.5, maxAspect: 2.2, tall: 120, wide: 40 },
  /**
   * A vertical line costs this much more than a horizontal one, so that when
   * nothing else decides, chains run left to right.
   */
  vertical: 2,
  /** Grid columns are wider than rows (shapes are wide), roughly by this factor. */
  columnWidth: 1.2,
  /** Per degree that the widest gap between a shape's lines falls short of what its attributes need. */
  room: 1.5,
  /** Degrees of open angle each attribute (nested ones included) needs, up to `maxRoom`. */
  roomPerAttribute: 25,
  maxRoom: 270,
};

/**
 * Grid cells for every node in each connected part of the diagram. `quick`
 * (for very large diagrams) tries one starting shape instead of four and
 * fewer rounds of rotation.
 */
export function placeOnGrid(diagram: Diagram, quick = false): Map<string, Cell>[] {
  const graph = new Graph(diagram);
  return graph.components().map((component) => {
    let best: { cells: Map<string, Cell>; cost: number } | null = null;
    for (const root of graph.roots(component).slice(0, quick ? 1 : 4)) {
      const cells = improveByRotation(
        graph,
        component,
        new GreedyPlacer(graph, component).run(root),
        quick ? 2 : 8,
      );
      const cost = totalCost(graph, cells);
      if (best === null || cost < best.cost) best = { cells, cost };
    }
    return normalizeCells(best!.cells);
  });
}

/** Entities and relationships as an undirected graph (a unary relationship has one neighbour). */
class Graph {
  readonly neighbours = new Map<string, string[]>();
  readonly order = new Map<string, number>();
  readonly isEntity = new Map<string, boolean>();
  /** Number of attributes (nested ones included) of each shape. */
  readonly attributes = new Map<string, number>();
  /** Unary relationships: both lines go to one entity. */
  readonly unary = new Set<string>();

  constructor(diagram: Diagram) {
    const count = (list: AttributeNode[]): number =>
      list.reduce((sum, a) => sum + 1 + count(a.children), 0);
    diagram.nodes.forEach((node, i) => {
      this.neighbours.set(node.id, []);
      this.order.set(node.id, i);
      this.isEntity.set(node.id, node.kind === 'entity');
      this.attributes.set(node.id, count(node.attributes));
    });
    for (const link of diagram.links) {
      const a = this.neighbours.get(link.entity)!;
      const b = this.neighbours.get(link.relationship)!;
      if (b.includes(link.entity) && b.length === 1) this.unary.add(link.relationship);
      if (!a.includes(link.relationship)) a.push(link.relationship);
      if (!b.includes(link.entity)) b.push(link.entity);
    }
  }

  degree(id: string): number {
    return this.neighbours.get(id)!.length;
  }

  /** Connected components, each in model order. */
  components(): string[][] {
    const seen = new Set<string>();
    const result: string[][] = [];
    for (const id of this.order.keys()) {
      if (seen.has(id)) continue;
      const component: string[] = [];
      const stack = [id];
      seen.add(id);
      while (stack.length > 0) {
        const current = stack.pop()!;
        component.push(current);
        for (const next of this.neighbours.get(current)!) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      component.sort((a, b) => this.order.get(a)! - this.order.get(b)!);
      result.push(component);
    }
    return result;
  }

  /** Starting shapes worth trying: the best-connected entities first. */
  roots(component: string[]): string[] {
    const ranked = [...component].sort(
      (a, b) =>
        Number(this.isEntity.get(b)) - Number(this.isEntity.get(a)) ||
        this.degree(b) - this.degree(a) ||
        this.order.get(a)! - this.order.get(b)!,
    );
    return ranked.slice(0, 4);
  }
}

class GreedyPlacer {
  private readonly cells = new Map<string, Cell>();
  private readonly occupied = new Map<string, string>();
  /** Lines between placed shapes. */
  private readonly edges: [string, string][] = [];

  constructor(
    private readonly graph: Graph,
    private readonly component: string[],
  ) {}

  run(root: string): Map<string, Cell> {
    this.place(root, { col: 0, row: 0 });
    while (this.cells.size < this.component.length) {
      const next = this.pickNext();
      this.place(next, this.bestCell(next));
    }
    return this.cells;
  }

  /** The unplaced shape with the most placed neighbours (then most lines, then model order). */
  private pickNext(): string {
    let best: string | null = null;
    let bestKey: number[] = [];
    for (const id of this.component) {
      if (this.cells.has(id)) continue;
      const placed = this.placedNeighbours(id).length;
      if (placed === 0) continue;
      const key = [placed, this.graph.degree(id), -this.graph.order.get(id)!];
      if (best === null || compare(key, bestKey) > 0) {
        best = id;
        bestKey = key;
      }
    }
    return best!;
  }

  private bestCell(id: string): Cell {
    let best: Cell | null = null;
    let bestCost = Infinity;
    for (const neighbour of this.placedNeighbours(id)) {
      const from = this.cells.get(neighbour)!;
      // A unary relationship stays right beside, above or below its entity,
      // so its loop stays small and symmetric.
      const unary = this.graph.unary.has(id);
      const maxLength = unary ? 1 : 3;
      for (const direction of unary ? DIRECTIONS.slice(0, 4) : DIRECTIONS) {
        for (let length = 1; length <= maxLength; length++) {
          const cell = {
            col: from.col + direction.col * length,
            row: from.row + direction.row * length,
          };
          if (this.occupied.has(key(cell))) continue;
          const cost = this.cost(id, cell);
          if (cost < bestCost - 1e-9) {
            best = cell;
            bestCost = cost;
          }
        }
      }
    }
    return best!;
  }

  /** Cost of putting `id` in `cell`, given everything placed so far. */
  private cost(id: string, cell: Cell): number {
    let cost = 0;
    const neighbours = this.placedNeighbours(id);
    const newArms: Cell[] = [];

    for (const neighbour of neighbours) {
      const other = this.cells.get(neighbour)!;
      cost += lineCost(cell, other);
      if (this.runsThroughShape(cell, other, [id, neighbour])) cost += COST.throughShape;
      for (const [a, b] of this.edges) {
        if (a === neighbour || b === neighbour) continue;
        if (segmentsCross(cell, other, this.cells.get(a)!, this.cells.get(b)!))
          cost += COST.crossing;
      }
      // Lines already leaving the neighbour should point elsewhere...
      const arm = { col: cell.col - other.col, row: cell.row - other.row };
      const existingArms = this.arms(neighbour);
      const bend = this.graph.isEntity.get(neighbour) ? 1 : COST.relationshipBend;
      for (const existing of existingArms) cost += bend * spreadCost(arm, existing);
      // ...and leave it room for its attributes.
      const weight = this.graph.attributes.get(neighbour)!;
      cost += roomCost([...existingArms, arm], weight) - roomCost(existingArms, weight);
      newArms.push({ col: other.col - cell.col, row: other.row - cell.row });
    }
    // The new shape's own lines should point in different directions too.
    const bend = this.graph.isEntity.get(id) ? 1 : COST.relationshipBend;
    for (let i = 0; i < newArms.length; i++) {
      for (let j = i + 1; j < newArms.length; j++) {
        cost += bend * spreadCost(newArms[i]!, newArms[j]!);
      }
    }
    cost += roomCost(newArms, this.graph.attributes.get(id)!);

    // The new shape must not sit on an existing line.
    for (const [a, b] of this.edges) {
      if (onSegment(cell, this.cells.get(a)!, this.cells.get(b)!)) cost += COST.throughShape;
    }

    // Unrelated neighbours leave less room for attributes.
    const related = new Set(this.graph.neighbours.get(id));
    for (const direction of DIRECTIONS) {
      const near = this.occupied.get(
        key({ col: cell.col + direction.col, row: cell.row + direction.row }),
      );
      if (near !== undefined && !related.has(near)) cost += COST.crowding;
    }

    // Stay close to the rest of the drawing.
    let sumCol = 0;
    let sumRow = 0;
    for (const c of this.cells.values()) {
      sumCol += c.col;
      sumRow += c.row;
    }
    const n = this.cells.size;
    cost += COST.distance * (Math.abs(cell.col - sumCol / n) + Math.abs(cell.row - sumRow / n));

    // Keep the drawing landscape as it grows, so that long chains fold
    // here already (a chain inside a cycle cannot be folded afterwards).
    const placed = [...this.cells.values()];
    cost += shapeCost([...placed, cell]) - shapeCost(placed);
    return cost;
  }

  private place(id: string, cell: Cell): void {
    this.cells.set(id, cell);
    this.occupied.set(key(cell), id);
    for (const neighbour of this.placedNeighbours(id)) this.edges.push([id, neighbour]);
  }

  private placedNeighbours(id: string): string[] {
    return this.graph.neighbours.get(id)!.filter((n) => this.cells.has(n));
  }

  /** Directions of the lines already leaving a placed shape. */
  private arms(id: string): Cell[] {
    const here = this.cells.get(id)!;
    return this.placedNeighbours(id).map((n) => {
      const there = this.cells.get(n)!;
      return { col: there.col - here.col, row: there.row - here.row };
    });
  }

  private runsThroughShape(a: Cell, b: Cell, ignore: string[]): boolean {
    for (const [k, id] of this.occupied) {
      if (ignore.includes(id)) continue;
      const [col, row] = k.split(',').map(Number) as [number, number];
      if (onSegment({ col, row }, a, b)) return true;
    }
    return false;
  }
}

/** Total cost of a finished placement, to compare different starting shapes. */
function totalCost(graph: Graph, cells: Map<string, Cell>): number {
  const edges: [string, string][] = [];
  for (const [id, neighbours] of graph.neighbours) {
    if (!cells.has(id)) continue;
    for (const n of neighbours) if (id < n && cells.has(n)) edges.push([id, n]);
  }
  let cost = 0;
  edges.forEach(([a, b], i) => {
    const p = cells.get(a)!;
    const q = cells.get(b)!;
    cost += lineCost(p, q);
    for (const [id, c] of cells) {
      if (id !== a && id !== b && onSegment(c, p, q)) cost += COST.throughShape;
    }
    for (const [c, d] of edges.slice(i + 1)) {
      if (c === a || c === b || d === a || d === b) continue;
      if (segmentsCross(p, q, cells.get(c)!, cells.get(d)!)) cost += COST.crossing;
    }
  });
  for (const [id, neighbours] of graph.neighbours) {
    const here = cells.get(id);
    if (!here) continue;
    const arms = neighbours
      .map((n) => cells.get(n))
      .filter((c): c is Cell => c !== undefined)
      .map((c) => ({ col: c.col - here.col, row: c.row - here.row }));
    const bend = graph.isEntity.get(id) ? 1 : COST.relationshipBend;
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) cost += bend * spreadCost(arms[i]!, arms[j]!);
    }
    cost += roomCost(arms, graph.attributes.get(id)!);
  }
  return cost + shapeCost([...cells.values()]);
}

/** Cost of the drawing's overall shape: its area, and how far it is from landscape. */
function shapeCost(cells: Cell[]): number {
  const cols = cells.map((c) => c.col);
  const rows = cells.map((c) => c.row);
  const width = Math.max(...cols) - Math.min(...cols) + 1;
  const height = Math.max(...rows) - Math.min(...rows) + 1;
  // The shape of the drawing only matters once it has a few shapes: a lone
  // binary relationship is naturally one short horizontal line.
  const ratio = (width * COST.columnWidth) / height;
  const weight = Math.min(1, Math.max(0, (cells.length - 3) / 6));
  const { minAspect, maxAspect, tall, wide } = COST.aspect;
  return (
    COST.area * width * height +
    weight * (tall * Math.max(0, minAspect - ratio) + wide * Math.max(0, ratio - maxAspect))
  );
}

/**
 * Local search: for every line whose removal splits the diagram in two
 * (a "bridge"), try rotating the smaller side by 90°, 180° and 270° around
 * the shape on the other end of the line; also try turning the whole
 * drawing (which only changes its aspect ratio and how many lines are
 * vertical). Keep any rotation that lowers the total cost, and repeat until
 * nothing improves.
 */
function improveByRotation(
  graph: Graph,
  component: string[],
  start: Map<string, Cell>,
  rounds: number,
): Map<string, Cell> {
  let cells = start;
  let cost = totalCost(graph, cells);
  const bridges = [{ pivot: component[0]!, branch: component }, ...findBridges(graph, component)];
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (const { pivot, branch } of bridges) {
      for (const turns of [1, 2, 3]) {
        const rotated = rotateBranch(cells, branch, cells.get(pivot)!, turns);
        if (!rotated) continue;
        const rotatedCost = totalCost(graph, rotated);
        if (rotatedCost < cost - 1e-6) {
          cells = rotated;
          cost = rotatedCost;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return cells;
}

/**
 * Lines whose removal disconnects the component, as the shape that stays
 * (`pivot`) and the shapes on the smaller side (`branch`).
 */
function findBridges(graph: Graph, component: string[]): { pivot: string; branch: string[] }[] {
  const result: { pivot: string; branch: string[] }[] = [];
  const inComponent = new Set(component);
  for (const a of component) {
    for (const b of graph.neighbours.get(a)!) {
      if (a >= b || !inComponent.has(b)) continue;
      // Shapes reachable from b without using the line a–b.
      const seen = new Set([b]);
      const stack = [b];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const next of graph.neighbours.get(current)!) {
          if (current === b && next === a) continue;
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      if (seen.has(a)) continue; // not a bridge
      const side = [...seen];
      const other = component.filter((id) => !seen.has(id));
      result.push(
        side.length <= other.length ? { pivot: a, branch: side } : { pivot: b, branch: other },
      );
    }
  }
  return result;
}

/** Rotates the branch's cells by `turns` quarter turns around `pivot`; null if they would collide. */
function rotateBranch(
  cells: Map<string, Cell>,
  branch: string[],
  pivot: Cell,
  turns: number,
): Map<string, Cell> | null {
  const inBranch = new Set(branch);
  const result = new Map(cells);
  const taken = new Set([...cells].filter(([id]) => !inBranch.has(id)).map(([, c]) => key(c)));
  for (const id of branch) {
    const c = cells.get(id)!;
    let dc = c.col - pivot.col;
    let dr = c.row - pivot.row;
    for (let i = 0; i < turns; i++) [dc, dr] = [-dr, dc];
    const moved = { col: pivot.col + dc, row: pivot.row + dr };
    if (taken.has(key(moved))) return null;
    taken.add(key(moved));
    result.set(id, moved);
  }
  return result;
}

/**
 * How much a shape's lines crowd its attributes: the widest gap between
 * neighbouring lines, compared with the angle its attributes need.
 */
function roomCost(arms: Cell[], attributes: number): number {
  if (attributes === 0 || arms.length < 2) return 0;
  const need = Math.min(COST.maxRoom, COST.roomPerAttribute * attributes);
  const angles = arms.map((a) => (Math.atan2(a.row, a.col) * 180) / Math.PI).sort((a, b) => a - b);
  let widest = 360 - (angles.at(-1)! - angles[0]!);
  for (let i = 1; i < angles.length; i++) widest = Math.max(widest, angles[i]! - angles[i - 1]!);
  return COST.room * Math.max(0, need - widest);
}

function lineCost(a: Cell, b: Cell): number {
  const dc = Math.abs(a.col - b.col);
  const dr = Math.abs(a.row - b.row);
  if (dc === 0) return COST.extraLength * (dr - 1) + COST.vertical;
  if (dr === 0) return COST.extraLength * (dc - 1);
  if (dc === dr) return COST.diagonal + COST.extraLength * (dc - 1);
  return COST.otherAngle + COST.extraLength * (dc + dr);
}

/** 0 for opposite directions, `spread` at a right angle, a large penalty for the same direction. */
function spreadCost(a: Cell, b: Cell): number {
  const cos =
    (a.col * b.col + a.row * b.row) / (Math.hypot(a.col, a.row) * Math.hypot(b.col, b.row));
  if (cos > 0.999) return COST.sameDirection;
  return COST.spread * (1 + cos);
}

/** True if `p` lies on the segment from `a` to `b`, strictly between its ends (within a third of a cell). */
function onSegment(p: Cell, a: Cell, b: Cell): boolean {
  const dx = b.col - a.col;
  const dy = b.row - a.row;
  const length2 = dx * dx + dy * dy;
  const t = ((p.col - a.col) * dx + (p.row - a.row) * dy) / length2;
  if (t <= 1e-9 || t >= 1 - 1e-9) return false;
  const x = a.col + t * dx - p.col;
  const y = a.row + t * dy - p.row;
  return x * x + y * y < 0.35 * 0.35;
}

/** True if two segments cross at a point inside both. */
function segmentsCross(a: Cell, b: Cell, c: Cell, d: Cell): boolean {
  const cross = (p: Cell, q: Cell, r: Cell) =>
    (q.col - p.col) * (r.row - p.row) - (q.row - p.row) * (r.col - p.col);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function normalizeCells(cells: Map<string, Cell>): Map<string, Cell> {
  const minCol = Math.min(...[...cells.values()].map((c) => c.col));
  const minRow = Math.min(...[...cells.values()].map((c) => c.row));
  return new Map([...cells].map(([id, c]) => [id, { col: c.col - minCol, row: c.row - minRow }]));
}

function key(cell: Cell): string {
  return `${cell.col},${cell.row}`;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}
