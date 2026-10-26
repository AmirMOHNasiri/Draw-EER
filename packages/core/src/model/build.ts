import type { AttributeItem, Name, RelationshipDecl, SourceFile } from '../syntax/ast';
import type {
  AttributeNode,
  Diagram,
  EntityNode,
  ParticipationLink,
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
  private readonly links: ParticipationLink[] = [];
  private readonly usedIds = new Set<string>();

  build(file: SourceFile): Diagram {
    const relationshipDecls: RelationshipDecl[] = [];

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
          // Aggregates themselves are drawn in a later milestone; their
          // relationship is already drawn as a normal one.
          if (statement.relationship) relationshipDecls.push(statement.relationship);
          break;
        case 'specialize':
          this.names([statement.supertype, ...statement.subtypes]);
          break;
        case 'category':
          this.names([statement.name, ...statement.superclasses]);
          break;
        case 'partOf':
          this.names([statement.whole, ...statement.parts]);
          break;
      }
    }

    // Pass 2: relationships, creating implicit entities for unknown names.
    for (const decl of relationshipDecls) this.relationship(decl);

    // A copy's weak flag follows its original, wherever that was declared.
    for (const copy of this.copies) copy.weak = this.entities.get(copy.name)?.weak ?? false;

    return {
      nodes: [...this.entities.values(), ...this.copies, ...this.relationships],
      links: this.links,
    };
  }

  private relationship(decl: RelationshipDecl): void {
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

    for (const participant of decl.participants) {
      const entityId = this.resolve(participant.name.text);
      const cardinality = participant.cardinality;
      this.links.push({
        kind: 'participation',
        id: this.uniqueId(`${id}->${entityId}`),
        relationship: id,
        entity: entityId,
        cardinality:
          cardinality === null
            ? null
            : cardinality.kind === 'ratio'
              ? cardinality.label
              : `(${cardinality.min},${cardinality.max})`,
        participation: participant.participation,
        role: participant.role?.text ?? null,
      });
    }
  }

  /** The node a participant name refers to: a declared entity, a copy's alias, or a new entity. */
  private resolve(name: string): string {
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
