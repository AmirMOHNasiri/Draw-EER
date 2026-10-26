/**
 * Sizes used to draw diagrams, in px. Kept in one place so the look stays
 * consistent and is easy to tune.
 */
export const STYLE = {
  font: {
    family: 'Vazirmatn',
    /** Entity, relationship and attribute names. */
    size: 16,
    /** Cardinality and role labels. */
    smallSize: 15,
    lineHeight: 1.3,
    /**
     * Distance from a text line's vertical center to its baseline, in em.
     * Vazirmatn capitals and alef are about 0.7 em tall, so this centers them.
     */
    baselineShift: 0.34,
  },
  strokeWidth: 1.75,
  /** Distance between the two strokes of a double line or double outline (center to center). */
  doubleGap: 5,
  entity: { paddingX: 22, minWidth: 100, height: 46, cornerRadius: 5, repeatedLineOffset: 8 },
  relationship: { paddingX: 8, paddingY: 5, minWidth: 108, minHeight: 58, wrapWidth: 100 },
  /** `paddingY`: space above and below the text inside an ellipse. */
  attribute: { paddingX: 20, paddingY: 11, minWidth: 74, height: 44, wrapWidth: 130 },
  underline: { offset: 3, doubleSpacing: 3, dash: '4 3' },
  dash: '6 4',
  /** Space between a shape and its attributes, and between neighbouring attributes. */
  attributeGap: { fromOwner: 30, between: 10, nested: 24 },
  /** Lines to attributes of a composite key: the group line sits this far below the ellipses. */
  keyGroupLineOffset: 5,
  /**
   * Cardinality labels on lines: `position` is how far along the line (from
   * the entity) the label's center sits; `fromEntity` and `fromRelationship`
   * are the smallest gaps between the label and the two shapes.
   */
  label: { position: 0.35, fromEntity: 8, fromRelationship: 6, padding: 3, heightEm: 1 },
  /** Distance between parallel lines that join the same two shapes (three or more lines). */
  parallelSpacing: 26,
  margin: 24,
  /**
   * `gap`: smallest space between a shape or attribute and anything that
   * belongs to another shape. `minLine`: target length of every line between
   * an entity and a relationship (from outline to outline), unless its label
   * needs more: the label's width plus `labelMargin` on each side.
   * `unaryLine`: the gap between an entity and the diamond of its unary
   * relationship.
   */
  layout: { gap: 26, minLine: 56, labelMargin: 22, unaryLine: 18, componentSpacing: 60 },
} as const;
