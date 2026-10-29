import { describe, expect, it } from 'vitest';
import { buildDiagram, parse } from '../../src';
import type { Diagram, EntityNode, RelationshipNode } from '../../src';

function build(source: string): Diagram {
  const { file, errors } = parse(source);
  expect(errors).toEqual([]);
  return buildDiagram(file);
}

const entities = (d: Diagram) => d.nodes.filter((n): n is EntityNode => n.kind === 'entity');
const relationships = (d: Diagram) =>
  d.nodes.filter((n): n is RelationshipNode => n.kind === 'relationship');

describe('buildDiagram', () => {
  it('gives every element a stable id built from names', () => {
    const d = build('entity Student { id: key, name { first } }\nrel Enroll { Student, Course }');
    const student = entities(d)[0]!;
    expect(student.id).toBe('entity:Student');
    expect(student.attributes.map((a) => a.id)).toEqual([
      'attr:entity:Student/id',
      'attr:entity:Student/name',
    ]);
    expect(student.attributes[1]!.children[0]!.id).toBe('attr:attr:entity:Student/name/first');
    expect(relationships(d)[0]!.id).toBe('rel:Enroll(Student,Course)');
    expect(d.links.map((l) => l.id)).toEqual([
      'rel:Enroll(Student,Course)->entity:Student',
      'rel:Enroll(Student,Course)->entity:Course',
    ]);
  });

  it('creates plain entities for names that are used but not declared', () => {
    const d = build('rel R { A, B }');
    expect(entities(d).map((e) => [e.name, e.weak, e.attributes.length])).toEqual([
      ['A', false, 0],
      ['B', false, 0],
    ]);
  });

  it('merges duplicate entity declarations', () => {
    const d = build('entity A { x }\nweak entity A { y }');
    expect(entities(d)).toHaveLength(1);
    expect(entities(d)[0]).toMatchObject({ weak: true });
    expect(entities(d)[0]!.attributes.map((a) => a.name)).toEqual(['x', 'y']);
  });

  it('keeps relationships with the same name apart', () => {
    const d = build('rel Has { A, B }\nrel Has { A, C }\nrel Has { A, B }');
    expect(relationships(d).map((r) => r.id)).toEqual([
      'rel:Has(A,B)',
      'rel:Has(A,C)',
      'rel:Has(A,B)#2',
    ]);
  });

  it('turns cardinalities into labels and keeps roles', () => {
    const d = build('rel R { A (0,N) total as boss, B 1 }');
    expect(d.links.map((l) => [l.cardinality, l.participation, l.role])).toEqual([
      ['(0,N)', 'total', 'boss'],
      ['1', 'partial', null],
    ]);
  });

  it('gives the two lines of a unary relationship distinct ids', () => {
    const d = build('rel Prereq { Course N, Course M }');
    expect(entities(d)).toHaveLength(1);
    expect(d.links.map((l) => l.id)).toEqual([
      'rel:Prereq(Course,Course)->entity:Course',
      'rel:Prereq(Course,Course)->entity:Course#2',
    ]);
  });

  it('creates repeated copies that relationships reach through their alias', () => {
    const d = build('weak entity Course\nshow Course again as C2\nrel Prereq { Course, C2 }');
    const copy = d.nodes.find((n) => n.id === 'copy:C2') as EntityNode;
    expect(copy).toMatchObject({ name: 'Course', repeated: true, weak: true, attributes: [] });
    expect(d.links.map((l) => l.to)).toEqual(['entity:Course', 'copy:C2']);
  });

  it('prefers a declared entity over an alias with the same name', () => {
    const d = build('entity A\nshow B again as A\nrel R { A }');
    expect(d.links[0]!.to).toBe('entity:A');
  });

  it('marks the attributes of a composite key with a shared group', () => {
    const d = build('entity C { (code, term): partial, title }');
    const [code, term, title] = entities(d)[0]!.attributes;
    expect(code).toMatchObject({ key: 'partial', keyGroup: 'keygroup:entity:C/code,term' });
    expect(term!.keyGroup).toBe(code!.keyGroup);
    expect(title!.keyGroup).toBeNull();
  });

  it('draws relationship attributes and aggregated relationships', () => {
    const d = build('aggregate S { rel G { A, B, attrs { since } } }');
    expect(relationships(d)[0]!.attributes.map((a) => a.id)).toEqual(['attr:rel:G(A,B)/since']);
  });

  it('creates the entities named by EER declarations', () => {
    const d = build(
      'specialize E { S }\ncategory C { X, Y }\npartof W { P }\nentity T inherits E, Q',
    );
    expect(
      entities(d)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['C', 'E', 'P', 'Q', 'S', 'T', 'W', 'X', 'Y'].sort());
  });
});
