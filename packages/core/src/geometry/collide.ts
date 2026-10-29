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
 * True if a shape and a box overlap. Exact for rectangles and ellipses; for
 * a diamond, checks the box's corners, edge midpoints and center against it,
 * and its center against the box, which is close enough for labels.
 */
export function shapeHitsBox(shape: Shape, center: Point, box: Box): boolean {
  const outline = boxAround(center, shape.width, shape.height);
  if (!boxesOverlap(outline, box)) return false;
  if (shape.kind === 'rect') return true;
  if (shape.kind === 'ellipse') {
    // Exact: the point of the box nearest the center, scaled so the ellipse is a unit circle.
    const x = (Math.min(Math.max(center.x, box.minX), box.maxX) - center.x) / (shape.width / 2);
    const y = (Math.min(Math.max(center.y, box.minY), box.maxY) - center.y) / (shape.height / 2);
    return x * x + y * y <= 1;
  }
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

/**
 * True if the segment from `a` to `b` passes through the axis-aligned
 * ellipse (grown by `padding` on every side). Scaling x and y turns the
 * ellipse into a unit circle; the segment hits it if its closest point to
 * the center is inside.
 */
export function segmentHitsEllipse(
  a: Point,
  b: Point,
  center: Point,
  width: number,
  height: number,
  padding = 0,
): boolean {
  const rx = width / 2 + padding;
  const ry = height / 2 + padding;
  const p = { x: (a.x - center.x) / rx, y: (a.y - center.y) / ry };
  const q = { x: (b.x - center.x) / rx, y: (b.y - center.y) / ry };
  const d = { x: q.x - p.x, y: q.y - p.y };
  const length2 = d.x * d.x + d.y * d.y;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(p.x * d.x + p.y * d.y) / length2));
  const x = p.x + t * d.x;
  const y = p.y + t * d.y;
  return x * x + y * y < 1;
}

/**
 * True if two shapes overlap or come closer than `gap`. Each outline is
 * sampled and checked against the other shape (both grown by half the gap),
 * which is exact enough for layout and much tighter than comparing boxes,
 * where an ellipse's empty corners would count as taken.
 */
export function shapesOverlap(p: Shape, pc: Point, q: Shape, qc: Point, gap = 0): boolean {
  const a = { ...p, width: p.width + gap, height: p.height + gap };
  const b = { ...q, width: q.width + gap, height: q.height + gap };
  if (!boxesOverlap(boxAround(pc, a.width, a.height), boxAround(qc, b.width, b.height))) {
    return false;
  }
  if (contains(a, pc, qc) || contains(b, qc, pc)) return true;
  return (
    outlinePoints(a, pc).some((point) => contains(b, qc, point)) ||
    outlinePoints(b, qc).some((point) => contains(a, pc, point))
  );
}

/** True if the segment from `a` to `b` passes through the shape. */
export function segmentHitsShape(a: Point, b: Point, shape: Shape, center: Point): boolean {
  return shape.kind === 'ellipse'
    ? segmentHitsEllipse(a, b, center, shape.width, shape.height)
    : segmentHitsBox(a, b, boxAround(center, shape.width, shape.height));
}

const OUTLINE_SAMPLES = 48;

/** Points around a shape's outline. */
function outlinePoints(shape: Shape, center: Point): Point[] {
  const a = shape.width / 2;
  const b = shape.height / 2;
  const points: Point[] = [];
  for (let i = 0; i < OUTLINE_SAMPLES; i++) {
    const t = (i / OUTLINE_SAMPLES) * 2 * Math.PI;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    // Scale the direction so the point lands on the outline.
    const k =
      shape.kind === 'ellipse'
        ? 1
        : shape.kind === 'diamond'
          ? 1 / (Math.abs(c) + Math.abs(s))
          : 1 / Math.max(Math.abs(c), Math.abs(s));
    points.push({ x: center.x + a * c * k, y: center.y + b * s * k });
  }
  return points;
}
