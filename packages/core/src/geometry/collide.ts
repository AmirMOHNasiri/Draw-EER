import { contains, type Point, type Shape } from './shapes';

/** An axis-aligned box. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxAround(center: Point, width: number, height: number, padding = 0): Box {
  return {
    minX: center.x - width / 2 - padding,
    maxX: center.x + width / 2 + padding,
    minY: center.y - height / 2 - padding,
    maxY: center.y + height / 2 + padding,
  };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** True if the segment from `a` to `b` passes through the box (Liang–Barsky clipping). */
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - box.minX],
    [dx, box.maxX - a.x],
    [-dy, a.y - box.minY],
    [dy, box.maxY - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * True if a shape and a box overlap. Checks the box's corners, edge
 * midpoints and center against the shape, and the shape's center against
 * the box; exact for rectangles and close enough for labels near curves.
 */
export function shapeHitsBox(shape: Shape, center: Point, box: Box): boolean {
  const outline = boxAround(center, shape.width, shape.height);
  if (!boxesOverlap(outline, box)) return false;
  if (shape.kind === 'rect') return true;
  if (
    center.x >= box.minX &&
    center.x <= box.maxX &&
    center.y >= box.minY &&
    center.y <= box.maxY
  ) {
    return true;
  }
  const xs = [box.minX, (box.minX + box.maxX) / 2, box.maxX];
  const ys = [box.minY, (box.minY + box.maxY) / 2, box.maxY];
  return xs.some((x) => ys.some((y) => contains(shape, center, { x, y })));
}
