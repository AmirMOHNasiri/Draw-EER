import { describe, expect, it } from 'vitest';
import { parse } from '../src';
import type { EntityDecl, RelationshipDecl } from '../src';
import { parseOk, plain } from './helpers';

const ZWNJ = '\u200C';

function only<T>(source: string): T {
  const statements = parseOk(source);
  expect(statements).toHaveLength(1);
  return statements[0] as T;
}

describe('entities', () => {
  it('parses a strong entity without attributes', () => {
    expect(plain(only('entity Student'))).toEqual({
      kind: 'entity',
      weak: false,
      name: 'Student',
      inherits: [],
      attributes: [],
    });
  });

  it('parses a weak entity', () => {
    expect(only<EntityDecl>('weak entity Dependent { name: partial }').weak).toBe(true);
  });

  it('parses every attribute flag', () => {
    const entity = only<EntityDecl>(`
      entity Employee {
        id: key
        ssn: key2
        name: partial
        phones: multi
        age: derived
        plain
      }`);
    expect(plain(entity.attributes)).toEqual([
      {
        kind: 'attribute',
        name: 'id',
        key: 'primary',
        multivalued: false,
        derived: false,
        children: [],
      },
      {
        kind: 'attribute',
        name: 'ssn',
        key: 'secondary',
        multivalued: false,
        derived: false,
        children: [],
      },
      {
        kind: 'attribute',
        name: 'name',
        key: 'partial',
        multivalued: false,
        derived: false,
        children: [],
      },
      {
        kind: 'attribute',
        name: 'phones',
        key: null,
        multivalued: true,
        derived: false,
        children: [],
      },
      {
        kind: 'attribute',
        name: 'age',
        key: null,
        multivalued: false,
        derived: true,
        children: [],
      },
      {
        kind: 'attribute',
        name: 'plain',
        key: null,
        multivalued: false,
        derived: false,
        children: [],
      },
    ]);
  });

  it('allows several flags on one attribute', () => {
    const [attribute] = only<EntityDecl>('entity E { tags: multi derived }').attributes;
    expect(attribute).toMatchObject({ multivalued: true, derived: true });
  });

  it('separates attributes with commas or newlines, allowing blank lines and trailing commas', () => {
    const entity = only<EntityDecl>('entity E {\n  a, b,\n\n  c,\n}');
    expect(plain(entity.attributes.map((a) => (a.kind === 'attribute' ? a.name : null)))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('accepts the opening brace on the next line', () => {
    expect(only<EntityDecl>('entity E\n{\n  a\n}').attributes).toHaveLength(1);
  });

  it('makes an attribute composite when it has braces, nested to any depth', () => {
    const entity = only<EntityDecl>(
      'entity E { address: multi { city, street { name, number } } }',
    );
    expect(plain(entity.attributes)).toEqual([
      {
        kind: 'attribute',
        name: 'address',
        key: null,
        multivalued: true,
        derived: false,
        children: [
          {
            kind: 'attribute',
            name: 'city',
            key: null,
            multivalued: false,
            derived: false,
            children: [],
          },
          {
            kind: 'attribute',
            name: 'street',
            key: null,
            multivalued: false,
            derived: false,
            children: [
              {
                kind: 'attribute',
                name: 'name',
                key: null,
                multivalued: false,
                derived: false,
                children: [],
              },
              {
                kind: 'attribute',
                name: 'number',
                key: null,
                multivalued: false,
                derived: false,
                children: [],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('parses a composite attribute without flags', () => {
    const [attribute] = only<EntityDecl>('entity E { name { first, last } }').attributes;
    expect(attribute).toMatchObject({ kind: 'attribute', key: null });
    expect(attribute?.kind === 'attribute' && attribute.children).toHaveLength(2);
  });

  it('parses composite key groups of every key kind', () => {
    const entity = only<EntityDecl>(`
      entity Course {
        (code, term): key
        (a, b): key2
        (number, "سال-ترم"): partial
      }`);
    expect(plain(entity.attributes)).toEqual([
      { kind: 'keyGroup', names: ['code', 'term'], key: 'primary' },
      { kind: 'keyGroup', names: ['a', 'b'], key: 'secondary' },
      { kind: 'keyGroup', names: ['number', 'سال-ترم'], key: 'partial' },
    ]);
  });

  it('parses inherits with one or more supertypes', () => {
    const entity = only<EntityDecl>('entity TA inherits Employee, Student { hours }');
    expect(plain(entity.inherits)).toEqual(['Employee', 'Student']);
    expect(entity.attributes).toHaveLength(1);
  });

  it('lets keywords be used as names where they are not expected', () => {
    const entity = only<EntityDecl>('entity rel { key: key, total, entity }');
    expect(entity.name.text).toBe('rel');
    expect(plain(entity.attributes.map((a) => (a.kind === 'attribute' ? a.name : null)))).toEqual([
      'key',
      'total',
      'entity',
    ]);
  });
});

describe('Persian and quoted names', () => {
  it('parses Persian identifiers and quoted names with spaces', () => {
    const word = `پیش${ZWNJ}نیازی`;
    const entity = only<EntityDecl>(`entity "عضو خانواده" { نام: partial, ${word}, "تاریخ تولد" }`);
    expect(entity.name).toMatchObject({ text: 'عضو خانواده', quoted: true });
    expect(plain(entity.attributes.map((a) => (a.kind === 'attribute' ? a.name : null)))).toEqual([
      'نام',
      word,
      'تاریخ تولد',
    ]);
  });

  it('accepts Persian letters and digits as cardinality labels', () => {
    const rel = only<RelationshipDecl>('rel انتخاب { دانشجو ن, درس ۱ }');
    expect(plain(rel.participants.map((p) => p.cardinality))).toEqual([
      { kind: 'ratio', label: 'ن' },
      { kind: 'ratio', label: '۱' },
    ]);
  });
});

describe('relationships', () => {
  it('parses a binary relationship with ratio cardinalities and total participation', () => {
    const rel = only<RelationshipDecl>(`
      identifying rel Has {
        Employee 1
        Dependent N total
      }`);
    expect(plain(rel)).toEqual({
      kind: 'relationship',
      identifying: true,
      name: 'Has',
      participants: [
        {
          name: 'Employee',
          cardinality: { kind: 'ratio', label: '1' },
          participation: 'partial',
          role: null,
        },
        {
          name: 'Dependent',
          cardinality: { kind: 'ratio', label: 'N' },
          participation: 'total',
          role: null,
        },
      ],
      attributes: [],
    });
  });

  it('parses (min,max) cardinalities and relationship attributes', () => {
    const rel = only<RelationshipDecl>(`
      rel Enroll {
        Student (1,N) total
        Course (0, *)
        attrs { term, year: derived }
      }`);
    expect(plain(rel.participants)).toEqual([
      {
        name: 'Student',
        cardinality: { kind: 'minMax', min: '1', max: 'N' },
        participation: 'total',
        role: null,
      },
      {
        name: 'Course',
        cardinality: { kind: 'minMax', min: '0', max: '*' },
        participation: 'partial',
        role: null,
      },
    ]);
    expect(plain(rel.attributes)).toEqual([
      {
        kind: 'attribute',
        name: 'term',
        key: null,
        multivalued: false,
        derived: false,
        children: [],
      },
      {
        kind: 'attribute',
        name: 'year',
        key: null,
        multivalued: false,
        derived: true,
        children: [],
      },
    ]);
  });

  it('parses a unary relationship with roles', () => {
    const rel = only<RelationshipDecl>(`
      rel Prerequisite {
        Course N as "requires"
        Course M as required_by
      }`);
    expect(plain(rel.participants)).toEqual([
      {
        name: 'Course',
        cardinality: { kind: 'ratio', label: 'N' },
        participation: 'partial',
        role: 'requires',
      },
      {
        name: 'Course',
        cardinality: { kind: 'ratio', label: 'M' },
        participation: 'partial',
        role: 'required_by',
      },
    ]);
  });

  it('accepts participant modifiers in any order', () => {
    const rel = only<RelationshipDecl>('rel R { Student total as taker (1,N) }');
    expect(plain(rel.participants[0])).toEqual({
      name: 'Student',
      cardinality: { kind: 'minMax', min: '1', max: 'N' },
      participation: 'total',
      role: 'taker',
    });
  });

  it('parses a ternary relationship on one line, without cardinalities', () => {
    const rel = only<RelationshipDecl>('rel Teaches { Professor, Course, Student }');
    expect(rel.participants.map((p) => [p.name.text, p.cardinality])).toEqual([
      ['Professor', null],
      ['Course', null],
      ['Student', null],
    ]);
  });

  it('parses an n-ary relationship and merges several attrs blocks', () => {
    const rel = only<RelationshipDecl>(`
      rel SPJ {
        Supplier M, Part N, Project K, Warehouse 1
        attrs { Quantity }
        attrs { Price }
      }`);
    expect(rel.participants).toHaveLength(4);
    expect(rel.attributes).toHaveLength(2);
  });

  it('treats attrs as a participant name when no block follows', () => {
    const rel = only<RelationshipDecl>('rel R { attrs 1, B }');
    expect(rel.participants[0]?.name.text).toBe('attrs');
    expect(rel.attributes).toEqual([]);
  });
});

describe('EER constructs', () => {
  it('parses all four specialization combinations', () => {
    const statements = parseOk(`
      specialize A disjoint total { B, C }
      specialize A overlapping partial { D, E }
      specialize A total disjoint { F, G }
      specialize A partial overlapping { H, I }`);
    expect(
      statements.map((s) => s.kind === 'specialize' && [s.disjointness, s.participation]),
    ).toEqual([
      ['disjoint', 'total'],
      ['overlapping', 'partial'],
      ['disjoint', 'total'],
      ['overlapping', 'partial'],
    ]);
  });

  it('defaults a specialization to partial with no disjointness (no circle)', () => {
    expect(plain(only('specialize Employee { Programmer }'))).toEqual({
      kind: 'specialize',
      supertype: 'Employee',
      disjointness: null,
      participation: 'partial',
      subtypes: ['Programmer'],
    });
  });

  it('parses a category', () => {
    expect(plain(only('category Owner total { Person, Company, Bank }'))).toEqual({
      kind: 'category',
      name: 'Owner',
      participation: 'total',
      superclasses: ['Person', 'Company', 'Bank'],
    });
    expect(parseOk('category Owner { A, B }')[0]).toMatchObject({ participation: 'partial' });
  });

  it('parses partof with and without a custom label', () => {
    expect(plain(only('partof Vehicle { Engine, Chassis }'))).toEqual({
      kind: 'partOf',
      whole: 'Vehicle',
      label: null,
      parts: ['Engine', 'Chassis'],
    });
    expect(plain(only('partof Vehicle as "Contains" { Engine }'))).toMatchObject({
      label: 'Contains',
    });
  });

  it('parses an aggregate with an inline relationship, on one line or several', () => {
    const one = only('aggregate Supervision { rel Guides { Professor, Student, Project } }');
    const many = only(`
      aggregate Supervision {
        rel Guides {
          Professor
          Student
          Project
        }
      }`);
    expect(plain(one)).toEqual(plain(many));
    expect(plain(one)).toMatchObject({
      kind: 'aggregate',
      name: 'Supervision',
      relationship: {
        name: 'Guides',
        participants: [{ name: 'Professor' }, { name: 'Student' }, { name: 'Project' }],
      },
    });
  });

  it('parses an aggregate around an identifying relationship', () => {
    expect(only('aggregate X { identifying rel R { A, B } }')).toMatchObject({
      relationship: { identifying: true },
    });
  });

  it('parses show again, with and without an alias', () => {
    expect(plain(only('show Course again'))).toEqual({
      kind: 'show',
      entity: 'Course',
      alias: null,
    });
    expect(plain(only('show Course again as Course2'))).toEqual({
      kind: 'show',
      entity: 'Course',
      alias: 'Course2',
    });
  });
});

describe('ranges', () => {
  it('records 0-based ranges for statements and names', () => {
    const { file } = parse('// header\nentity Student {\n  id: key\n}\n');
    const entity = file.statements[0] as EntityDecl;
    expect(entity.range.start).toMatchObject({ line: 1, column: 0 });
    expect(entity.range.end).toMatchObject({ line: 3, column: 1 });
    expect(entity.name.range.start).toMatchObject({ line: 1, column: 7 });
    expect(entity.attributes[0]?.range).toMatchObject({
      start: { line: 2, column: 2 },
      end: { line: 2, column: 9 },
    });
  });
});

describe('the full example from the spec', () => {
  const source = `
// comments with //
entity Employee {
  id: key
  ssn: key2                      // secondary key
  name { first, last }
  phones: multi
  age: derived
  address: multi { city, street }
}

entity Course { (code, term): key }   // composite key

weak entity Dependent {
  name: partial
  birth_date
}

identifying rel Has {
  Employee 1
  Dependent N total
}

rel Enroll {
  Student (1,N) total
  Course (0,M)
  attrs { term, year }
}

rel Prerequisite {                 // unary / recursive
  Course N as "requires"
  Course2 M as "required_by"
}

rel Teaches { Professor, Course, Student }   // ternary, no cardinality

specialize Employee disjoint total { Male, Female }
specialize Programmer overlapping partial { Frontend, Backend, Systems }
specialize Employee partial { Programmer }    // single subtype, no circle

entity TA inherits Employee, Student { hours }   // multiple inheritance

category Owner total { Person, Company, Bank }

partof Vehicle { Engine, Chassis }

aggregate Supervision { rel Guides { Professor, Student, Project } }
rel Evaluates {
  Supervision
  Evaluator
  attrs { quality }
}

/* draw a repeated-entity copy */
show Course again as Course2
`;

  it('parses without errors', () => {
    const statements = parseOk(source);
    expect(statements.map((s) => s.kind)).toEqual([
      'entity',
      'entity',
      'entity',
      'relationship',
      'relationship',
      'relationship',
      'relationship',
      'specialize',
      'specialize',
      'specialize',
      'entity',
      'category',
      'partOf',
      'aggregate',
      'relationship',
      'show',
    ]);
  });
});
