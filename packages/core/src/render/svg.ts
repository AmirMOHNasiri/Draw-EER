import type { Point, Shape } from '../geometry/shapes';
import { add, exitPoint, normal, unaryLineEnds } from '../geometry/shapes';
import {
  boxAround,
  boxesOverlap,
  segmentHitsBox,
  shapeHitsBox,
  type Box,
} from '../geometry/collide';
import type { Layout } from '../layout/layout';
import {
  hexagonSize,
  type ElementGeometry,
  type SizedDiagram,
  type TextBlock,
} from '../layout/size';
import type {
  Aggregate,
  AttributeNode,
  CircleNode,
  EntityNode,
  Link,
  MainNode,
  PartOfNode,
  RelationshipNode,
} from '../model/types';
import type { KeyKind } from '../syntax/ast';
import { isRightToLeft } from '../text/direction';
import type { FontData } from '../text/measure';
import { base64 } from './base64';
import { STYLE } from './style';

export interface Theme {
  /** Lines and outlines. */
  stroke: string;
  text: string;
  /** Inside of shapes; hides lines that pass behind them. */
  fill: string;
  /** Page background, or null for a transparent one. */
  background: string | null;
}

/** Black on white: the default for exports. */
export const LIGHT_THEME: Theme = {
  stroke: '#000000',
  text: '#000000',
  fill: '#ffffff',
  background: '#ffffff',
};

export interface RenderOptions {
  theme?: Theme;
  /**
   * Fonts to embed in the SVG, so Persian text renders correctly where
   * Vazirmatn is not installed. Leave out when the page already loads it
   * (as the preview does).
   */
  embedFont?: FontData;
}

/** Draws a laid-out diagram as an SVG document. */
export function renderSvg(
  sized: SizedDiagram,
  layout: Layout,
  options: RenderOptions = {},
): string {
  return new SvgRenderer(sized, layout, options.theme ?? LIGHT_THEME).render(options.embedFont);
}

class SvgRenderer {
  private readonly lines: string[] = [];
  private readonly shapes: string[] = [];
  private readonly labels: string[] = [];
  private readonly bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  /** Everything a label must not cover: lines, shapes and labels already placed. */
  private readonly segments: [Point, Point][] = [];
  private readonly obstacles: { center: Point; shape: Shape }[] = [];
  private readonly labelBoxes: Box[] = [];
  /** The dashed box of each aggregate, by id. */
  private readonly aggregateBoxes = new Map<string, Box>();

  constructor(
    private readonly sized: SizedDiagram,
    private readonly layout: Layout,
    private readonly theme: Theme,
  ) {}

  render(embedFont: FontData | undefined): string {
    const { diagram } = this.sized;
    for (const node of diagram.nodes) {
      this.mainNode(node);
      this.attributes(node.attributes, node.id);
    }
    for (const aggregate of diagram.aggregates) this.aggregate(aggregate);
    this.links();

    const { margin } = STYLE;
    const x = this.bounds.minX - margin;
    const y = this.bounds.minY - margin;
    const width = this.bounds.maxX - this.bounds.minX + 2 * margin;
    const height = this.bounds.maxY - this.bounds.minY + 2 * margin;
    const empty = !Number.isFinite(width);
    const viewBox = empty ? '0 0 100 100' : `${f(x)} ${f(y)} ${f(width)} ${f(height)}`;

    const t = this.theme;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${empty ? 100 : f(width)}" height="${empty ? 100 : f(height)}">`,
      `<style>${embedFont ? fontFaces(embedFont) : ''}`,
      `text { font-family: '${STYLE.font.family}', sans-serif; fill: ${t.text}; }`,
      `.line { stroke: ${t.stroke}; stroke-width: ${STYLE.strokeWidth}; fill: none; }`,
      `.shape { stroke: ${t.stroke}; stroke-width: ${STYLE.strokeWidth}; fill: ${t.fill}; }`,
      `.outline { stroke: ${t.stroke}; stroke-width: ${STYLE.strokeWidth}; fill: none; }`,
      `.dashed { stroke-dasharray: ${STYLE.dash}; }`,
      `.knockout { fill: ${t.background ?? t.fill}; stroke: none; }`,
      `</style>`,
      t.background && !empty
        ? `<rect x="${f(x)}" y="${f(y)}" width="${f(width)}" height="${f(height)}" fill="${t.background}"/>`
        : '',
      `<g class="lines">${this.lines.join('')}</g>`,
      `<g class="shapes">${this.shapes.join('')}</g>`,
      `<g class="labels">${this.labels.join('')}</g>`,
      `</svg>`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // Shapes
  // -------------------------------------------------------------------------

  private mainNode(node: MainNode): void {
    const { shape, label } = this.geometry(node.id);
    const c = this.position(node.id);
    this.include(c, shape);
    this.obstacles.push({ center: c, shape });
    let body: string;
    switch (node.kind) {
      case 'entity': {
        const labelCenter = node.repeated
          ? { x: c.x, y: c.y + STYLE.entity.repeatedLineOffset / 2 }
          : c;
        body = this.entity(node, shape, c) + this.text(label, labelCenter);
        break;
      }
      case 'relationship':
        body = this.relationship(node, shape, c) + this.text(label, c);
        break;
      case 'circle':
        body = this.circle(node, shape, c, label);
        break;
      case 'partOf':
        body = this.hexagon(node, c, label);
        break;
    }
    this.shapes.push(`<g class="${node.kind}" data-id="${escape(node.id)}">${body}</g>`);
  }

  private entity(node: EntityNode, shape: Shape, c: Point): string {
    const r = STYLE.entity.cornerRadius;
    let svg = rect(c, shape.width, shape.height, r, 'shape');
    if (node.weak) {
      const g = 2 * STYLE.doubleGap;
      svg += rect(c, shape.width - g, shape.height - g, Math.max(r - 2, 1), 'outline');
    }
    if (node.repeated) {
      // The repeated-entity mark: a line across, near the top edge.
      const y = c.y - shape.height / 2 + STYLE.entity.repeatedLineOffset;
      svg += line({ x: c.x - shape.width / 2, y }, { x: c.x + shape.width / 2, y });
    }
    return svg;
  }

  private relationship(node: RelationshipNode, shape: Shape, c: Point): string {
    const a = shape.width / 2;
    const b = shape.height / 2;
    let svg = diamond(c, a, b, 'shape');
    if (node.identifying) {
      // A similar diamond whose edges are `doubleGap` inside the outer ones.
      const scale = 1 - (STYLE.doubleGap * Math.hypot(a, b)) / (a * b);
      svg += diamond(c, a * scale, b * scale, 'outline');
    }
    return svg;
  }

  /** A D, O or U circle; a junction point draws nothing but can still be grabbed. */
  private circle(node: CircleNode, shape: Shape, c: Point, label: TextBlock): string {
    const r = shape.width / 2;
    if (node.symbol === null) {
      return `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(r)}" fill="transparent"/>`;
    }
    return ellipse(c, r, r, 'shape') + this.text(label, c);
  }

  /**
   * The part-of hexagon, turned to lie along the line from the whole to the
   * part, with its label along it (never upside down).
   */
  private hexagon(node: PartOfNode, c: Point, label: TextBlock): string {
    const { length, height } = hexagonSize(label);
    const whole = this.sized.diagram.links.find((l) => l.to === node.id);
    const part = this.sized.diagram.links.find((l) => l.from === node.id);
    let angle = 0;
    if (whole && part) {
      const a = this.position(whole.from);
      const b = this.position(part.to);
      angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    }
    // Text reads left to right (or right to left) the right way up.
    if (angle > 90) angle -= 180;
    if (angle <= -90) angle += 180;
    const half = length / 2;
    const side = half - STYLE.partOf.tip;
    const corners = [
      [-half, 0],
      [-side, -height / 2],
      [side, -height / 2],
      [half, 0],
      [side, height / 2],
      [-side, height / 2],
    ];
    const points = corners.map(([x, y]) => `${f(c.x + x!)},${f(c.y + y!)}`).join(' ');
    return (
      `<g transform="rotate(${f(angle)} ${f(c.x)} ${f(c.y)})">` +
      `<polygon class="shape" points="${points}"/>${this.text(label, c)}</g>`
    );
  }

  /**
   * The dashed box around an aggregate: around the relationship inside,
   * its participants and all their attributes.
   */
  private aggregate(aggregate: Aggregate): void {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    // Measured as the layout measures it: below an attribute, room for a key group's line.
    const add = (id: string, below = 0) => {
      const c = this.position(id);
      const { width, height } = this.geometry(id).shape;
      box.minX = Math.min(box.minX, c.x - width / 2);
      box.maxX = Math.max(box.maxX, c.x + width / 2);
      box.minY = Math.min(box.minY, c.y - height / 2);
      box.maxY = Math.max(box.maxY, c.y + height / 2 + below);
    };
    const visit = (attributes: AttributeNode[]) => {
      for (const a of attributes) {
        add(a.id, STYLE.keyGroupLineOffset);
        visit(a.children);
      }
    };
    const nodes = new Map(this.sized.diagram.nodes.map((n) => [n.id, n]));
    for (const id of aggregate.members) {
      add(id);
      visit(nodes.get(id)?.attributes ?? []);
    }
    // The same box the layout kept clear (see `aggregateBlocks` in layout.ts).
    const { padding, cornerRadius } = STYLE.aggregate;
    const padded = {
      minX: box.minX - padding,
      minY: box.minY - padding,
      maxX: box.maxX + padding,
      maxY: box.maxY + padding,
    };
    this.aggregateBoxes.set(aggregate.id, padded);
    const center = { x: (padded.minX + padded.maxX) / 2, y: (padded.minY + padded.maxY) / 2 };
    const width = padded.maxX - padded.minX;
    const height = padded.maxY - padded.minY;
    this.includeBox(center, width, height);
    this.lines.push(
      `<g class="aggregate" data-id="${escape(aggregate.id)}">${rect(center, width, height, cornerRadius, 'outline dashed')}</g>`,
    );
  }

  private attributes(attributes: AttributeNode[], parentId: string): void {
    const parent = this.position(parentId);
    const parentShape = this.geometry(parentId).shape;
    for (const attribute of attributes) {
      const c = this.position(attribute.id);
      const { shape, label } = this.geometry(attribute.id);
      this.include(c, shape);
      this.obstacles.push({ center: c, shape });
      const start = attributeLineStart(parentShape, parent, c);
      this.addLine(start, exitPoint(shape, c, c, start));

      const rx = shape.width / 2;
      const ry = shape.height / 2;
      let body = ellipse(c, rx, ry, attribute.derived ? 'shape dashed' : 'shape');
      if (attribute.multivalued) {
        const g = STYLE.doubleGap;
        body += ellipse(c, rx - g, ry - g, 'outline');
      }
      body += this.text(label, c, attribute.key);
      this.shapes.push(`<g class="attribute" data-id="${escape(attribute.id)}">${body}</g>`);
      this.attributes(attribute.children, attribute.id);
    }
    this.keyGroupLines(attributes);
  }

  /** One line under all the attributes of a composite key. */
  private keyGroupLines(attributes: AttributeNode[]): void {
    const groups = new Map<string, AttributeNode[]>();
    for (const a of attributes) {
      if (a.keyGroup !== null) groups.set(a.keyGroup, [...(groups.get(a.keyGroup) ?? []), a]);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      let left = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const member of members) {
        const c = this.position(member.id);
        const { width, height } = this.geometry(member.id).shape;
        left = Math.min(left, c.x - width * 0.4);
        right = Math.max(right, c.x + width * 0.4);
        bottom = Math.max(bottom, c.y + height / 2 + STYLE.keyGroupLineOffset);
      }
      const dashed = members[0]!.key === 'partial';
      this.segments.push([
        { x: left, y: bottom },
        { x: right, y: bottom },
      ]);
      this.labels.push(line({ x: left, y: bottom }, { x: right, y: bottom }, dashed));
    }
  }

  // -------------------------------------------------------------------------
  // Relationship lines
  // -------------------------------------------------------------------------

  private links(): void {
    // Group the lines that join the same two shapes.
    const pairs = new Map<string, Link[]>();
    for (const link of this.sized.diagram.links) {
      const key = `${link.from}|${link.to}`;
      pairs.set(key, [...(pairs.get(key) ?? []), link]);
    }

    // Draw every line first, so that labels placed afterwards can avoid them.
    const pending: (() => void)[] = [];
    for (const links of pairs.values()) {
      const first = links[0]!;
      const segments =
        links.length === 2
          ? this.unarySegments(first.to, first.from)
          : links.map((_, i) =>
              this.straightSegment(
                first.to,
                first.from,
                (i - (links.length - 1) / 2) * STYLE.parallelSpacing,
              ),
            );

      links.forEach((link, i) => {
        const [start, end] = segments[i]!;
        if (link.participation === 'total') {
          const n = normal(start, end);
          const half = STYLE.doubleGap / 2;
          for (const side of [-half, half]) {
            this.addLine(...this.clipped(link, add(start, n, side), add(end, n, side)));
          }
        } else if (link.aggregate !== null) {
          this.aggregateLine(start, end, this.aggregateBoxes.get(link.aggregate));
        } else {
          this.addLine(start, end);
        }
        if (link.subset) this.subsetArc(...this.outsideBoxes(start, end));
        // On a unary loop, a role name goes outside the loop, away from the other line.
        const other = links.length === 2 ? segments[1 - i]! : null;
        pending.push(() => {
          if (link.cardinality !== null) this.cardinalityLabel(link.cardinality, start, end, link);
          if (link.role !== null) this.roleLabel(link.role, start, end, other);
        });
      });
    }
    for (const place of pending) place();
  }

  /**
   * A straight line between the two shapes' borders, shifted sideways by
   * `offset`. Lines run all the way to a junction point, so they meet there.
   */
  private straightSegment(entityId: string, relId: string, offset: number): [Point, Point] {
    const entity = this.position(entityId);
    const rel = this.position(relId);
    const n = normal(entity, rel);
    const from = add(entity, n, offset);
    const to = add(rel, n, offset);
    return [
      this.isJunction(entityId) ? from : exitPoint(this.geometry(entityId).shape, entity, from, to),
      this.isJunction(relId) ? to : exitPoint(this.geometry(relId).shape, rel, to, from),
    ];
  }

  private isJunction(id: string): boolean {
    const node = this.sized.diagram.nodes.find((n) => n.id === id);
    return node?.kind === 'circle' && node.symbol === null;
  }

  /**
   * The subset symbol: a half circle across the middle of the line, open
   * toward `end` (the more general side) and curving toward `start`.
   */
  private subsetArc(start: Point, end: Point): void {
    const r = STYLE.subset.radius;
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const n = normal(start, end);
    const d = unit(end, start);
    const p = add(middle, n, r);
    const q = add(middle, n, -r);
    // Sweep so that the arc passes through middle + d·r (screen y points down).
    const sweep = n.x * d.y - n.y * d.x > 0 ? 1 : 0;
    this.segments.push([p, q]);
    this.lines.push(
      `<path class="line" d="M${f(p.x)},${f(p.y)} A${r},${r} 0 0 ${sweep} ${f(q.x)},${f(q.y)}"/>`,
    );
  }

  /**
   * The part of a line outside every aggregate box (a line that comes from
   * outside into a box, or the whole line), so that a subset symbol in its
   * middle does not land on a box's border.
   */
  private outsideBoxes(start: Point, end: Point): [Point, Point] {
    let [s, e] = [start, end];
    for (const box of this.aggregateBoxes.values()) {
      if (inBox(box, s) && !inBox(box, e))
        s = add(s, { x: e.x - s.x, y: e.y - s.y }, boxExit(box, s, e));
      if (inBox(box, e) && !inBox(box, s))
        e = add(e, { x: s.x - e.x, y: s.y - e.y }, boxExit(box, e, s));
    }
    return [s, e];
  }

  /**
   * A line into an aggregate, from the relationship inside (`start`): dashed
   * inside the aggregate's box, solid outside (slides 61 and 62).
   */
  private aggregateLine(start: Point, end: Point, box: Box | undefined): void {
    const d = { x: end.x - start.x, y: end.y - start.y };
    const t = box ? boxExit(box, start, end) : 1;
    const exit = add(start, d, t);
    this.segments.push([start, end]);
    this.lines.push(
      `<line class="line dashed" x1="${f(start.x)}" y1="${f(start.y)}" x2="${f(exit.x)}" y2="${f(exit.y)}"/>`,
    );
    if (t < 1) this.lines.push(line(exit, end));
  }

  /** The two lines of a unary (recursive) relationship (see `unaryLineEnds`). */
  private unarySegments(entityId: string, relId: string): [Point, Point][] {
    return unaryLineEnds(
      this.geometry(entityId).shape,
      this.position(entityId),
      this.geometry(relId).shape,
      this.position(relId),
    );
  }

  /**
   * Clips one stroke of a double line to the two shapes. Each end first
   * steps back a little into its shape, so strokes that end at a diamond's
   * corner still reach the outline.
   */
  private clipped(link: Link, start: Point, end: Point): [Point, Point] {
    const entity = this.position(link.to);
    const rel = this.position(link.from);
    const from = add(start, unit(start, end), -6);
    const to = add(end, unit(end, start), -6);
    return [
      this.isJunction(link.to) ? start : exitPoint(this.geometry(link.to).shape, entity, from, end),
      this.isJunction(link.from) ? end : exitPoint(this.geometry(link.from).shape, rel, to, start),
    ];
  }

  /**
   * A cardinality label sits on its own line, about a third of the way from
   * the entity, with the line broken around it. On a line too short for
   * that, it goes beside the line, always on the left of the direction from
   * entity to relationship.
   */
  private cardinalityLabel(text: string, start: Point, end: Point, link: Link): void {
    const size = STYLE.font.smallSize;
    const width = this.sized.measurer.width(text, { size });
    const height = size * STYLE.label.heightEm;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const d = unit(start, end);
    const pad = STYLE.label.padding;
    // Half the label's size measured along the line.
    const along =
      (Math.abs(d.x) * (width + 2 * pad)) / 2 + (Math.abs(d.y) * (height + 2 * pad)) / 2;
    const t = Math.max(length * STYLE.label.position, STYLE.label.fromEntity + along);

    if (t + along <= length - STYLE.label.fromRelationship) {
      this.knockoutLabel(text, add(start, d, t), width, height);
      return;
    }
    const left = { x: d.y, y: -d.x };
    const across = (Math.abs(left.x) * width) / 2 + (Math.abs(left.y) * height) / 2;
    const away = across + 4 + (link.participation === 'total' ? STYLE.doubleGap / 2 : 0);
    const center = add(add(start, d, Math.min(length / 2, Math.max(t, 0))), left, away);
    this.plainLabel(text, center, width, height);
  }

  /**
   * A role name beside its line, past the middle toward the relationship,
   * wherever it fits. On a unary loop (`other` is the loop's other line) it
   * always goes on the outer side, next to its own line: inside the loop it
   * would be ambiguous which line it names. If that side is busy, it moves
   * along the line and then a little further out, but never inside.
   */
  private roleLabel(text: string, start: Point, end: Point, other: [Point, Point] | null): void {
    const size = STYLE.font.smallSize;
    const width = this.sized.measurer.width(text, { size });
    const height = size * STYLE.label.heightEm;
    const d = unit(start, end);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const left = { x: d.y, y: -d.x };
    const across = (Math.abs(left.x) * width) / 2 + (Math.abs(left.y) * height) / 2 + 5;

    let sides = [1, -1];
    let extra = [0];
    if (other) {
      const middle = { x: (other[0].x + other[1].x) / 2, y: (other[0].y + other[1].y) / 2 };
      const towardOther = (middle.x - start.x) * left.x + (middle.y - start.y) * left.y;
      sides = [towardOther > 0 ? -1 : 1];
      extra = [0, 8, 16, 28];
    }
    let best: { center: Point; hits: number } | null = null;
    for (const out of extra) {
      for (const t of other ? [0.6, 0.5, 0.7, 0.4, 0.8, 0.3, 0.2] : [0.6, 0.5, 0.7, 0.4, 0.8]) {
        for (const side of sides) {
          const center = add(add(start, d, length * t), left, side * (across + out));
          const hits = this.collisions(boxAround(center, width, height, 1.5));
          if (best === null || hits < best.hits) best = { center, hits };
        }
        if (best?.hits === 0) break;
      }
      if (best?.hits === 0) break;
    }
    this.plainLabel(text, best!.center, width, height, true);
  }

  /** A label with a background patch that breaks the line under it. */
  private knockoutLabel(text: string, center: Point, width: number, height: number): void {
    const pad = STYLE.label.padding;
    const w = width + 2 * pad;
    const h = height + 2 * pad;
    this.labels.push(
      `<rect class="knockout" x="${f(center.x - w / 2)}" y="${f(center.y - h / 2)}" width="${f(w)}" height="${f(h)}"/>`,
    );
    this.plainLabel(text, center, width, height);
  }

  private plainLabel(
    text: string,
    center: Point,
    width: number,
    height: number,
    italic = false,
  ): void {
    const size = STYLE.font.smallSize;
    this.labelBoxes.push(boxAround(center, width, height, 1.5));
    this.includeBox(center, width, height);
    const baseline = center.y + STYLE.font.baselineShift * size;
    this.labels.push(
      `<text x="${f(center.x)}" y="${f(baseline)}" font-size="${size}" text-anchor="middle"${italic ? ' font-style="italic"' : ''}${direction(text)}>${escape(text)}</text>`,
    );
  }

  private collisions(box: Box): number {
    let hits = 0;
    for (const [a, b] of this.segments) if (segmentHitsBox(a, b, box)) hits++;
    for (const o of this.obstacles) if (shapeHitsBox(o.shape, o.center, box)) hits++;
    for (const other of this.labelBoxes) if (boxesOverlap(other, box)) hits++;
    return hits;
  }

  private addLine(a: Point, b: Point): void {
    this.segments.push([a, b]);
    this.lines.push(line(a, b));
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  /** A centered, possibly multi-line label with optional key underlines. */
  private text(block: TextBlock, c: Point, key: KeyKind | null = null): string {
    const { size, bold } = block.style;
    const lineHeight = size * STYLE.font.lineHeight;
    let svg = '';
    block.lines.forEach((text, i) => {
      const middle = c.y + (i - (block.lines.length - 1) / 2) * lineHeight;
      const baseline = middle + STYLE.font.baselineShift * size;
      svg += `<text x="${f(c.x)}" y="${f(baseline)}" font-size="${size}"${bold ? ' font-weight="bold"' : ''} text-anchor="middle"${direction(text)}>${escape(text)}</text>`;
      if (key !== null)
        svg += underline(c.x, baseline, this.sized.measurer.width(text, block.style), key);
    });
    return svg;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private position(id: string): Point {
    const p = this.layout.get(id);
    if (!p) throw new Error(`No position for ${id}`);
    return p;
  }

  private geometry(id: string): ElementGeometry {
    return this.sized.geometry.get(id)!;
  }

  private include(c: Point, shape: Shape): void {
    this.includeBox(c, shape.width, shape.height + STYLE.keyGroupLineOffset * 2);
  }

  private includeBox(c: Point, width: number, height: number): void {
    this.bounds.minX = Math.min(this.bounds.minX, c.x - width / 2);
    this.bounds.maxX = Math.max(this.bounds.maxX, c.x + width / 2);
    this.bounds.minY = Math.min(this.bounds.minY, c.y - height / 2);
    this.bounds.maxY = Math.max(this.bounds.maxY, c.y + height / 2);
  }
}

function inBox(box: Box, p: Point): boolean {
  return p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY;
}

/**
 * How far along the segment from `from` (inside the box) to `to` it leaves
 * the box, from 0 to 1 (1 if it never does).
 */
function boxExit(box: Box, from: Point, to: Point): number {
  const d = { x: to.x - from.x, y: to.y - from.y };
  let t = 1;
  if (d.x > 0) t = Math.min(t, (box.maxX - from.x) / d.x);
  if (d.x < 0) t = Math.min(t, (box.minX - from.x) / d.x);
  if (d.y > 0) t = Math.min(t, (box.maxY - from.y) / d.y);
  if (d.y < 0) t = Math.min(t, (box.minY - from.y) / d.y);
  return Math.max(0, t);
}

/** Within this angle of a diamond's vertex, an attribute's line starts at the vertex. */
const VERTEX_SNAP = (20 * Math.PI) / 180;

/**
 * Where the line to an attribute at `to` leaves its owner. On a diamond, an
 * attribute roughly in the direction of a vertex is joined to the vertex
 * itself, as on the slides; anywhere else the line points at the center.
 */
function attributeLineStart(shape: Shape, center: Point, to: Point): Point {
  if (shape.kind === 'diamond') {
    const angle = Math.atan2(to.y - center.y, to.x - center.x);
    const a = shape.width / 2;
    const b = shape.height / 2;
    for (const [direction, vertex] of [
      [0, { x: center.x + a, y: center.y }],
      [Math.PI / 2, { x: center.x, y: center.y + b }],
      [Math.PI, { x: center.x - a, y: center.y }],
      [-Math.PI / 2, { x: center.x, y: center.y - b }],
    ] as const) {
      const off = Math.abs(Math.atan2(Math.sin(angle - direction), Math.cos(angle - direction)));
      if (off <= VERTEX_SNAP) return vertex;
    }
  }
  return exitPoint(shape, center, center, to);
}

/** Unit vector from `a` toward `b`. */
function unit(a: Point, b: Point): Point {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

function underline(cx: number, baseline: number, width: number, key: KeyKind): string {
  const { offset, doubleSpacing } = STYLE.underline;
  const y = baseline + offset;
  const from = { x: cx - width / 2, y };
  const to = { x: cx + width / 2, y };
  switch (key) {
    case 'primary':
      return line(from, to, false, 1);
    case 'secondary':
      return (
        line(from, to, false, 1) +
        line({ ...from, y: y + doubleSpacing }, { ...to, y: y + doubleSpacing }, false, 1)
      );
    case 'partial':
      return line(from, to, true, 1);
  }
}

function line(a: Point, b: Point, dashed = false, width?: number): string {
  const style = width !== undefined ? ` stroke-width="${width}"` : '';
  const dash = dashed ? ` stroke-dasharray="${STYLE.underline.dash}"` : '';
  return `<line class="line" x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}"${style}${dash}/>`;
}

function rect(c: Point, width: number, height: number, radius: number, cls: string): string {
  return `<rect class="${cls}" x="${f(c.x - width / 2)}" y="${f(c.y - height / 2)}" width="${f(width)}" height="${f(height)}" rx="${radius}"/>`;
}

function diamond(c: Point, a: number, b: number, cls: string): string {
  const points = [
    [c.x, c.y - b],
    [c.x + a, c.y],
    [c.x, c.y + b],
    [c.x - a, c.y],
  ];
  return `<polygon class="${cls}" points="${points.map(([x, y]) => `${f(x!)},${f(y!)}`).join(' ')}"/>`;
}

function ellipse(c: Point, rx: number, ry: number, cls: string): string {
  return `<ellipse class="${cls}" cx="${f(c.x)}" cy="${f(c.y)}" rx="${f(rx)}" ry="${f(ry)}"/>`;
}

/** Right-to-left text gets `direction="rtl"` so neutral characters order correctly. */
function direction(text: string): string {
  return isRightToLeft(text) ? ' direction="rtl"' : '';
}

function fontFaces(fonts: FontData): string {
  const face = (data: Uint8Array, weight: number) =>
    `@font-face { font-family: '${STYLE.font.family}'; font-weight: ${weight}; src: url(data:font/ttf;base64,${base64(data)}) format('truetype'); }`;
  return face(fonts.regular, 400) + face(fonts.bold, 700);
}

/** Rounds to 2 decimals to keep the SVG small. */
function f(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
