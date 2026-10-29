/**
 * Editing a diagram that has a layout file: pinned elements never move,
 * new ones are placed around them, and nothing overlaps.
 *
 * The starting point is the owner's test in the preview: airline.eer laid
 * out automatically, then «صندلی» dragged down by hand (which pins the
 * whole layout). Then the text is edited.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  arrange,
  buildDiagram,
  clearOfShapes,
  layoutDiagram,
  moveTo,
  NO_POSITIONS,
  parse,
  prunePositions,
  sizeDiagram,
  type Layout,
  type Positions,
  type SizedDiagram,
  type TextMeasurer,
} from '../../src';
import { segmentHitsShape, shapesOverlap } from '../../src/geometry/collide';
import { createNodeMeasurer } from '../../src/node';

const AIRLINE = readFileSync(new URL('../fixtures/airline.eer', import.meta.url), 'utf8');
const SEAT = 'entity:صندلی';

let measurer: TextMeasurer;
/** Airline after the drag: its layout and the positions saved by the drag. */
let pinned: { layout: Layout; positions: Positions };

beforeAll(async () => {
  measurer = await createNodeMeasurer();
  const s = sized(AIRLINE);
  const auto = layoutDiagram(s);
  const seat = auto.get(SEAT)!;
  const positions = moveTo(s.diagram, auto, NO_POSITIONS, SEAT, { x: seat.x, y: seat.y + 160 });
  pinned = arrange(s, positions);
  expect(overlaps(s, pinned.layout)).toEqual([]);
});

function sized(source: string): SizedDiagram {
  return sizeDiagram(buildDiagram(parse(source).file), measurer);
}

/** Airline edited, laid out with the saved positions, as the preview does it. */
function edit(source: string) {
  const s = sized(source);
  const result = arrange(s, pinned.positions);
  return { sized: s, ...result, saved: prunePositions(s.diagram, result.positions) };
}

/** Pairs of elements whose outlines overlap (shrunk 2 px, so touching does not count). */
function overlaps(s: SizedDiagram, layout: Layout): string[] {
  const ids = [...layout.keys()];
  const result: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i]!, ids[j]!];
      const [p, q] = [s.geometry.get(a)!.shape, s.geometry.get(b)!.shape];
      if (shapesOverlap(p, layout.get(a)!, q, layout.get(b)!, -4)) result.push(`${a} / ${b}`);
    }
  }
  return result;
}

/** Elements of the old layout that are still in the diagram but moved. */
function movedPinned(after: Layout): string[] {
  return [...pinned.layout]
    .filter(([id, p]) => after.has(id) && (after.get(id)!.x !== p.x || after.get(id)!.y !== p.y))
    .map(([id]) => id);
}

/** New elements that a relationship line runs through (other than the line's own two shapes). */
function linesThroughNew(s: SizedDiagram, layout: Layout): string[] {
  const fresh = [...layout.keys()].filter((id) => !pinned.layout.has(id));
  const result: string[] = [];
  for (const link of s.diagram.links) {
    const [a, b] = [layout.get(link.to)!, layout.get(link.from)!];
    for (const id of fresh) {
      if (id === link.to || id === link.from) continue;
      if (segmentHitsShape(a, b, s.geometry.get(id)!.shape, layout.get(id)!)) {
        result.push(`${link.id} through ${id}`);
      }
    }
  }
  return result;
}

function expectSound(result: ReturnType<typeof edit>) {
  expect(movedPinned(result.layout), 'pinned elements that moved').toEqual([]);
  expect(overlaps(result.sized, result.layout), 'overlaps').toEqual([]);
  expect(linesThroughNew(result.sized, result.layout), 'lines through new shapes').toEqual([]);
  // Every element is placed, and saved for next time.
  const ids = [...result.layout.keys()];
  const saved = new Set([
    ...Object.keys(result.saved.nodes),
    ...Object.keys(result.saved.attributes),
  ]);
  expect(ids.filter((id) => !saved.has(id))).toEqual([]);
}

describe('editing a diagram with a layout file', () => {
  it('without a layout file, uses the automatic layout', () => {
    const s = sized(AIRLINE);
    expect(arrange(s, NO_POSITIONS).layout).toEqual(layoutDiagram(s));
  });

  it('keeps the layout as dragged when nothing else changed', () => {
    const result = edit(AIRLINE);
    expect(result.layout).toEqual(pinned.layout);
    expect(result.saved).toEqual(pinned.positions);
  });

  it('case 1: two new entities and a relationship, joined to nothing pinned', () => {
    const result = edit(`${AIRLINE}\nrel N { Name total N, B }\n`);
    expectSound(result);
  });

  it('case 2: a new relationship to an entity that was not moved', () => {
    const result = edit(`${AIRLINE}\nrel N { Name total N, مسافر }\n`);
    expectSound(result);
  });

  it('case 3: a new relationship to the entity that was moved', () => {
    const result = edit(`${AIRLINE}\nrel N { Name total N, صندلی }\n`);
    expectSound(result);
    // There is room around the moved entity, so the new lines are straight.
    const [seat, rel, name] = [SEAT, 'rel:N(Name,صندلی)', 'entity:Name'].map((id) =>
      result.layout.get(id)!,
    );
    const straight = (p: typeof seat, q: typeof seat) => p!.x === q!.x || p!.y === q!.y;
    expect(straight(seat, rel) && straight(rel, name)).toBe(true);
  });

  it('drops a deleted element from the layout file and moves nothing else', () => {
    const result = edit(AIRLINE.replace('rel تخصیص { "پرواز روزانه" N, هواپیما 1 }', ''));
    expectSound(result);
    const removed = Object.keys(pinned.positions.nodes).filter((id) => !(id in result.saved.nodes));
    expect(removed).toEqual(['rel:تخصیص(پرواز روزانه,هواپیما)']);
  });

  it('places several new elements at once: shapes, attributes and parts of a composite', () => {
    const source = AIRLINE.replace('  تلفن: multi', '  تلفن: multi\n  ایمیل')
      .replace(
        'نام { "نام کوچک", "نام خانوادگی" }',
        'نام { "نام کوچک", "نام خانوادگی", "نام پدر" }',
      )
      .concat(
        '\nrel N { Name total N, B }',
        '\nrel K { مسافر, صندلی, C }',
        '\nentity D { x: key, y, z }',
        '\nrel L { D 1, هواپیما N }\n',
      );
    const result = edit(source);
    expectSound(result);
    // New attributes sit near their owners.
    const near = (id: string, owner: string, reach: number) => {
      const [p, q] = [result.layout.get(id)!, result.layout.get(owner)!];
      expect(Math.hypot(p.x - q.x, p.y - q.y), id).toBeLessThan(reach);
    };
    near('attr:entity:مسافر/ایمیل', 'entity:مسافر', 250);
    near('attr:attr:entity:مسافر/نام/نام پدر', 'attr:entity:مسافر/نام', 250);
  });

  it('draws the same picture the next time, from what was saved', () => {
    const source = `${AIRLINE}\nrel N { Name total N, صندلی }\nentity D { x, y }\n`;
    const first = edit(source);
    const again = arrange(sized(source), first.saved);
    expect(again.layout).toEqual(first.layout);
  });
});

describe('clearOfShapes', () => {
  it('keeps a dragged shape from landing on another, and leaves a free drop alone', () => {
    const s = sized(AIRLINE);
    const { layout } = pinned;
    const target = layout.get('entity:مسافر')!;
    const to = clearOfShapes(s, layout, SEAT, { x: target.x + 10, y: target.y });
    const seat = s.geometry.get(SEAT)!.shape;
    const passenger = s.geometry.get('entity:مسافر')!.shape;
    expect(shapesOverlap(seat, to, passenger, target)).toBe(false);
    expect(Math.hypot(to.x - target.x, to.y - target.y)).toBeLessThan(200);
    const free = { x: layout.get(SEAT)!.x + 5, y: layout.get(SEAT)!.y };
    expect(clearOfShapes(s, layout, SEAT, free)).toEqual(free);
  });
});
