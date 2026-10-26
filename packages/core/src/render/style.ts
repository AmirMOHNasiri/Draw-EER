/**
 * Sizes used to draw diagrams, in px. Kept in one place so the look stays
 * consistent and is easy to tune.
 */
export const STYLE = {
  font: {
    family: 'Vazirmatn',
    /** Entity, relationship and attribute names. */
    size: 14,
    /** Cardinality and role labels. */
    smallSize: 13,
    lineHeight: 1.3,
    /**
     * Distance from a text line's vertical center to its baseline, in em.
     * Vazirmatn capitals and alef are about 0.7 em tall, so this centers them.
     */
    baselineShift: 0.34,
  },
  strokeWidth: 1.5,
  /** Distance between the two strokes of a double line or double outline (center to center). */
  doubleGap: 4.5,
  entity: { paddingX: 18, minWidth: 84, height: 40, cornerRadius: 5, repeatedLineOffset: 7 },
  relationship: { paddingX: 6, paddingY: 4, minWidth: 96, minHeight: 50, wrapWidth: 90 },
  attribute: { paddingX: 14, minWidth: 60, height: 32, wrapWidth: 120 },
  underline: { offset: 3, doubleSpacing: 3, dash: '4 3' },
  dash: '6 4',
  /** Space between a shape and its attributes, and between neighbouring attributes. */
  attributeGap: { fromOwner: 34, between: 10, nested: 26 },
  /** Lines to attributes of a composite key: the group line sits this far below the ellipses. */
  keyGroupLineOffset: 5,
  cardinality: { alongLine: 16, offset: 9 },
  /** Distance between parallel lines that join the same two shapes (unary relationships). */
  parallelSpacing: 26,
  margin: 24,
  layout: { nodeSpacing: 36, layerSpacing: 56, componentSpacing: 48 },
} as const;
