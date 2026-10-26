/**
 * Shape outlines and where lines cross them.
 *
 * Every shape is described around its center at (0, 0); `width` and `height`
 * are the size of its outermost outline (for a weak entity, the outer
 * rectangle), since that is where lines stop.
 */

export interface Point {
  x: number;
  y: number;
}

export type ShapeKind = 'rect' | 'diamond' | 'ellipse';

export interface Shape {
  kind: ShapeKind;
  width: number;
  height: number;
}

/**
 * Walks from `from` toward `to` and returns the first point where the line
 * leaves `shape` (centered at `center`). `from` should be inside the shape;
 * if it is not, `from` itself is returned.
 *
 * Lines between shapes are drawn from the point where they leave the first
 * shape to the point where they enter the second, so they touch the borders
 * instead of running to the centers.
 */
export function exitPoint(shape: Shape, center: Point, from: Point, to: Point): Point {
  const u = { x: from.x - center.x, y: from.y - center.y };
  const d = { x: to.x - from.x, y: to.y - from.y };
  const t = shape.kind === 'ellipse' ? ellipseExit(shape, u, d) : polygonExit(shape, u, d);
  if (t === null) return from;
  return { x: from.x + d.x * t, y: from.y + d.y * t };
}

/** Exit along the straight line between two centers. */
export function borderPoint(shape: Shape, center: Point, toward: Point): Point {
  return exitPoint(shape, center, center, toward);
}

/** True if `point` lies inside (or on) the shape centered at `center`. */
export function contains(shape: Shape, center: Point, point: Point): boolean {
  const x = point.x - center.x;
  const y = point.y - center.y;
  const a = shape.width / 2;
  const b = shape.height / 2;
  switch (shape.kind) {
    case 'rect':
      return Math.abs(x) <= a + 1e-9 && Math.abs(y) <= b + 1e-9;
    case 'diamond':
      return Math.abs(x) / a + Math.abs(y) / b <= 1 + 1e-9;
    case 'ellipse':
      return (x * x) / (a * a) + (y * y) / (b * b) <= 1 + 1e-9;
  }
}

/**
 * Rectangles and diamonds are convex polygons, written as half-planes
 * `n · p <= 1`. Along `u + t·d` the line leaves through the first half-plane
 * it crosses.
 */
function polygonExit(shape: Shape, u: Point, d: Point): number | null {
  const a = shape.width / 2;
  const b = shape.height / 2;
  const normals: Point[] =
    shape.kind === 'rect'
      ? [
          { x: 1 / a, y: 0 },
          { x: -1 / a, y: 0 },
          { x: 0, y: 1 / b },
          { x: 0, y: -1 / b },
        ]
      : [
          { x: 1 / a, y: 1 / b },
          { x: 1 / a, y: -1 / b },
          { x: -1 / a, y: 1 / b },
          { x: -1 / a, y: -1 / b },
        ];
  let best: number | null = null;
  for (const n of normals) {
    const inside = n.x * u.x + n.y * u.y;
    const speed = n.x * d.x + n.y * d.y;
    if (inside > 1 + 1e-9) return null; // `from` is outside the shape
    if (speed <= 1e-12) continue;
    const t = (1 - inside) / speed;
    if (best === null || t < best) best = t;
  }
  return best;
}

/** Solves (ux + t·dx)²/a² + (uy + t·dy)²/b² = 1 for the positive root. */
function ellipseExit(shape: Shape, u: Point, d: Point): number | null {
  const a2 = (shape.width / 2) ** 2;
  const b2 = (shape.height / 2) ** 2;
  const qa = (d.x * d.x) / a2 + (d.y * d.y) / b2;
  const qb = 2 * ((u.x * d.x) / a2 + (u.y * d.y) / b2);
  const qc = (u.x * u.x) / a2 + (u.y * u.y) / b2 - 1;
  if (qc > 1e-9 || qa < 1e-12) return null;
  return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
}

/** Unit vector perpendicular to the direction from `a` to `b` (rotated 90° clockwise on screen). */
export function normal(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

export function add(p: Point, q: Point, scale = 1): Point {
  return { x: p.x + q.x * scale, y: p.y + q.y * scale };
}
