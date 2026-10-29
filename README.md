# draw-eer

Write ER/EER diagrams as text in `.eer` files and see them rendered live in VS Code, in the
classic Chen notation used in database courses (Elmasri/Navathe style). Persian (RTL) names are
fully supported.

> **Status:** early development. The parser, layout and SVG renderer for basic ER diagrams and
> the VS Code extension with a live preview work; EER constructs, dragging and export are next.

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
  the color theme. Scroll to zoom around the pointer, drag to pan, double-click or `F` to fit,
  `0` for actual size. Open previews come back when VS Code restarts.

To try it from a clone: open the repository in VS Code and press `F5` ("Run Extension"), which
builds `packages/vscode` and opens a window with the fixtures folder.

**Where the work happens.** The extension host only parses (for the squiggles, Quick Fixes and
completion), which takes a few milliseconds. Layout and drawing run in a Web Worker inside the preview, so a large diagram never
blocks the editor or other extensions, and while it is busy only the newest text waits. HarfBuzz
needs care when bundled: `harfbuzzjs` loads its WebAssembly at import time with a top-level
`await`, which esbuild cannot emit for the extension host (CommonJS) or the worker. The build
replaces that one line with an explicit `loadHarfBuzz({ wasmBinary })` (see
`packages/vscode/scripts/build.mjs`), and `npm run smoke -w packages/vscode` checks that HarfBuzz
loads, as bundled, in both places. `npm run check:webview -w packages/vscode` goes further: it loads
the real preview page, with its Content Security Policy, in headless Chrome or Chromium, and checks
that it draws, loads the font, zooms, pans and fits. (It found that the worker inherits the page's
policy, which must allow `'wasm-unsafe-eval'` for HarfBuzz to compile.)

`npm run test:integration -w packages/vscode` runs `packages/vscode/test/integration` inside a real
VS Code (downloaded into `packages/vscode/.vscode-test/` on the first run; on Linux without a
display, run it under `xvfb-run -a`). It opens `.eer` files and asks for completions, Quick Fixes
and the colors of names the way the editor does. The parser's fixes, completion logic and grammar
scopes have faster unit tests that run with `npm test`.

## Repository layout

| Path              | Contents                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `packages/core`   | Parser, model, layout and SVG renderer. No DOM or VS Code dependencies. |
| `packages/vscode` | The VS Code extension: language support and the live preview.           |
| `packages/web`    | Browser playground (planned).                                           |

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm test            # run all tests
npm run lint        # ESLint
npm run typecheck   # TypeScript, strict mode
npm run format      # Prettier
npm run render -- path/to/file.eer --png --out-dir out/renders   # render to SVG (and PNG)
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

**Speed.** Layout runs again whenever the text changes, so it must be fast. Real diagrams (up to
about 40 shapes and attributes) take 3–320 ms, a 300-element synthetic diagram about 1.8 s (see
`npm run bench`). Diagrams with more than 150 shapes and attributes get a cheaper search (one
starting shape, fewer rounds). This depends only on the diagram, never on the clock, so the same
text always gives the same picture.

ELK's layered algorithm was tried first and dropped: it forces every line into one main
direction, so it cannot draw a T or put a participant above a relationship. When the automatic
result is not what you want, dragging shapes in the preview (planned) overrides it.

## License

[MIT](LICENSE)
