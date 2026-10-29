# draw-eer

Write ER/EER diagrams as text in `.eer` files and see them rendered live in VS Code, in the
classic Chen notation used in database courses (Elmasri/Navathe style). Persian (RTL) names are
fully supported.

> **Status:** early development. The parser, layout and SVG renderer for basic ER diagrams and
> the VS Code extension work: live preview, dragging, and export to SVG and PNG. EER constructs
> (specialization, categories, part-of, aggregation) are next.

```
entity Student {
  id: key
  name { first, last }
  phones: multi
}

entity Course { (code, term): key }

rel Enroll {
  Student (1,N) total
  Course (0,M)
  attrs { grade }
}
```

See [docs/language.md](docs/language.md) for the full language reference.

## The VS Code extension

- `.eer` files get syntax highlighting, bracket matching, comment toggling and completion
  (statements, attribute flags after `:`, entity names, cardinalities and participation). A name
  has the same color wherever it appears, quoted or not.
- Syntax errors show as red squiggles and in the Problems panel, with "did you mean" hints for
  misspelled or unfinished keywords (`en` → `entity`). Most errors have a Quick Fix (the light bulb,
  or `Ctrl+.`) that repairs them in one click: a misspelled keyword or flag, a missing `:`, `,` or
  `}`, a name that needs quotes, a Persian comma `،` where `,` is meant. Nothing else is checked:
  whatever parses is drawn.
- **Open Preview to the Side** (the preview button in the editor title, or `Ctrl+K V`) shows the
  diagram, redrawn as you type (after `drawEer.preview.updateDelay` ms, 300 by default). It follows
  the color theme. Scroll to zoom around the pointer, drag the background to pan, double-click or
  `F` to fit, `0` for actual size. Open previews come back when VS Code restarts.
- **Drag** a shape or an attribute in the preview to move it; a shape's attributes come along. A
  shape snaps into line with the shapes it is joined to, so its lines can be made straight again
  (hold `Alt` to place it freely); `Escape` cancels a drag. `Ctrl+Z` and `Ctrl+Shift+Z` undo and
  redo moves, and **Reset** in the preview's toolbar goes back to the automatic layout. Moves are
  saved in a layout file next to the diagram (see below).
- **Export** as SVG or PNG from the preview's toolbar, the Explorer's context menu, or the
  Command Palette (**Draw EER: Export as SVG…** / **Export as PNG…**). Exports are black on white
  whatever the color theme. The SVG embeds the font, cut down to the characters the diagram uses
  (a few KB), so Persian text looks the same on any computer; the PNG is three times the diagram's
  size (`drawEer.export.pngScale`).

### The layout file

Moves are saved in `<name>.eer.layout.json` next to `<name>.eer`, one element per line and sorted,
so it diffs well in version control; commit it with the diagram.

```json
{
  "version": 1,
  "nodes": {
    "entity:Student": { "x": 412, "y": 230 }
  },
  "attributes": {
    "attr:entity:Student/name": { "x": -150, "y": -20 }
  }
}
```

- Without a layout file, the automatic layout places everything. The first drag saves the whole
  layout as shown, so from then on **nothing moves unless you move it**: editing the text never
  moves an element that is in the file.
- A shape (`nodes`) stores its center. An attribute stores where it sits relative to its owner
  (its shape, or the composite attribute it is part of), so it moves along with the owner.
- Elements added to the text are placed around the pinned ones, which stay fixed: a new shape
  goes to the best free spot next to the shapes it is joined to (short, straight lines that cross
  nothing), further out if nothing nearby is free; new attributes go in the free angles around
  their owner; a group of new shapes joined to nothing pinned goes where it grows the drawing
  least. Nothing new ever overlaps anything, and a dragged shape cannot be dropped onto another.
  New elements are then saved to the file too.
- Elements deleted from the text are dropped from the file. This waits while the text has syntax
  errors, so an element hidden for a moment by a half-typed edit keeps its place.
- Keys are built from names, so a renamed element counts as a new one.
- **Reset** (in the preview's toolbar) deletes the file and goes back to the automatic layout;
  `Ctrl+Z` brings the file back. Changes to the file made outside the preview (by hand, or a
  `git checkout`) show up at once. A file that cannot be read gives a warning, and the automatic
  layout is used.

To try it from a clone: open the repository in VS Code and press `F5` ("Run Extension"), which
builds `packages/vscode` and opens a window with the fixtures folder.

**Where the work happens.** While you type, the extension host only parses (for the squiggles,
Quick Fixes and completion), which takes a few milliseconds. Layout and drawing run in a Web Worker
inside the preview, so a large diagram never blocks the editor or other extensions, and while it is
busy only the newest text waits. The worker keeps the automatic layout of the last text, so while
a shape is dragged each frame only applies the positions and draws. Exports run in the extension
host instead (they also work without a preview), since they happen only when asked for.

HarfBuzz needs care when bundled: `harfbuzzjs` loads its WebAssembly at import time with a
top-level `await`, which esbuild cannot emit for the extension host (CommonJS) or the worker. The
build replaces that one line with an explicit `loadHarfBuzz({ wasmBinary })` (see
`packages/vscode/scripts/build.mjs`). Exports use two more WebAssembly modules: HarfBuzz's font
subsetter (`harfbuzz-subset.wasm`, which ships with harfbuzzjs; it keeps the font's shaping rules,
so joined Persian letters still work) and resvg for PNG. resvg ignores fonts embedded with
`@font-face`, so it is given the bundled font directly; without it every label would be left out,
which the export test checks with a Persian label.

`npm run smoke -w packages/vscode` checks, as bundled, that HarfBuzz loads in the extension host
and in the worker, that exports work in the host, and that the worker applies a drag.
`npm run check:webview -w packages/vscode` goes further: it loads the real preview page, with its
Content Security Policy, in headless Chrome or Chromium, and checks that it draws, loads the font,
zooms, pans, fits, and that dragging a shape moves it, snaps and reports the new positions. (It
found that the worker inherits the page's policy, which must allow `'wasm-unsafe-eval'` for
HarfBuzz to compile.)

`npm run test:integration -w packages/vscode` runs `packages/vscode/test/integration` inside a real
VS Code (downloaded into `packages/vscode/.vscode-test/` on the first run; on Linux without a
display, run it under `xvfb-run -a`). It opens `.eer` files and asks for completions, Quick Fixes
and the colors of names the way the editor does, exports SVG and PNG, and checks the layout file
with a preview open (outside edits, reset, undo, redo). The parser's fixes, completion logic and grammar
scopes have faster unit tests that run with `npm test`.

## Repository layout

| Path              | Contents                                                                        |
| ----------------- | ------------------------------------------------------------------------------- |
| `packages/core`   | Parser, model, layout, layout file, SVG renderer and export. No DOM or VS Code. |
| `packages/vscode` | The VS Code extension: language support, live preview with dragging, export.    |
| `packages/web`    | Browser playground (planned).                                                   |

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm test            # run all tests
npm run lint        # ESLint
npm run typecheck   # TypeScript, strict mode
npm run format      # Prettier
npm run render -- path/to/file.eer --png --out-dir out/renders   # export to SVG (and PNG), with its layout file
npm run bench       # layout time for every fixture and a 300-element synthetic diagram
npm run test:update-snapshots   # accept intended changes to the rendered fixtures
```

Every fixture in `packages/core/test/fixtures` has a rendered snapshot in
`packages/core/test/snapshots/*.svg` (one SVG element per line, so diffs are readable, and the
files open as pictures). A change to layout or rendering fails the snapshot test; look at the new
pictures, then run `npm run test:update-snapshots` to accept them.

`@draw-eer/core` is consumed straight from its TypeScript sources (its `exports` points at
`src/index.ts`); the extension and playground bundle it with esbuild, so it has no build step of
its own.

## How it works

`@draw-eer/core` turns text into a drawing in five steps:

1. **Parse** (`src/syntax`): a hand-written lexer and parser produce an AST and syntax errors.
   It never throws and recovers after errors, so a half-typed file still draws.
2. **Model** (`src/model`): the AST becomes a diagram graph. Undeclared names become entities,
   duplicate entity declarations merge, and every element gets a stable id built from names.
3. **Size** (`src/layout/size.ts`): labels are measured and shapes built around them. Text is
   shaped with [HarfBuzz](https://harfbuzz.github.io/) (WebAssembly) and the bundled
   [Vazirmatn](https://github.com/rastikerdar/vazirmatn) font, so Persian letters join correctly
   and widths match Chromium to within 0.05 px on every platform.
4. **Layout** (`src/layout`): see [How the layout works](#how-the-layout-works) below.
5. **Render** (`src/render`): a custom SVG renderer draws Chen notation. Lines run straight from
   border to border; cardinality labels sit on their own line, which is broken around them; the
   two lines of a unary relationship run side by side from the entity to the diamond's two facing
   edges, far enough apart not to be mistaken for a double line.

## How the layout works

The layout is custom, tuned on textbook figures (the library diagram in
`packages/core/test/fixtures/library.eer` is the quality bar). It runs in four stages.

**1. Grid placement with costs** (`grid.ts`). Entities and relationships go into the cells of an
invisible grid, one at a time, starting from the best-connected entity. Every free cell near the
shapes already placed gets a cost, and the cheapest wins:

- horizontal and vertical lines are free, diagonals cost a little, other angles more, and longer
  lines cost per extra cell (vertical ones slightly more, so chains prefer to run left to right);
- a line through another shape, or two lines crossing, cost a lot;
- the lines leaving a shape should spread out, and at a relationship they should be opposite each
  other, so entity–relationship–entity is one straight line and a ternary relationship forms a T;
- a shape with attributes needs an open side for them;
- the drawing pays for its area and for being outside a landscape ratio (about 3:2 to 2:1),
  because diagrams end up in slides and reports. This is checked while the drawing grows, so a
  long chain folds as it is placed (a chain inside a cycle cannot be folded afterwards).

This runs from a few starting shapes and the cheapest result is kept.

**2. Folding.** The greedy result is then improved by rotating whole branches (the part of the
diagram behind a line whose removal splits it in two) by 90°, 180° or 270° around the shape they
hang from, and by turning the whole drawing. A rotation is kept if it lowers the total cost.

**3. Attribute fans** (`attributes.ts`). Each shape's attributes spread in an arc in the free
angles between its lines, centered on the nearest straight direction (up, down, left, right).
The fan tries, in order:

1. sides that face no relationship partner (35° clear of each line) and no unrelated neighbour,
   staying on its own half of every straight line, so two neighbours' fans never compete for the
   space between them and that line keeps its target length;
2. the same without the halfway limit;
3. any free side, as far out as needed.

Within a side, simple attributes may sit on an inner ring and composite ones on an outer ring
between them, which keeps a shape with many attributes compact. If a side cannot hold all its
attributes, the smallest move to the next side. Rows read left to right, or right to left when
the names are Persian or Arabic. A composite key's parts sit in one row with one line under them.
On a recursive relationship, role names sit outside the loop, next to their own line, and
attributes keep clear of them.

**4. Compaction** (`layout.ts`). Grid cells become pixel positions. Shapes joined by a straight
line share a center line, so the line stays straight; nothing else is tied together. Each axis is
then solved in turn: shapes keep their grid order and a minimum gap from everything that faces
them, and every entity–relationship line is pulled toward one target length (just enough for its
cardinality label and a margin), which gives the even look of a hand-drawn figure. Both axis
orders are tried and the one with shorter lines wins. Slanted lines keep most of their grid
slope, so they do not flatten into other shapes. Attributes are then placed again for the real
angles and compaction repeats (three rounds). Finally, any shape whose attributes ended up under
a slanted line gets them placed once more with everything else fixed.

**Hierarchies** (`tree.ts`). Specializations, categories and part-of are not placed shape by
shape. Each connected hierarchy is laid out as a tidy top-down tree (Reingold–Tilford style):
the supertype on top, the D/O circle straight below it, the subtypes in one evenly spaced row,
centered under the circle; subtrees keep clear of each other level by level. The superclasses
of a category (or the supertypes of a shared subtype) form a row above it, and each part-of
hexagon sits halfway along its line. Children follow the text, right to left when most of
their names are Persian. The tree then moves as one rigid block: the grid places it whole
(never turned) and keeps its inside free, and compaction moves its shapes together. A shape
in a tree keeps its attributes beside or below it, off the tree's lines. A relationship
between two trees prefers both entities in its own row, so its line is straight.

**Aggregates.** An aggregate is laid out first, on its own: the relationship inside, its
participants around it (nothing below it, where the line to the outer relationship leaves),
and all their attributes. Participants that also connect to the outside keep their outer side
free of attributes, and every arrangement of the participants around the diamond is tried as
a variant, so the grid can turn each one to face its outside lines. The dashed box encloses
exactly that block with even padding; compaction treats the box as an obstacle, so nothing
else can come near it, and the outer relationship goes straight below the diamond. A shape
inside an aggregate leaves its hierarchy's tree; the tree's line runs into the box to reach
it.

**Speed.** Layout runs again whenever the text changes, so it must be fast. Real diagrams (up to
about 40 shapes and attributes) take 3–320 ms, a 300-element synthetic diagram about 2 s (see
`npm run bench`). Diagrams with more than 150 shapes and attributes get a cheaper search (one
starting shape, fewer rounds). This depends only on the diagram, never on the clock, so the same
text always gives the same picture.

**With a layout file** (`incremental.ts`), the steps above run only until the first drag. After
that, pinned elements are fixed obstacles and only new elements are placed: a new shape is tried
at line-length distances in eight directions around each placed shape it is joined to, ring by
ring further out, and the cheapest spot where it and its attributes overlap nothing wins (short,
straight lines that cross no other line and run through no shape). New attributes of a pinned
owner take the nearest free spot around it. A group of new shapes joined to nothing pinned is laid
out by steps 1–4 on its own and put where the drawing grows least. A whole layout first pinned
and then edited this way takes a few milliseconds.

ELK's layered algorithm was tried first and dropped: it forces every line into one main
direction, so it cannot draw a T or put a participant above a relationship. When the automatic
result is not what you want, drag shapes in the preview; from then on they stay where you put
them.

## License

[MIT](LICENSE)
