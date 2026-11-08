/**
 * Loads the real preview page in headless Chrome or Chromium and checks that
 * it draws a diagram:
 *
 *   npm run check:webview [-- --screenshot out/preview.png]
 *
 * The page is the one the extension builds, with the library fixture as its
 * text (see browser.mjs for how it is loaded and driven).
 *
 * This caught a bug no other test could: the worker inherits the page's
 * policy, and compiling WebAssembly needs 'wasm-unsafe-eval'.
 *
 * Skips (and succeeds) when no Chrome or Chromium is installed, unless
 * --require is given.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findBrowser, openPage, writePreviewPage } from './browser.mjs';
import { root } from './options.mjs';

const args = process.argv.slice(2);
const screenshot = args.includes('--screenshot') ? args[args.indexOf('--screenshot') + 1] : null;
const browser = findBrowser();
if (!browser) {
  console.log('No Chrome or Chromium found (set CHROME_PATH); skipping the webview check.');
  process.exit(args.includes('--require') ? 1 : 0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'draw-eer-webview-'));
try {
  const source = await readFile(path.join(root, '../core/test/fixtures/library.eer'), 'utf8');
  const url = await writePreviewPage(temp, { source, document: 'file:///library.eer' });

  let result;
  try {
    result = await inspect(url, screenshot);
  } catch (error) {
    console.log(`FAIL the browser could not run the check: ${error.message}`);
    process.exit(1);
  }
  const failures = [];
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  check(result.svg, 'the preview draws the diagram');
  check(result.persian, 'Persian names are in the drawing');
  check(result.font, 'the Vazirmatn font is loaded');
  check(
    result.status === '',
    `no error is shown${result.status ? ` (shows "${result.status}")` : ''}`,
  );
  check(
    result.scale > 0 && result.scale <= 1,
    `the diagram is fitted to the window (scale ${result.scale.toFixed(2)})`,
  );
  check(result.interaction?.zoomedIn, 'the mouse wheel zooms in');
  check(result.interaction?.panned, 'dragging pans');
  check(result.interaction?.refitted, 'double-click fits the diagram again');
  check(
    result.drag?.saved,
    `dragging a shape saves where it was dropped, and pins every shape (moved by ${JSON.stringify(result.drag?.offset)})`,
  );
  check(result.drag?.redrawn, 'the dragged shape is drawn at its new place');
  check(result.drag?.snapped, 'a shape dragged near a partner snaps into line');
  check(result.drag?.toolbar, 'toolbar buttons send export and reset commands');
  if (screenshot) console.log(`screenshot: ${screenshot}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}

/**
 * Opens `url`, waits until a diagram is shown (or 20 s pass), and reports on
 * the page. Rejects with Chrome's own output if it quits or refuses a command.
 */
async function inspect(url, screenshotPath) {
  const page = await openPage(browser, url);
  const { evaluate } = page;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await evaluate("!!document.querySelector('#canvas svg')"))) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const report = await evaluate(`(async () => {
      await document.fonts.ready;
      const svg = document.querySelector('#canvas svg');
      return {
        svg: !!svg,
        persian: !!svg && svg.textContent.includes('کتابخانه'),
        font: document.fonts.check("16px 'Vazirmatn'", 'کتابخانه'),
        status: document.getElementById('status').textContent,
        scale: window.__state ? window.__state.view.scale : 0,
      };
    })()`);
    // Zoom with the wheel, drag to pan, then double-click to fit again.
    report.interaction = await evaluate(`(() => {
      const viewport = document.getElementById('viewport');
      const fitted = window.__state.view.scale;
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 700, clientY: 400, cancelable: true }));
      const zoomed = window.__state.view;
      const at = (type, x, y) => viewport.dispatchEvent(new PointerEvent(type, { button: 0, clientX: x, clientY: y, pointerId: 1, bubbles: true }));
      viewport.setPointerCapture = () => {};
      at('pointerdown', 500, 400); at('pointermove', 560, 430); at('pointerup', 560, 430);
      const panned = window.__state.view;
      viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const refitted = window.__state.view;
      return {
        zoomedIn: zoomed.scale > fitted && !zoomed.fitted,
        panned: Math.abs(panned.x - zoomed.x - 60) < 0.01 && Math.abs(panned.y - zoomed.y - 30) < 0.01,
        refitted: refitted.fitted && Math.abs(refitted.scale - fitted) < 1e-9,
      };
    })()`);
    // Drag a shape with real pointer events, as a user would.
    report.drag = await evaluate(`(async () => {
      const id = 'entity:انتشارات';
      const shape = () => document.querySelector('#canvas [data-id="' + id + '"] rect');
      const viewport = document.getElementById('viewport');
      const scale = window.__state.view.scale;
      const box = shape().getBoundingClientRect();
      const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const at = (type, x, y, extra = {}) => shape().dispatchEvent(new PointerEvent(type, { button: 0, clientX: x, clientY: y, pointerId: 1, bubbles: true, ...extra }));
      const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
      const saved = async () => {
        for (let i = 0; i < 40 && !window.__messages.some((m) => m.type === 'moved'); i++) await settle();
        return window.__messages.findLast((m) => m.type === 'moved');
      };
      const centerX = () => Number(shape().getAttribute('x')) + Number(shape().getAttribute('width')) / 2;
      const centerY = () => Number(shape().getAttribute('y')) + Number(shape().getAttribute('height')) / 2;
      const before = { x: centerX(), y: centerY() };
      // 1. A plain move, without snapping (Alt), by 100 x 50 screen px.
      at('pointerdown', start.x, start.y);
      at('pointermove', start.x + 50, start.y + 20, { altKey: true });
      at('pointermove', start.x + 100, start.y + 50, { altKey: true });
      at('pointerup', start.x + 100, start.y + 50);
      const first = await saved();
      const dropped = first?.positions.nodes[id];
      const offset = dropped && { x: Math.round(dropped.x - before.x), y: Math.round(dropped.y - before.y) };
      const result = {
        offset,
        // Saved where it was dropped, and the first drag pins every shape.
        saved: !!offset && Math.abs(offset.x - 100 / scale) <= 1 && Math.abs(offset.y - 50 / scale) <= 1 &&
          Object.keys(first.positions.nodes).length === document.querySelectorAll('#canvas .entity, #canvas .relationship').length,
        redrawn: Math.abs(centerX() - before.x - 100 / scale) <= 1,
      };
      // 2. Back to 4 px beside the column of its relationship (it sits right
      // above it): it snaps into line, so its line is straight again.
      window.__messages.length = 0;
      const now = shape().getBoundingClientRect();
      const from = { x: now.x + now.width / 2, y: now.y + now.height / 2 };
      const dx = (4 - offset.x) * scale;
      at('pointerdown', from.x, from.y);
      at('pointermove', from.x + dx, from.y);
      at('pointerup', from.x + dx, from.y);
      const second = await saved();
      result.snapped = second?.positions.nodes[id]?.x === Math.round(before.x);
      // 3. Toolbar buttons.
      window.__messages.length = 0;
      for (const button of ['export-svg', 'export-png', 'reset-layout']) document.getElementById(button).click();
      result.toolbar = window.__messages.map((m) => m.command).join() === 'exportSvg,exportPng,resetLayout';
      return result;
    })()`);
    if (screenshotPath) await writeFile(screenshotPath, await page.screenshot());
    return report;
  } finally {
    page.close();
  }
}
