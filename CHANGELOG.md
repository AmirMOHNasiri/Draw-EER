# Changelog

All notable changes to Draw EER are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-09

Packaging and release fixes; corrected changelog.

## [0.1.0] - 2026-11-09

The first release.

### Diagrams

- Write ER and EER diagrams as text in `.eer` files, in a small language made for it (see
  the [language reference](docs/language.md)).
- Drawn in classic Chen notation, as in database courses: entities and weak entities,
  relationships and identifying relationships, key, secondary key, partial key, composite,
  multi-valued and derived attributes, composite keys, cardinalities (`1`, `N`, `(min,max)`),
  total participation, role names and recursive relationships.
- EER constructs: specialization with D and O circles (total, partial, or neither),
  multi-level hierarchies, multiple inheritance, categories (U), part-of with the "Has"
  hexagon, aggregation in a dashed box, and repeated entities.
- Persian (right-to-left) names, mixed freely with English ones, shaped with the bundled
  Vazirmatn font.
- An automatic layout tuned on textbook figures: straight entity–relationship–entity lines,
  ternary relationships as a T, hierarchies as top-down trees, attributes fanned out where
  they do not cross anything, and a landscape drawing.

### VS Code

- Live preview beside the editor, redrawn as you type, following the color theme, with zoom,
  pan and fit.
- Drag shapes and attributes to move them; moves are saved in a `.eer.layout.json` file next
  to the diagram, and from then on nothing moves unless you move it. Undo, redo and reset.
- Export to SVG (with the font embedded, so Persian text looks the same everywhere) and PNG.
- Syntax highlighting, completion, and syntax errors with "did you mean" hints and Quick
  Fixes. There is no other checking: whatever parses is drawn.

### Known issues

- In large diagrams with cycles of relationships, the automatic layout can leave a few lines
  much longer than the rest (for example around «بستری» and «مربوط به» in a hospital
  diagram). Dragging the shapes closer fixes it, and the positions are kept. A layout search
  that moves several shapes at once is planned for 0.2.0.
- When a shape has many attributes, the line to one of them can pass very close to another.
  Dragging the attribute a little fixes it.
- An aggregation whose members belong to a specialization hierarchy that another aggregation
  also uses, or that holds more than one member of one hierarchy while also touching a second
  hierarchy, is drawn correctly but less tidily: that hierarchy is not kept symmetric.

[0.1.1]: https://github.com/AmirMOHNasiri/Draw-EER/releases/tag/v0.1.1
[0.1.0]: https://github.com/AmirMOHNasiri/Draw-EER/releases/tag/v0.1.0
