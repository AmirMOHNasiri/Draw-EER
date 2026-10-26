/**
 * Bundled like the extension (see smoke.mjs) and run with Node: proves that
 * HarfBuzz loads in the extension host the way the extension will load it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderDiagram } from '@draw-eer/core';
import { createMeasurer } from '../src/harfbuzz';

async function main() {
  const dist = process.argv[2]!;
  const measurer = await createMeasurer(readFileSync(path.join(dist, 'harfbuzz.wasm')), {
    regular: readFileSync(path.join(dist, 'fonts/Vazirmatn-Regular.ttf')),
    bold: readFileSync(path.join(dist, 'fonts/Vazirmatn-Bold.ttf')),
  });
  const width = measurer.width('دانشجو', { size: 16 });
  const { svg } = renderDiagram('entity دانشجو { نام }', measurer);
  console.log(JSON.stringify({ width, svg: svg.length, persian: svg.includes('دانشجو') }));
}

// No top-level await: like the extension, this is CommonJS.
void main();
