/**
 * Checks the packaged extension the way a user gets it:
 *
 *   npm run check:vsix [-- path/to/draw-eer.vsix]
 *
 * The .vsix (by default the one `npm run package` made) is installed with
 * VS Code's own command line into an empty extensions folder and profile,
 * in a temporary folder outside the repository, so nothing from the
 * repository (node_modules, sources, dist/) can stand in for what the
 * package lacks. VS Code then opens a workspace with a Persian .eer file,
 * and a probe (plain JavaScript, no test libraries) checks that the
 * installed extension is the one running and that it works: syntax errors,
 * completion, SVG and PNG export, and the preview.
 *
 * Uses the copy of VS Code the integration tests download. On Linux without
 * a display, run it under `xvfb-run -a`.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';
import { root } from './options.mjs';

// VS Code's own terminal sets this, and the downloaded VS Code would then
// start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const { version, publisher, name } = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
);
const vsix = path.resolve(process.argv[2] ?? path.join(root, `draw-eer-${version}.vsix`));
const temp = await mkdtemp(path.join(os.tmpdir(), 'draw-eer-vsix-'));
try {
  const dirs = {
    extensions: path.join(temp, 'extensions'),
    profile: path.join(temp, 'profile'),
    workspace: path.join(temp, 'workspace'),
    probe: path.join(temp, 'probe'),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const copy = path.join(temp, path.basename(vsix));
  await copyFile(vsix, copy);

  const vscode = await downloadAndUnzipVSCode({ cachePath: path.join(root, '.vscode-test') });
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscode);
  const install = spawnSync(
    cli,
    [
      ...cliArgs,
      '--extensions-dir',
      dirs.extensions,
      '--user-data-dir',
      dirs.profile,
      '--install-extension',
      copy,
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  console.log(install.stdout.trim());
  if (install.status !== 0) {
    console.error(install.stderr);
    throw new Error('installing the .vsix failed');
  }

  await writeFile(
    path.join(dirs.workspace, 'library.eer'),
    'entity "عضو کتابخانه" { "کد ملی": key, نام }\nentity کتاب { شابک: key }\nrel امانت { "عضو کتابخانه" N, کتاب M }\n',
  );
  await writeFile(path.join(dirs.workspace, 'broken.eer'), 'entty Student { id: key }\n');
  // runTests needs an extension under development; this one only carries the probe.
  await writeFile(
    path.join(dirs.probe, 'package.json'),
    JSON.stringify({ name: 'probe', version: '0.0.0', engines: { vscode: '*' } }),
  );
  await writeFile(path.join(dirs.probe, 'probe.js'), probe(`${publisher}.${name}`, dirs));

  await runTests({
    vscodeExecutablePath: vscode,
    extensionDevelopmentPath: dirs.probe,
    extensionTestsPath: path.join(dirs.probe, 'probe.js'),
    launchArgs: [
      dirs.workspace,
      '--extensions-dir',
      dirs.extensions,
      '--user-data-dir',
      dirs.profile,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
  console.log(`\nThe packaged extension installs and works (${path.basename(vsix)}).`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

/** The probe that runs inside VS Code, as CommonJS source. */
function probe(id, dirs) {
  return `
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const workspace = ${JSON.stringify(dirs.workspace)};
const extensions = ${JSON.stringify(dirs.extensions)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('timed out waiting for ' + what);
}
function ok(what) { console.log('ok   ' + what); }

exports.run = async () => {
  const extension = vscode.extensions.getExtension(${JSON.stringify(id)});
  assert.ok(extension, 'the extension is installed');
  assert.ok(extension.extensionPath.startsWith(extensions), 'it runs from the installed package: ' + extension.extensionPath);
  ok('installed from the .vsix: ' + path.basename(extension.extensionPath));

  const broken = await vscode.workspace.openTextDocument(path.join(workspace, 'broken.eer'));
  await vscode.window.showTextDocument(broken);
  assert.equal(broken.languageId, 'eer');
  const diagnostics = await waitFor(() => vscode.languages.getDiagnostics(broken.uri).length && vscode.languages.getDiagnostics(broken.uri), 'syntax errors');
  assert.match(diagnostics[0].message, /entity/);
  ok('syntax errors: ' + diagnostics[0].message);

  const library = await vscode.workspace.openTextDocument(path.join(workspace, 'library.eer'));
  await vscode.window.showTextDocument(library);
  const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', library.uri, new vscode.Position(3, 0));
  assert.ok(completions.items.some((item) => (item.label.label ?? item.label) === 'entity'), 'completion offers entity');
  ok('completion');

  const svgFile = vscode.Uri.file(path.join(workspace, 'library.svg'));
  await vscode.commands.executeCommand('drawEer.exportSvg', library.uri, svgFile);
  const svg = fs.readFileSync(svgFile.fsPath, 'utf8');
  assert.ok(svg.includes('عضو کتابخانه') && svg.includes('@font-face'), 'the SVG has the Persian names and the font');
  ok('SVG export (' + svg.length + ' bytes)');

  const pngFile = vscode.Uri.file(path.join(workspace, 'library.png'));
  await vscode.commands.executeCommand('drawEer.exportPng', library.uri, pngFile);
  const png = fs.readFileSync(pngFile.fsPath);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.length > 10000, 'the PNG has a drawing in it');
  ok('PNG export (' + png.length + ' bytes)');

  await vscode.commands.executeCommand('drawEer.openPreviewToSide');
  const tab = await waitFor(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find(
    (t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('drawEer.preview')), 'the preview');
  ok('preview opens: ' + tab.label);
};
`;
}
