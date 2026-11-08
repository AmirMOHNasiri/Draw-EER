/**
 * An aggregate whose members are also in a tree (a subtype inside an
 * aggregate, say) is drawn together with that tree, as one rigid block: the
 * members sit on their tree levels and every circle is centered over all
 * its children, as in any tree (the owner's rule: general on top, trees
 * symmetric). The aggregate's members ("anchors") are moved to one side of
 * the tree (`withAnchorsAt`), so that its box can take that side without
 * enclosing anything else of the tree; both sides are tried on the grid.
 *
 * In pixels, the tree is laid out with the anchors in it, then widened
 * between siblings and lowered between levels until the anchors are at
 * least as far apart as in the aggregate's own layout and nothing else of
 * the tree touches the box. The aggregate is then stretched to match: the
 * shapes beyond the midpoint between two neighbouring anchors move away
 * by what the tree adds there (a straight line between them just gets
 * longer).
 *
 * An aggregate can touch several trees (vehicles.eer: an owner and a
 * vehicle, each a category under its own U), as long as each holds one of
 * its members. Each tree then hangs from its member as laid out on its
 * own, and the aggregate is stretched between the members of neighbouring
 * trees until the trees are clear of each other.
 */
import type { Point } from '../geometry/shapes';
import { STYLE } from '../render/style';
import type { AttributeCluster, Bounds } from './attributes';
import type { Cell } from './grid';
import type { SizedDiagram } from './size';
import {
  lineDistance,
  treeCells,
  treeOffsets,
  withAnchorsAt,
  type Hierarchy,
  type Slopes,
  type TreeStretch,
} from './tree';

export type Side = 'left' | 'right';

/** How far (px) the tree widens or a level goes down at a time to clear a line (see `compoundOffsets`). */
const STEP = 4;

/** A tree drawn with an aggregate, with the anchors at `side` (see `withAnchorsAt`). */
export interface CompoundTree {
  hierarchy: Hierarchy;
  side: Side;
  /** Children the aggregate pins (see `pinnedChildren`). */
  pinned: Set<string>;
}

/** One way to draw trees with an aggregate. */
export interface CompoundVariant {
  trees: CompoundTree[];
  /** The aggregate's own arrangement (see `arrangements` in layout.ts), relative to the relationship inside. */
  arrangement: Map<string, Cell>;
  /** Grid cells of the tree and the aggregate, relative to the relationship inside. */
  cells: Map<string, Cell>;
}

/**
 * The ways to put the aggregate's arrangements into the tree on either
 * side. An arrangement fits if the relationship inside can be given a cell
 * that keeps every anchor on the same side of it as in the arrangement
 * (above it, left of it, in its row...), and its box then holds no other
 * shape of the tree. None fits: the aggregate is drawn on its own.
 */
export function compoundVariants(
  trees: Hierarchy[],
  members: string[],
  arrangements: Map<string, Cell>[],
  /** EER lines (general end first), for the order of siblings (see `withAnchorsAt`). */
  lines: [string, string][],
): CompoundVariant[] {
  if (trees.length > 1) return severalTrees(trees, members, arrangements, lines);
  const h = trees[0]!;
  const anchors = new Set(members.filter((m) => h.members.includes(m)));
  const result: CompoundVariant[] = [];
  const seen = new Set<string>();
  for (const side of ['right', 'left'] as const) {
    const hierarchy = withAnchorsAt(h, anchors, side, lines);
    const pinned = pinnedChildren(hierarchy, anchors, lines);
    for (const arrangement of arrangements) {
      const placed = placeIn(hierarchy, anchors, arrangement, members, side, pinned);
      if (!placed) continue;
      const { cells, at } = placed;
      const relative = new Map(
        [...cells].map(([id, c]) => [id, { col: c.col - at.col, row: c.row - at.row }]),
      );
      const key = [...relative].map(([id, c]) => `${id}@${c.col},${c.row}`).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ trees: [{ hierarchy, side, pinned }], arrangement, cells: relative });
    }
  }
  return result;
}

/**
 * A cell for the relationship inside, among the tree's cells: in the column
 * of an anchor straight above or below it in the arrangement (else between
 * the anchors left and right of it), in the row of an anchor beside it
 * (else between those above and below), or null if no cell keeps every
 * anchor on its side.
 */
function innerCell(
  tree: Map<string, Cell>,
  anchors: Set<string>,
  arrangement: Map<string, Cell>,
): Cell | null {
  const along = (axis: 'col' | 'row'): number | null => {
    const placed = [...anchors].map((id) => ({
      at: tree.get(id)![axis],
      d: arrangement.get(id)![axis],
    }));
    const level = placed.filter((p) => p.d === 0).map((p) => p.at);
    if (level.length > 0) return new Set(level).size === 1 ? level[0]! : null;
    const lo = Math.max(-Infinity, ...placed.filter((p) => p.d < 0).map((p) => p.at + 1));
    const hi = Math.min(Infinity, ...placed.filter((p) => p.d > 0).map((p) => p.at - 1));
    // As far from each anchor as in the arrangement, where that is allowed.
    const wanted = placed.map((p) => p.at - p.d).sort((a, b) => a - b);
    const value = Math.min(hi, Math.max(lo, wanted[Math.floor(wanted.length / 2)]!));
    return lo <= hi ? Math.round(value) : null;
  };
  const col = along('col');
  const row = along('row');
  if (col === null || row === null) return null;
  for (const id of anchors) {
    const [t, a] = [tree.get(id)!, arrangement.get(id)!];
    if (Math.sign(t.col - col) !== Math.sign(a.col) || Math.sign(t.row - row) !== Math.sign(a.row))
      return null;
  }
  return { col, row };
}

/**
 * The tree's cells with the aggregate's arrangement in them, the tree
 * widened (in whole columns, as in pixels: see `compoundOffsets`) until the
 * anchors are as far apart as in the arrangement and the box around
 * `members` holds no other shape of the tree. Null if the anchors' rows do
 * not fit the arrangement.
 */
function placeIn(
  h: Hierarchy,
  anchors: Set<string>,
  arrangement: Map<string, Cell>,
  members: string[],
  side: Side,
  pinned: Set<string>,
): { cells: Map<string, Cell>; at: Cell } | null {
  const symmetric = widenedCells(h, anchors, arrangement, members, side, NO_SPREAD);
  if (!symmetric) return null;
  const natural = treeCells(h);
  const col = (cells: Map<string, Cell>) => (id: string) => cells.get(id)!.col;
  const asymmetric = spreadTooFar(h, pinned, symmetric.extra, col(natural), col(symmetric.tree));
  if (asymmetric.size === 0) return symmetric;
  return widenedCells(h, anchors, arrangement, members, side, { asymmetric, pinned }) ?? symmetric;
}

/** `placeIn` with the rows in `spread.asymmetric` widened on one side only (see `widener`). */
function widenedCells(
  h: Hierarchy,
  anchors: Set<string>,
  arrangement: Map<string, Cell>,
  members: string[],
  side: Side,
  spread: Spread,
): {
  cells: Map<string, Cell>;
  at: Cell;
  tree: Map<string, Cell>;
  extra: Map<string, number>;
} | null {
  const stretch = { x: new Map<string, number>(), away: new Map<string, number>() };
  const extra = stretch.x;
  const centerOver = freeChildren(h, spread);
  const widen = widener(h, true, spread);
  const byCol = [...anchors].sort((p, q) => arrangement.get(p)!.col - arrangement.get(q)!.col);
  for (let i = 0; i < 40; i++) {
    const tree = treeCells(h, extra, stretch.away, centerOver);
    let widened = false;
    for (let k = 1; k < byCol.length && !widened; k++) {
      const [p, q] = [byCol[k - 1]!, byCol[k]!];
      const wanted = arrangement.get(q)!.col - arrangement.get(p)!.col;
      const short = wanted - (tree.get(q)!.col - tree.get(p)!.col);
      if (wanted > 0 && short > 0) widened = widen(stretch, q, p, short);
    }
    if (widened) continue;
    const at = innerCell(tree, anchors, arrangement);
    if (!at) return null;
    const cells = new Map(tree);
    for (const [id, c] of arrangement) {
      if (!anchors.has(id)) cells.set(id, { col: at.col + c.col, row: at.row + c.row });
    }
    const box = members.map((id) => cells.get(id)!);
    const [minCol, maxCol] = [
      Math.min(...box.map((c) => c.col)),
      Math.max(...box.map((c) => c.col)),
    ];
    const [minRow, maxRow] = [
      Math.min(...box.map((c) => c.row)),
      Math.max(...box.map((c) => c.row)),
    ];
    const inside = [...cells].find(
      ([id, c]) =>
        !members.includes(id) &&
        c.col >= minCol &&
        c.col <= maxCol &&
        c.row >= minRow &&
        c.row <= maxRow,
    );
    if (!inside) return { cells, at, tree, extra };
    // Out of the box, away from the anchor its near side moves with.
    const [id, c] = inside;
    const near = side === 'right' ? byCol[0]! : byCol.at(-1)!;
    const moved =
      side === 'right'
        ? widen(stretch, near, id, c.col - minCol + 1)
        : widen(stretch, id, near, maxCol - c.col + 1);
    if (!moved) return null;
  }
  return null;
}

/** A tree and an aggregate in pixels, relative to the relationship inside. */
export interface CompoundBlock {
  offsets: Map<string, Point>;
  /** The aggregate's box, padding included. */
  box: Bounds;
}

/**
 * Pixel offsets of a tree drawn with an aggregate (see the top of this
 * file). `natural` is the aggregate laid out on its own (relative to the
 * relationship inside), `bounds` the room each shape of the tree takes
 * with its attributes.
 */
export function compoundOffsets(
  variant: CompoundVariant,
  natural: { offsets: Map<string, Point>; clusters: Map<string, AttributeCluster> },
  sized: SizedDiagram,
  bounds: (id: string) => Bounds,
  slopes: Slopes,
): CompoundBlock {
  if (variant.trees.length > 1) return severalTreesOffsets(variant, natural, sized, bounds, slopes);
  const one = variant.trees[0]!;
  const h = one.hierarchy;
  const { arrangement } = variant;
  const members = [...arrangement.keys()];
  const anchors = members.filter((m) => h.members.includes(m));
  const symmetric = widenedOffsets(one, arrangement, natural, sized, bounds, slopes, NO_SPREAD);
  const plain = treeOffsets(h, sized, bounds, { x: new Map(), y: new Map() }, slopes);
  const x = (at: Map<string, Point>) => (id: string) => at.get(id)!.x;
  const asymmetric = spreadTooFar(h, one.pinned, symmetric.stretch.x, x(plain), x(symmetric.tree));
  const { tree, aggregate } =
    asymmetric.size === 0
      ? symmetric
      : widenedOffsets(one, arrangement, natural, sized, bounds, slopes, {
          asymmetric,
          pinned: one.pinned,
        });

  // Everything relative to the relationship inside (at 0, 0 in its arrangement),
  // which the stretching may have moved.
  const [a0, t0] = [aggregate.get(anchors[0]!)!, tree.get(anchors[0]!)!];
  const offsets = new Map(aggregate);
  for (const [id, p] of tree) {
    if (!members.includes(id)) offsets.set(id, { x: p.x - t0.x + a0.x, y: p.y - t0.y + a0.y });
  }
  return relativeToInner(arrangement, offsets, boxOf(aggregate, natural.clusters, members));
}

/** The relationship inside: at 0, 0 in its arrangement. */
function innerOf(arrangement: Map<string, Cell>): string {
  return [...arrangement].find(([, c]) => c.col === 0 && c.row === 0)![0];
}

/** `offsets` and `box` moved so that the relationship inside (the stretching may have moved it) is at 0, 0. */
function relativeToInner(
  arrangement: Map<string, Cell>,
  offsets: Map<string, Point>,
  box: Bounds,
): CompoundBlock {
  const origin = offsets.get(innerOf(arrangement))!;
  return {
    offsets: new Map([...offsets].map(([id, p]) => [id, { x: p.x - origin.x, y: p.y - origin.y }])),
    box: {
      minX: box.minX - origin.x,
      maxX: box.maxX - origin.x,
      minY: box.minY - origin.y,
      maxY: box.maxY - origin.y,
    },
  };
}

/**
 * The tree, widened and lowered until the aggregate fits (see the top of
 * this file), the shapes in `asymmetric` widened on one side only, and the
 * aggregate stretched to match.
 */
function widenedOffsets(
  { hierarchy: h, side }: CompoundTree,
  arrangement: Map<string, Cell>,
  natural: { offsets: Map<string, Point>; clusters: Map<string, AttributeCluster> },
  sized: SizedDiagram,
  bounds: (id: string) => Bounds,
  slopes: Slopes,
  spread: Spread,
): { tree: Map<string, Point>; aggregate: Map<string, Point>; stretch: TreeStretch } {
  const members = [...arrangement.keys()];
  const anchors = members.filter((m) => h.members.includes(m));
  const N = natural.offsets;
  const stretch: TreeStretch = {
    x: new Map(),
    away: new Map(),
    centerOver: freeChildren(h, spread),
    y: new Map(),
  };
  const widen = widener(h, false, spread);
  const level = levelOf(h);
  const separate = (a: string, b: string, amount: number) => widen(stretch, a, b, amount);
  const lower = (l: number, amount: number) => stretch.y.set(l, (stretch.y.get(l) ?? 0) + amount);

  for (let i = 0; i < 200; i++) {
    const tree = treeOffsets(h, sized, bounds, stretch, slopes);
    let fixed = false;
    // The anchors at least as far apart as in the aggregate's own layout.
    for (const axis of ['x', 'y'] as const) {
      const sorted = [...anchors].sort((p, q) => N.get(p)![axis] - N.get(q)![axis]);
      for (let k = 1; k < sorted.length && !fixed; k++) {
        const [p, q] = [sorted[k - 1]!, sorted[k]!];
        const wanted = N.get(q)![axis] - N.get(p)![axis];
        const short = wanted - (tree.get(q)![axis] - tree.get(p)![axis]);
        if (wanted < 0.5 || short < 0.5) continue;
        if (axis === 'x') fixed = separate(q, p, short);
        else if (level(q) > level(p)) {
          lower(level(q), short);
          fixed = true;
        }
      }
    }
    if (fixed) continue;
    const aggregate = stretched(N, anchors, tree, members);
    // In the tree's frame: the aggregate's offsets are relative to the relationship inside.
    const [a0, t0] = [aggregate.get(anchors[0]!)!, tree.get(anchors[0]!)!];
    const own = boxOf(aggregate, natural.clusters, members);
    const box = {
      minX: own.minX + t0.x - a0.x,
      maxX: own.maxX + t0.x - a0.x,
      minY: own.minY + t0.y - a0.y,
      maxY: own.maxY + t0.y - a0.y,
    };
    const byX = [...anchors].sort((p, q) => N.get(p)!.x - N.get(q)!.x);
    const near = side === 'right' ? byX[0]! : byX.at(-1)!;
    if (!clearTree({ h, side, anchors, near, members, stretch, widen, sized, bounds }, tree, box))
      break;
  }
  const tree = treeOffsets(h, sized, bounds, stretch, slopes);
  const aggregate = stretched(N, anchors, tree, members);
  return { tree, aggregate, stretch };
}

/** A shape's level in a tree; a part-of hexagon's is half a level above its part. */
function levelOf(h: Hierarchy): (id: string) => number {
  return (id) => h.level.get(id) ?? h.level.get(h.hexagons.get(id)?.[1] ?? '')! - 0.5;
}

/** A tree being widened next to an aggregate (see `clearTree`). */
interface TreeWork {
  h: Hierarchy;
  side: Side;
  /** The aggregate's members in this tree. */
  anchors: string[];
  /** The anchor the box's near edge moves with (see `stretched`). */
  near: string;
  /** All the aggregate's shapes. */
  members: string[];
  stretch: TreeStretch;
  widen: Widener;
  sized: SizedDiagram;
  bounds: (id: string) => Bounds;
}

/**
 * Makes one change to the tree, if one is needed, and says whether it did:
 * nothing else of the tree in or touching the aggregate's `box` (in the
 * tree's frame; below it, above it or beside it), and every line down the
 * tree clear of the shapes it does not join (a shared subtype beside a
 * circle, whose lines run past it): a shape beside the line's upper end
 * moves sideways, away from it; otherwise the lower end goes further down.
 */
function clearTree(w: TreeWork, tree: Map<string, Point>, box: Bounds): boolean {
  const { h, side, anchors, near, stretch, widen, sized, bounds } = w;
  const level = levelOf(h);
  const gap = STYLE.layout.gap;
  const separate = (a: string, b: string, amount: number) => widen(stretch, a, b, amount);
  const lower = (l: number, amount: number) => stretch.y.set(l, (stretch.y.get(l) ?? 0) + amount);
  const top = Math.min(...anchors.map(level));
  const bottom = Math.max(...anchors.map(level));
  for (const id of h.members.filter((m) => !w.members.includes(m))) {
    const p = tree.get(id)!;
    const b = bounds(id);
    const r = { minX: p.x + b.minX, maxX: p.x + b.maxX, minY: p.y + b.minY, maxY: p.y + b.maxY };
    if (
      r.maxX + gap <= box.minX + 0.5 ||
      r.minX - gap >= box.maxX - 0.5 ||
      r.maxY + gap <= box.minY + 0.5 ||
      r.minY - gap >= box.maxY - 0.5
    )
      continue;
    if (level(id) < top) lower(top, r.maxY + gap - box.minY);
    else if (level(id) > bottom) lower(Math.ceil(level(id)), box.maxY + gap - r.minY);
    else {
      const moved =
        side === 'right'
          ? separate(near, id, r.maxX + gap - box.minX)
          : separate(id, near, box.maxX + gap - r.minX);
      if (!moved) continue;
    }
    return true;
  }
  for (const [from, to] of treeLines(h)) {
    const id = h.members.find(
      (x) =>
        x !== from &&
        x !== to &&
        !h.hexagons.has(x) &&
        lineDistance(sized, tree, from, to, x) < STYLE.lineClearance,
    );
    if (id === undefined) continue;
    const beside = level(id) <= level(from) + 1e-9;
    const right = tree.get(id)!.x > tree.get(from)!.x;
    if (!beside || !(right ? separate(id, from, STEP) : separate(from, id, STEP)))
      lower(Math.ceil(level(to)), STEP);
    return true;
  }
  return false;
}

/** The lines of a tree, general end first: to each child, and from each parent drawn above a shape. */
function treeLines(h: Hierarchy): [string, string][] {
  const lines: [string, string][] = [];
  for (const [parent, kids] of h.children) for (const kid of kids) lines.push([parent, kid]);
  for (const [shape, parents] of h.above) for (const p of parents) lines.push([p, shape]);
  return lines;
}

/**
 * The aggregate's offsets (relative to the relationship inside) with the
 * anchors as far apart as in the tree: along each axis, every shape beyond
 * the midpoint between two neighbouring anchors moves by what the tree adds.
 */
function stretched(
  N: Map<string, Point>,
  anchors: string[],
  tree: Map<string, Point>,
  members: string[],
): Map<string, Point> {
  const result = new Map(members.map((id) => [id, { ...N.get(id)! }]));
  for (const axis of ['x', 'y'] as const) {
    const sorted = [...anchors].sort((p, q) => N.get(p)![axis] - N.get(q)![axis]);
    for (let k = 1; k < sorted.length; k++) {
      const [p, q] = [sorted[k - 1]!, sorted[k]!];
      const added = tree.get(q)![axis] - tree.get(p)![axis] - (N.get(q)![axis] - N.get(p)![axis]);
      const cut = (N.get(p)![axis] + N.get(q)![axis]) / 2;
      if (Math.abs(added) < 1e-9) continue;
      for (const id of members) if (N.get(id)![axis] > cut) result.get(id)![axis] += added;
    }
  }
  return result;
}

/** The box around the aggregate's shapes and their attributes, padding included. */
function boxOf(
  offsets: Map<string, Point>,
  clusters: Map<string, AttributeCluster>,
  members: string[],
): Bounds {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const id of members) {
    const p = offsets.get(id)!;
    const b = clusters.get(id)!.bounds;
    box.minX = Math.min(box.minX, p.x + b.minX);
    box.maxX = Math.max(box.maxX, p.x + b.maxX);
    box.minY = Math.min(box.minY, p.y + b.minY);
    box.maxY = Math.max(box.maxY, p.y + b.maxY);
  }
  const { padding } = STYLE.aggregate;
  return {
    minX: box.minX - padding,
    maxX: box.maxX + padding,
    minY: box.minY - padding,
    maxY: box.maxY + padding,
  };
}

/**
 * Rows of a tree that give up symmetry (`asymmetric`, by their parent; see
 * `spreadTooFar`), and the children the aggregate pins (`pinnedChildren`).
 */
interface Spread {
  asymmetric: Set<string>;
  pinned: Set<string>;
}

const NO_SPREAD: Spread = { asymmetric: new Set(), pinned: new Set() };

/**
 * Widens a tree until `a` is `amount` further right of `b`; false if
 * nothing moves it right. Between the children of the shape where that
 * moves `a` furthest (`stretch.x`, the row stays centered under its
 * parent), or, in a row that gives up symmetry (`spread`), by moving only
 * its pinned child, the one on the way to `a` or to `b` (`stretch.away`), so
 * the parent stays over its free children. In `cells`, by whole columns (an
 * even number between children), so the tree's cells stay whole.
 */
type Widener = (
  stretch: Pick<TreeStretch, 'x' | 'away'>,
  a: string,
  b: string,
  amount: number,
) => boolean;

function widener(h: Hierarchy, cells: boolean, spread: Spread): Widener {
  const path = ancestry(h, freeChildren(h, spread));
  return (stretch, a, b, amount) => {
    let best: { parent: string; rate: number; child?: string; sign?: number } | null = null;
    for (const parent of new Set([...path(a), ...path(b)].map((s) => s.parent))) {
      let option: { rate: number; child?: string; sign?: number } = {
        rate: moves(path(a), parent) - moves(path(b), parent),
      };
      if (spread.asymmetric.has(parent)) {
        const [ca, cb] = [path(a), path(b)].map((p) => p.find((s) => s.parent === parent)?.child);
        if (ca !== cb && ca !== undefined && spread.pinned.has(ca))
          option = { rate: 1, child: ca, sign: 1 };
        else if (ca !== cb && cb !== undefined && spread.pinned.has(cb))
          option = { rate: 1, child: cb, sign: -1 };
      }
      if (option.rate > 1e-9 && (best === null || option.rate > best.rate + 1e-9))
        best = { parent, ...option };
    }
    if (!best) return false;
    if (best.child !== undefined) {
      const away = stretch.away!;
      const more = cells ? Math.ceil(amount) : amount;
      away.set(best.child, (away.get(best.child) ?? 0) + best.sign! * more);
    } else {
      const more = cells ? 2 * Math.ceil(amount / best.rate / 2) : amount / best.rate;
      stretch.x.set(best.parent, (stretch.x.get(best.parent) ?? 0) + more);
    }
    return true;
  };
}

/**
 * For each row that gives up symmetry, the free children its parent stays
 * centered over (straight above a single one).
 */
function freeChildren(h: Hierarchy, spread: Spread): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const parent of spread.asymmetric) {
    const free = (h.children.get(parent) ?? []).filter((k) => !spread.pinned.has(k));
    if (free.length > 0) result.set(parent, free);
  }
  return result;
}

/**
 * The children an aggregate pins: an aggregate member, one with a member
 * below it, or one whose subtree has a line from a member (a shared
 * subtype's second supertype). The others are free.
 */
function pinnedChildren(
  h: Hierarchy,
  anchors: Set<string>,
  lines: [string, string][],
): Set<string> {
  const under = (id: string): string[] => [id, ...(h.children.get(id) ?? []).flatMap(under)];
  const pinned = new Set<string>();
  for (const kids of h.children.values()) {
    for (const kid of kids) {
      const subtree = new Set(under(kid));
      const member = [...subtree].some((id) => anchors.has(id));
      const tied = lines.some(
        ([from, to]) => anchors.has(from) && !subtree.has(from) && subtree.has(to),
      );
      if (member || tied) pinned.add(kid);
    }
  }
  return pinned;
}

/**
 * The rows (by parent) where keeping the row symmetric around the pinned
 * children, as widened by `extra`, pushes a free child more than
 * `STYLE.tree.maxSpread` normal sibling spacings further from its parent
 * than in the tree without the aggregate (`natural`). Positions along x, in
 * px or columns (`widened`).
 */
function spreadTooFar(
  h: Hierarchy,
  pinned: Set<string>,
  extra: Map<string, number>,
  natural: (id: string) => number,
  widened: (id: string) => number,
): Set<string> {
  const result = new Set<string>();
  for (const [parent, more] of extra) {
    const kids = h.children.get(parent) ?? [];
    if (more <= 0 || kids.length < 2) continue;
    const xs = kids.map(natural).sort((a, b) => a - b);
    const spacing = (xs.at(-1)! - xs[0]!) / (kids.length - 1);
    const pushed = kids.some((kid) => {
      if (pinned.has(kid)) return false;
      const near = natural(kid) - natural(parent);
      return Math.abs(widened(kid) - widened(parent) - near) > STYLE.tree.maxSpread * spacing;
    });
    if (pushed) result.add(parent);
  }
  return result;
}

/** One step up a tree: the row a shape is in (its parent's children, or the roots under ''). */
interface Step {
  parent: string;
  /** The shape in that row on the way up. */
  child: string;
  index: number;
  /** Children are centered under their parent, on index `center`; roots start at the first one. */
  centered: boolean;
  center: number;
}

/**
 * For each shape, its steps up to the roots. Parents drawn above a shape move
 * with it; a parent in `centerOver` is centered over those children only.
 */
function ancestry(h: Hierarchy, centerOver = new Map<string, string[]>()): (id: string) => Step[] {
  const up = new Map<string, Step & { next: string | null }>();
  for (const [parent, kids] of h.children) {
    const over = (centerOver.get(parent) ?? kids).map((k) => kids.indexOf(k));
    const center = (Math.min(...over) + Math.max(...over)) / 2;
    kids.forEach((kid, index) =>
      up.set(kid, { parent, child: kid, index, center, centered: true, next: parent }),
    );
  }
  h.roots.forEach((root, index) =>
    up.set(root, {
      parent: '',
      child: root,
      index,
      center: 0,
      centered: false,
      next: null,
    }),
  );
  const attachedTo = new Map<string, string>();
  for (const [shape, parents] of h.above) for (const p of parents) attachedTo.set(p, shape);
  for (const [hexagon, [, part]] of h.hexagons) attachedTo.set(hexagon, part);
  return (id: string) => {
    const steps: Step[] = [];
    let current: string | null = id;
    for (let guard = 0; current !== null && guard < 1000; guard++) {
      if (attachedTo.has(current) && !up.has(current)) {
        current = attachedTo.get(current)!;
        continue;
      }
      const step = up.get(current);
      if (!step) break;
      steps.push(step);
      current = step.next;
    }
    return steps;
  };
}

/** How far a shape moves right per pixel added between the children of `parent`. */
function moves(steps: Step[], parent: string): number {
  const step = steps.find((s) => s.parent === parent);
  if (!step) return 0;
  return step.centered ? step.index - step.center : step.index;
}

/**
 * `compoundVariants` for an aggregate whose members are in several trees,
 * one in each: every tree hangs from its member's cell (the box on the
 * side away from the tree), and the aggregate is widened between the
 * members of neighbouring trees until their other cells are a column apart.
 */
function severalTrees(
  trees: Hierarchy[],
  members: string[],
  arrangements: Map<string, Cell>[],
  lines: [string, string][],
): CompoundVariant[] {
  const anchorOf = trees.map((h) => members.filter((m) => h.members.includes(m)));
  if (anchorOf.some((a) => a.length !== 1)) return [];
  const result: CompoundVariant[] = [];
  const seen = new Set<string>();
  for (const arrangement of arrangements) {
    const hanging = trees
      .map((h, i) => {
        const anchor = anchorOf[i]![0]!;
        const side: Side = arrangement.get(anchor)!.col > 0 ? 'left' : 'right';
        return { hierarchy: withAnchorsAt(h, new Set([anchor]), side, lines), side, anchor };
      })
      .sort((a, b) => arrangement.get(a.anchor)!.col - arrangement.get(b.anchor)!.col);
    const cells = spread(hanging, arrangement, members);
    if (!cells) continue;
    const key = [...cells].map(([id, c]) => `${id}@${c.col},${c.row}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      trees: hanging.map(({ hierarchy, side, anchor }) => ({
        hierarchy,
        side,
        pinned: pinnedChildren(hierarchy, new Set([anchor]), lines),
      })),
      arrangement,
      cells,
    });
  }
  return result;
}

/**
 * The cells of `severalTrees`, relative to the relationship inside; null if
 * a tree reaches into the box.
 */
function spread(
  hanging: { hierarchy: Hierarchy; anchor: string }[],
  arrangement: Map<string, Cell>,
  members: string[],
): Map<string, Cell> | null {
  const widened = new Map<number, number>();
  const anchorCol = (k: number) => arrangement.get(hanging[k]!.anchor)!.col;
  for (let i = 0; i < 40; i++) {
    const shift = (id: string) => {
      let more = 0;
      for (const [k, cols] of widened)
        if (arrangement.get(id)!.col > (anchorCol(k - 1) + anchorCol(k)) / 2) more += cols;
      return more;
    };
    const cells = new Map(
      members.map((id) => {
        const c = arrangement.get(id)!;
        return [id, { col: c.col + shift(id), row: c.row }];
      }),
    );
    const own = hanging.map(({ hierarchy, anchor }) => {
      const tree = treeCells(hierarchy);
      const [a, at] = [tree.get(anchor)!, cells.get(anchor)!];
      return new Map(
        [...tree]
          .filter(([id]) => id !== anchor)
          .map(([id, c]) => [id, { col: c.col - a.col + at.col, row: c.row - a.row + at.row }]),
      );
    });
    const box = [...cells.values()];
    const [minCol, maxCol] = [
      Math.min(...box.map((c) => c.col)),
      Math.max(...box.map((c) => c.col)),
    ];
    const [minRow, maxRow] = [
      Math.min(...box.map((c) => c.row)),
      Math.max(...box.map((c) => c.row)),
    ];
    for (const tree of own) {
      for (const c of tree.values())
        if (c.col >= minCol && c.col <= maxCol && c.row >= minRow && c.row <= maxRow) return null;
    }
    // Neighbouring trees: a free column between them in every row they share.
    let need = 0;
    let at = 0;
    for (let k = 1; k < own.length && need === 0; k++) {
      for (const [, c] of own[k - 1]!) {
        for (const [, d] of own[k]!) {
          if (Math.abs(c.row - d.row) < 1) need = Math.max(need, c.col + 2 - d.col);
        }
      }
      at = k;
    }
    if (need > 0) {
      widened.set(at, (widened.get(at) ?? 0) + Math.ceil(need));
      continue;
    }
    for (const tree of own) for (const [id, c] of tree) cells.set(id, c);
    const origin = cells.get(innerOf(arrangement))!;
    return new Map(
      [...cells].map(([id, c]) => [id, { col: c.col - origin.col, row: c.row - origin.row }]),
    );
  }
  return null;
}

/**
 * `compoundOffsets` for several trees, one member of the aggregate in each:
 * each tree is laid out on its own (and kept clear of the box, see
 * `clearTree`), hangs from its member, and the aggregate is stretched
 * between the members of neighbouring trees until those trees are clear
 * of each other.
 */
function severalTreesOffsets(
  variant: CompoundVariant,
  natural: { offsets: Map<string, Point>; clusters: Map<string, AttributeCluster> },
  sized: SizedDiagram,
  bounds: (id: string) => Bounds,
  slopes: Slopes,
): CompoundBlock {
  const members = [...variant.arrangement.keys()];
  const N = natural.offsets;
  const gap = STYLE.layout.gap;
  const work: TreeWork[] = variant.trees
    .map(({ hierarchy: h, side }) => {
      const anchors = members.filter((m) => h.members.includes(m));
      const stretch: TreeStretch = { x: new Map(), away: new Map(), y: new Map() };
      const widen = widener(h, false, NO_SPREAD);
      return { h, side, anchors, near: anchors[0]!, members, stretch, widen, sized, bounds };
    })
    .sort((a, b) => N.get(a.near)!.x - N.get(b.near)!.x);
  const widened = new Map<number, number>();
  const place = () => {
    const aggregate = new Map(members.map((id) => [id, { ...N.get(id)! }]));
    for (const [k, more] of widened) {
      const cut = (N.get(work[k - 1]!.near)!.x + N.get(work[k]!.near)!.x) / 2;
      for (const id of members) if (N.get(id)!.x > cut) aggregate.get(id)!.x += more;
    }
    // Each tree in the aggregate's frame, hanging from its member.
    const trees = work.map((w) => {
      const tree = treeOffsets(w.h, sized, bounds, w.stretch, slopes);
      const [t, a] = [tree.get(w.near)!, aggregate.get(w.near)!];
      return new Map([...tree].map(([id, p]) => [id, { x: p.x - t.x + a.x, y: p.y - t.y + a.y }]));
    });
    return { aggregate, trees, box: boxOf(aggregate, natural.clusters, members) };
  };
  for (let i = 0; i < 300; i++) {
    const { trees, box } = place();
    if (work.some((w, k) => clearTree(w, trees[k]!, box))) continue;
    const rects = (k: number) =>
      [...trees[k]!]
        .filter(([id]) => !members.includes(id))
        .map(([id, p]) => {
          const b = bounds(id);
          return { minX: p.x + b.minX, maxX: p.x + b.maxX, minY: p.y + b.minY, maxY: p.y + b.maxY };
        });
    let need = 0;
    let at = 0;
    for (let k = 1; k < work.length && need === 0; k++) {
      for (const r of rects(k - 1)) {
        for (const q of rects(k)) {
          const apart =
            r.maxY + gap <= q.minY || q.maxY + gap <= r.minY || r.maxX + gap <= q.minX + 0.5;
          if (!apart) need = Math.max(need, r.maxX + gap - q.minX);
        }
      }
      at = k;
    }
    if (need <= 0) break;
    widened.set(at, (widened.get(at) ?? 0) + need);
  }
  const { aggregate, trees, box } = place();
  const offsets = new Map(aggregate);
  for (const tree of trees)
    for (const [id, p] of tree) if (!members.includes(id)) offsets.set(id, p);
  return relativeToInner(variant.arrangement, offsets, box);
}
