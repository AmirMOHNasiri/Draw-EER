# Development

How Draw EER is built, tested and released. For using it, see the [README](../README.md).

## Repository layout

| Path              | Contents                                                                        |
| ----------------- | ------------------------------------------------------------------------------- |
| `packages/core`   | Parser, model, layout, layout file, SVG renderer and export. No DOM or VS Code. |
| `packages/vscode` | The VS Code extension: language support, live preview with dragging, export.    |
| `packages/web`    | Browser playground (planned).                                                   |

## Commands

Requires Node.js 22.12 or newer.

```sh
npm install
npm test            # run all tests
npm run lint        # ESLint
npm run typecheck   # TypeScript, strict mode
npm run format      # Prettier
npm run build       # build the extension into packages/vscode/dist
npm run render -- path/to/file.eer --png --out-dir out/renders   # export to SVG (and PNG), with its layout file
npm run bench       # layout time for every fixture and a 300-element synthetic diagram
npm run test:update-snapshots   # accept intended changes to the rendered fixtures
npm run gallery     # redraw the README's gallery (docs/images) from examples/
```

To try the extension from a clone, open the repository in VS Code and press `F5` ("Run
Extension"), which builds `packages/vscode` and opens a window with the fixtures folder.

Every fixture in `packages/core/test/fixtures` has a rendered snapshot in
`packages/core/test/snapshots/*.svg` (one SVG element per line, so diffs are readable, and the
files open as pictures). A change to layout or rendering fails the snapshot test; look at the new
pictures, then run `npm run test:update-snapshots` to accept them. Layout rule tests
(`packages/core/test/layout`) check every fixture for overlaps, lines through shapes or
attributes, straight binary relationships, and the aggregate rules.

`@draw-eer/core` is consumed straight from its TypeScript sources (its `exports` points at
`src/index.ts`); the extension bundles it with esbuild, so it has no build step of its own.

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

The layout is explained in the README, under
[How the layout works](../README.md#how-the-layout-works).

## The extension

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

## The demo animation

`npm run demo -w packages/vscode` records `docs/images/demo.gif` (it needs Chrome or Chromium,
and ffmpeg). The right half of each frame is the real preview page, as the extension ships it:
the same HTML, worker, WebAssembly and font, in headless Chrome. The left half stands in for
VS Code's editor: the text is colored by the extension's own TextMate grammar with VS Code's Dark
Modern theme, both read by `vscode-textmate`, the library VS Code itself uses (the theme comes from
the copy of VS Code the integration tests download). The script types a few characters per frame
and sends the text to the preview at the end of each line, as the extension does when typing
pauses; ffmpeg turns the screenshots into a GIF. To change what is typed, edit `TEXT` in
`packages/vscode/scripts/demo.mjs`.

## Packaging and releasing

`npm run package -w packages/vscode` makes `packages/vscode/draw-eer-<version>.vsix`: a fresh
production build (minified, without source maps), with README, CHANGELOG and LICENSE copied in
from the repository root. Everything is bundled, so no `node_modules` ship; `.vscodeignore`
decides what goes in, and `npx vsce ls` (in `packages/vscode`) lists it. Links and images in the
README point into this repository on GitHub, since the Marketplace cannot show files from the
package.

`npm run check:vsix -w packages/vscode` then installs that `.vsix` with VS Code's own command line
into an empty extensions folder and profile, in a temporary folder outside the repository, and
checks inside VS Code that the installed copy is the one running and that syntax errors,
completion, SVG and PNG export and the preview work. Nothing from the repository can stand in for
something the package lacks.

To release, update the version in `packages/vscode/package.json` and the CHANGELOG, commit, and
push a tag `v<version>`. The release workflow (`.github/workflows/release.yml`) then runs every
check, packages the extension, checks the package as above, publishes it, and attaches the
`.vsix` to a GitHub release.

- **VS Code Marketplace:** Trusted Publishing, with no stored token. GitHub gives the workflow a
  short-lived OpenID Connect token, which `vsce publish --oidc` exchanges for a Marketplace
  credential. The publisher's trusted publishing policy names the repository
  (`AmirMOHNasiri/Draw-EER`) and the workflow file (`release.yml`), with no GitHub environment;
  renaming either breaks publishing until the policy is updated. This needs `@vscode/vsce` 4.1.0
  or newer.
- **Open VSX:** an access token for the `amirmohnasiri` namespace, in the repository secret
  `OVSX_PAT`.
