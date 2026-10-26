import { boxAround, segmentHitsBox, segmentHitsEllipse } from '../geometry/collide';
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
 * read in declaration order: top to bottom, and left to right (right to
 * left for Persian or Arabic names). Sides that face a nearby unrelated
 * shape are used last. Composite attributes fan their children outward in
 * the same way.
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
  cache: Map<number, Placed[]>;
  /** A small number for each attribute id, for cache keys. */
  ids: Map<string, number>;
  /** Directions (angles) of nearby shapes that are not joined to the owner. */
  crowded: number[];
  /** Rows of attributes read right to left (for right-to-left names). */
  rtl: boolean;
  /** Directions of the lines to the owner's relationship partners. */
  partners: number[];
  /** See `FanOptions.walls`. */
  walls: Placed[];
}

/** How a fan should be arranged, beyond the free angles. */
export interface FanOptions {
  /**
   * Directions of nearby unrelated shapes. Attributes prefer the free sides
   * that do not face them: an attribute that grows toward a neighbour pushes
   * that neighbour away and stretches every line in between.
   */
  crowded?: number[];
  /** Read rows of attributes right to left, as Persian and Arabic are read. */
  rtl?: boolean;
  /**
   * Directions of the lines to the owner's relationship partners.
   * Attributes keep `PARTNER_MARGIN` away from them where they fit.
   */
  partners?: number[];
  /**
   * Segments (relative to the owner's center) that attributes should not
   * cross where they fit: the middle of each straight line to a partner.
   */
  walls?: [Point, Point][];
  /**
   * Shapes and attributes that belong to others, with the lines to them
   * (relative to the owner's center). Used only to repair a fan after
   * everything else is fixed (see `repairAttributes` in layout.ts).
   */
  occupied?: { center: Point; shape: Shape; connector?: [Point, Point] }[];
}

/** Angle kept free on each side of a line to a relationship partner, where attributes fit. */
const PARTNER_MARGIN = 35 * DEG;
/** A crowded direction counts against a free range if it lies within this angle of it. */
const CROWD_REACH = 30 * DEG;

/** Id of the obstacles that stand for relationship lines. */
const RELATIONSHIP_LINE = '#line';
/** Id of the obstacles that stand for other shapes and their attributes. */
const OCCUPIED = '#occupied';
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
/** How far past its target direction a composite key's row may be nudged. */
const KEY_GROUP_REACH = 60 * DEG;
/** How much further out the second ring (composite attributes) may be. */
const OUTER_RING = [110, 150, 190];
/** The same, when the next range faces a nearby shape. */
const MEDIUM = 90;
/**
 * How far out attributes may go while keeping clear of the sides that face
 * relationship partners (the first choice; see `fan`). A composite attribute
 * needs some distance to fit in the narrower angle.
 */
const STRICT_FAR = 130;
/** Placements are computed at angles rounded to this. */
const ANGLE_GRAIN = 0.5 * DEG;
const QUICK: Search = { distances: [0, 24, 48], step: 4 * DEG, maxSteps: 45, rings: [0, 24] };

/** A line that attributes and their own lines must not touch, as an obstacle. */
function asLineObstacle(line: [Point, Point]): Placed {
  return {
    id: RELATIONSHIP_LINE,
    center: { x: 1e6, y: 1e6 },
    shape: { kind: 'ellipse', width: 1e-3, height: 1e-3 },
    connector: line,
  };
}

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
  options: FanOptions = {},
): AttributeCluster {
  const ranges = freeRanges(arms, ARM_MARGIN);
  // The relationship lines themselves are obstacles too, so that composite
  // attributes cannot spread their children across them.
  const obstacles = lines.map(asLineObstacle);
  for (const { center, shape, connector } of options.occupied ?? []) {
    // A rectangle as the ellipse around it, which covers its corners.
    const covering: Shape =
      shape.kind === 'rect'
        ? { kind: 'ellipse', width: shape.width * Math.SQRT2, height: shape.height * Math.SQRT2 }
        : { ...shape, kind: 'ellipse' };
    const far = { x: 1e6, y: 1e6 };
    obstacles.push({ id: OCCUPIED, center, shape: covering, connector: connector ?? [far, far] });
  }
  const ctx: Context = {
    search: FULL,
    cache: new Map(),
    ids: new Map(),
    crowded: options.crowded ?? [],
    rtl: options.rtl ?? false,
    partners: options.partners ?? [],
    walls: (options.walls ?? []).map(asLineObstacle),
  };
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
  // First choice: keep clear of the sides that face the shape's relationship
  // partners. A fan that grows toward a partner meets that partner's own
  // attributes halfway, and the line between them has to stretch.
  let open: Range[] = ranges;
  for (const partner of ctx.partners) {
    open = subtract(open, partner - PARTNER_MARGIN, partner + PARTNER_MARGIN);
  }
  // Best of all, each fan also stays on its own half of every straight line.
  const walled = [...obstacles, ...ctx.walls];
  const result =
    (ctx.walls.length > 0
      ? tryFan(owner, units, open, geometry, distance, 'strict', walled, ctx)?.filter(
          (p) => !ctx.walls.includes(p),
        )
      : null) ??
    (ctx.partners.length > 0
      ? tryFan(owner, units, open, geometry, distance, 'strict', obstacles, ctx)
      : null) ??
    tryFan(owner, units, ranges, geometry, distance, 'normal', obstacles, ctx) ??
    tryFan(owner, units, ranges, geometry, distance, 'overflow', obstacles, ctx)!;
  return result.slice(obstacles.length);
}

/**
 * How hard `tryFan` tries. `strict`: only open sides with no shape right
 * next to them, not too far out, and fail rather than spill elsewhere. `normal`:
 * any free side, as far out as needed, but fail if something does not fit.
 * `overflow`: never fail; the largest side takes whatever is left.
 */
type FanMode = 'strict' | 'normal' | 'overflow';

/**
 * Composite keys go first, at the free direction closest to straight up or
 * down, because their parts sit in a row with a line under them. The other
 * units fill the largest range, or are shared evenly between ranges of
 * similar size (like above and below a relationship). Ranges that face a
 * nearby unrelated shape come last. A range that is too small for its units
 * first moves them further out (where each takes less angle); units that
 * still do not fit spill into the next range.
 */
function tryFan(
  owner: Shape,
  units: Unit[],
  ranges: Range[],
  geometry: Geometry,
  distance: number,
  mode: FanMode,
  obstacles: Placed[],
  ctx: Context,
): Placed[] | null {
  const overflow = mode === 'overflow';
  const strict = mode === 'strict';
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

  // Ranges too narrow to hold an attribute are skipped, unless nothing else
  // is free or every wide range faces a nearby shape.
  const crowding = (r: Range) => ctx.crowded.filter((a) => within(a, r, CROWD_REACH)).length;
  let candidates = free.filter((r) => width(r) >= MIN_RANGE);
  if (strict) {
    // A shape right next to a side counts twice (see `crowdedDirections`);
    // one further away does not rule the side out.
    candidates = candidates.filter((r) => crowding(r) < 2);
    if (candidates.length === 0) return null;
  } else if (candidates.length === 0) candidates = free;
  else if (candidates.every((r) => crowding(r) > 0)) {
    candidates = [
      ...candidates,
      ...free.filter((r) => !candidates.includes(r) && crowding(r) === 0),
    ];
  }
  const order = candidates.sort(
    (a, b) => crowding(a) - crowding(b) || width(b) - width(a) || preference(a) - preference(b),
  );
  const largest = width(order[0]!);
  const sharing = order.filter(
    (r) => crowding(r) === crowding(order[0]!) && width(r) >= 0.7 * largest,
  ).length;
  const counts = evenCounts(rest.length, sharing);

  // Fill each range with as many units as fit. Every range but the last
  // only tries nearby distances and passes the rest on, so attributes use
  // another free side before moving far out; the last range may go as far
  // as it takes. A range whose next one faces a nearby shape may go a
  // little further first (open space is better than growing toward a
  // neighbour, but not at the cost of very long attribute lines).
  // When a range cannot hold all its units, the smallest ones move on to
  // the next range: they fit in more places than a composite attribute does.
  const twoRings = (range: Range, units: Unit[]): Placed[] | null => {
    const simple = (u: Unit) => !u.isKeyGroup && u.attributes[0]!.children.length === 0;
    const inner = units.filter(simple);
    const outer = units.filter((u) => !simple(u));
    if (inner.length === 0 || outer.length === 0) return null;
    for (const extra of ctx.search.distances.filter((d) => d <= STRICT_FAR)) {
      const first = placeInRange(
        owner,
        inner,
        range,
        geometry,
        distance + extra,
        placed,
        false,
        ctx,
      );
      if (!first) continue;
      for (const out of OUTER_RING) {
        const second = placeInRange(
          owner,
          outer,
          range,
          geometry,
          distance + extra + out,
          [...placed, ...first],
          false,
          ctx,
        );
        if (second) return [...first, ...second];
      }
    }
    return null;
  };
  const fill = (range: Range, wanted: Unit[], distances: readonly number[]): Unit[] => {
    const bySize = [...wanted].sort((a, b) => unitSize(a, geometry) - unitSize(b, geometry));
    for (let count = wanted.length; count > 0; count--) {
      const left = new Set(bySize.slice(0, wanted.length - count));
      const kept = wanted.filter((u) => !left.has(u));
      let triedRings = false;
      for (const extra of distances) {
        // Before moving everything far out: simple attributes close in, and
        // composite ones on a second ring further out, between them.
        if (extra > NEAR && !triedRings && count === wanted.length) {
          triedRings = true;
          const rings = twoRings(range, kept);
          if (rings) {
            placed.push(...rings);
            return [];
          }
        }
        const result = placeInRange(
          owner,
          kept,
          range,
          geometry,
          distance + extra,
          placed,
          false,
          ctx,
        );
        if (result) {
          placed.push(...result);
          return wanted.filter((u) => left.has(u));
        }
      }
    }
    return wanted;
  };
  const near = ctx.search.distances.filter((d) => d <= NEAR);
  const medium = ctx.search.distances.filter((d) => d <= MEDIUM);
  const far = strict ? ctx.search.distances.filter((d) => d <= STRICT_FAR) : ctx.search.distances;
  let next = 0;
  let spill: Unit[] = [];
  order.forEach((range, i) => {
    const wanted = [...spill, ...rest.slice(next, next + (counts[i] ?? 0))];
    next += counts[i] ?? 0;
    const last = i === order.length - 1;
    const beforeCrowded = !last && crowding(order[i + 1]!) > crowding(range);
    spill = fill(range, wanted, last ? far : beforeCrowded ? medium : near);
  });
  // Still left over: try every range again, now as far out as needed.
  for (const range of order) {
    if (spill.length === 0) break;
    spill = fill(range, spill, far);
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
  // Toward whichever of up and down has fewer unrelated shapes nearby.
  const facing = (angle: number) =>
    ctx.crowded.filter((a) => Math.abs(angleBetween(a, angle)) < 60 * DEG).length;
  const targets = facing(DOWN) < facing(UP) ? [DOWN, UP] : [UP, DOWN];
  for (const extra of ctx.search.distances) {
    for (const target of targets) {
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
          // Not found near the target: try the next distance or direction.
          angle + KEY_GROUP_REACH,
        );
        if (result) return result.placed;
      }
    }
  }
  const angle = closestFreeAngle(free, targets) ?? targets[0]!;
  return placeUnit(owner, unit, angle, geometry, distance, ctx);
}

/** Rough size of a unit: the widths of all its ellipses, children included. */
function unitSize(unit: Unit, geometry: Geometry): number {
  const size = (a: AttributeNode): number =>
    geometry.get(a.id)!.shape.width + a.children.reduce((sum, c) => sum + size(c), 0);
  return unit.attributes.reduce((sum, a) => sum + size(a), 0);
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
  const limit = overflow ? Infinity : range.end;
  const first = sweep(
    owner,
    units,
    range.start,
    geometry,
    distance,
    existing,
    overflow,
    ctx,
    limit,
  );
  if (!first) return null;
  const span = first.end - range.start;
  if (span > width(range) + 1e-9 && !overflow) return null;

  // ...then the units are swept again from where a centered fan starts,
  // in the order that makes them read left to right or top to bottom.
  const center = preferredCenter(range, span);
  const ordered = readsBackward(center, ctx.rtl) ? [...units].reverse() : units;
  const centered = sweep(
    owner,
    ordered,
    center - span / 2,
    geometry,
    distance,
    existing,
    overflow,
    ctx,
    overflow ? Infinity : range.end + 2 * DEG,
  );
  if (centered && (centered.end <= range.end + 2 * DEG || overflow)) return centered.placed;
  const fromStart = sweep(
    owner,
    ordered,
    range.start,
    geometry,
    distance,
    existing,
    false,
    ctx,
    range.end,
  );
  return fromStart?.placed ?? first.placed;
}

/**
 * Sweeping goes in increasing angle (clockwise on screen). Above a shape that
 * runs left to right and on its right side top to bottom; below and on the
 * left it runs backward. Columns always read top to bottom; rows read left
 * to right, or right to left for right-to-left names.
 */
function readsBackward(center: number, rtl: boolean): boolean {
  const tangent = { x: -Math.sin(center), y: Math.cos(center) };
  if (Math.abs(tangent.x) >= Math.abs(tangent.y)) return rtl ? tangent.x > 0 : tangent.x < 0;
  return tangent.y < 0;
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
  limit = Infinity,
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
      // Past the end of the range (unless forced): give up early.
      if (!force && angle > limit) return null;
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
  // A number rather than a string: this runs for every candidate position.
  const id = unit.attributes[0]!.id;
  let index = ctx.ids.get(id);
  if (index === undefined) ctx.ids.set(id, (index = ctx.ids.size));
  const cacheKey =
    (index * 100_000 + Math.round(angle / ANGLE_GRAIN) + 50_000) * 100_000 + Math.round(distance);
  const cached = ctx.cache.get(cacheKey);
  if (cached) return cached;

  const origin = { x: 0, y: 0 };
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const ownerReach = reach(owner, u);
  let result: Placed[];

  if (unit.isKeyGroup) {
    // Parts side by side in a row, each joined to the owner, in reading order.
    const parts = ctx.rtl ? [...unit.attributes].reverse() : unit.attributes;
    const shapes = parts.map((a) => geometry.get(a.id)!.shape);
    const rowWidth = shapes.reduce((sum, s) => sum + s.width, 0) + 2 * (shapes.length - 1);
    const rowHeight = Math.max(...shapes.map((s) => s.height));
    const rowReach = Math.abs(u.x) * (rowWidth / 2) + Math.abs(u.y) * (rowHeight / 2);
    const middle = add(origin, u, ownerReach + distance + rowReach);
    let x = middle.x - rowWidth / 2;
    result = parts.map((attribute, i) => {
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
      // Their arrangement depends only on the angle, so it is cached by
      // angle (relative to the parent), whatever the parent's distance.
      const childKey = -(index * 100_000 + Math.round(angle / ANGLE_GRAIN) + 50_000) - 1;
      let children = ctx.cache.get(childKey);
      if (!children) {
        const range = { start: angle - CHILD_SPREAD, end: angle + CHILD_SPREAD };
        children = fan(
          shape,
          toUnits(attribute.children),
          [range],
          geometry,
          STYLE.attributeGap.nested,
          [],
          { ...ctx, search: QUICK, crowded: [], partners: [], walls: [] },
        );
        ctx.cache.set(childKey, children);
      }
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
  // Hot path of the whole layout: called for every candidate position.
  for (const item of items) {
    for (const other of others) {
      if (other.id === RELATIONSHIP_LINE) {
        if (linesCross(item.connector, other.connector) || lineHits(other, item)) return true;
        continue;
      }
      if (ellipsesOverlap(item, other, STYLE.attributeGap.between)) return true;
      if (lineHits(other, item) || lineHits(item, other)) return true;
    }
  }
  return false;
}

/** True if two axis-aligned ellipses, each grown by `padding / 2`, overlap. */
function ellipsesOverlap(p: Placed, q: Placed, padding: number): boolean {
  const aw = p.shape.width + padding;
  const ah = p.shape.height + padding;
  const bw = q.shape.width + padding;
  const bh = q.shape.height + padding;
  const dx = q.center.x - p.center.x;
  const dy = q.center.y - p.center.y;
  if (Math.abs(dx) > (aw + bw) / 2 || Math.abs(dy) > (ah + bh) / 2) return false;
  const a: Shape = { kind: 'ellipse', width: aw, height: ah };
  const b: Shape = { kind: 'ellipse', width: bw, height: bh };
  if (contains(a, p.center, q.center) || contains(b, q.center, p.center)) return true;
  // Points around each outline, tested against the other ellipse.
  for (let i = 0; i < 32; i++) {
    const c = UNIT_CIRCLE[i]!;
    const ax = (aw / 2) * c.x - dx;
    const ay = (ah / 2) * c.y - dy;
    if ((4 * ax * ax) / (bw * bw) + (4 * ay * ay) / (bh * bh) <= 1) return true;
    const bx = (bw / 2) * c.x + dx;
    const by = (bh / 2) * c.y + dy;
    if ((4 * bx * bx) / (aw * aw) + (4 * by * by) / (ah * ah) <= 1) return true;
  }
  return false;
}

/** 32 points around the unit circle, for `ellipsesOverlap`. */
const UNIT_CIRCLE: Point[] = Array.from({ length: 32 }, (_, i) => ({
  x: Math.cos((i / 32) * 2 * Math.PI),
  y: Math.sin((i / 32) * 2 * Math.PI),
}));

/** True if two segments cross at a point inside both (touching at an end does not count). */
function linesCross([a, b]: [Point, Point], [c, d]: [Point, Point]): boolean {
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y)
  ) {
    return false;
  }
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
}

/** Which side of the line through `p` and `q` the point `r` is on (the sign), times twice the triangle's area. */
function side(p: Point, q: Point, r: Point): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

/** True if `line`'s connector runs through `item`, an ellipse other than the ones at its ends. */
function lineHits(line: Placed, item: Placed): boolean {
  const [from, to] = line.connector;
  if (same(from, item.center) || same(to, item.center)) return false;
  // Relationship lines must stay well clear of the whole box; attribute
  // lines may pass the empty corners of an ellipse's box, but not touch it.
  if (line.id === RELATIONSHIP_LINE) {
    return segmentHitsBox(from, to, boxAround(item.center, item.shape.width, item.shape.height, 4));
  }
  return segmentHitsEllipse(from, to, item.center, item.shape.width, item.shape.height, 3);
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

/** True if `angle` lies inside `range`, or within `reach` of it. */
function within(angle: number, range: Range, reach: number): boolean {
  return [-1, 0, 1, 2].some((t) => {
    const a = angle + t * 2 * Math.PI;
    return a >= range.start - reach && a <= range.end + reach;
  });
}

/** Signed difference between two angles, in (-π, π]. */
function angleBetween(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function normalize(angle: number): number {
  const full = 2 * Math.PI;
  return ((angle % full) + full) % full;
}
