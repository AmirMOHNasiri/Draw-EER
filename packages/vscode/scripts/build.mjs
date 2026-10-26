/**
 * Builds the extension with esbuild:
 *
 * - dist/extension.js  the extension (Node, CommonJS, runs in the extension host)
 * - dist/preview.js    the preview's page script (browser)
 * - dist/worker.js     the preview's Web Worker, which runs parse → layout → SVG
 * - dist/harfbuzz.wasm and dist/fonts/*.ttf, loaded at run time
 *
 *   node scripts/build.mjs [--watch] [--production]
 *
 * harfbuzzjs needs care. Its entry module loads the WebAssembly at import
 * time with a top-level `await`, and finds the .wasm file next to itself
 * through `import.meta.url`. A bundle has neither: esbuild cannot emit
 * top-level await in CommonJS or IIFE output, and `import.meta` is empty
 * there. So the plugin below rewrites that one line into an exported
 * `loadHarfBuzz(options)` that we call ourselves with the .wasm bytes (see
 * src/harfbuzz.ts), and `import.meta.url` is given a value that makes
 * Emscripten's Node code path work.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { builds, dist, root } from './options.mjs';

const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

async function copyAssets() {
  await mkdir(path.join(dist, 'fonts'), { recursive: true });
  const fonts = path.join(path.dirname(require.resolve('@draw-eer/core')), '../assets/fonts');
  await Promise.all([
    copyFile(require.resolve('harfbuzzjs/dist/harfbuzz.wasm'), path.join(dist, 'harfbuzz.wasm')),
    copyFile(
      path.join(fonts, 'Vazirmatn-Regular.ttf'),
      path.join(dist, 'fonts/Vazirmatn-Regular.ttf'),
    ),
    copyFile(path.join(fonts, 'Vazirmatn-Bold.ttf'), path.join(dist, 'fonts/Vazirmatn-Bold.ttf')),
    copyFile(path.join(fonts, 'OFL.txt'), path.join(dist, 'fonts/OFL.txt')),
    copyFile(path.join(root, 'webview/preview.css'), path.join(dist, 'preview.css')),
  ]);
}

await mkdir(dist, { recursive: true });
await copyAssets();
if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
