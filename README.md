# draw-eer

Write ER/EER diagrams as text in `.eer` files and see them rendered live in VS Code, in the
classic Chen notation used in database courses (Elmasri/Navathe style). Persian (RTL) names are
fully supported.

> **Status:** early development. The parser is done; rendering and the VS Code extension are next.

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
```

`@draw-eer/core` is consumed straight from its TypeScript sources (its `exports` points at
`src/index.ts`); the extension and playground bundle it with esbuild, so it has no build step of
its own.

## License

[MIT](LICENSE)
