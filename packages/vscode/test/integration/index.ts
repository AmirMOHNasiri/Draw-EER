/**
 * Entry point that VS Code calls to run the integration tests in its
 * extension host (see scripts/integration.mjs). Runs every *.test.js next
 * to this file with Mocha.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30_000, color: true });
  for (const file of readdirSync(__dirname).sort()) {
    if (file.endsWith('.test.js')) mocha.addFile(path.join(__dirname, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve(),
    );
  });
}
