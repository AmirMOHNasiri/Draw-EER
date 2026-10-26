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
  /** Shapes placed by the layout: entities and relationships. */
  nodes: MainNode[];
  /** Lines between main nodes. */
  links: ParticipationLink[];
}

export type MainNode = EntityNode | RelationshipNode;

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

/** A line from a relationship to one of its participants. */
export interface ParticipationLink {
  kind: 'participation';
  id: string;
  relationship: string;
  entity: string;
  /** Label near the entity end, as written: `N`, `1`, `(0,N)`. */
  cardinality: string | null;
  /** `total` is drawn as a double line. */
  participation: Participation;
  role: string | null;
}
