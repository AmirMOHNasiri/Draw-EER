import { distanceToOutline, exitPoint, type Point } from '../geometry/shapes';
import type { Diagram, MainNode } from '../model/types';
import { STYLE } from '../render/style';
import { isRightToLeft } from '../text/direction';
import type { Bounds } from './attributes';
import type { Cell } from './grid';
import type { SizedDiagram } from './size';

/**
 * Hierarchies: specializations, categories and part-of, drawn as tidy
 * top-down trees, as on the course slides.
 *
 * A hierarchy is every shape joined by specialization, category or part-of
 * lines. It is laid out on its own, as one rigid block that the rest of the
 * layout then places like a single shape (it moves, but never turns):
 *
 * - each shape sits on a level (a row): a subtype one level below its
 *   supertype, a D/O/U circle between them;
 * - a parent is centered over its children, and the children are evenly
 *   spaced in one row (a single child sits straight below);
 * - several subtrees side by side keep clear of each other level by level,
 *   comparing their outlines ("contours"), as in the Reingold–Tilford
 *   tidy-tree algorithm;
 * - when a shape has several parents that belong only to it (the
 *   superclasses of a category, the supertypes of a shared subtype), those
 *   parents go in one row above it, evenly spaced and centered;
 * - a part-of hexagon sits halfway along the line from the whole to the
 *   part; the part itself is one level below the whole.
 *
 * Children follow the order of the text, right to left when most of their
 * names are right-to-left (Persian).
 */
export interface Hierarchy {
  /** Every shape in it, in model order (hexagons included). */
  members: string[];
  level: Map<string, number>;
  /** Children in the tree, in drawing order (left to right). */
  children: Map<string, string[]>;
  /** Parents drawn in one row above a shape that is theirs alone, left to right. */
  above: Map<string, string[]>;
  /** Shapes with no parent in the tree, left to right. */
  roots: string[];
  /** Part-of hexagon → [whole, part]. */
  hexagons: Map<string, [string, string]>;
  /** Shapes with a parent: their attributes stay out of the side facing it. */
  hanging: Set<string>;
}

/**
 * The hierarchies in a diagram (blocks of shapes joined by EER lines).
 * Shapes in `detached` (the members of aggregates that cannot be drawn with
 * their tree, see compound.ts) are left out: the lines to them are drawn,
 * but the rest of the hierarchy forms its tree without them.
 *
 * A subtype whose supertypes do not all belong to one tree (one is inside
 * an aggregate, or they are in different trees) is in none of them: it
 * cannot sit below both, so it is placed on its own, centered below its
 * supertypes (see `freeSubtypes` and grid.ts), with its own subtypes, if
 * any, as a tree below it.
 */
export function findHierarchies(diagram: Diagram, detached = new Set<string>()): Hierarchy[] {
  const nodes = new Map(diagram.nodes.map((n) => [n.id, n]));
  const order = new Map(diagram.nodes.map((n, i) => [n.id, i]));

  // Structural edges, general → specific. A part-of line runs whole →
  // hexagon → part; in the tree it is one edge from the whole to the part.
  const hexagons = new Map<string, [string, string]>();
  const wholes = new Map<string, string>();
  for (const link of diagram.links) {
    if (link.kind === 'partOf' && nodes.get(link.to)?.kind === 'partOf')
      wholes.set(link.to, link.from);
  }
  const free = freeSubtypes(diagram, detached);
  const edges: [string, string][] = [];
  for (const link of diagram.links) {
    if (link.kind === 'participation' || link.from === link.to) continue;
    if (detached.has(link.from) || detached.has(link.to) || free.has(link.to)) continue;
    if (link.kind === 'partOf') {
      if (nodes.get(link.to)?.kind === 'partOf') continue; // whole → hexagon: the other half
      const whole = wholes.get(link.from);
      if (whole === undefined || whole === link.to || detached.has(whole)) continue;
      hexagons.set(link.from, [whole, link.to]);
      edges.push([whole, link.to]);
    } else {
      edges.push([link.from, link.to]);
    }
  }

  // Blocks: shapes joined by structural edges.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    while (parent.has(id)) id = parent.get(id)!;
    return id;
  };
  for (const [a, b] of edges) {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  }
  for (const [hexagon, [whole]] of hexagons) {
    const [ra, rb] = [find(whole), find(hexagon)];
    if (ra !== rb) parent.set(rb, ra);
  }
  const blocks = new Map<string, string[]>();
  for (const node of diagram.nodes) {
    if (!edges.some(([a, b]) => a === node.id || b === node.id) && !hexagons.has(node.id)) continue;
    const root = find(node.id);
    blocks.set(root, [...(blocks.get(root) ?? []), node.id]);
  }

  return [...blocks.values()].map((members) => {
    const inBlock = new Set(members);
    const own = edges.filter(([a]) => inBlock.has(a));
    return buildHierarchy(members, own, hexagons, nodes, order);
  });
}

/**
 * Subtypes (or a category's U) with several supertypes that do not all
 * belong to one tree: a supertype is in `detached` (inside an aggregate), or
 * the supertypes are not joined without this subtype. Supertypes that have
 * no supertypes and no other subtypes are not a reason: they form a row
 * above it, in its tree (a category's superclasses, slide 52's E and F).
 */
export function freeSubtypes(diagram: Diagram, detached = new Set<string>()): Set<string> {
  const eer = diagram.links.filter(
    (l) => (l.kind === 'specialization' || l.kind === 'category') && l.from !== l.to,
  );
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const { from, to } of eer) {
    parents.set(to, [...(parents.get(to) ?? []), from]);
    children.set(from, [...(children.get(from) ?? []), to]);
  }
  const free = new Set<string>();
  for (const [child, own] of parents) {
    if (new Set(own).size < 2) continue;
    const alone = own.every((p) => !parents.has(p) && children.get(p)!.length === 1);
    if (alone) continue;
    if (own.some((p) => detached.has(p))) {
      free.add(child);
      continue;
    }
    // Are the supertypes joined to each other without this subtype?
    const root = new Map<string, string>();
    const find = (id: string): string => {
      while (root.has(id)) id = root.get(id)!;
      return id;
    };
    for (const { from, to } of eer) {
      if (to === child || from === child || detached.has(from) || detached.has(to)) continue;
      const [a, b] = [find(from), find(to)];
      if (a !== b) root.set(b, a);
    }
    if (new Set(own.map(find)).size > 1) free.add(child);
  }
  return free;
}

function buildHierarchy(
  members: string[],
  edges: [string, string][],
  allHexagons: Map<string, [string, string]>,
  nodes: Map<string, MainNode>,
  order: Map<string, number>,
): Hierarchy {
  const hexagons = new Map([...allHexagons].filter(([h]) => members.includes(h)));
  const shapes = members.filter((m) => !hexagons.has(m));

  // Drop the edges that close a cycle (a user's error, drawn but not used
  // for the tree): depth-first, an edge back to a shape still being visited.
  const out = new Map<string, string[]>(shapes.map((m) => [m, []]));
  for (const [a, b] of edges) if (!out.get(a)!.includes(b)) out.get(a)!.push(b);
  const parents = new Map<string, string[]>(shapes.map((m) => [m, []]));
  const state = new Map<string, number>();
  const postorder: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id)!) {
      if (state.get(next) === 1) continue;
      parents.get(next)!.push(id);
      if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
    postorder.push(id);
  };
  for (const id of shapes) if (!state.has(id)) visit(id);
  const children = new Map<string, string[]>(shapes.map((m) => [m, []]));
  for (const [child, list] of parents) {
    list.sort((a, b) => edgeIndex(edges, a, child) - edgeIndex(edges, b, child));
  }
  for (const id of shapes) {
    for (const next of out.get(id)!)
      if (parents.get(next)!.includes(id)) children.get(id)!.push(next);
  }

  // Levels: one below the lowest parent; a shape with no parent sits just
  // above its highest child, so it is not stranded far above it.
  const level = new Map<string, number>();
  for (const id of [...postorder].reverse()) {
    level.set(id, Math.max(0, ...parents.get(id)!.map((p) => level.get(p)! + 1)));
  }
  for (const id of shapes) {
    const below = children.get(id)!;
    if (parents.get(id)!.length === 0 && below.length > 0)
      level.set(id, Math.min(...below.map((c) => level.get(c)!)) - 1);
  }
  const top = Math.min(...shapes.map((id) => level.get(id)!));
  for (const id of shapes) level.set(id, level.get(id)! - top);

  // The tree: every shape hangs from its first parent, except a shape whose
  // parents all have no parents and no other children (a category's
  // superclasses, the supertypes of a shared subtype): they go above it.
  const above = new Map<string, string[]>();
  const treeChildren = new Map<string, string[]>(shapes.map((m) => [m, []]));
  const inTree = new Set<string>();
  for (const id of shapes) {
    const own = parents.get(id)!;
    if (own.length === 0) continue;
    const alone = own.every((p) => parents.get(p)!.length === 0 && children.get(p)!.length === 1);
    if (own.length >= 2 && alone) {
      above.set(id, drawingOrder(own, nodes));
      for (const p of own) inTree.add(p);
    } else {
      treeChildren.get(own[0]!)!.push(id);
      inTree.add(id);
    }
  }
  // In the order of the lines (the text), not of the shapes' declarations.
  for (const [id, list] of treeChildren) {
    const inTextOrder = children.get(id)!.filter((c) => list.includes(c));
    treeChildren.set(id, drawingOrder(inTextOrder, nodes));
  }
  const roots = drawingOrder(
    shapes.filter((id) => !inTree.has(id)).sort((a, b) => order.get(a)! - order.get(b)!),
    nodes,
  );
  const hanging = new Set(shapes.filter((id) => parents.get(id)!.length > 0));
  return { members, level, children: treeChildren, above, roots, hexagons, hanging };
}

/**
 * The hierarchy with every row of siblings (and of roots, and of parents
 * above a shape) reordered so that the shapes leading to `anchors` (the
 * members of an aggregate drawn with this tree, see compound.ts) are at
 * its `side` end; the others keep their order. On every level the
 * aggregate's members are then at that end, and its box can take that side
 * without enclosing anything else of the tree.
 *
 * A shape leads to the anchors in its subtree and to those joined to its
 * subtree by other EER lines (`lines`, general end first: a second
 * supertype). The one leading to the highest anchor goes outermost, so
 * that its line up to the box passes over the lines of the others down to
 * theirs (a shared subtype beside a circle, say); then the nearest.
 */
export function withAnchorsAt(
  h: Hierarchy,
  anchors: Set<string>,
  side: 'left' | 'right',
  lines: [string, string][],
): Hierarchy {
  const below = (id: string) => [...(h.children.get(id) ?? []), ...(h.above.get(id) ?? [])];
  const reach = new Map<string, { level: number; depth: number }>();
  const leads = (id: string): { level: number; depth: number } => {
    if (reach.has(id)) return reach.get(id)!;
    let best = { level: Infinity, depth: Infinity };
    reach.set(id, best); // guards against a cycle
    const consider = (level: number, depth: number) => {
      if (level < best.level || (level === best.level && depth < best.depth))
        best = { level, depth };
    };
    if (anchors.has(id)) consider(h.level.get(id)!, 0);
    for (const [from, to] of lines) {
      const other = to === id ? from : from === id ? to : null;
      if (other !== null && anchors.has(other) && h.level.has(other))
        consider(h.level.get(other)!, 1);
    }
    for (const c of below(id)) {
      const r = leads(c);
      consider(r.level, r.depth + 1);
    }
    reach.set(id, best);
    return best;
  };
  const reorder = (ids: string[]): string[] => {
    const others = ids.filter((id) => leads(id).level === Infinity);
    // Outermost first.
    const leading = ids
      .filter((id) => leads(id).level < Infinity)
      .sort((a, b) => leads(a).level - leads(b).level || leads(a).depth - leads(b).depth);
    return side === 'right' ? [...others, ...leading.reverse()] : [...leading, ...others];
  };
  const children = new Map([...h.children].map(([id, kids]) => [id, reorder(kids)]));
  return {
    ...h,
    children,
    above: new Map([...h.above].map(([id, parents]) => [id, reorder(parents)])),
    roots: reorder(h.roots),
  };
}

function edgeIndex(edges: [string, string][], from: string, to: string): number {
  return edges.findIndex(([a, b]) => a === from && b === to);
}

/** Left to right: text order, reversed when most of the entities' names read right to left. */
function drawingOrder(ids: string[], nodes: Map<string, MainNode>): string[] {
  const names = ids.map((id) => nodes.get(id)!).filter((n) => n.kind === 'entity');
  const rtl = names.filter((n) => isRightToLeft(n.name)).length * 2 > names.length;
  return rtl ? [...ids].reverse() : ids;
}

/** Horizontal room a shape needs, left and right of its center. */
type Width = (id: string) => [number, number];

/**
 * Horizontal positions relative to the first root (Reingold–Tilford style):
 * each subtree is built bottom-up with its outline per level, siblings are
 * pushed apart until their outlines keep `gap` between them on every level
 * they share, then spaced evenly, and the parent is centered over them.
 * `extra` widens the steps between the children of a shape (the roots
 * under ''), `away` moves a child (with its subtree) after its parent is
 * centered, and `centerOver` centers a parent over some of its children
 * only, as a tree drawn with an aggregate needs (see compound.ts).
 */
function placeColumns(
  h: Hierarchy,
  width: Width,
  gap: number,
  extra = new Map<string, number>(),
  away = new Map<string, number>(),
  centerOver = new Map<string, string[]>(),
): Map<string, number> {
  type Subtree = { x: Map<string, number>; contour: Map<number, [number, number]> };
  const level = (id: string) => h.level.get(id)!;
  const addBox = (s: Subtree, id: string, at: number) => {
    const [left, right] = width(id);
    const c = s.contour.get(level(id));
    s.contour.set(
      level(id),
      c ? [Math.min(c[0], at - left), Math.max(c[1], at + right)] : [at - left, at + right],
    );
    s.x.set(id, at);
  };
  const merge = (into: Subtree, s: Subtree, shift: number) => {
    for (const [id, x] of s.x) into.x.set(id, x + shift);
    for (const [l, [lo, hi]] of s.contour) {
      const c = into.contour.get(l);
      into.contour.set(
        l,
        c ? [Math.min(c[0], lo + shift), Math.max(c[1], hi + shift)] : [lo + shift, hi + shift],
      );
    }
  };
  /** Offsets that keep each subtree clear of all the ones before it. */
  const row = (subtrees: Subtree[], roots: string[], even: boolean, more: number): number[] => {
    const acc: Subtree = { x: new Map(), contour: new Map() };
    const xs: number[] = [];
    subtrees.forEach((s, i) => {
      let x = 0;
      if (i > 0) {
        x = xs[i - 1]! + width(roots[i - 1]!)[1] + gap + width(roots[i]!)[0];
        for (const [l, [lo]] of s.contour) {
          const c = acc.contour.get(l);
          if (c) x = Math.max(x, c[1] + gap - lo);
        }
      }
      xs.push(x);
      merge(acc, s, x);
    });
    if (!even || xs.length < 3) return xs.map((x, i) => x + i * more);
    // Evenly spaced: every step as wide as the widest one (never closer than before).
    const step = Math.max(...xs.slice(1).map((x, i) => x - xs[i]!));
    return xs.map((_, i) => i * (step + more));
  };
  /** A row of shapes centered on 0, evenly spaced. */
  const centeredRow = (ids: string[]): number[] => {
    let step = 0;
    for (let i = 1; i < ids.length; i++)
      step = Math.max(step, width(ids[i - 1]!)[1] + gap + width(ids[i]!)[0]);
    return ids.map((_, i) => (i - (ids.length - 1) / 2) * step);
  };
  const subtree = (id: string): Subtree => {
    const s: Subtree = { x: new Map(), contour: new Map() };
    addBox(s, id, 0);
    const parents = h.above.get(id) ?? [];
    centeredRow(parents).forEach((x, i) => addBox(s, parents[i]!, x));
    const kids = h.children.get(id) ?? [];
    if (kids.length > 0) {
      const subtrees = kids.map(subtree);
      const xs = row(subtrees, kids, true, extra.get(id) ?? 0);
      const over = (centerOver.get(id) ?? kids).map((k) => xs[kids.indexOf(k)]!);
      const middle = (Math.min(...over) + Math.max(...over)) / 2;
      subtrees.forEach((t, i) => merge(s, t, xs[i]! - middle + (away.get(kids[i]!) ?? 0)));
    }
    return s;
  };
  const all: Subtree = { x: new Map(), contour: new Map() };
  const trees = h.roots.map(subtree);
  const xs = row(trees, h.roots, false, extra.get('') ?? 0);
  trees.forEach((t, i) => merge(all, t, xs[i]!));
  return all.x;
}

/**
 * Grid cells of a hierarchy, relative to its first root: one row per level,
 * two columns between siblings (so a parent of two sits between them), and
 * each hexagon halfway between its whole and its part.
 */
export function treeCells(
  h: Hierarchy,
  extra = new Map<string, number>(),
  away = new Map<string, number>(),
  centerOver = new Map<string, string[]>(),
): Map<string, Cell> {
  const cols = placeColumns(h, () => [0, 0], 2, extra, away, centerOver);
  const cells = new Map<string, Cell>();
  for (const [id, col] of cols) cells.set(id, { col, row: h.level.get(id)! });
  for (const [hexagon, [whole, part]] of h.hexagons) {
    const a = cells.get(whole)!;
    const b = cells.get(part)!;
    cells.set(hexagon, { col: (a.col + b.col) / 2, row: (a.row + b.row) / 2 });
  }
  const origin = cells.get(h.roots[0]!)!;
  return new Map(
    [...cells].map(([id, c]) => [id, { col: c.col - origin.col, row: c.row - origin.row }]),
  );
}

/** How far (px) a level goes down at a time to clear a line, and how often (see `treeOffsets`). */
const LOWER_STEP = 4;
const LOWER_TRIES = 100;

/** Distance from the line between `a` and `b` (as drawn, outline to outline) to the outline of `id`. */
export function lineDistance(
  sized: SizedDiagram,
  at: Map<string, Point>,
  a: string,
  b: string,
  id: string,
): number {
  const shape = (x: string) => sized.geometry.get(x)!.shape;
  const [p, q] = [at.get(a)!, at.get(b)!];
  const from = exitPoint(shape(a), p, p, q);
  const to = exitPoint(shape(b), q, q, p);
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    best = Math.min(best, distanceToOutline(shape(id), at.get(id)!, point));
  }
  return best;
}

/**
 * Smallest angles (degrees, from horizontal) of the lines down a tree:
 * `tree` for its own lines, `shared` for a shared subtype's lines from its
 * second and later supertypes. The layout's first round, before attributes are placed
 * at real positions, uses none (see `layoutPart`).
 */
export interface Slopes {
  tree: number;
  shared: number;
}

export const SLOPES: Slopes = { tree: STYLE.tree.minSlope, shared: STYLE.tree.sharedSlope };
export const NO_SLOPES: Slopes = { tree: 0, shared: 0 };

/**
 * Room added to a tree: between the children of a shape, beside one child
 * (`away`), above a level; and the children a parent is centered over
 * (`centerOver`, all of them if not given; see `placeColumns`).
 */
export interface TreeStretch {
  x: Map<string, number>;
  away?: Map<string, number>;
  centerOver?: Map<string, string[]>;
  y: Map<number, number>;
}

/**
 * Pixel offsets of a hierarchy's shapes, relative to its first root, given
 * the room each shape takes with its attributes (`bounds`, relative to its
 * center), with room added where `stretch` says.
 */
export function treeOffsets(
  h: Hierarchy,
  sized: SizedDiagram,
  bounds: (id: string) => Bounds,
  stretch: TreeStretch = { x: new Map(), y: new Map() },
  slopes: Slopes = SLOPES,
): Map<string, Point> {
  const { siblingGap, levelGap, partGap } = STYLE.tree;
  const xs = placeColumns(
    h,
    (id) => [-bounds(id).minX, bounds(id).maxX],
    siblingGap,
    stretch.x,
    stretch.away,
    stretch.centerOver,
  );

  // Each level below the previous one: clear of the attributes above, and
  // with room for the lines (and the hexagons on part-of lines) between them.
  const half = (id: string) => sized.geometry.get(id)!.shape.height / 2;
  const levels = new Map<number, string[]>();
  for (const id of xs.keys()) {
    const l = h.level.get(id)!;
    levels.set(l, [...(levels.get(l) ?? []), id]);
  }
  const lineGap = new Map<string, number>();
  for (const [id, kids] of h.children)
    for (const kid of kids) lineGap.set(`${id}|${kid}`, levelGap);
  for (const [kid, parents] of h.above)
    for (const p of parents) lineGap.set(`${p}|${kid}`, levelGap);
  for (const [hexagon, [whole, part]] of h.hexagons) {
    lineGap.set(`${whole}|${part}`, sized.geometry.get(hexagon)!.shape.width + 2 * partGap);
  }
  // The tree's own lines, before the shared subtypes' lines are added.
  const tree = new Set(lineGap.keys());
  // A shared subtype's lines from its second and later supertypes in the
  // tree (drawn, but not tree edges: it hangs from its first supertype) slope
  // down too, less steeply (`slopes.shared`). Lines up a cycle are skipped.
  for (const link of sized.diagram.links) {
    if (link.kind !== 'specialization' && link.kind !== 'category') continue;
    const [a, b] = [link.from, link.to];
    if (!xs.has(a) || !xs.has(b) || lineGap.has(`${a}|${b}`)) continue;
    if (h.level.get(b)! > h.level.get(a)!) lineGap.set(`${a}|${b}`, levelGap);
  }
  // Steep enough for the room across (`minSlope`): center to center, the
  // drawn line's own angle.
  const tan = (degrees: number) => Math.tan((degrees * Math.PI) / 180);
  const depth = Math.max(...levels.keys());
  const levelsAt = (drop: Map<number, number>) => {
    const y = new Map<number, number>([[0, 0]]);
    for (let l = 1; l <= depth; l++) {
      const upper = levels.get(l - 1) ?? [];
      const lower = levels.get(l) ?? [];
      const bottom = Math.max(0, ...upper.map((id) => bounds(id).maxY));
      const topOf = Math.max(0, ...lower.map((id) => -bounds(id).minY));
      let step = bottom + STYLE.layout.gap + topOf;
      for (const [key, gap] of lineGap) {
        const [a, b] = key.split('|') as [string, string];
        if (h.level.get(b) !== l) continue;
        // A line spanning several levels needs its room over all of them.
        const from = h.level.get(a)!;
        const slope = tan(tree.has(key) ? slopes.tree : slopes.shared);
        const down = Math.max(half(a) + gap + half(b), slope * Math.abs(xs.get(a)! - xs.get(b)!));
        step = Math.max(step, down - (y.get(l - 1)! - y.get(from)!));
      }
      y.set(l, y.get(l - 1)! + step + (stretch.y.get(l) ?? 0) + (drop.get(l) ?? 0));
    }
    return y;
  };
  const place = (y: Map<number, number>) => {
    const at = new Map<string, Point>();
    for (const [id, x] of xs) at.set(id, { x, y: y.get(h.level.get(id)!)! });
    return at;
  };

  // A line down the tree that passes a shape closer than `lineClearance`
  // (the line to an outer child past the corner of a middle one): the level
  // it goes down to is lowered until the line is clear.
  const passed = [...xs.keys()].filter((id) => {
    const node = sized.diagram.nodes.find((n) => n.id === id);
    return !(node?.kind === 'circle' && node.symbol === null);
  });
  const drop = new Map<number, number>();
  let offsets = place(levelsAt(drop));
  for (let i = 0; i < LOWER_TRIES; i++) {
    const close = [...lineGap.keys()].find((key) => {
      const [a, b] = key.split('|') as [string, string];
      const [p, q] = [offsets.get(a)!, offsets.get(b)!];
      return passed.some((id) => {
        if (id === a || id === b) return false;
        // Far from the box around the line's two centers: clear, no need to measure.
        const c = offsets.get(id)!;
        const { width, height } = sized.geometry.get(id)!.shape;
        const reach = STYLE.lineClearance;
        if (
          c.x + width / 2 + reach < Math.min(p.x, q.x) ||
          c.x - width / 2 - reach > Math.max(p.x, q.x) ||
          c.y + height / 2 + reach < Math.min(p.y, q.y) ||
          c.y - height / 2 - reach > Math.max(p.y, q.y)
        )
          return false;
        return lineDistance(sized, offsets, a, b, id) < STYLE.lineClearance - 0.5;
      });
    });
    if (close === undefined) break;
    const l = h.level.get(close.split('|')[1]!)!;
    drop.set(l, (drop.get(l) ?? 0) + LOWER_STEP);
    offsets = place(levelsAt(drop));
  }

  // Hexagons halfway along the visible part of the line from whole to part.
  for (const [hexagon, [whole, part]] of h.hexagons) {
    const a = offsets.get(whole)!;
    const b = offsets.get(part)!;
    const start = exitPoint(sized.geometry.get(whole)!.shape, a, a, b);
    const end = exitPoint(sized.geometry.get(part)!.shape, b, b, a);
    offsets.set(hexagon, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
  }
  const origin = offsets.get(h.roots[0]!)!;
  return new Map([...offsets].map(([id, p]) => [id, { x: p.x - origin.x, y: p.y - origin.y }]));
}
