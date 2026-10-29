import { exitPoint, type Point } from '../geometry/shapes';
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
 * Shapes in `detached` (the members of aggregates, which keep their own
 * compact block) are left out: the lines to them are drawn, but the rest of
 * the hierarchy forms its tree without them.
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
  const edges: [string, string][] = [];
  for (const link of diagram.links) {
    if (link.kind === 'participation' || link.from === link.to) continue;
    if (detached.has(link.from) || detached.has(link.to)) continue;
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
 */
function placeColumns(h: Hierarchy, width: Width, gap: number): Map<string, number> {
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
  const row = (subtrees: Subtree[], roots: string[], even: boolean): number[] => {
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
    if (!even || xs.length < 3) return xs;
    // Evenly spaced: every step as wide as the widest one (never closer than before).
    const step = Math.max(...xs.slice(1).map((x, i) => x - xs[i]!));
    return xs.map((_, i) => i * step);
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
      const xs = row(subtrees, kids, true);
      const middle = (xs[0]! + xs.at(-1)!) / 2;
      subtrees.forEach((t, i) => merge(s, t, xs[i]! - middle));
    }
    return s;
  };
  const all: Subtree = { x: new Map(), contour: new Map() };
  const trees = h.roots.map(subtree);
  const xs = row(trees, h.roots, false);
  trees.forEach((t, i) => merge(all, t, xs[i]!));
  return all.x;
}

/**
 * Grid cells of a hierarchy, relative to its first root: one row per level,
 * two columns between siblings (so a parent of two sits between them), and
 * each hexagon halfway between its whole and its part.
 */
export function treeCells(h: Hierarchy): Map<string, Cell> {
  const cols = placeColumns(h, () => [0, 0], 2);
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

/**
 * Pixel offsets of a hierarchy's shapes, relative to its first root, given
 * the room each shape takes with its attributes (`bounds`, relative to its
 * center).
 */
export function treeOffsets(
  h: Hierarchy,
  sized: SizedDiagram,
  bounds: (id: string) => Bounds,
): Map<string, Point> {
  const { siblingGap, levelGap, partGap } = STYLE.tree;
  const xs = placeColumns(h, (id) => [-bounds(id).minX, bounds(id).maxX], siblingGap);

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
  const y = new Map<number, number>();
  const depth = Math.max(...levels.keys());
  for (let l = 0; l <= depth; l++) {
    if (l === 0) {
      y.set(0, 0);
      continue;
    }
    const upper = levels.get(l - 1) ?? [];
    const lower = levels.get(l) ?? [];
    let step = 0;
    const bottom = Math.max(0, ...upper.map((id) => bounds(id).maxY));
    const topOf = Math.max(0, ...lower.map((id) => -bounds(id).minY));
    step = Math.max(step, bottom + STYLE.layout.gap + topOf);
    for (const [key, gap] of lineGap) {
      const [a, b] = key.split('|') as [string, string];
      if (h.level.get(b) !== l) continue;
      // A line spanning several levels needs its room over all of them.
      const from = h.level.get(a)!;
      const needed = half(a) + gap + half(b) - (y.get(l - 1)! - y.get(from)!);
      step = Math.max(step, needed);
    }
    y.set(l, y.get(l - 1)! + step);
  }

  const offsets = new Map<string, Point>();
  for (const [id, x] of xs) offsets.set(id, { x, y: y.get(h.level.get(id)!)! });
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
