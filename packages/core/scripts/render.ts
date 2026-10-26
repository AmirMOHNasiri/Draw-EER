/**
 * Renders .eer files to SVG (and optionally PNG) from the command line, to
 * check output while developing:
 *
 *   npm run render -- examples/university.eer [more.eer ...] [--png] [--out-dir dir]
 *
 * Each input `name.eer` produces `name.svg` (and `name.png`) in the output
 * directory, or next to the input when no directory is given. Syntax errors
 * are printed, and whatever parsed is still drawn.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { renderDiagram } from '../src';
import { createNodeMeasurer, loadFonts } from '../src/node';

async function main() {
  const args = process.argv.slice(2);
  const png = args.includes('--png');
  const outDirIndex = args.indexOf('--out-dir');
  const outDir = outDirIndex >= 0 ? args[outDirIndex + 1] : undefined;
  const inputs = args.filter(
    (a, i) => !a.startsWith('--') && (outDirIndex < 0 || i !== outDirIndex + 1),
  );
  if (inputs.length === 0) {
    console.error('Usage: npm run render -- <file.eer> [...] [--png] [--out-dir <dir>]');
    process.exit(1);
  }

  const [measurer, fonts] = await Promise.all([createNodeMeasurer(), loadFonts()]);
  if (png) {
    const wasmPath = createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
    await initWasm(await readFile(wasmPath));
  }
  if (outDir) await mkdir(outDir, { recursive: true });

  for (const input of inputs) {
    const source = await readFile(input, 'utf8');
    const { svg, errors } = renderDiagram(source, measurer, { embedFont: fonts });
    for (const e of errors) {
      console.error(`${input}:${e.range.start.line + 1}:${e.range.start.column + 1}: ${e.message}`);
    }
    const base = path.join(outDir ?? path.dirname(input), path.basename(input, '.eer'));
    await writeFile(`${base}.svg`, svg);
    console.log(`wrote ${base}.svg`);

    if (png) {
      // resvg does not read @font-face; the fonts are passed to it directly.
      const image = new Resvg(svg, {
        font: { fontBuffers: [fonts.regular, fonts.bold], defaultFontFamily: 'Vazirmatn' },
        fitTo: { mode: 'zoom', value: 2 },
        background: '#ffffff',
      }).render();
      await writeFile(`${base}.png`, image.asPng());
      console.log(`wrote ${base}.png`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
