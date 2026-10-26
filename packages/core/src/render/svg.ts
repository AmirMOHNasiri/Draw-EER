import type { Point, Shape } from '../geometry/shapes';
import { add, exitPoint, normal } from '../geometry/shapes';
import {
  boxAround,
  boxesOverlap,
  segmentHitsBox,
  shapeHitsBox,
  type Box,
} from '../geometry/collide';
import type { Layout } from '../layout/layout';
import type { ElementGeometry, SizedDiagram, TextBlock } from '../layout/size';
import type { AttributeNode, EntityNode, MainNode, RelationshipNode } from '../model/types';
import type { KeyKind } from '../syntax/ast';
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
    this.participationLinks();

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
    const body =
      node.kind === 'entity' ? this.entity(node, shape, c) : this.relationship(node, shape, c);
    const labelCenter =
      node.kind === 'entity' && node.repeated
        ? { x: c.x, y: c.y + STYLE.entity.repeatedLineOffset / 2 }
        : c;
    this.shapes.push(
      `<g class="${node.kind}" data-id="${escape(node.id)}">${body}${this.text(label, labelCenter)}</g>`,
    );
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

  private attributes(attributes: AttributeNode[], parentId: string): void {
    const parent = this.position(parentId);
    const parentShape = this.geometry(parentId).shape;
    for (const attribute of attributes) {
      const c = this.position(attribute.id);
      const { shape, label } = this.geometry(attribute.id);
      this.include(c, shape);
      this.obstacles.push({ center: c, shape });
      this.addLine(exitPoint(parentShape, parent, parent, c), exitPoint(shape, c, c, parent));

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

  private participationLinks(): void {
    // Lines joining the same two shapes (a unary relationship) are spread apart.
    const pairs = new Map<string, string[]>();
    for (const link of this.sized.diagram.links) {
      const key = `${link.relationship}|${link.entity}`;
      pairs.set(key, [...(pairs.get(key) ?? []), link.id]);
    }

    // Draw every line first, so that labels can avoid all of them.
    const pending: (() => void)[] = [];
    for (const link of this.sized.diagram.links) {
      const siblings = pairs.get(`${link.relationship}|${link.entity}`)!;
      const index = siblings.indexOf(link.id);
      const offset = (index - (siblings.length - 1) / 2) * STYLE.parallelSpacing;

      const entity = this.position(link.entity);
      const rel = this.position(link.relationship);
      const entityShape = this.geometry(link.entity).shape;
      const relShape = this.geometry(link.relationship).shape;
      const n = normal(entity, rel);

      const segment = (shift: number): [Point, Point] => {
        const from = add(entity, n, offset + shift);
        const to = add(rel, n, offset + shift);
        return [exitPoint(entityShape, entity, from, to), exitPoint(relShape, rel, to, from)];
      };
      if (link.participation === 'total') {
        const half = STYLE.doubleGap / 2;
        this.addLine(...segment(-half));
        this.addLine(...segment(half));
      } else {
        this.addLine(...segment(0));
      }

      const [start, end] = segment(0);
      // Preferred side: outside of spread lines, otherwise above the line.
      const side = offset !== 0 ? Math.sign(offset) : labelSide(n);
      const away =
        STYLE.cardinality.offset + (link.participation === 'total' ? STYLE.doubleGap / 2 : 0);
      const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
      const pointAt = (distance: number) => ({
        x: start.x + ((end.x - start.x) / length) * distance,
        y: start.y + ((end.y - start.y) / length) * distance,
      });

      pending.push(() => {
        if (link.cardinality !== null) {
          // Near the entity end; further along the line or on the other side if crowded.
          const distances = [16, 26, 38, 52].filter((d) => d < length * 0.6);
          const anchors = (distances.length > 0 ? distances : [length / 3]).map(pointAt);
          this.smallLabel(link.cardinality, anchors, n, side, away);
        }
        if (link.role !== null) {
          const anchors = [0.5, 0.4, 0.6, 0.3, 0.7].map((t) => pointAt(length * t));
          this.smallLabel(link.role, anchors, n, side, away, true);
        }
      });
    }
    for (const place of pending) place();
  }

  /**
   * Places a small label beside a line, at the first candidate spot that
   * covers no line, shape or other label. Candidates are the `anchors` along
   * the line, each on the preferred side first, then on the other side.
   */
  private smallLabel(
    text: string,
    anchors: Point[],
    n: Point,
    preferredSide: number,
    away: number,
    italic = false,
  ): void {
    const size = STYLE.font.smallSize;
    const width = this.sized.measurer.width(text, { size });
    const height = size * STYLE.font.lineHeight * 0.8;
    // How far the label's center must be from its edge facing the line.
    const reach = (Math.abs(n.x) * width) / 2 + (Math.abs(n.y) * height) / 2;

    let best: { center: Point; box: Box; hits: number } | null = null;
    for (const anchor of anchors) {
      for (const side of [preferredSide, -preferredSide]) {
        const center = add(anchor, n, side * (away + reach));
        const box = boxAround(center, width, height, 1.5);
        const hits = this.collisions(box);
        if (best === null || hits < best.hits) best = { center, box, hits };
        if (hits === 0) break;
      }
      if (best?.hits === 0) break;
    }
    const { center, box } = best!;
    this.labelBoxes.push(box);
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

/** Puts labels of mostly horizontal lines above them, and of vertical lines to their right. */
function labelSide(n: Point): number {
  if (Math.abs(n.y) > 0.3) return n.y < 0 ? 1 : -1;
  return n.x > 0 ? 1 : -1;
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
  const firstStrong = /[\p{L}\p{N}]/u.exec(text)?.[0] ?? '';
  return /[֐-ࣿיִ-﷿ﹰ-\uFEFF]/u.test(firstStrong) ? ' direction="rtl"' : '';
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
