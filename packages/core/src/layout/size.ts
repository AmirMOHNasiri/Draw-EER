import type { Shape } from '../geometry/shapes';
import type { AttributeNode, Diagram, MainNode } from '../model/types';
import { STYLE } from '../render/style';
import type { TextMeasurer, TextStyle } from '../text/measure';

/** A label split into lines and measured. */
export interface TextBlock {
  lines: string[];
  width: number;
  height: number;
  style: TextStyle;
}

export interface ElementGeometry {
  /** The outermost outline, centered at (0, 0). */
  shape: Shape;
  label: TextBlock;
}

export interface SizedDiagram {
  diagram: Diagram;
  /** Shape and label of every node and attribute, by id. */
  geometry: Map<string, ElementGeometry>;
  measurer: TextMeasurer;
}

/** Measures every label and builds the shape around it. */
export function sizeDiagram(diagram: Diagram, measurer: TextMeasurer): SizedDiagram {
  const geometry = new Map<string, ElementGeometry>();
  const visitAttributes = (attributes: AttributeNode[]) => {
    for (const attribute of attributes) {
      geometry.set(attribute.id, attributeGeometry(attribute, measurer));
      visitAttributes(attribute.children);
    }
  };
  for (const node of diagram.nodes) {
    geometry.set(node.id, nodeGeometry(node, measurer));
    visitAttributes(node.attributes);
  }
  return { diagram, geometry, measurer };
}

function nodeGeometry(node: MainNode, measurer: TextMeasurer): ElementGeometry {
  const gap = STYLE.doubleGap;
  const style: TextStyle = { size: STYLE.font.size, bold: true };

  if (node.kind === 'entity') {
    const { paddingX, minWidth, height, repeatedLineOffset } = STYLE.entity;
    const label = textBlock(node.name, style, measurer);
    const extra = node.weak ? 2 * gap : 0;
    return {
      label,
      shape: {
        kind: 'rect',
        width: Math.max(minWidth, label.width + 2 * paddingX) + extra,
        height: height + extra + (node.repeated ? repeatedLineOffset : 0),
      },
    };
  }

  // A diamond with half-diagonals a and b contains the text box (w, h) when
  // (w/2)/a + (h/2)/b <= 1; a = w and b = h is the balanced choice.
  const { paddingX, paddingY, minWidth, minHeight, wrapWidth } = STYLE.relationship;
  const label = textBlock(node.name, style, measurer, wrapWidth);
  let a = Math.max(minWidth / 2, label.width + 2 * paddingX);
  let b = Math.max(minHeight / 2, label.height + 2 * paddingY);
  if (node.identifying) {
    // Grow the outline outward by `gap`, measured perpendicular to the edges.
    const edge = Math.hypot(a, b);
    [a, b] = [a + (gap * edge) / b, b + (gap * edge) / a];
  }
  return { label, shape: { kind: 'diamond', width: 2 * a, height: 2 * b } };
}

function attributeGeometry(attribute: AttributeNode, measurer: TextMeasurer): ElementGeometry {
  const { paddingX, paddingY, minWidth, height, wrapWidth } = STYLE.attribute;
  const label = textBlock(attribute.name, { size: STYLE.font.size }, measurer, wrapWidth);
  const extra = attribute.multivalued ? 2 * STYLE.doubleGap : 0;
  // An ellipse needs some room beyond the text width, or the text's
  // corners poke out of the curved sides.
  const width = Math.max(minWidth, label.width * 1.1 + 2 * paddingX);
  const ellipseHeight = Math.max(height, label.height + 2 * paddingY);
  return {
    label,
    shape: { kind: 'ellipse', width: width + extra, height: ellipseHeight + extra },
  };
}

/**
 * Measures a label. If `wrapWidth` is given and the text is wider, it is
 * split into two lines at the space that balances them best (like «ارائه
 * می‌شود» or «منبع اصلی» in two lines inside a diamond).
 */
export function textBlock(
  text: string,
  style: TextStyle,
  measurer: TextMeasurer,
  wrapWidth?: number,
): TextBlock {
  const lineHeight = style.size * STYLE.font.lineHeight;
  const single = measurer.width(text, style);
  let lines = [text];
  let width = single;

  if (wrapWidth !== undefined && single > wrapWidth) {
    for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) {
      const first = text.slice(0, i).trim();
      const second = text.slice(i + 1).trim();
      if (!first || !second) continue;
      const widest = Math.max(measurer.width(first, style), measurer.width(second, style));
      if (widest < width) {
        lines = [first, second];
        width = widest;
      }
    }
  }
  return { lines, width, height: lines.length * lineHeight, style };
}
