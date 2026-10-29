import type {
  AggregateDecl,
  AttributeItem,
  CategoryDecl,
  Name,
  Participation,
  PartOfDecl,
  RelationshipDecl,
  SourceFile,
  SpecializeDecl,
  Statement,
} from '../syntax/ast';
import type {
  Aggregate,
  AttributeNode,
  CircleNode,
  Diagram,
  EntityNode,
  Link,
  MainNode,
  PartOfNode,
  RelationshipNode,
} from './types';

/**
 * Turns a parsed file into a diagram model.
 *
 * Nothing is validated here: the user is responsible for their design.
 * - An entity declared twice is drawn once, with the attributes of both
 *   declarations (and weak if either says so).
 * - A name that is used but never declared becomes a plain strong entity.
 * - Relationships are never merged, even with equal names: several
 *   relationships called "Has" are common.
 * - A participant named after an aggregate connects to the relationship
 *   inside it.
 */
export function buildDiagram(file: SourceFile): Diagram {
  return new DiagramBuilder().build(file);
}

class DiagramBuilder {
  private readonly entities = new Map<string, EntityNode>();
  /** `show X again as Alias`: alias → copy node. */
  private readonly copiesByAlias = new Map<string, EntityNode>();
  private readonly copies: EntityNode[] = [];
  private readonly relationships: RelationshipNode[] = [];
  /** Circles and hexagons of the EER constructs. */
  private readonly connectors: (CircleNode | PartOfNode)[] = [];
  private readonly links: Link[] = [];
  private readonly aggregates: Aggregate[] = [];
  /** Aggregate name → the id of the relationship inside it. */
  private readonly aggregateRelationships = new Map<string, string>();
  /** `from|to` of lines drawn straight from a supertype to a subtype, to draw each only once. */
  private readonly subtypeLines = new Set<string>();
  private readonly usedIds = new Set<string>();

  build(file: SourceFile): Diagram {
    const relationshipDecls: RelationshipDecl[] = [];
    const eer: Statement[] = [];

    // Pass 1: declared entities and copies, so that pass 2 can resolve names.
    for (const statement of file.statements) {
      switch (statement.kind) {
        case 'entity': {
          const entity = this.entity(statement.name.text);
          entity.weak ||= statement.weak;
          entity.source ??= statement.range;
          entity.attributes.push(...this.attributes(statement.attributes, entity.id));
          for (const supertype of statement.inherits) this.entity(supertype.text);
          break;
        }
        case 'show': {
          const original = this.entity(statement.entity.text);
          const alias = statement.alias?.text ?? null;
          const copy: EntityNode = {
            kind: 'entity',
            id: this.uniqueId(`copy:${alias ?? original.name}`),
            name: original.name,
            weak: false,
            repeated: true,
            attributes: [],
            source: statement.range,
          };
          this.copies.push(copy);
          if (alias !== null && !this.copiesByAlias.has(alias)) this.copiesByAlias.set(alias, copy);
          break;
        }
        case 'relationship':
          relationshipDecls.push(statement);
          break;
        case 'aggregate':
          if (statement.relationship) relationshipDecls.push(statement.relationship);
          eer.push(statement);
          break;
        case 'specialize':
          this.names([statement.supertype, ...statement.subtypes]);
          eer.push(statement);
          break;
        case 'category':
          this.names([statement.name, ...statement.superclasses]);
          eer.push(statement);
          break;
        case 'partOf':
          this.names([statement.whole, ...statement.parts]);
          eer.push(statement);
          break;
      }
    }

    // Pass 2: relationship shapes first, so that a relationship can connect
    // to an aggregate declared further down; then their lines, creating
    // implicit entities for unknown names.
    const relationshipIds = relationshipDecls.map((decl) => this.relationshipNode(decl));
    for (const statement of eer) {
      if (statement.kind === 'aggregate' && statement.relationship) {
        const relationship = relationshipIds[relationshipDecls.indexOf(statement.relationship)]!;
        if (!this.aggregateRelationships.has(statement.name.text))
          this.aggregateRelationships.set(statement.name.text, relationship);
      }
    }
    relationshipDecls.forEach((decl, i) => this.participationLinks(decl, relationshipIds[i]!));

    // Pass 3: the EER constructs, now that every name resolves.
    for (const statement of file.statements) {
      if (statement.kind === 'entity') {
        for (const supertype of statement.inherits) {
          this.subtypeLine(this.resolve(supertype.text), this.resolve(statement.name.text));
        }
      }
    }
    for (const statement of eer) {
      switch (statement.kind) {
        case 'specialize':
          this.specialization(statement);
          break;
        case 'category':
          this.category(statement);
          break;
        case 'partOf':
          this.partOf(statement);
          break;
        case 'aggregate':
          this.aggregate(
            statement,
            relationshipIds[relationshipDecls.indexOf(statement.relationship!)],
          );
          break;
      }
    }

    // A copy's weak flag follows its original, wherever that was declared.
    for (const copy of this.copies) copy.weak = this.entities.get(copy.name)?.weak ?? false;

    const nodes: MainNode[] = [
      ...this.entities.values(),
      ...this.copies,
      ...this.relationships,
      ...this.connectors,
    ];
    return { nodes, links: this.links, aggregates: this.aggregates };
  }

  private relationshipNode(decl: RelationshipDecl): string {
    const participantNames = decl.participants.map((p) => p.name.text).join(',');
    const id = this.uniqueId(`rel:${decl.name.text}(${participantNames})`);
    this.relationships.push({
      kind: 'relationship',
      id,
      name: decl.name.text,
      identifying: decl.identifying,
      attributes: this.attributes(decl.attributes, id),
      source: decl.range,
    });
    return id;
  }

  private participationLinks(decl: RelationshipDecl, id: string): void {
    for (const participant of decl.participants) {
      const name = participant.name.text;
      const to = this.resolve(name);
      const cardinality = participant.cardinality;
      this.link('participation', id, to, {
        cardinality:
          cardinality === null
            ? null
            : cardinality.kind === 'ratio'
              ? cardinality.label
              : `(${cardinality.min},${cardinality.max})`,
        participation: participant.participation,
        role: participant.role?.text ?? null,
        aggregate: this.aggregateRelationships.get(name) === to ? `aggregate:${name}` : null,
      });
    }
  }

  /**
   * `specialize Super [disjoint|overlapping] [total|partial] { Subs }`, drawn
   * as on the course slides:
   * - with `disjoint` or `overlapping`: a circle with D or O, a line from the
   *   supertype to it (double if total) and one from it to each subtype;
   * - without, total, several subtypes: the same with a bare junction point
   *   instead of the circle (slide 48);
   * - otherwise: a line straight from the supertype to each subtype (slides
   *   46 and 54).
   * Lines toward subtypes carry the subset symbol.
   */
  private specialization(decl: SpecializeDecl): void {
    const supertype = this.resolve(decl.supertype.text);
    const subtypes = decl.subtypes.map((s) => this.resolve(s.text));
    const symbol =
      decl.disjointness === 'disjoint' ? 'D' : decl.disjointness === 'overlapping' ? 'O' : null;
    if (symbol === null && (decl.participation === 'partial' || subtypes.length < 2)) {
      for (const subtype of subtypes) this.subtypeLine(supertype, subtype, decl.participation);
      return;
    }
    const names = decl.subtypes.map((s) => s.text).join(',');
    const circle = this.circle(`spec:${decl.supertype.text}(${names})`, symbol, decl);
    this.link('specialization', supertype, circle, { participation: decl.participation });
    for (const subtype of subtypes) this.link('specialization', circle, subtype, { subset: true });
  }

  /** A line straight from a supertype to a subtype (no circle), drawn once per pair. */
  private subtypeLine(
    supertype: string,
    subtype: string,
    participation: Participation = 'partial',
  ) {
    const key = `${supertype}|${subtype}`;
    if (this.subtypeLines.has(key)) return;
    this.subtypeLines.add(key);
    this.link('specialization', supertype, subtype, { participation, subset: true });
  }

  /**
   * `category G [total|partial] { E, F }`: lines from each superclass to a U
   * circle, with the subset symbol (slide 56), and one from the circle to
   * the category (double if total).
   */
  private category(decl: CategoryDecl): void {
    const category = this.resolve(decl.name.text);
    const names = decl.superclasses.map((s) => s.text).join(',');
    const circle = this.circle(`union:${decl.name.text}(${names})`, 'U', decl);
    for (const superclass of decl.superclasses) {
      this.link('category', this.resolve(superclass.text), circle, { subset: true });
    }
    this.link('category', circle, category, { participation: decl.participation });
  }

  /** `partof Whole { Parts }`: one hexagon on the line to each part (slide 59). */
  private partOf(decl: PartOfDecl): void {
    const whole = this.resolve(decl.whole.text);
    for (const part of decl.parts) {
      const id = this.uniqueId(`partof:${decl.whole.text}/${part.text}`);
      this.connectors.push({
        kind: 'partOf',
        id,
        name: decl.label?.text ?? 'Has',
        attributes: [],
        source: decl.range,
      });
      this.link('partOf', whole, id);
      this.link('partOf', id, this.resolve(part.text));
    }
  }

  /** The box around an aggregated relationship and its participants. */
  private aggregate(decl: AggregateDecl, relationship: string | undefined): void {
    if (relationship === undefined) return; // the body did not parse
    const members = [relationship];
    for (const link of this.links) {
      if (link.from === relationship && !members.includes(link.to)) members.push(link.to);
    }
    this.aggregates.push({
      id: this.uniqueId(`aggregate:${decl.name.text}`),
      name: decl.name.text,
      relationship,
      members,
      source: decl.range,
    });
  }

  private circle(
    base: string,
    symbol: CircleNode['symbol'],
    decl: SpecializeDecl | CategoryDecl,
  ): string {
    const id = this.uniqueId(base);
    this.connectors.push({
      kind: 'circle',
      id,
      symbol,
      name: symbol ?? '',
      attributes: [],
      source: decl.range,
    });
    return id;
  }

  private link(
    kind: Link['kind'],
    from: string,
    to: string,
    style: Partial<
      Pick<Link, 'cardinality' | 'participation' | 'role' | 'subset' | 'aggregate'>
    > = {},
  ): void {
    this.links.push({
      kind,
      id: this.uniqueId(`${from}->${to}`),
      from,
      to,
      cardinality: style.cardinality ?? null,
      participation: style.participation ?? 'partial',
      role: style.role ?? null,
      subset: style.subset ?? false,
      aggregate: style.aggregate ?? null,
    });
  }

  /**
   * The node a participant name refers to: the relationship inside an
   * aggregate, a declared entity, a copy's alias, or a new entity.
   */
  private resolve(name: string): string {
    const aggregated = this.aggregateRelationships.get(name);
    if (aggregated !== undefined) return aggregated;
    if (this.entities.has(name)) return this.entities.get(name)!.id;
    const copy = this.copiesByAlias.get(name);
    if (copy) return copy.id;
    return this.entity(name).id;
  }

  /** Gets or creates the entity with this name. */
  private entity(name: string): EntityNode {
    let entity = this.entities.get(name);
    if (!entity) {
      entity = {
        kind: 'entity',
        id: this.uniqueId(`entity:${name}`),
        name,
        weak: false,
        repeated: false,
        attributes: [],
      };
      this.entities.set(name, entity);
    }
    return entity;
  }

  private names(names: Name[]): void {
    for (const name of names) {
      if (!this.copiesByAlias.has(name.text)) this.entity(name.text);
    }
  }

  private attributes(items: AttributeItem[], ownerId: string): AttributeNode[] {
    const result: AttributeNode[] = [];
    for (const item of items) {
      if (item.kind === 'attribute') {
        const id = this.uniqueId(`attr:${ownerId}/${item.name.text}`);
        result.push({
          id,
          name: item.name.text,
          key: item.key,
          multivalued: item.multivalued,
          derived: item.derived,
          children: this.attributes(item.children, id),
          keyGroup: null,
          source: item.range,
        });
      } else {
        const names = item.names.map((n) => n.text);
        const group = this.uniqueId(`keygroup:${ownerId}/${names.join(',')}`);
        for (const name of item.names) {
          result.push({
            id: this.uniqueId(`attr:${ownerId}/${name.text}`),
            name: name.text,
            key: item.key,
            multivalued: false,
            derived: false,
            children: [],
            keyGroup: group,
            source: name.range,
          });
        }
      }
    }
    return result;
  }

  /** `base`, or `base#2`, `base#3`, ... if it is already taken. */
  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}#${n}`;
    this.usedIds.add(id);
    return id;
  }
}
