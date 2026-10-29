import type { AttributeNode, Diagram } from '../model/types';
import { treeCells, type Hierarchy } from './tree';

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
 * Hierarchies (specialization, category, part-of) are not placed shape by
 * shape: each one is a rigid block of cells laid out as a tree (see
 * tree.ts), placed all at once where its lines to the rest cost least, and
 * never turned. Nothing else may go inside it. An aggregate is a rigid block
 * too, laid out on its own beforehand (see layout.ts); nothing may go
 * inside its box, and lines between other shapes should not cross it. A
 * relationship that connects to an aggregate goes straight below the
 * relationship inside (`COST.aggregate`), and other lines into it should
 * reach its shapes from outside the box (`COST.intoBox`). An aggregate comes
 * in variants (its participants arranged in different ways around the
 * relationship); the one that fits best is used. A relationship between entities
 * of two different hierarchies should have both in its own row, so its
 * lines are one straight line (`COST.acrossTrees`).
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

/** An aggregate laid out on its own: its cells in each variant, relative to the relationship inside. */
export interface AggregateCells {
  inner: string;
  variants: Map<string, Cell>[];
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
  /**
   * For each broken aggregate rule: a relationship connecting to an
   * aggregate not straight below the relationship inside it, or not below
   * all of the aggregate's participants; a participant below the
   * relationship inside. High enough to act as a rule.
   */
  aggregate: 1000,
  /** A binary relationship between two hierarchies whose entities are not both in its row. */
  acrossTrees: 80,
  /**
   * A line from outside an aggregate to a shape inside it that does not come
   * from the shape's outer side (away from the relationship inside, or from
   * below for the relationship itself), where its attributes left room.
   */
  intoBox: 60,
  /**
   * An EER line that leaves its tree (to a shape inside an aggregate) and
   * runs sideways instead of down from the general end; twice this if it
   * runs up.
   */
  notDownward: 40,
};

/**
 * Grid cells for every node in each connected part of the diagram. `quick`
 * (for very large diagrams) tries one starting shape instead of four and
 * fewer rounds of rotation.
 */
export function placeOnGrid(
  diagram: Diagram,
  hierarchies: Hierarchy[],
  aggregates: AggregateCells[],
  quick = false,
): Map<string, Cell>[] {
  const graph = new Graph(diagram, hierarchies, aggregates);
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
  /** The block of every shape in a hierarchy or aggregate, in each of its variants. */
  readonly blockOf = new Map<string, Block[]>();
  /** For every shape inside an aggregate, the relationship inside. */
  readonly innerOf = new Map<string, string>();
  readonly aggregates: { inner: string; participants: string[]; outer: string[] }[];
  /** Binary relationships between entities of two different hierarchies: [relationship, entity, entity]. */
  readonly acrossTrees: [string, string, string][] = [];
  /** EER lines outside any tree: general end → specific ends. */
  readonly downward = new Map<string, Set<string>>();

  constructor(diagram: Diagram, hierarchies: Hierarchy[], aggregates: AggregateCells[]) {
    const count = (list: AttributeNode[]): number =>
      list.reduce((sum, a) => sum + 1 + count(a.children), 0);
    diagram.nodes.forEach((node, i) => {
      this.neighbours.set(node.id, []);
      this.order.set(node.id, i);
      this.isEntity.set(node.id, node.kind === 'entity');
      this.attributes.set(node.id, count(node.attributes));
    });
    for (const link of diagram.links) {
      const a = this.neighbours.get(link.to)!;
      const b = this.neighbours.get(link.from)!;
      if (b.includes(link.to) && b.length === 1) this.unary.add(link.from);
      if (!a.includes(link.from)) a.push(link.from);
      if (!b.includes(link.to)) b.push(link.to);
    }
    for (const hierarchy of hierarchies) {
      const block = new Block(treeCells(hierarchy), false);
      for (const id of hierarchy.members) this.blockOf.set(id, [block]);
    }
    for (const { inner, variants } of aggregates) {
      // The relationship first, so that it is placed before the others (see `outward`).
      const blocks = variants.map(
        (cells) =>
          new Block(
            new Map([[inner, cells.get(inner)!], ...[...cells].filter(([id]) => id !== inner)]),
            true,
          ),
      );
      for (const id of variants[0]!.keys()) {
        this.blockOf.set(id, blocks);
        this.innerOf.set(id, inner);
      }
    }
    const tree = new Map<string, number>();
    hierarchies.forEach((h, i) => h.members.forEach((id) => tree.set(id, i)));
    for (const link of diagram.links) {
      if (link.kind === 'participation') continue;
      const block = tree.get(link.from);
      if (block !== undefined && block === tree.get(link.to)) continue;
      if (!this.downward.has(link.from)) this.downward.set(link.from, new Set());
      this.downward.get(link.from)!.add(link.to);
    }
    for (const node of diagram.nodes) {
      if (node.kind !== 'relationship') continue;
      const ends = [...new Set(diagram.links.filter((l) => l.from === node.id).map((l) => l.to))];
      const [a, b] = ends;
      if (ends.length !== 2 || !tree.has(a!) || !tree.has(b!) || tree.get(a!) === tree.get(b!))
        continue;
      this.acrossTrees.push([node.id, a!, b!]);
    }
    this.aggregates = diagram.aggregates.map((a) => ({
      inner: a.relationship,
      participants: a.members.filter((m) => m !== a.relationship),
      outer: diagram.links.filter((l) => l.aggregate === a.id).map((l) => l.from),
    }));
  }

  /**
   * Cost of the line between `a` and `b` if it enters an aggregate (`a` or
   * `b` inside it, the other outside) from the wrong side (see `COST.intoBox`).
   */
  intoBoxCost(a: string, aCell: Cell, b: string, bCell: Cell, cells: Map<string, Cell>): number {
    let cost = 0;
    for (const [inside, here, there, outside] of [
      [a, aCell, bCell, b],
      [b, bCell, aCell, a],
    ] as const) {
      const inner = this.innerOf.get(inside);
      if (inner === undefined || this.innerOf.get(outside) === inner) continue;
      const out = this.outward(inside, here, cells);
      if (out && out.col * (there.col - here.col) + out.row * (there.row - here.row) <= 0)
        cost += COST.intoBox;
    }
    return cost;
  }

  /** The outer side of a shape inside an aggregate: away from the relationship, or down for it. */
  private outward(id: string, cell: Cell, cells: Map<string, Cell>): Cell | null {
    const inner = this.innerOf.get(id)!;
    if (id === inner) return { col: 0, row: 1 };
    const c = cells.get(inner);
    if (!c) return null;
    return { col: Math.sign(cell.col - c.col), row: Math.sign(cell.row - c.row) };
  }

  /** Cost of the line between `a` and `b` if it is an EER line outside a tree that does not run down. */
  downwardCost(a: string, aCell: Cell, b: string, bCell: Cell): number {
    const [upper, lower] = this.downward.get(a)?.has(b)
      ? [aCell, bCell]
      : this.downward.get(b)?.has(a)
        ? [bCell, aCell]
        : [null, null];
    if (!upper || !lower || lower.row > upper.row) return 0;
    return lower.row === upper.row ? COST.notDownward : 2 * COST.notDownward;
  }

  /**
   * How many relationships between two hierarchies `id` in `cell` leaves
   * bent, with the shapes already in `cells` (see `COST.acrossTrees`).
   */
  acrossTreesFaults(id: string, cell: Cell, cells: Map<string, Cell>): number {
    let faults = 0;
    for (const trio of this.acrossTrees) {
      if (!trio.includes(id)) continue;
      const rows = trio.map((t) => (t === id ? cell : cells.get(t))?.row);
      if (rows.every((r) => r !== undefined) && new Set(rows).size > 1) faults++;
    }
    return faults;
  }

  /**
   * How many aggregate rules `id` in `cell` breaks with the shapes already
   * in `cells` (see `COST.aggregate`).
   */
  aggregateFaults(id: string, cell: Cell, cells: Map<string, Cell>): number {
    let faults = 0;
    for (const { inner, participants, outer } of this.aggregates) {
      const below = (lower: Cell, upper: Cell) => lower.row > upper.row;
      const under = (lower: Cell, upper: Cell) => lower.col === upper.col && below(lower, upper);
      if (outer.includes(id)) {
        const i = cells.get(inner);
        if (i && !under(cell, i)) faults++;
        for (const p of participants) {
          const c = cells.get(p);
          if (c && !below(cell, c)) faults++;
        }
      }
      if (id === inner) {
        for (const o of outer) {
          const c = cells.get(o);
          if (c && !under(c, cell)) faults++;
        }
        for (const p of participants) {
          const c = cells.get(p);
          if (c && below(c, cell)) faults++;
        }
      }
      if (participants.includes(id)) {
        const i = cells.get(inner);
        if (i && below(cell, i)) faults++;
        for (const o of outer) {
          const c = cells.get(o);
          if (c && !below(c, cell)) faults++;
        }
      }
    }
    return faults;
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

/**
 * A rigid block of cells: a hierarchy (relative to its first root) or an
 * aggregate (relative to the relationship inside), and the cells it keeps
 * free inside. A hierarchy keeps free, on each row, everything between its
 * leftmost and rightmost shape in that row and the rows just above and below
 * (so no shape can end up between its levels, where the rigid block leaves
 * no room); an aggregate keeps its whole box free.
 */
class Block {
  readonly reserved: { row: number; lo: number; hi: number }[] = [];
  /** An aggregate's box, in cells; null for a hierarchy. */
  readonly box: { minCol: number; maxCol: number; minRow: number; maxRow: number } | null;

  constructor(
    readonly cells: Map<string, Cell>,
    aggregate: boolean,
  ) {
    const rows = [...cells.values()].map((c) => c.row);
    const cols = [...cells.values()].map((c) => c.col);
    this.box = aggregate
      ? {
          minCol: Math.min(...cols),
          maxCol: Math.max(...cols),
          minRow: Math.min(...rows),
          maxRow: Math.max(...rows),
        }
      : null;
    for (let row = Math.min(...rows); row <= Math.max(...rows); row++) {
      if (this.box) {
        this.reserved.push({ row, lo: this.box.minCol, hi: this.box.maxCol });
        continue;
      }
      const near = [...cells.values()].filter((c) => Math.abs(c.row - row) <= 1);
      const nearCols = near.map((c) => c.col);
      this.reserved.push({ row, lo: Math.min(...nearCols), hi: Math.max(...nearCols) });
    }
  }
}

class GreedyPlacer {
  private readonly cells = new Map<string, Cell>();
  private readonly occupied = new Map<string, string>();
  /** Lines between placed shapes. */
  private readonly edges: [string, string][] = [];
  /** Inside placed blocks, by the first cell of their first root. */
  private readonly reserved: { row: number; lo: number; hi: number }[] = [];
  /** Placed aggregate boxes, with the shapes inside them. */
  private readonly boxes: { box: CellBox; members: Set<string> }[] = [];

  constructor(
    private readonly graph: Graph,
    private readonly component: string[],
  ) {}

  run(root: string): Map<string, Cell> {
    const blocks = this.graph.blockOf.get(root);
    if (blocks) {
      const at = blocks[0]!.cells.get(root)!;
      this.placeBlock(blocks[0]!, { col: -at.col, row: -at.row });
    } else {
      this.place(root, { col: 0, row: 0 });
    }
    while (this.cells.size < this.component.length) {
      const next = this.pickNext();
      const variants = this.graph.blockOf.get(next);
      if (variants) {
        const { block, shift } = this.bestShift(variants);
        this.placeBlock(block, shift);
      } else {
        this.place(next, this.bestCell(next));
      }
    }
    return this.cells;
  }

  /**
   * Where to put a block: each of its shapes that has a placed neighbour is
   * tried in every cell `bestCell` would try for it (further out if none is
   * free), and each try costs what placing the block's shapes one by one
   * would. Every variant of the block is tried.
   */
  private bestShift(variants: Block[]): { block: Block; shift: Cell } {
    let best: { block: Block; shift: Cell } | null = null;
    let bestCost = Infinity;
    for (let reach = 3; best === null; reach += 3) {
      for (const block of variants) {
        const tried = new Set<string>();
        for (const [id, from] of block.cells) {
          for (const neighbour of this.placedNeighbours(id)) {
            const n = this.cells.get(neighbour)!;
            for (const d of DIRECTIONS) {
              for (let length = 1; length <= reach; length++) {
                const shift = {
                  col: n.col + d.col * length - from.col,
                  row: n.row + d.row * length - from.row,
                };
                if (tried.has(key(shift))) continue;
                tried.add(key(shift));
                const cost = this.blockCost(block, shift);
                if (cost < bestCost - 1e-9) {
                  best = { block, shift };
                  bestCost = cost;
                }
              }
            }
          }
        }
      }
    }
    return best!;
  }

  /** Cost of a block moved by `shift`; Infinity if it would overlap anything. */
  private blockCost(block: Block, shift: Cell): number {
    const moved = [...block.cells].map(([id, c]): [string, Cell] => [
      id,
      { col: c.col + shift.col, row: c.row + shift.row },
    ]);
    if (moved.some(([, c]) => this.taken(c))) return Infinity;
    for (const r of block.reserved) {
      for (const c of this.cells.values()) {
        if (c.row === r.row + shift.row && c.col >= r.lo + shift.col && c.col <= r.hi + shift.col)
          return Infinity;
      }
    }
    let cost = 0;
    if (block.box) {
      // Lines already drawn between other shapes should not cross the new box.
      const box = shiftBox(block.box, shift);
      for (const [a, b] of this.edges) {
        if (segmentHitsCellBox(this.cells.get(a)!, this.cells.get(b)!, box))
          cost += COST.throughShape;
      }
    }
    const placed: string[] = [];
    for (const [id, c] of moved) {
      cost += this.cost(id, c);
      this.place(id, c);
      placed.push(id);
    }
    for (const id of placed.reverse()) this.unplace(id);
    return cost;
  }

  private placeBlock(block: Block, shift: Cell): void {
    for (const [id, c] of block.cells)
      this.place(id, { col: c.col + shift.col, row: c.row + shift.row });
    for (const r of block.reserved) {
      this.reserved.push({ row: r.row + shift.row, lo: r.lo + shift.col, hi: r.hi + shift.col });
    }
    if (block.box) {
      this.boxes.push({ box: shiftBox(block.box, shift), members: new Set(block.cells.keys()) });
    }
  }

  /** True if a shape is in the cell or a block keeps it free. */
  private taken(cell: Cell): boolean {
    if (this.occupied.has(key(cell))) return true;
    return this.reserved.some((r) => r.row === cell.row && cell.col >= r.lo && cell.col <= r.hi);
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
          if (this.taken(cell)) continue;
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
      cost += this.graph.downwardCost(id, cell, neighbour, other);
      cost += this.graph.intoBoxCost(id, cell, neighbour, other, this.cells);
      if (this.runsThroughShape(cell, other, [id, neighbour])) cost += COST.throughShape;
      // Only lines to a shape inside an aggregate may cross into its box.
      for (const { box, members } of this.boxes) {
        if (!members.has(id) && !members.has(neighbour) && segmentHitsCellBox(cell, other, box))
          cost += COST.throughShape;
      }
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
    cost += COST.aggregate * this.graph.aggregateFaults(id, cell, this.cells);
    cost += COST.acrossTrees * this.graph.acrossTreesFaults(id, cell, this.cells);

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

  /** Undoes the last `place` of `id` (its lines were the last ones added). */
  private unplace(id: string): void {
    const cell = this.cells.get(id)!;
    this.cells.delete(id);
    this.occupied.delete(key(cell));
    while (this.edges.length > 0 && this.edges.at(-1)![0] === id) this.edges.pop();
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
    cost += graph.downwardCost(a, p, b, q);
    cost += graph.intoBoxCost(a, p, b, q, cells);
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
  // Each fault is seen from both shapes involved (or all three).
  for (const [id, cell] of cells) {
    cost += (COST.aggregate / 2) * graph.aggregateFaults(id, cell, cells);
    cost += (COST.acrossTrees / 3) * graph.acrossTreesFaults(id, cell, cells);
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
  // Hierarchies are always drawn top-down, so nothing that holds one turns.
  const bridges = [
    { pivot: component[0]!, branch: component },
    ...findBridges(graph, component),
  ].filter(({ branch }) => !branch.some((id) => graph.blockOf.has(id)));
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

interface CellBox {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

function shiftBox(box: CellBox, shift: Cell): CellBox {
  return {
    minCol: box.minCol + shift.col,
    maxCol: box.maxCol + shift.col,
    minRow: box.minRow + shift.row,
    maxRow: box.maxRow + shift.row,
  };
}

/** True if the segment from `a` to `b` passes through the box (grown by under half a cell). */
function segmentHitsCellBox(a: Cell, b: Cell, box: CellBox): boolean {
  const m = 0.4;
  let t0 = 0;
  let t1 = 1;
  const d = { col: b.col - a.col, row: b.row - a.row };
  for (const [p, q, lo, hi] of [
    [a.col, d.col, box.minCol - m, box.maxCol + m],
    [a.row, d.row, box.minRow - m, box.maxRow + m],
  ] as const) {
    if (Math.abs(q) < 1e-12) {
      if (p < lo || p > hi) return false;
      continue;
    }
    let [s, e] = [(lo - p) / q, (hi - p) / q];
    if (s > e) [s, e] = [e, s];
    t0 = Math.max(t0, s);
    t1 = Math.min(t1, e);
    if (t0 > t1) return false;
  }
  return true;
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
