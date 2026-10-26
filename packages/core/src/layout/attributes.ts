import { boxAround, segmentHitsBox } from '../geometry/collide';
import { add, contains, type Point, type Shape } from '../geometry/shapes';
import type { AttributeNode } from '../model/types';
import { STYLE } from '../render/style';
import type { ElementGeometry } from './size';

/**
 * Places a shape's attributes around it, in a fan.
 *
 * The lines to a shape's relationships leave it at certain angles ("arms").
 * Attributes go in the free angles between the arms, keeping a margin from
 * each arm so they never sit on a relationship line. Within a free range
 * they are spread in an arc at a fixed distance from the owner's outline,
 * centered on the nearest straight direction (up, down, left, right), and
 * read top to bottom or left to right in declaration order. Composite
 * attributes fan their children outward in the same way.
 *
 * Angles are in radians in screen coordinates: 0 points right, π/2 down.
 * Positions are relative to the owner's center, so attributes move with it.
 */

export interface AttributeCluster {
  /** Center of every attribute (nested ones included), relative to the owner's center. */
  positions: Map<string, Point>;
  /** Bounding box of the owner and all its attributes, relative to the owner's center. */
  bounds: Bounds;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * One item of the fan: a single attribute (with its children), or the
 * attributes of one composite key, which stay side by side in a row.
 */
export interface Unit {
  attributes: AttributeNode[];
  isKeyGroup: boolean;
}

type Geometry = Map<string, ElementGeometry>;

/** An ellipse placed relative to the owner, and the line that joins it to its parent. */
interface Placed {
  id: string;
  center: Point;
  shape: Shape;
  connector: [Point, Point];
}

/** A range of free angles, `start < end`. */
interface Range {
  start: number;
  end: number;
}

const DEG = Math.PI / 180;
const UP = 270 * DEG;
const DOWN = 90 * DEG;
const LEFT = 180 * DEG;
const RIGHT = 0;
/** Straight directions, in order of preference when equally good. */
const AXES = [UP, DOWN, LEFT, RIGHT];
/**
 * Angle kept free on each side of a relationship line. The line itself is
 * also an obstacle (see `placeAttributes`), so this only keeps attributes
 * from crowding it.
 */
const ARM_MARGIN = 16 * DEG;
/** Children of a composite attribute stay within this angle of straight outward. */
const CHILD_SPREAD = 60 * DEG;
/**
 * How hard to search. The children of a composite attribute are placed again
 * for every angle tried for the composite itself, so they get a quick search;
 * if it fails, the composite simply tries its next angle.
 */
interface Search {
  /** Extra distances tried when attributes do not fit. */
  distances: readonly number[];
  /** Angle step when nudging a unit clear of others. */
  step: number;
  /** Most steps before giving up on a unit. */
  maxSteps: number;
  /** Extra distances a single unit may move out to, before it moves sideways. */
  rings: readonly number[];
}
/**
 * Shared by one `placeAttributes` call. A unit placed at a given angle and
 * distance always comes out the same (its children ignore everything
 * outside it), so placements are cached: searching for a clear angle tries
 * the same angles many times, and composites nest.
 */
interface Context {
  search: Search;
  cache: Map<string, Placed[]>;
}

/** Id of the obstacles that stand for relationship lines. */
const RELATIONSHIP_LINE = '#line';
/*
 * FULL.distances: further out a range is wider, which matters for shapes
 * with lines in every direction.
 */
const FULL: Search = {
  distances: [0, 18, 36, 60, 90, 130, 180, 240, 300],
  step: 1 * DEG,
  maxSteps: 360,
  rings: [0, 36, 72, 108, 144],
};
/** Free ranges narrower than this are only used when nothing else is free. */
const MIN_RANGE = 35 * DEG;
/** Extra distance (px) a range may use before attributes move on to the next range. */
const NEAR = 60;
/** Placements are computed at angles rounded to this. */
const ANGLE_GRAIN = 0.5 * DEG;
const QUICK: Search = { distances: [0, 24, 48], step: 4 * DEG, maxSteps: 45, rings: [0, 24] };

/** Groups consecutive attributes of the same composite key into one unit. */
export function toUnits(attributes: AttributeNode[]): Unit[] {
  const units: Unit[] = [];
  for (const attribute of attributes) {
    const last = units.at(-1);
    if (attribute.keyGroup !== null && last?.attributes[0]?.keyGroup === attribute.keyGroup) {
      last.attributes.push(attribute);
    } else {
      units.push({ attributes: [attribute], isKeyGroup: attribute.keyGroup !== null });
    }
  }
  return units;
}

/**
 * Places the attributes of one owner, given the angles of its relationship
 * lines (`arms`, which decide the free ranges) and the lines themselves
 * (relative to the owner's center), which no attribute may touch.
 */
export function placeAttributes(
  owner: Shape,
  attributes: AttributeNode[],
  arms: number[],
  geometry: Geometry,
  lines: [Point, Point][],
): AttributeCluster {
  const ranges = freeRanges(arms, ARM_MARGIN);
  // The relationship lines themselves are obstacles too, so that composite
  // attributes cannot spread their children across them.
  const obstacles = lines.map((line): Placed => ({
    id: RELATIONSHIP_LINE,
    center: { x: 1e6, y: 1e6 },
    shape: { kind: 'ellipse', width: 1e-3, height: 1e-3 },
    connector: line,
  }));
  const ctx: Context = { search: FULL, cache: new Map() };
  const placed = fan(
    owner,
    toUnits(attributes),
    ranges,
    geometry,
    STYLE.attributeGap.fromOwner,
    obstacles,
    ctx,
  );
  const positions = new Map(placed.map((p) => [p.id, p.center]));
  return { positions, bounds: clusterBounds(owner, placed) };
}

/** The angle ranges not within `margin` of any arm. With no arms, the whole circle. */
export function freeRanges(arms: number[], margin: number): Range[] {
  if (arms.length === 0) return [{ start: UP - Math.PI, end: UP + Math.PI }];
  const sorted = arms.map(normalize).sort((a, b) => a - b);
  const ranges: Range[] = [];
  sorted.forEach((arm, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + 2 * Math.PI;
    const start = arm + margin;
    const end = next - margin;
    if (end - start > 4 * DEG) ranges.push({ start, end });
  });
  return ranges;
}

/**
 * Spreads units over the free ranges, moving them further out if they do not
 * fit (further out, each takes less angle). As a last resort the largest
 * range overflows rather than losing attributes.
 */
function fan(
  owner: Shape,
  units: Unit[],
  ranges: Range[],
  geometry: Geometry,
  distance: number,
  obstacles: Placed[],
  ctx: Context,
): Placed[] {
  if (units.length === 0) return [];
  const result =
    tryFan(owner, units, ranges, geometry, distance, false, obstacles, ctx) ??
    tryFan(owner, units, ranges, geometry, distance, true, obstacles, ctx)!;
  return result.slice(obstacles.length);
}

/**
 * Composite keys go first, at the free direction closest to straight up or
 * down, because their parts sit in a row with a line under them. The other
 * units fill the largest range, or are shared evenly between ranges of
 * similar size (like above and below a relationship). A range that is too
 * small for its units first moves them further out (where each takes less
 * angle); units that still do not fit spill into the next range.
 */
function tryFan(
  owner: Shape,
  units: Unit[],
  ranges: Range[],
  geometry: Geometry,
  distance: number,
  overflow: boolean,
  obstacles: Placed[],
  ctx: Context,
): Placed[] | null {
  // Starts with the obstacles, so everything placed avoids them; the caller drops them again.
  const placed: Placed[] = [...obstacles];
  let free = ranges.map((r) => ({ ...r }));

  for (const unit of units.filter((u) => u.isKeyGroup)) {
    const items = placeKeyGroup(owner, unit, free, geometry, distance, placed, ctx);
    placed.push(...items);
    const angle = Math.atan2(items[0]!.center.y, items[0]!.center.x);
    const half = halfAngle(items);
    free = subtract(free, angle - half, angle + half);
  }

  const rest = units.filter((u) => !u.isKeyGroup);
  if (rest.length === 0) return placed;
  if (free.length === 0) {
    if (!overflow) return null;
    free = [{ start: UP - Math.PI, end: UP + Math.PI }];
  }

  // Ranges too narrow to hold an attribute are skipped (unless nothing else is free).
  const wide = free.filter((r) => width(r) >= MIN_RANGE);
  const order = (wide.length > 0 ? wide : free).sort(
    (a, b) => width(b) - width(a) || preference(a) - preference(b),
  );
  const largest = width(order[0]!);
  const sharing = order.filter((r) => width(r) >= 0.7 * largest).length;
  const counts = evenCounts(rest.length, sharing);

  // Fill each range with as many units as fit. Every range but the last
  // only tries nearby distances and passes the rest on, so attributes use
  // another free side before moving far out; the last range may go as far
  // as it takes.
  const fill = (range: Range, wanted: Unit[], distances: readonly number[]): Unit[] => {
    for (let count = wanted.length; count > 0; count--) {
      for (const extra of distances) {
        const result = placeInRange(
          owner,
          wanted.slice(0, count),
          range,
          geometry,
          distance + extra,
          placed,
          false,
          ctx,
        );
        if (result) {
          placed.push(...result);
          return wanted.slice(count);
        }
      }
    }
    return wanted;
  };
  const near = ctx.search.distances.filter((d) => d <= NEAR);
  let next = 0;
  let spill: Unit[] = [];
  order.forEach((range, i) => {
    const wanted = [...spill, ...rest.slice(next, next + (counts[i] ?? 0))];
    next += counts[i] ?? 0;
    spill = fill(range, wanted, i === order.length - 1 ? ctx.search.distances : near);
  });
  // Still left over: try every range again, now as far out as needed.
  for (const range of order) {
    if (spill.length === 0) break;
    spill = fill(range, spill, ctx.search.distances);
  }
  if (spill.length > 0) {
    if (!overflow) return null;
    placed.push(...placeInRange(owner, spill, order[0]!, geometry, distance, placed, true, ctx)!);
  }
  return placed;
}

/**
 * A composite key's row goes as close to straight up (or else down) as it
 * can without touching a relationship line or another attribute, moving
 * further out if it has to.
 */
function placeKeyGroup(
  owner: Shape,
  unit: Unit,
  free: Range[],
  geometry: Geometry,
  distance: number,
  existing: Placed[],
  ctx: Context,
): Placed[] {
  for (const extra of ctx.search.distances) {
    for (const target of [UP, DOWN]) {
      const angle = closestFreeAngle(free, [target]);
      if (angle === null) continue;
      // Sweep starts at the unit's near edge, so start half a unit before the target.
      const half = halfAngle(placeUnit(owner, unit, angle, geometry, distance + extra, ctx));
      for (const start of [angle - half, angle - 2 * half]) {
        const result = sweep(
          owner,
          [unit],
          start,
          geometry,
          distance + extra,
          existing,
          false,
          ctx,
        );
        if (result) return result.placed;
      }
    }
  }
  const angle = closestFreeAngle(free, [UP, DOWN]) ?? UP;
  return placeUnit(owner, unit, angle, geometry, distance, ctx);
}

/** Splits `total` into `parts` counts as evenly as possible, earlier parts larger. */
function evenCounts(total: number, parts: number): number[] {
  const counts: number[] = [];
  let left = total;
  for (let i = 0; i < parts; i++) {
    const count = Math.ceil(left / (parts - i));
    counts.push(count);
    left -= count;
  }
  return counts;
}

/**
 * Places units side by side in one range, centered on the best straight
 * direction inside it. Returns null if they do not fit (unless `overflow`).
 */
function placeInRange(
  owner: Shape,
  units: Unit[],
  range: Range,
  geometry: Geometry,
  distance: number,
  existing: Placed[],
  overflow: boolean,
  ctx: Context,
): Placed[] | null {
  // A first sweep from the start of the range measures the fan...
  const first = sweep(owner, units, range.start, geometry, distance, existing, overflow, ctx);
  if (!first) return null;
  const span = first.end - range.start;
  if (span > width(range) + 1e-9 && !overflow) return null;

  // ...then the units are swept again from where a centered fan starts,
  // in the order that makes them read left to right or top to bottom.
  const center = preferredCenter(range, span);
  const ordered = readsBackward(center) ? [...units].reverse() : units;
  const centered = sweep(
    owner,
    ordered,
    center - span / 2,
    geometry,
    distance,
    existing,
    overflow,
    ctx,
  );
  if (centered && (centered.end <= range.end + 2 * DEG || overflow)) return centered.placed;
  const fromStart = sweep(owner, ordered, range.start, geometry, distance, existing, false, ctx);
  return fromStart?.placed ?? first.placed;
}

/**
 * Sweeping goes in increasing angle (clockwise on screen). Above a shape that
 * runs left to right and on its right side top to bottom, as we read; below
 * and on the left it runs backward.
 */
function readsBackward(center: number): boolean {
  const tangent = { x: -Math.sin(center), y: Math.cos(center) };
  return Math.abs(tangent.x) >= Math.abs(tangent.y) ? tangent.x < 0 : tangent.y < 0;
}

/**
 * Places units one after another with increasing angle, each as close to
 * the previous one as it can be without overlapping it or anything already
 * placed.
 */
function sweep(
  owner: Shape,
  units: Unit[],
  start: number,
  geometry: Geometry,
  distance: number,
  existing: Placed[],
  force: boolean,
  ctx: Context,
): { placed: Placed[]; end: number } | null {
  const placed: Placed[] = [];
  let edge = start;
  for (const unit of units) {
    // Put the unit's near edge at the previous unit's far edge...
    const others = [...existing, ...placed];
    const at = (a: number, ring = 0) => placeUnit(owner, unit, a, geometry, distance + ring, ctx);
    let angle = edge + halfAngle(at(edge));
    const firstAngle = angle;
    // ...then, if it overlaps something, first try moving it further out
    // (staggered, between its inner neighbours), then nudge it on sideways.
    let items: Placed[] | null = null;
    // In case nothing is clear: the spot with the fewest conflicts.
    let fallback = { items: at(firstAngle), angle: firstAngle, conflicts: Infinity };
    for (let guard = 0; items === null; guard++) {
      if (guard > ctx.search.maxSteps) {
        if (!force) return null;
        items = fallback.items;
        angle = fallback.angle;
        break;
      }
      for (const ring of ctx.search.rings) {
        const candidate = at(angle, ring);
        if (!overlapsAny(candidate, others)) {
          items = candidate;
          break;
        }
        if (force) {
          const conflicts = countConflicts(candidate, others);
          if (conflicts < fallback.conflicts) fallback = { items: candidate, angle, conflicts };
        }
      }
      if (items === null) angle += ctx.search.step;
    }
    placed.push(...items);
    edge = angle + halfAngle(items);
  }
  return { placed, end: edge };
}

/** Where to center a fan of `span` radians: the straight direction nearest the range's middle. */
function preferredCenter(range: Range, span: number): number {
  const low = range.start + span / 2;
  const high = range.end - span / 2;
  const middle = (range.start + range.end) / 2;
  if (high < low) return middle;
  let best = middle;
  let bestDistance = Infinity;
  for (const axis of AXES) {
    for (const turn of [-2, -1, 0, 1, 2]) {
      const candidate = axis + turn * 2 * Math.PI;
      if (candidate < range.start || candidate > range.end) continue;
      const d = Math.abs(candidate - middle);
      if (d < bestDistance - 1e-6) {
        best = candidate;
        bestDistance = d;
      }
    }
  }
  return Math.min(high, Math.max(low, best));
}

/** Lower is better: ranges that contain "up", then "down", then "left", then "right". */
function preference(range: Range): number {
  const index = AXES.findIndex((axis) =>
    [-1, 0, 1, 2].some((t) => {
      const a = axis + t * 2 * Math.PI;
      return a >= range.start && a <= range.end;
    }),
  );
  return index === -1 ? AXES.length : index;
}

/** The free angle closest to one of `targets` (tried in order), or null if nothing is free. */
function closestFreeAngle(ranges: Range[], targets: number[]): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    for (const range of ranges) {
      for (const turn of [-1, 0, 1, 2]) {
        const t = target + turn * 2 * Math.PI;
        const clamped = Math.min(range.end, Math.max(range.start, t));
        const d = Math.abs(clamped - t);
        if (d < bestDistance - 1e-6) {
          best = clamped;
          bestDistance = d;
        }
      }
    }
    if (bestDistance < 1e-6) break;
  }
  return best;
}

/** Removes the angles from `from` to `to` from the ranges. */
function subtract(ranges: Range[], from: number, to: number): Range[] {
  let result = ranges;
  for (const turn of [-1, 0, 1]) {
    const a = from + turn * 2 * Math.PI;
    const b = to + turn * 2 * Math.PI;
    const next: Range[] = [];
    for (const range of result) {
      if (b <= range.start || a >= range.end) {
        next.push(range);
        continue;
      }
      if (a - range.start > 4 * DEG) next.push({ start: range.start, end: a });
      if (range.end - b > 4 * DEG) next.push({ start: b, end: range.end });
    }
    result = next;
  }
  return result;
}

// ---------------------------------------------------------------------------
// One unit at one angle
// ---------------------------------------------------------------------------

/**
 * Places a unit (and, for composites, its children) at `angle` around the
 * owner. Angles are rounded to half a degree so that cached placements can be
 * reused.
 */
function placeUnit(
  owner: Shape,
  unit: Unit,
  rawAngle: number,
  geometry: Geometry,
  distance: number,
  ctx: Context,
): Placed[] {
  const angle = Math.round(rawAngle / ANGLE_GRAIN) * ANGLE_GRAIN;
  const cacheKey = `${unit.attributes[0]!.id}|${Math.round(angle / ANGLE_GRAIN)}|${Math.round(distance)}`;
  const cached = ctx.cache.get(cacheKey);
  if (cached) return cached;

  const origin = { x: 0, y: 0 };
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const ownerReach = reach(owner, u);
  let result: Placed[];

  if (unit.isKeyGroup) {
    // Parts side by side in a row, each joined to the owner.
    const shapes = unit.attributes.map((a) => geometry.get(a.id)!.shape);
    const rowWidth = shapes.reduce((sum, s) => sum + s.width, 0) + 2 * (shapes.length - 1);
    const rowHeight = Math.max(...shapes.map((s) => s.height));
    const rowReach = Math.abs(u.x) * (rowWidth / 2) + Math.abs(u.y) * (rowHeight / 2);
    const middle = add(origin, u, ownerReach + distance + rowReach);
    let x = middle.x - rowWidth / 2;
    result = unit.attributes.map((attribute, i) => {
      const shape = shapes[i]!;
      const center = { x: x + shape.width / 2, y: middle.y };
      x += shape.width + 2;
      return { id: attribute.id, center, shape, connector: [origin, center] };
    });
  } else {
    const attribute = unit.attributes[0]!;
    const shape = geometry.get(attribute.id)!.shape;
    const center = add(origin, u, ownerReach + distance + reach(shape, u));
    result = [{ id: attribute.id, center, shape, connector: [origin, center] }];
    if (attribute.children.length > 0) {
      // Children fan outward from the parent, away from the owner. They only
      // avoid each other; the search around the owner moves the whole unit.
      const range = { start: angle - CHILD_SPREAD, end: angle + CHILD_SPREAD };
      const children = fan(
        shape,
        toUnits(attribute.children),
        [range],
        geometry,
        STYLE.attributeGap.nested,
        [],
        {
          search: QUICK,
          cache: ctx.cache,
        },
      );
      for (const child of children) {
        result.push({
          ...child,
          center: add(child.center, center),
          connector: [add(child.connector[0], center), add(child.connector[1], center)],
        });
      }
    }
  }
  ctx.cache.set(cacheKey, result);
  return result;
}

/**
 * Distance from a shape's center to its outline in direction `u` (a unit
 * vector), for the axis-aligned shapes we draw.
 */
function reach(shape: Shape, u: Point): number {
  const a = shape.width / 2;
  const b = shape.height / 2;
  const cx = Math.abs(u.x);
  const cy = Math.abs(u.y);
  switch (shape.kind) {
    case 'rect':
      return Math.min(cx > 1e-9 ? a / cx : Infinity, cy > 1e-9 ? b / cy : Infinity);
    case 'diamond':
      return 1 / (cx / a + cy / b);
    case 'ellipse':
      return 1 / Math.sqrt((cx * cx) / (a * a) + (cy * cy) / (b * b));
  }
}

/**
 * Half the angle a unit takes up as seen from the owner's center, plus
 * spacing: for each ellipse, its own direction plus its half-width seen from
 * its own distance (children of a composite are further out, so they take
 * less angle than they would next to the owner).
 */
function halfAngle(items: Placed[]): number {
  const anchor = Math.atan2(items[0]!.center.y, items[0]!.center.x);
  let half = 0;
  for (const item of items) {
    const r = Math.hypot(item.center.x, item.center.y) || 1;
    const t = { x: -item.center.y / r, y: item.center.x / r };
    const a = item.shape.width / 2;
    const b = item.shape.height / 2;
    const support = Math.sqrt(a * a * t.x * t.x + b * b * t.y * t.y);
    const own = Math.atan2(support + STYLE.attributeGap.between / 2, r);
    let offset = Math.atan2(item.center.y, item.center.x) - anchor;
    offset = Math.atan2(Math.sin(offset), Math.cos(offset));
    half = Math.max(half, Math.abs(offset) + own);
  }
  return half;
}

// ---------------------------------------------------------------------------
// Overlap tests
// ---------------------------------------------------------------------------

/** How badly a unit collides: touching a relationship line counts most. */
function countConflicts(items: Placed[], others: Placed[]): number {
  let conflicts = 0;
  for (const item of items) {
    for (const other of others) {
      if (other.id === RELATIONSHIP_LINE) {
        if (lineHits(other, item)) conflicts += 5;
        else if (linesCross(item.connector, other.connector)) conflicts += 3;
      } else if (ellipsesOverlap(item, other, 0)) {
        conflicts += 2;
      } else if (lineHits(other, item) || lineHits(item, other)) {
        conflicts += 1;
      }
    }
  }
  return conflicts;
}

function overlapsAny(items: Placed[], others: Placed[]): boolean {
  for (const item of items) {
    for (const other of others) {
      if (other.id === RELATIONSHIP_LINE && linesCross(item.connector, other.connector))
        return true;
      if (ellipsesOverlap(item, other, STYLE.attributeGap.between)) return true;
      if (lineHits(other, item) || lineHits(item, other)) return true;
    }
  }
  return false;
}

/** True if two axis-aligned ellipses, each grown by `padding / 2`, overlap. */
function ellipsesOverlap(p: Placed, q: Placed, padding: number): boolean {
  const grow = (s: Shape): Shape => ({
    ...s,
    width: s.width + padding,
    height: s.height + padding,
  });
  const a = grow(p.shape);
  const b = grow(q.shape);
  if (
    Math.abs(p.center.x - q.center.x) > (a.width + b.width) / 2 ||
    Math.abs(p.center.y - q.center.y) > (a.height + b.height) / 2
  ) {
    return false;
  }
  if (contains(a, p.center, q.center) || contains(b, q.center, p.center)) return true;
  for (let i = 0; i < 32; i++) {
    const t = (i / 32) * 2 * Math.PI;
    const onA = {
      x: p.center.x + (a.width / 2) * Math.cos(t),
      y: p.center.y + (a.height / 2) * Math.sin(t),
    };
    if (contains(b, q.center, onA)) return true;
    const onB = {
      x: q.center.x + (b.width / 2) * Math.cos(t),
      y: q.center.y + (b.height / 2) * Math.sin(t),
    };
    if (contains(a, p.center, onB)) return true;
  }
  return false;
}

/** True if two segments cross at a point inside both (touching at an end does not count). */
function linesCross([a, b]: [Point, Point], [c, d]: [Point, Point]): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
}

/** True if `line`'s connector runs through `item`, an ellipse other than the ones at its ends. */
function lineHits(line: Placed, item: Placed): boolean {
  const [from, to] = line.connector;
  if (same(from, item.center) || same(to, item.center)) return false;
  // Relationship lines must stay well clear; attribute lines may pass the
  // empty corners of an ellipse's box, so for those the box shrinks a little.
  const box =
    line.id === RELATIONSHIP_LINE
      ? boxAround(item.center, item.shape.width, item.shape.height, 4)
      : boxAround(item.center, item.shape.width * 0.8, item.shape.height * 0.8);
  return segmentHitsBox(from, to, box);
}

function same(p: Point, q: Point): boolean {
  return Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
}

function clusterBounds(owner: Shape, placed: Placed[]): Bounds {
  const bounds: Bounds = {
    minX: -owner.width / 2,
    maxX: owner.width / 2,
    minY: -owner.height / 2,
    maxY: owner.height / 2,
  };
  for (const { center, shape } of placed) {
    bounds.minX = Math.min(bounds.minX, center.x - shape.width / 2);
    bounds.maxX = Math.max(bounds.maxX, center.x + shape.width / 2);
    bounds.minY = Math.min(bounds.minY, center.y - shape.height / 2);
    bounds.maxY = Math.max(bounds.maxY, center.y + shape.height / 2 + STYLE.keyGroupLineOffset);
  }
  return bounds;
}

function width(range: Range): number {
  return range.end - range.start;
}

function normalize(angle: number): number {
  const full = 2 * Math.PI;
  return ((angle % full) + full) % full;
}
