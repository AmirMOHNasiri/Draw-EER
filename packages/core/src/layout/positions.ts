import type { Point } from '../geometry/shapes';
import type { AttributeNode, Diagram } from '../model/types';
import type { Layout } from './layout';

/**
 * Pinned positions, saved next to the diagram in `<name>.eer.layout.json`
 * (the "layout file").
 *
 * A diagram without a layout file is placed by the automatic layout. The
 * first time the user drags something in the preview, the whole layout as
 * shown is saved, so from then on nothing moves unless the user moves it:
 *
 * - A shape (entity or relationship) stores its center.
 * - An attribute stores where it sits relative to its owner (the shape, or
 *   the composite attribute it is part of), so it moves with the owner.
 *
 * Elements added to the text later are placed around the pinned ones (see
 * incremental.ts) and saved too. Keys are the model's name-based ids, so a
 * renamed element counts as a new one.
 */
export interface Positions {
  /** Shape id → its center. */
  nodes: Record<string, Point>;
  /** Attribute id → offset from its owner's center. */
  attributes: Record<string, Point>;
}

export const NO_POSITIONS: Positions = Object.freeze({
  nodes: Object.freeze({}),
  attributes: Object.freeze({}),
}) as Positions;

/**
 * Every element of `layout` as pinned positions, in whole pixels: what the
 * first drag saves.
 */
export function pinAll(diagram: Diagram, layout: Layout): Positions {
  const nodes: Record<string, Point> = {};
  const attributes: Record<string, Point> = {};
  const visit = (list: AttributeNode[], ownerId: string) => {
    for (const attribute of list) {
      attributes[attribute.id] = round(sub(layout.get(attribute.id)!, layout.get(ownerId)!));
      visit(attribute.children, attribute.id);
    }
  };
  for (const node of diagram.nodes) {
    nodes[node.id] = round(layout.get(node.id)!);
    visit(node.attributes, node.id);
  }
  return { nodes, attributes };
}

/**
 * The positions after the user dropped element `id` with its center at
 * `to`. `layout` is what is shown, from `arrange(…, positions)`. With no
 * positions yet, the whole layout is pinned first, so that nothing else
 * moves when the text changes later.
 */
export function moveTo(
  diagram: Diagram,
  layout: Layout,
  positions: Positions,
  id: string,
  to: Point,
): Positions {
  const ownerId = owners(diagram).get(id);
  const isNode = diagram.nodes.some((node) => node.id === id);
  if (!isNode && ownerId === undefined) return positions;
  const base = isEmpty(positions) ? pinAll(diagram, layout) : positions;
  if (isNode) {
    return { nodes: { ...base.nodes, [id]: round(to) }, attributes: base.attributes };
  }
  return {
    nodes: base.nodes,
    attributes: { ...base.attributes, [id]: round(sub(to, layout.get(ownerId!)!)) },
  };
}

/**
 * Lines `to` up with a neighbour when it is within `threshold` of it, so
 * dragging can restore straight lines: a shape snaps to the centers of the
 * shapes it is joined to, an attribute to its owner's center. Each axis
 * snaps on its own.
 */
export function snap(
  diagram: Diagram,
  layout: Layout,
  id: string,
  to: Point,
  threshold: number,
): Point {
  const partners = new Set<string>();
  for (const link of diagram.links) {
    if (link.to === id) partners.add(link.from);
    if (link.from === id) partners.add(link.to);
  }
  const owner = owners(diagram).get(id);
  if (owner !== undefined) partners.add(owner);
  partners.delete(id);

  let { x, y } = to;
  let bestX = threshold;
  let bestY = threshold;
  for (const partner of partners) {
    const p = layout.get(partner);
    if (!p) continue;
    if (Math.abs(p.x - to.x) <= bestX) [x, bestX] = [p.x, Math.abs(p.x - to.x)];
    if (Math.abs(p.y - to.y) <= bestY) [y, bestY] = [p.y, Math.abs(p.y - to.y)];
  }
  return { x, y };
}

/** Only the positions of elements that are in the diagram. */
export function prunePositions(diagram: Diagram, positions: Positions): Positions {
  const nodeIds = new Set(diagram.nodes.map((n) => n.id));
  const attributeIds = new Set(owners(diagram).keys());
  return {
    nodes: pick(positions.nodes, (id) => nodeIds.has(id)),
    attributes: pick(positions.attributes, (id) => attributeIds.has(id)),
  };
}

export function isEmpty(positions: Positions): boolean {
  return Object.keys(positions.nodes).length + Object.keys(positions.attributes).length === 0;
}

// ---------------------------------------------------------------------------
// The layout file
// ---------------------------------------------------------------------------

const VERSION = 1;

/**
 * Reads a layout file. A file that cannot be used gives no positions and an
 * error message (the diagram is then drawn with the automatic layout);
 * single entries that are not points are skipped.
 */
export function parseLayoutFile(text: string): { positions: Positions; error: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { positions: NO_POSITIONS, error: `The layout file is not valid JSON: ${error}` };
  }
  if (!isRecord(data) || data.version !== VERSION) {
    return {
      positions: NO_POSITIONS,
      error: `The layout file has an unknown format (expected "version": ${VERSION}).`,
    };
  }
  return {
    positions: { nodes: points(data.nodes), attributes: points(data.attributes) },
    error: null,
  };
}

/**
 * Writes a layout file: one element per line, sorted by id, so that changes
 * show up as small diffs in version control.
 */
export function serializeLayoutFile(positions: Positions): string {
  const section = (name: string, entries: Record<string, Point>) => {
    const ids = Object.keys(entries).sort();
    if (ids.length === 0) return `  "${name}": {}`;
    const lines = ids.map((id) => {
      const p = entries[id]!;
      return `    ${JSON.stringify(id)}: { "x": ${num(p.x)}, "y": ${num(p.y)} }`;
    });
    return `  "${name}": {\n${lines.join(',\n')}\n  }`;
  };
  return [
    '{',
    `  "version": ${VERSION},`,
    `${section('nodes', positions.nodes)},`,
    section('attributes', positions.attributes),
    '}',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Each attribute's owner: its shape, or the composite attribute it is part of. */
function owners(diagram: Diagram): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (attributes: AttributeNode[], ownerId: string) => {
    for (const attribute of attributes) {
      result.set(attribute.id, ownerId);
      visit(attribute.children, attribute.id);
    }
  };
  for (const node of diagram.nodes) visit(node.attributes, node.id);
  return result;
}

function points(value: unknown): Record<string, Point> {
  const result: Record<string, Point> = {};
  if (!isRecord(value)) return result;
  for (const [id, p] of Object.entries(value)) {
    if (isRecord(p) && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      result[id] = { x: p.x as number, y: p.y as number };
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(entries: Record<string, Point>, keep: (id: string) => boolean) {
  return Object.fromEntries(Object.entries(entries).filter(([id]) => keep(id)));
}

function sub(p: Point, q: Point): Point {
  return { x: p.x - q.x, y: p.y - q.y };
}

function round(p: Point): Point {
  // `+ 0` turns -0 into 0, so the file never says "-0".
  return { x: Math.round(p.x) + 0, y: Math.round(p.y) + 0 };
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}
