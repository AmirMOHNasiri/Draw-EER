/**
 * esbuild settings shared by the build (build.mjs) and the smoke test
 * (smoke.mjs), so the smoke test checks exactly what ships. See build.mjs
 * for why harfbuzzjs needs a plugin.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dist = path.join(root, 'dist');
const production = process.argv.includes('--production');

/** The line in harfbuzzjs's entry module that loads WebAssembly on import. */
const HARFBUZZ_INIT = 'init(await createHarfBuzz());';

/** @type {import("esbuild").Plugin} */
export const harfbuzzPlugin = {
  name: 'harfbuzz-explicit-load',
  setup(build) {
    build.onLoad({ filter: /harfbuzzjs[\\/]dist[\\/]index\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      if (source.split(HARFBUZZ_INIT).length !== 2) {
        throw new Error(
          `harfbuzzjs changed: expected exactly one "${HARFBUZZ_INIT}" in ${args.path}. ` +
            'Update the harfbuzz plugin in packages/vscode/scripts/build.mjs.',
        );
      }
      return {
        contents: source.replace(
          HARFBUZZ_INIT,
          'export async function loadHarfBuzz(options) { init(await createHarfBuzz(options)); }',
        ),
        loader: 'js',
      };
    });
  },
};

/** @type {import("esbuild").BuildOptions} */
export const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  plugins: [harfbuzzPlugin],
  // Emscripten's loader is ES2020+; VS Code ships a recent Chromium and Node.
  target: 'es2022',
};

/** Settings for code that runs in the extension host (Node, CommonJS). */
export const extensionHost = {
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  // A file URL for this bundle, so Emscripten's `createRequire(import.meta.url)` works.
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: {
    js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
};

export const builds = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/extension.ts')],
    outfile: path.join(dist, 'extension.js'),
    ...extensionHost,
  },
  {
    ...common,
    entryPoints: [path.join(root, 'webview/preview.ts')],
    outfile: path.join(dist, 'preview.js'),
    platform: 'browser',
    format: 'iife',
  },
  {
    ...common,
    entryPoints: [path.join(root, 'webview/worker.ts')],
    outfile: path.join(dist, 'worker.js'),
    platform: 'browser',
    format: 'iife',
    // Not used in the browser (the .wasm bytes are passed in), only needs to be a string.
    define: { 'import.meta.url': '""' },
    // Emscripten's Node-only branch imports "module"; it never runs in a browser.
    external: ['module'],
  },
];
