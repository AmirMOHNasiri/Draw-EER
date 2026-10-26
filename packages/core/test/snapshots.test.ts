/**
 * Regression snapshots: the rendered SVG of every fixture, one element per
 * line, stored as real .svg files in test/snapshots/ (open them to see the
 * picture). Any change to layout or rendering shows up as a diff there.
 *
 * After an intended change, review the new pictures and update them with:
 *
 *   npm run test:update-snapshots
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderDiagram, type TextMeasurer } from '../src';
import { createNodeMeasurer } from '../src/node';

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.eer'));

let measurer: TextMeasurer;
beforeAll(async () => {
  measurer = await createNodeMeasurer();
});

describe.each(fixtures)('%s', (fixture) => {
  it('renders as in its snapshot', async () => {
    const source = readFileSync(fixturesDir + fixture, 'utf8');
    const { svg } = renderDiagram(source, measurer);
    const readable = svg.replace(/></g, '>\n<') + '\n';
    await expect(readable).toMatchFileSnapshot(`snapshots/${fixture.replace(/\.eer$/, '.svg')}`);
  });
});
