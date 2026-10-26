import type { Point, Shape } from '../geometry/shapes';
import type { AttributeNode } from '../model/types';
import { STYLE } from '../render/style';
import type { ElementGeometry } from './size';

/**
 * Places a shape's attributes around it.
 *
 * Attributes go on up to four sides of their owner: a row above, a row
 * below, or a column on the left or right. Composite attributes grow their
 * children further outward, so attributes sit close to their owner, like in
 * textbook figures.
 *
 * Which sides to use depends on where the relationship lines go. This module
 * proposes candidate arrangements (`candidateArrangements`); the layout picks
 * the one that lines and other shapes cross least.
 *
 * Positions are relative to the owner's center, so attributes move with
 * their owner.
 */

export type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * How a row or column sits along its side when it is longer than the owner:
 * centered on it, or shifted so it extends only one way (left/up for
 * `start`, right/down for `end`).
 */
export type Align = 'center' | 'start' | 'end';

export interface Arrangement {
  sides: Map<Side, Unit[]>;
  align: Align;
}

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
 * One item on a side: a single attribute (with its children), or the
 * attributes of one composite key, which always stay side by side.
 */
export interface Unit {
  attributes: AttributeNode[];
  isKeyGroup: boolean;
}

/** Layout of a unit in "local" axes: `c` runs along the side, `m` points away from the owner. */
interface LocalLayout {
  items: { id: string; c: number; m: number }[];
  minC: number;
  maxC: number;
  minM: number;
  maxM: number;
}

type Geometry = Map<string, ElementGeometry>;

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
 * Decides which side each attribute goes on.
 *
 * `blocked` counts the lines leaving the owner through each side. Attributes
 * avoid those sides. A few attributes (up to 3) stay together on one side;
 * more are spread over the free sides in declaration order.
 */
export function chooseSides(units: Unit[], blocked: Record<Side, number>): Map<Side, Unit[]> {
  const sides: Side[] = ['top', 'right', 'bottom', 'left'];
  let free = sides.filter((side) => blocked[side] === 0);
  if (free.length === 0) {
    const least = Math.min(...sides.map((side) => blocked[side]));
    free = sides.filter((side) => blocked[side] === least);
  }

  const result = new Map<Side, Unit[]>();
  const put = (side: Side, unit: Unit) => {
    const list = result.get(side) ?? [];
    list.push(unit);
    result.set(side, list);
  };
  const rows = free.filter((side) => side === 'top' || side === 'bottom');
  // Composite keys need a row, so the group line can run under all their parts.
  const rowFor = (index: number): Side => rows[index % Math.max(rows.length, 1)] ?? 'top';

  const columns = free.filter((side) => side === 'left' || side === 'right');
  if (units.length <= 3) {
    // At the end of a chain (exactly one free column), the column reads best.
    const side: Side =
      columns.length === 1 && !units.some((u) => u.isKeyGroup)
        ? columns[0]!
        : (rows[0] ?? free[0]!);
    for (const unit of units) put(unit.isKeyGroup ? rowFor(0) : side, unit);
    return result;
  }

  // Spread over the free sides, keeping declaration order on each side.
  const plain = units.filter((u) => !u.isKeyGroup);
  units.filter((u) => u.isKeyGroup).forEach((unit, i) => put(rowFor(i), unit));
  const perSide = Math.ceil(plain.length / free.length);
  let index = 0;
  for (const side of free) {
    const isColumn = side === 'left' || side === 'right';
    // Long columns get tall; rows can take the overflow.
    const take = isColumn && rows.length > 0 ? Math.min(perSide, 4) : perSide;
    for (let n = 0; n < take && index < plain.length; n++) put(side, plain[index++]!);
  }
  for (let i = 0; index < plain.length; i++)
    put(rows[i % rows.length] ?? free[0]!, plain[index++]!);
  return result;
}

/**
 * Arrangements worth trying, most preferred first: the rule-based choice of
 * `chooseSides`, then every single side, then every pair of sides, each with
 * rows and columns centered or shifted.
 */
export function candidateArrangements(units: Unit[], blocked: Record<Side, number>): Arrangement[] {
  if (units.length === 0) return [{ sides: new Map(), align: 'center' }];
  const aligns: Align[] = ['center', 'start', 'end'];
  const result: Arrangement[] = aligns.map((align) => ({
    sides: chooseSides(units, blocked),
    align,
  }));

  const all: Side[] = ['top', 'bottom', 'right', 'left'];
  const isRow = (side: Side) => side === 'top' || side === 'bottom';
  for (const side of all) {
    // Composite keys must stay in a row.
    const sides = new Map<Side, Unit[]>();
    for (const unit of units) {
      const target = unit.isKeyGroup && !isRow(side) ? 'top' : side;
      sides.set(target, [...(sides.get(target) ?? []), unit]);
    }
    for (const align of aligns) result.push({ sides, align });
  }

  // Spread over two, three or four sides, in declaration order.
  const ringOrder: Side[] = ['top', 'right', 'bottom', 'left'];
  for (const subset of sideSubsets(ringOrder)) {
    if (subset.length < 2 || subset.length > units.length) continue;
    const sides = new Map<Side, Unit[]>();
    const perSide = Math.ceil(units.length / subset.length);
    units.forEach((unit, index) => {
      let target = subset[Math.floor(index / perSide)]!;
      if (unit.isKeyGroup && !isRow(target)) target = subset.find(isRow) ?? 'top';
      sides.set(target, [...(sides.get(target) ?? []), unit]);
    });
    for (const align of aligns) result.push({ sides, align });
  }
  return result;
}

/**
 * Every subset of the sides, keeping their order around the shape. Subsets
 * that wrap around (like left + top) start after the gap, so attributes are
 * spread in one continuous sweep.
 */
function sideSubsets(ring: Side[]): Side[][] {
  const subsets: Side[][] = [];
  for (let mask = 1; mask < 1 << ring.length; mask++) {
    const chosen = ring.filter((_, i) => mask & (1 << i));
    // Rotate so the sweep starts right after the first unused side.
    const firstGap = ring.findIndex((_, i) => !(mask & (1 << i)));
    if (firstGap > 0) {
      const after = ring.slice(firstGap).concat(ring.slice(0, firstGap));
      subsets.push(after.filter((side) => chosen.includes(side)));
    } else {
      subsets.push(chosen);
    }
  }
  return subsets;
}

/** Places all attributes of one owner in the given arrangement. */
export function layoutCluster(
  owner: Shape,
  arrangement: Arrangement,
  geometry: Geometry,
): AttributeCluster {
  const positions = new Map<string, Point>();
  for (const [side, units] of arrangement.sides) {
    const vertical = side === 'top' || side === 'bottom';
    const layouts = units.map((unit) => layoutUnit(unit, vertical, geometry));
    const ownerHalf = (vertical ? owner.height : owner.width) / 2;
    const gap = STYLE.attributeGap.between;
    const total =
      layouts.reduce((sum, l) => sum + (l.maxC - l.minC), 0) + gap * (layouts.length - 1);

    // Along the side: centered on the owner, or shifted to one end of it.
    const ownerCross = (vertical ? owner.width : owner.height) / 2;
    let c =
      arrangement.align === 'center' || total <= 2 * ownerCross
        ? -total / 2
        : arrangement.align === 'start'
          ? ownerCross - total
          : -ownerCross;
    for (const layout of layouts) {
      const offsetC = c - layout.minC;
      // The near edge of every unit sits the same distance from the owner.
      const offsetM = ownerHalf + STYLE.attributeGap.fromOwner - layout.minM;
      for (const item of layout.items) {
        positions.set(item.id, toXY(side, item.c + offsetC, item.m + offsetM));
      }
      c += layout.maxC - layout.minC + gap;
    }
  }
  return { positions, bounds: clusterBounds(owner, positions, geometry) };
}

function toXY(side: Side, c: number, m: number): Point {
  switch (side) {
    case 'top':
      return { x: c, y: -m };
    case 'bottom':
      return { x: c, y: m };
    case 'left':
      return { x: -m, y: c };
    case 'right':
      return { x: m, y: c };
  }
}

function layoutUnit(unit: Unit, vertical: boolean, geometry: Geometry): LocalLayout {
  if (unit.attributes.length === 1) return layoutAttribute(unit.attributes[0]!, vertical, geometry);

  // Composite key: ellipses side by side along the side, nearly touching.
  const result: LocalLayout = { items: [], minC: 0, maxC: 0, minM: 0, maxM: 0 };
  let c = 0;
  for (const attribute of unit.attributes) {
    const { cross, main } = sizes(attribute, vertical, geometry);
    result.items.push({ id: attribute.id, c: c + cross / 2, m: 0 });
    result.minM = Math.min(result.minM, -main / 2);
    result.maxM = Math.max(result.maxM, main / 2 + STYLE.keyGroupLineOffset);
    c += cross + 2;
  }
  result.maxC = c - 2;
  return result;
}

/** An attribute with its composite children placed beyond it, centered on it. */
function layoutAttribute(
  attribute: AttributeNode,
  vertical: boolean,
  geometry: Geometry,
): LocalLayout {
  const { cross, main } = sizes(attribute, vertical, geometry);
  const result: LocalLayout = {
    items: [{ id: attribute.id, c: 0, m: 0 }],
    minC: -cross / 2,
    maxC: cross / 2,
    minM: -main / 2,
    maxM: main / 2,
  };
  if (attribute.children.length === 0) return result;

  const children = toUnits(attribute.children).map((u) => layoutUnit(u, vertical, geometry));
  const gap = STYLE.attributeGap.between;
  const total =
    children.reduce((sum, l) => sum + (l.maxC - l.minC), 0) + gap * (children.length - 1);
  let c = -total / 2;
  for (const child of children) {
    const offsetC = c - child.minC;
    const offsetM = main / 2 + STYLE.attributeGap.nested - child.minM;
    for (const item of child.items) {
      result.items.push({ id: item.id, c: item.c + offsetC, m: item.m + offsetM });
    }
    result.minC = Math.min(result.minC, child.minC + offsetC);
    result.maxC = Math.max(result.maxC, child.maxC + offsetC);
    result.maxM = Math.max(result.maxM, child.maxM + offsetM);
    c += child.maxC - child.minC + gap;
  }
  return result;
}

/** Ellipse size along the side (`cross`) and away from the owner (`main`). */
function sizes(attribute: AttributeNode, vertical: boolean, geometry: Geometry) {
  const shape = geometry.get(attribute.id)!.shape;
  return vertical
    ? { cross: shape.width, main: shape.height }
    : { cross: shape.height, main: shape.width };
}

function clusterBounds(owner: Shape, positions: Map<string, Point>, geometry: Geometry): Bounds {
  const bounds: Bounds = {
    minX: -owner.width / 2,
    maxX: owner.width / 2,
    minY: -owner.height / 2,
    maxY: owner.height / 2,
  };
  for (const [id, p] of positions) {
    const shape = geometry.get(id)!.shape;
    bounds.minX = Math.min(bounds.minX, p.x - shape.width / 2);
    bounds.maxX = Math.max(bounds.maxX, p.x + shape.width / 2);
    bounds.minY = Math.min(bounds.minY, p.y - shape.height / 2);
    bounds.maxY = Math.max(bounds.maxY, p.y + shape.height / 2 + STYLE.keyGroupLineOffset);
  }
  return bounds;
}
