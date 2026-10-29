/**
 * Bundled like the extension (see smoke.mjs) and run with Node: proves that
 * HarfBuzz loads in the extension host the way the extension will load it,
 * and that exports work there: font subsetting and resvg for PNG.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildDiagram,
  createSubsetter,
  exportSvg,
  layoutDiagram,
  parse,
  renderDiagram,
  renderPng,
  sizeDiagram,
} from '@draw-eer/core';
import { createMeasurer } from '../src/harfbuzz';

async function main() {
  const dist = process.argv[2]!;
  const measurer = await createMeasurer(readFileSync(path.join(dist, 'harfbuzz.wasm')), {
    regular: readFileSync(path.join(dist, 'fonts/Vazirmatn-Regular.ttf')),
    bold: readFileSync(path.join(dist, 'fonts/Vazirmatn-Bold.ttf')),
  });
  const width = measurer.width('دانشجو', { size: 16 });
  const { svg } = renderDiagram('entity دانشجو { نام }', measurer);

  // Export, the way export.ts does it.
  const fonts = {
    regular: readFileSync(path.join(dist, 'fonts/Vazirmatn-Regular.ttf')),
    bold: readFileSync(path.join(dist, 'fonts/Vazirmatn-Bold.ttf')),
  };
  const subsetter = await createSubsetter(readFileSync(path.join(dist, 'harfbuzz-subset.wasm')));
  const sized = sizeDiagram(buildDiagram(parse('entity دانشجو { نام }').file), measurer);
  const exported = exportSvg(sized, layoutDiagram(sized), fonts, subsetter);
  const resvg = await import('@resvg/resvg-wasm');
  await resvg.initWasm(readFileSync(path.join(dist, 'resvg.wasm')));
  const png = renderPng(exported, resvg, fonts, 2);
  const isPng = png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;

  console.log(
    JSON.stringify({
      width,
      svg: svg.length,
      persian: svg.includes('دانشجو'),
      exported: exported.length,
      fontFaces: exported.split('@font-face').length - 1,
      png: isPng ? png.length : 0,
    }),
  );
}

// No top-level await: like the extension, this is CommonJS.
void main();
