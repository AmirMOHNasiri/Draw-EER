import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildDiagram,
  isEmpty,
  layoutDiagram,
  moveTo,
  NO_POSITIONS,
  parse,
  parseLayoutFile,
  pinAll,
  prunePositions,
  serializeLayoutFile,
  sizeDiagram,
  snap,
  type Layout,
  type Positions,
  type SizedDiagram,
  type TextMeasurer,
} from '../../src';
import { createNodeMeasurer } from '../../src/node';

let measurer: TextMeasurer;
beforeAll(async () => {
  measurer = await createNodeMeasurer();
});

function prepare(source: string): { sized: SizedDiagram; auto: Layout } {
  const sized = sizeDiagram(buildDiagram(parse(source).file), measurer);
  return { sized, auto: layoutDiagram(sized) };
}

const SOURCE = [
  'entity Student { id: key, name { first, last } }',
  'entity Course { code: key }',
  'rel Takes { Student N, Course M }',
].join('\n');

const STUDENT = 'entity:Student';
const NAME = 'attr:entity:Student/name';
const FIRST = 'attr:attr:entity:Student/name/first';
const TAKES = 'rel:Takes(Student,Course)';

describe('pinAll', () => {
  it('pins shapes at their centers and attributes relative to their owners', () => {
    const { sized, auto } = prepare(SOURCE);
    const positions = pinAll(sized.diagram, auto);
    const at = (id: string) => auto.get(id)!;
    const rounded = (x: number) => Math.round(x) + 0;
    expect(positions.nodes[STUDENT]).toEqual({
      x: rounded(at(STUDENT).x),
      y: rounded(at(STUDENT).y),
    });
    // `first` is relative to `name`, its composite owner.
    expect(positions.attributes[FIRST]).toEqual({
      x: rounded(at(FIRST).x - at(NAME).x),
      y: rounded(at(FIRST).y - at(NAME).y),
    });
    expect(Object.keys(positions.nodes).sort()).toEqual(['entity:Course', STUDENT, TAKES].sort());
  });
});

describe('moveTo', () => {
  it('pins the whole layout on the first move, with the moved shape where it was dropped', () => {
    const { sized, auto } = prepare(SOURCE);
    const to = { x: auto.get(TAKES)!.x + 30.4, y: auto.get(TAKES)!.y - 12.6 };
    const positions = moveTo(sized.diagram, auto, NO_POSITIONS, TAKES, to);
    expect(positions.nodes[TAKES]).toEqual({ x: Math.round(to.x), y: Math.round(to.y) });
    const rest = pinAll(sized.diagram, auto);
    expect({ ...positions.nodes, [TAKES]: rest.nodes[TAKES] }).toEqual(rest.nodes);
    expect(positions.attributes).toEqual(rest.attributes);
  });

  it('stores an attribute relative to where its owner is shown', () => {
    const { sized, auto } = prepare(SOURCE);
    const owner = auto.get(STUDENT)!;
    const positions = moveTo(sized.diagram, auto, NO_POSITIONS, NAME, {
      x: owner.x + 10,
      y: owner.y + 90,
    });
    expect(positions.attributes[NAME]).toEqual({ x: 10, y: 90 });
    // Its parts keep their place relative to it, so they move along.
    expect(positions.attributes[FIRST]).toEqual(pinAll(sized.diagram, auto).attributes[FIRST]);
  });

  it('ignores ids that are not in the diagram', () => {
    const { sized, auto } = prepare(SOURCE);
    expect(moveTo(sized.diagram, auto, NO_POSITIONS, 'entity:Nobody', { x: 0, y: 0 })).toBe(
      NO_POSITIONS,
    );
  });
});

describe('snap', () => {
  it('lines a shape up with a shape it is joined to, axis by axis', () => {
    const { sized, auto } = prepare(SOURCE);
    const takes = auto.get(TAKES)!;
    const near = { x: takes.x + 300, y: takes.y + 5 };
    expect(snap(sized.diagram, auto, STUDENT, near, 8)).toEqual({ x: near.x, y: takes.y });
    const far = { x: takes.x + 300, y: takes.y + 20 };
    expect(snap(sized.diagram, auto, STUDENT, far, 8)).toEqual(far);
  });

  it('lines an attribute up with its owner', () => {
    const { sized, auto } = prepare(SOURCE);
    const student = auto.get(STUDENT)!;
    const to = { x: student.x - 3, y: student.y - 120 };
    expect(snap(sized.diagram, auto, NAME, to, 8)).toEqual({ x: student.x, y: to.y });
  });
});

describe('the layout file', () => {
  const positions: Positions = {
    nodes: { 'entity:دانشجو': { x: 12, y: -4 }, 'entity:A': { x: 0, y: 30 } },
    attributes: { 'attr:entity:A/"x"': { x: -90.5, y: 40 } },
  };

  it('writes one element per line, sorted, and reads it back', () => {
    const text = serializeLayoutFile(positions);
    expect(text).toBe(
      [
        '{',
        '  "version": 1,',
        '  "nodes": {',
        '    "entity:A": { "x": 0, "y": 30 },',
        '    "entity:دانشجو": { "x": 12, "y": -4 }',
        '  },',
        '  "attributes": {',
        '    "attr:entity:A/\\"x\\"": { "x": -90.5, "y": 40 }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(parseLayoutFile(text)).toEqual({ positions, error: null });
  });

  it('writes empty sections compactly', () => {
    expect(serializeLayoutFile(NO_POSITIONS)).toBe(
      '{\n  "version": 1,\n  "nodes": {},\n  "attributes": {}\n}\n',
    );
    expect(isEmpty(NO_POSITIONS)).toBe(true);
    expect(isEmpty(positions)).toBe(false);
  });

  it('falls back to the automatic layout for a file it cannot use', () => {
    expect(parseLayoutFile('{ nope').error).toMatch(/not valid JSON/);
    expect(parseLayoutFile('{ "version": 2 }').error).toMatch(/unknown format/);
    expect(parseLayoutFile('[]').positions).toEqual(NO_POSITIONS);
  });

  it('skips entries that are not points', () => {
    const text =
      '{ "version": 1, "nodes": { "a": { "x": 1, "y": 2 }, "b": { "x": "1" }, "c": 3 } }';
    expect(parseLayoutFile(text)).toEqual({
      positions: { nodes: { a: { x: 1, y: 2 } }, attributes: {} },
      error: null,
    });
  });

  it('drops positions of elements that are no longer in the diagram', () => {
    const { sized } = prepare(SOURCE);
    const stale: Positions = {
      nodes: { [STUDENT]: { x: 1, y: 1 }, 'entity:Gone': { x: 2, y: 2 } },
      attributes: { [FIRST]: { x: 3, y: 3 }, 'attr:entity:Gone/x': { x: 4, y: 4 } },
    };
    expect(prunePositions(sized.diagram, stale)).toEqual({
      nodes: { [STUDENT]: { x: 1, y: 1 } },
      attributes: { [FIRST]: { x: 3, y: 3 } },
    });
  });
});
