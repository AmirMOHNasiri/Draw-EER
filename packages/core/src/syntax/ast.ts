/**
 * Abstract syntax tree for `.eer` files.
 *
 * The AST mirrors what the user wrote, with nothing resolved or merged.
 * Turning it into a drawable diagram (implicit entities, merged duplicate
 * declarations, and so on) is the model's job, not the parser's.
 *
 * Positions use 0-based lines and columns, counted in UTF-16 code units,
 * the same convention as VS Code and JavaScript string indices.
 */

export interface Position {
  /** 0-based line number. */
  line: number;
  /** 0-based column, in UTF-16 code units. */
  column: number;
  /** 0-based offset from the start of the file, in UTF-16 code units. */
  offset: number;
}

export interface Range {
  start: Position;
  /** Exclusive end. */
  end: Position;
}

/** A name as written: a bare identifier or a quoted string. */
export interface Name {
  /** The name itself (quotes removed and escapes resolved). */
  text: string;
  quoted: boolean;
  range: Range;
}

/** Root of a parsed `.eer` file. */
export interface SourceFile {
  statements: Statement[];
  range: Range;
}

export type Statement =
  | EntityDecl
  | RelationshipDecl
  | SpecializeDecl
  | CategoryDecl
  | PartOfDecl
  | AggregateDecl
  | ShowDecl;

// ---------------------------------------------------------------------------
// Entities and attributes
// ---------------------------------------------------------------------------

/** `[weak] entity Name [inherits A, B] { attributes }` */
export interface EntityDecl {
  kind: 'entity';
  weak: boolean;
  name: Name;
  /** Supertypes from `inherits`; empty when there is no `inherits` clause. */
  inherits: Name[];
  attributes: AttributeItem[];
  range: Range;
}

/**
 * Which kind of key an attribute (or a group of attributes) forms.
 * - `primary`   (`key`):     underlined
 * - `secondary` (`key2`):    double-underlined
 * - `partial`   (`partial`): dashed underline, the discriminator of a weak entity
 */
export type KeyKind = 'primary' | 'secondary' | 'partial';

export type AttributeItem = AttributeDecl | KeyGroupDecl;

/** `name [: flags] [{ children }]`. Children make the attribute composite. */
export interface AttributeDecl {
  kind: 'attribute';
  name: Name;
  key: KeyKind | null;
  multivalued: boolean;
  derived: boolean;
  /** Child attributes of a composite attribute; empty for simple ones. */
  children: AttributeItem[];
  range: Range;
}

/** `(a, b): key` declares several simple attributes that form one key together. */
export interface KeyGroupDecl {
  kind: 'keyGroup';
  names: Name[];
  key: KeyKind;
  range: Range;
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/** `[identifying] rel Name { participants, attrs { ... } }` */
export interface RelationshipDecl {
  kind: 'relationship';
  identifying: boolean;
  name: Name;
  participants: Participant[];
  /** Attributes from all `attrs { }` blocks, in order. */
  attributes: AttributeItem[];
  range: Range;
}

export type Participation = 'total' | 'partial';

/** One line end of a relationship: `Entity [cardinality] [total|partial] [as role]`. */
export interface Participant {
  name: Name;
  cardinality: Cardinality | null;
  /** `total` draws a double line. Defaults to `partial` (single line). */
  participation: Participation;
  role: Name | null;
  range: Range;
}

/**
 * The label drawn near the entity end of a relationship line.
 * Labels are kept as written (`1`, `N`, `*`, `۱`), nothing is interpreted.
 */
export type Cardinality =
  | { kind: 'ratio'; label: string; range: Range }
  | { kind: 'minMax'; min: string; max: string; range: Range };

// ---------------------------------------------------------------------------
// EER constructs
// ---------------------------------------------------------------------------

export type Disjointness = 'disjoint' | 'overlapping';

/** `specialize Super [disjoint|overlapping] [total|partial] { Sub1, Sub2 }` */
export interface SpecializeDecl {
  kind: 'specialize';
  supertype: Name;
  /** `null` when neither flag is given: the subtypes are drawn without a circle. */
  disjointness: Disjointness | null;
  participation: Participation;
  subtypes: Name[];
  range: Range;
}

/** `category Name [total|partial] { Super1, Super2 }` (union type) */
export interface CategoryDecl {
  kind: 'category';
  name: Name;
  participation: Participation;
  superclasses: Name[];
  range: Range;
}

/** `partof Whole [as "Label"] { Part1, Part2 }` */
export interface PartOfDecl {
  kind: 'partOf';
  whole: Name;
  /** Custom hexagon label; `null` means the default "Has". */
  label: Name | null;
  parts: Name[];
  range: Range;
}

/** `aggregate Name { rel ... }` */
export interface AggregateDecl {
  kind: 'aggregate';
  name: Name;
  /** `null` only when the body was missing or broken (a syntax error was reported). */
  relationship: RelationshipDecl | null;
  range: Range;
}

/** `show Entity again [as Alias]` draws a repeated copy of an entity. */
export interface ShowDecl {
  kind: 'show';
  entity: Name;
  /** Name that relationships use to connect to the copy. */
  alias: Name | null;
  range: Range;
}
