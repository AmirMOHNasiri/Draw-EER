/**
 * Renders .eer files to SVG (and optionally PNG) from the command line, the
 * same way the extension exports them:
 *
 *   npm run render -- examples/company.eer [more.eer ...] [--png] [--out-dir dir]
 *     [--scale n] [--png-only]
 *
 * Each input `name.eer` produces `name.svg` (and with `--png`, `name.png`,
 * `--scale` times the size, 2 by default) in the output directory, or next
 * to the input when no directory is given. `--png-only` leaves out the SVG. A layout file `name.eer.layout.json` next to the input is applied.
 * Syntax errors are printed, and whatever parsed is still drawn.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  arrange,
  buildDiagram,
  exportSvg,
  NO_POSITIONS,
  parse,
  parseLayoutFile,
  renderPng,
  sizeDiagram,
  type Positions,
} from '../src';
import { createNodeMeasurer, loadFonts, loadResvg, loadSubsetter } from '../src/node';

async function main() {
  const args = process.argv.slice(2);
  const pngOnly = args.includes('--png-only');
  const png = pngOnly || args.includes('--png');
  const valueOf = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outDir = valueOf('--out-dir');
  const scale = Number(valueOf('--scale') ?? 2);
  const values = new Set(
    ['--out-dir', '--scale'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0),
  );
  const inputs = args.filter((a, i) => !a.startsWith('--') && !values.has(i));
  if (inputs.length === 0) {
    console.error('Usage: npm run render -- <file.eer> [...] [--png] [--out-dir <dir>]');
    process.exit(1);
  }

  const [measurer, fonts, subsetter] = await Promise.all([
    createNodeMeasurer(),
    loadFonts(),
    loadSubsetter(),
  ]);
  if (outDir) await mkdir(outDir, { recursive: true });

  for (const input of inputs) {
    const source = await readFile(input, 'utf8');
    const { file, errors } = parse(source);
    for (const e of errors) {
      console.error(`${input}:${e.range.start.line + 1}:${e.range.start.column + 1}: ${e.message}`);
    }
    const sized = sizeDiagram(buildDiagram(file), measurer);
    const { layout } = arrange(sized, await positionsFor(input));
    const svg = exportSvg(sized, layout, fonts, subsetter);
    const base = path.join(outDir ?? path.dirname(input), path.basename(input, '.eer'));
    if (!pngOnly) {
      await writeFile(`${base}.svg`, svg);
      console.log(`wrote ${base}.svg`);
    }

    if (png) {
      await writeFile(`${base}.png`, renderPng(svg, await loadResvg(), fonts, scale));
      console.log(`wrote ${base}.png`);
    }
  }
}

/** Positions from the layout file next to `input`, if there is one. */
async function positionsFor(input: string): Promise<Positions> {
  let text: string;
  try {
    text = await readFile(`${input}.layout.json`, 'utf8');
  } catch {
    return NO_POSITIONS;
  }
  const { positions, error } = parseLayoutFile(text);
  if (error) console.error(`${input}.layout.json: ${error}`);
  else console.log(`using the layout file ${input}.layout.json`);
  return positions;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
