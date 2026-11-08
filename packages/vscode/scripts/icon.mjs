/**
 * Draws the extension's icon (icons/icon.png, 256 px, as the Marketplace
 * wants a PNG) from its source, icons/icon.svg:
 *
 *   node scripts/icon.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { root } from './options.mjs';

const require = createRequire(import.meta.url);
await initWasm(await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
const svg = await readFile(path.join(root, 'icons/icon.svg'), 'utf8');
const image = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render();
await writeFile(path.join(root, 'icons/icon.png'), image.asPng());
console.log('wrote icons/icon.png');
