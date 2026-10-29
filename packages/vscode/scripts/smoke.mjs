/**
 * Smoke test for the built extension (run `npm run smoke` in packages/vscode):
 *
 * 1. The extension host: a probe bundled exactly like dist/extension.js
 *    (CommonJS for Node, with the harfbuzz plugin) loads HarfBuzz from
 *    dist/harfbuzz.wasm and measures Persian text, then exports an SVG with
 *    subset fonts and a PNG with resvg, from the .wasm files in dist/.
 * 2. The preview's worker: dist/worker.js runs in a sandbox without Node's
 *    globals, like a browser Web Worker, gets the same `init` and `render`
 *    messages the preview page sends, and must answer with an SVG.
 *
 * Both must agree on the width of «دانشجو», which is measured with HarfBuzz
 * and the bundled font everywhere.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import { common, dist, extensionHost, root } from './options.mjs';

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// 1. Extension host -----------------------------------------------------------
const temp = await mkdtemp(path.join(os.tmpdir(), 'draw-eer-smoke-'));
const probe = path.join(temp, 'probe.js');
await esbuild.build({
  ...common,
  ...extensionHost,
  logLevel: 'warning',
  sourcemap: false,
  entryPoints: [path.join(root, 'scripts/host-probe.ts')],
  outfile: probe,
});
const host = JSON.parse(execFileSync(process.execPath, [probe, dist], { encoding: 'utf8' }));
await rm(temp, { recursive: true, force: true });
check(
  host.width > 30 && host.width < 70,
  `extension host: HarfBuzz measures «دانشجو» (${host.width.toFixed(2)} px)`,
);
check(host.persian && host.svg > 500, 'extension host: renders a Persian diagram to SVG');
check(
  host.fontFaces === 2 && host.exported < 30_000,
  `extension host: exports an SVG with subset fonts (${(host.exported / 1000).toFixed(1)} KB)`,
);
check(
  host.png > 1000,
  `extension host: exports a PNG with resvg (${(host.png / 1000).toFixed(1)} KB)`,
);

// 2. Preview worker -----------------------------------------------------------
const replies = [];
const sandbox = {
  // What a browser worker has, and nothing from Node (no process, require, Buffer).
  self: { onmessage: null, postMessage: (message) => replies.push(message) },
  setTimeout,
  performance,
  TextDecoder,
  TextEncoder,
  URL,
  console,
  // WebAssembly and FinalizationRegistry are built into every context;
  // passing ours in would mix realms, which WebAssembly tables reject.
};
sandbox.WorkerGlobalScope = function WorkerGlobalScope() {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(dist, 'worker.js'), 'utf8'), sandbox, {
  filename: 'worker.js',
});
check(sandbox.self.onmessage !== null, 'worker: starts without Node globals');

const bytes = (file) => {
  const data = readFileSync(path.join(dist, file));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
};
sandbox.self.onmessage({
  data: {
    type: 'init',
    wasm: bytes('harfbuzz.wasm'),
    regular: bytes('fonts/Vazirmatn-Regular.ttf'),
    bold: bytes('fonts/Vazirmatn-Bold.ttf'),
  },
});
const render = {
  type: 'render',
  text: 'entity دانشجو { نام }\nrel R { دانشجو 1, Course N }',
  theme: { stroke: '#ccc', text: '#ccc', fill: '#1e1e1e', background: null },
  positions: { nodes: {}, attributes: {} },
};
/** Sends a render request and waits for its answer. */
async function draw(request) {
  sandbox.self.onmessage({ data: request });
  const deadline = Date.now() + 10_000;
  const answered = () => replies.find((r) => r.id === request.id && r.type !== 'ready');
  while (!answered() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return answered();
}
const rendered = await draw({ ...render, id: 1 });
check(
  replies.some((r) => r.type === 'ready'),
  'worker: HarfBuzz loads from the .wasm bytes',
);
check(rendered?.svg.includes('دانشجو') === true, 'worker: renders a Persian diagram to SVG');
check(rendered?.svg.includes('stroke: #ccc') === true, 'worker: uses the theme colors');
check(rendered?.errors === 0, 'worker: reports no syntax errors for valid input');
if (rendered) console.log(`     worker drew it in ${rendered.ms.toFixed(0)} ms`);

// A drag: the first one pins the whole layout (two entities and the relationship).
const dragged = await draw({
  ...render,
  id: 2,
  move: { id: 'entity:دانشجو', dx: 40, dy: 0, snap: 0 },
});
check(
  Object.keys(dragged?.positions?.nodes ?? {}).length === 3 && dragged.svg !== rendered?.svg,
  'worker: applies a drag and pins the whole layout',
);

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
