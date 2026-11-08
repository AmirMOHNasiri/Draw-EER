/**
 * Packages the extension as a .vsix, ready to install or publish:
 *
 *   npm run package [-- --ref v0.1.0]
 *
 * 1. A fresh production build (minified, no source maps) in dist/.
 * 2. README.md, CHANGELOG.md and LICENSE from the repository root are
 *    copied in, since the Marketplace and Open VSX show the extension's own.
 * 3. vsce packages it. Everything is bundled, so no node_modules ship
 *    (--no-dependencies). Relative links and images in the README point
 *    into the repository on GitHub at `--ref` (default main; the release
 *    workflow passes the tag), as those pages cannot show files from the
 *    .vsix.
 *
 * The result is draw-eer-<version>.vsix in packages/vscode. .vscodeignore
 * decides what goes in; `npx vsce ls` lists it.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { root } from './options.mjs';

const args = process.argv.slice(2);
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : 'main';
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const repository = 'https://github.com/AmirMOHNasiri/Draw-EER';

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(path.join(root, 'dist'), { recursive: true, force: true });
run(process.execPath, ['scripts/build.mjs', '--production']);

const repoRoot = path.resolve(root, '../..');
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
  await copyFile(path.join(repoRoot, file), path.join(root, file));
}

const vsix = `draw-eer-${version}.vsix`;
run('npx', [
  'vsce',
  'package',
  '--no-dependencies',
  '--baseContentUrl',
  `${repository}/blob/${ref}/`,
  '--baseImagesUrl',
  `${repository}/raw/${ref}/`,
  '--out',
  vsix,
]);
console.log(`\npackaged ${path.join(root, vsix)}`);
