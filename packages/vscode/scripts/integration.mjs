/**
 * Runs the integration tests (test/integration/*.test.ts) inside a real VS
 * Code with this extension loaded from dist/, so completion, Quick Fixes and
 * highlighting are checked exactly as users get them.
 *
 *   node scripts/build.mjs && node scripts/integration.mjs
 *
 * @vscode/test-electron downloads VS Code into .vscode-test/ on the first
 * run. Linux without a display needs a virtual one: `xvfb-run -a` (CI does
 * this). The tests are bundled with esbuild, like the extension itself.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';
import { root } from './options.mjs';

const testsDir = path.join(root, 'test/integration');
const outDir = path.join(root, 'out/integration');

const entryPoints = (await readdir(testsDir))
  .filter((file) => file === 'index.ts' || file.endsWith('.test.ts'))
  .map((file) => path.join(testsDir, file));
await esbuild.build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  sourcemap: 'inline',
  // Provided by VS Code, and shared with the runner in index.js.
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});

// Set when this runs from a process that VS Code started (a task, an
// extension); it would make the downloaded VS Code start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(outDir, 'index.js'),
  launchArgs: [
    // Only this extension, so others (Copilot and the like) add no noise.
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ],
});
