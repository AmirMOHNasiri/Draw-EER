import { describe, expect, it } from 'vitest';
import { borderPoint, contains, exitPoint, type Shape } from '../../src/geometry/shapes';
import { segmentHitsBox, shapeHitsBox } from '../../src/geometry/collide';

const origin = { x: 0, y: 0 };
const rect: Shape = { kind: 'rect', width: 100, height: 40 };
const diamond: Shape = { kind: 'diamond', width: 100, height: 40 };
const ellipse: Shape = { kind: 'ellipse', width: 100, height: 40 };

function close(p: { x: number; y: number }, x: number, y: number) {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
}

describe('borderPoint', () => {
  it('finds rectangle edges', () => {
    close(borderPoint(rect, origin, { x: 500, y: 0 }), 50, 0);
    close(borderPoint(rect, origin, { x: 0, y: -500 }), 0, -20);
    close(borderPoint(rect, origin, { x: 500, y: 500 }), 20, 20);
  });

  it('finds diamond edges, including the vertices', () => {
    close(borderPoint(diamond, origin, { x: 500, y: 0 }), 50, 0);
    close(borderPoint(diamond, origin, { x: 0, y: 500 }), 0, 20);
    // On the edge x/50 + y/20 = 1 along y = x: x = 100/7.
    close(borderPoint(diamond, origin, { x: 9, y: 9 }), 100 / 7, 100 / 7);
  });

  it('finds the ellipse perimeter', () => {
    close(borderPoint(ellipse, origin, { x: -500, y: 0 }), -50, 0);
    const p = borderPoint(ellipse, origin, { x: 300, y: 200 });
    expect((p.x / 50) ** 2 + (p.y / 20) ** 2).toBeCloseTo(1, 6);
  });

  it('works for shapes away from the origin', () => {
    close(borderPoint(rect, { x: 10, y: 10 }, { x: 10, y: 100 }), 10, 30);
  });
});

describe('exitPoint', () => {
  it('clips lines that do not pass through the center', () => {
    // A horizontal line 10 px above the center of the diamond.
    const p = exitPoint(diamond, origin, { x: 0, y: -10 }, { x: 500, y: -10 });
    expect(p.y).toBeCloseTo(-10, 6);
    expect(p.x / 50 + 10 / 20).toBeCloseTo(1, 6);
  });

  it('returns the start when it is outside the shape', () => {
    expect(exitPoint(rect, origin, { x: 0, y: 99 }, { x: 5, y: 99 })).toEqual({ x: 0, y: 99 });
  });
});

describe('contains', () => {
  it('distinguishes inside and outside for every shape', () => {
    for (const shape of [rect, diamond, ellipse]) {
      expect(contains(shape, origin, { x: 0, y: 0 })).toBe(true);
      expect(contains(shape, origin, { x: 51, y: 0 })).toBe(false);
    }
    expect(contains(rect, origin, { x: 49, y: 19 })).toBe(true);
    expect(contains(diamond, origin, { x: 49, y: 19 })).toBe(false);
  });
});

describe('collisions', () => {
  const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  it('detects segments through, beside and inside a box', () => {
    expect(segmentHitsBox({ x: -5, y: 5 }, { x: 15, y: 5 }, box)).toBe(true);
    expect(segmentHitsBox({ x: -5, y: 15 }, { x: 15, y: 15 }, box)).toBe(false);
    expect(segmentHitsBox({ x: 2, y: 2 }, { x: 3, y: 3 }, box)).toBe(true);
    expect(segmentHitsBox({ x: -5, y: -5 }, { x: -1, y: 20 }, box)).toBe(false);
  });

  it('ignores the empty corners of a diamond', () => {
    const corner = { minX: 40, minY: -20, maxX: 50, maxY: -12 };
    expect(shapeHitsBox(diamond, origin, corner)).toBe(false);
    expect(shapeHitsBox(rect, origin, corner)).toBe(true);
  });
});
