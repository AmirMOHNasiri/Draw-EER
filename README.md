# draw-eer

Write ER/EER diagrams as text in `.eer` files and see them rendered live in VS Code, in the
classic Chen notation used in database courses (Elmasri/Navathe style). Persian (RTL) names are
fully supported.

> **Status:** early development. The parser and the renderer for basic ER diagrams are done; the
> VS Code extension is next.

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

## Repository layout

| Path              | Contents                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `packages/core`   | Parser, model, layout and SVG renderer. No DOM or VS Code dependencies. |
| `packages/vscode` | The VS Code extension (coming next).                                    |
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
```

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
4. **Layout** (`src/layout`): [ELK](https://eclipse.dev/elk/) places entities and relationships;
   attributes are arranged around their owner on the sides that relationship lines leave free.
5. **Render** (`src/render`): a custom SVG renderer draws Chen notation. Lines run straight from
   border to border, and small labels are placed where they cover no line or shape.

## License

[MIT](LICENSE)
