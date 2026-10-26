/**
 * Measures how long layout takes, for every fixture and for a large
 * synthetic diagram (50 entities, 60 relationships, 200 attributes):
 *
 *   npm run bench
 *
 * The preview in VS Code lays the diagram out again after typing pauses,
 * so this must stay well under a second for real diagrams.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDiagram, layoutDiagram, parse, renderSvg, sizeDiagram } from '../src';
import { createNodeMeasurer } from '../src/node';

/**
 * A large, connected diagram: entities joined in a chain, plus extra
 * relationships between pseudo-random pairs and a few ternary ones. The
 * random numbers come from a fixed seed, so every run measures the same input.
 */
export function syntheticDiagram(entities = 50, relationships = 60, attributes = 200): string {
  let seed = 42;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const lines: string[] = [];
  for (let i = 0; i < entities; i++) {
    const count = Math.floor(attributes / entities) + (i < attributes % entities ? 1 : 0);
    const attrs = Array.from({ length: count }, (_, j) =>
      j === 0 ? `a${i}_${j}: key` : `a${i}_${j}`,
    );
    lines.push(`entity E${i} { ${attrs.join(', ')} }`);
  }
  for (let r = 0; r < relationships; r++) {
    const a = r < entities - 1 ? r : random(entities);
    let b = r < entities - 1 ? r + 1 : random(entities);
    if (b === a) b = (a + 1) % entities;
    const ternary = r >= entities - 1 && r % 4 === 0 ? `, E${(b + 7) % entities} K` : '';
    lines.push(`rel R${r} { E${a} 1, E${b} N${ternary} }`);
  }
  return lines.join('\n');
}

async function main() {
  const measurer = await createNodeMeasurer();
  const dir = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
  const inputs = readdirSync(dir)
    .filter((f) => f.endsWith('.eer'))
    .map((f) => ({ name: f, source: readFileSync(dir + f, 'utf8') }));
  inputs.push({ name: 'synthetic (50 entities, 60 rels, 200 attrs)', source: syntheticDiagram() });

  const rows: string[][] = [['diagram', 'shapes', 'parse+size ms', 'layout ms', 'render ms']];
  for (const { name, source } of inputs) {
    const runs = name.startsWith('synthetic') ? 1 : 3;
    let best = { prep: Infinity, layout: Infinity, render: Infinity };
    let shapes = 0;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const sized = sizeDiagram(buildDiagram(parse(source).file), measurer);
      const t1 = performance.now();
      const layout = layoutDiagram(sized);
      const t2 = performance.now();
      renderSvg(sized, layout);
      const t3 = performance.now();
      shapes = sized.geometry.size;
      best = {
        prep: Math.min(best.prep, t1 - t0),
        layout: Math.min(best.layout, t2 - t1),
        render: Math.min(best.render, t3 - t2),
      };
    }
    rows.push([
      name,
      String(shapes),
      best.prep.toFixed(1),
      best.layout.toFixed(0),
      best.render.toFixed(1),
    ]);
    console.log(rows.at(-1)!.join('  |  '));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
