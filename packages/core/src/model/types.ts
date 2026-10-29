import type { KeyKind, Participation, Range } from '../syntax/ast';

/**
 * The diagram model: what to draw, with no positions yet.
 *
 * Every element has a stable `id` built from names (for example
 * `entity:Student` or `attr:entity:Student/name/first`). The layout file
 * stores positions under these ids, so they survive edits that do not rename
 * the element.
 */
export interface Diagram {
  /** Shapes placed by the layout: entities, relationships, circles and hexagons. */
  nodes: MainNode[];
  /** Lines between main nodes. */
  links: Link[];
  /** Dashed boxes drawn around an aggregated relationship and its participants. */
  aggregates: Aggregate[];
}

export type MainNode = EntityNode | RelationshipNode | CircleNode | PartOfNode;

export interface EntityNode {
  kind: 'entity';
  id: string;
  name: string;
  weak: boolean;
  /**
   * Set on a copy created with `show X again`: drawn with an extra line near
   * the top edge. `name` is the original entity's name.
   */
  repeated: boolean;
  attributes: AttributeNode[];
  /** Where the entity was declared; absent for implicit entities. */
  source?: Range;
}

export interface RelationshipNode {
  kind: 'relationship';
  id: string;
  name: string;
  identifying: boolean;
  attributes: AttributeNode[];
  source?: Range;
}

/**
 * The circle of a specialization (`D` disjoint, `O` overlapping) or of a
 * category (`U`). `symbol` is null for the point where the lines of a total
 * specialization without `disjoint`/`overlapping` split (slide 48): no circle
 * is drawn there, the lines just meet.
 */
export interface CircleNode {
  kind: 'circle';
  id: string;
  symbol: 'D' | 'O' | 'U' | null;
  /** The symbol as text (empty for a junction point), so every node has a name. */
  name: string;
  /** Always empty; present so that layout can treat every shape alike. */
  attributes: AttributeNode[];
  source?: Range;
}

/** The "Has" hexagon on the line from a whole to one of its parts. */
export interface PartOfNode {
  kind: 'partOf';
  id: string;
  /** The label: "Has" unless `as` gives another. */
  name: string;
  /** Always empty; present so that layout can treat every shape alike. */
  attributes: AttributeNode[];
  source?: Range;
}

export interface AttributeNode {
  id: string;
  name: string;
  key: KeyKind | null;
  multivalued: boolean;
  derived: boolean;
  children: AttributeNode[];
  /**
   * Id shared by the attributes of one composite key `(a, b): key`. They are
   * drawn side by side with one line under all of them.
   */
  keyGroup: string | null;
  source?: Range;
}

/**
 * A line between two main nodes.
 *
 * `from` is the hub or the more general end: the relationship, the
 * supertype, the specialization or category circle, the whole. `to` is the
 * participant or the more specific end.
 *
 * - `participation`: relationship → participant (an entity, or the
 *   relationship inside an aggregate).
 * - `specialization`: supertype → circle → subtype, or supertype → subtype
 *   when there is no circle (also for `inherits`).
 * - `category`: superclass → U circle → category.
 * - `partOf`: whole → hexagon → part.
 */
export interface Link {
  kind: 'participation' | 'specialization' | 'category' | 'partOf';
  id: string;
  from: string;
  to: string;
  /** Label near the `to` end, as written: `N`, `1`, `(0,N)`. */
  cardinality: string | null;
  /** `total` is drawn as a double line. */
  participation: Participation;
  role: string | null;
  /**
   * Draws the subset symbol (a small arc, open toward `from`, the more
   * general side) across the middle of the line.
   */
  subset: boolean;
  /**
   * Set when `to` is the relationship inside this aggregate: the part of
   * the line inside the aggregate's box is dashed.
   */
  aggregate: string | null;
}

/** `aggregate Name { rel ... }`: a relationship and its participants, seen as one entity. */
export interface Aggregate {
  id: string;
  name: string;
  /** The relationship inside; lines to the aggregate end at its diamond. */
  relationship: string;
  /** Everything inside the box: the relationship and its participants. */
  members: string[];
  source?: Range;
}
