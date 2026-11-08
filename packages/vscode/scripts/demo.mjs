/**
 * Records docs/images/demo.gif, the README's animation of a diagram being
 * typed while the preview follows:
 *
 *   npm run demo -w packages/vscode
 *
 * Needs Chrome or Chromium and ffmpeg. The right half is the real preview
 * page, exactly as the extension ships it (see browser.mjs): the same HTML,
 * worker, WebAssembly and font. The left half stands in for VS Code's
 * editor: the text is colored with the extension's own TextMate grammar and
 * VS Code's Dark Modern theme (both read by vscode-textmate, the library
 * VS Code itself uses; the theme comes from the copy of VS Code that the
 * integration tests download). The text is "typed" a few characters per
 * frame, and the preview is sent the text at the end of every line, as the
 * extension does when typing pauses. Each frame is a screenshot; ffmpeg
 * turns them into a GIF with one shared palette.
 *
 * Everything is scripted, so the same inputs give the same GIF. To change
 * what is typed, edit TEXT below.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';
import { findBrowser, openPage, writePreviewPage } from './browser.mjs';
import { root } from './options.mjs';

const TEXT = `entity Student {
  id: key
  name { first, last }
}

entity Course { code: key, title }

rel Enroll {
  Student N total
  Course M
  attrs { grade }
}

entity Person { ssn: key }
specialize Person disjoint { Student, Professor }
`;

const FILE = 'university.eer';
const OUTPUT = path.resolve(root, '../../docs/images/demo.gif');
const SIZE = { width: 1280, height: 640 };
const FPS = 15;
/** Characters typed per frame. */
const SPEED = 3;
/**
 * Frames held: the finished diagram first (so a still of the GIF shows it,
 * and the loop runs on from the last frame into the first), the empty file,
 * after each line (once the preview is redrawn), and at the end.
 */
const HOLD = { poster: 20, start: 8, line: 3, end: 16 };

const require = createRequire(import.meta.url);
const browser = findBrowser();
if (!browser) {
  console.error('No Chrome or Chromium found (set CHROME_PATH).');
  process.exit(1);
}
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg is needed to make the GIF.');
  process.exit(1);
}

const highlight = await highlighter();
const temp = await mkdtemp(path.join(os.tmpdir(), 'draw-eer-demo-'));
try {
  const url = await writePreviewPage(temp, {
    source: '',
    document: `file:///${FILE}`,
    head: `<style>${css(highlight.colors)}</style>`,
  });
  const page = await openPage(browser, url, SIZE);
  try {
    await page.evaluate(`(async () => {
      for (let i = 0; i < 100 && !(window.__messages ?? []).some((m) => m.type === 'ready'); i++)
        await new Promise((r) => setTimeout(r, 100));
      ${chromeScript(FILE)}
    })()`);

    /** Screenshots, each with the number of frames it is shown for. */
    const frames = [];
    const shoot = async (count = 1) => frames.push([await page.screenshot(), count]);
    const showText = (text) =>
      page.evaluate(`window.__showText(${JSON.stringify(highlight.html(text))})`);
    let version = 1;
    const sendToPreview = (text) =>
      page.evaluate(`window.__send(${JSON.stringify(text)}, ${++version})`);

    await showText('');
    await shoot(HOLD.start);
    for (let typed = 0; typed < TEXT.length;) {
      const lineEnd = TEXT.indexOf('\n', typed);
      const next = Math.min(typed + SPEED, lineEnd + 1);
      typed = next;
      await showText(TEXT.slice(0, typed));
      if (TEXT[typed - 1] === '\n') {
        await sendToPreview(TEXT.slice(0, typed));
        await shoot(HOLD.line);
      } else {
        await shoot();
      }
    }
    await shoot(HOLD.end);
    // The finished diagram also opens the animation.
    let frame = 0;
    for (const [png, count] of [[frames.at(-1)[0], HOLD.poster], ...frames]) {
      for (let i = 0; i < count; i++) {
        await writeFile(path.join(temp, `frame-${String(++frame).padStart(4, '0')}.png`), png);
      }
    }
    console.log(`${frame} frames`);
  } finally {
    page.close();
  }

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      String(FPS),
      '-i',
      path.join(temp, 'frame-%04d.png'),
      '-vf',
      // One palette for the whole animation; only changed areas are stored.
      'split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      '-loop',
      '0',
      OUTPUT,
    ],
    { stdio: 'inherit' },
  );
  const { size } = await import('node:fs').then((fs) => fs.promises.stat(OUTPUT));
  console.log(`wrote ${OUTPUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

/**
 * Colors .eer text as VS Code would with the Dark Modern theme: the
 * extension's grammar and the theme files, through vscode-textmate.
 */
async function highlighter() {
  const wasm = await readFile(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const themes = await themeFolder();
  const theme = await loadTheme(path.join(themes, 'dark_modern.json'));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () =>
      textmate.parseRawGrammar(
        await readFile(path.join(root, 'syntaxes/eer.tmLanguage.json'), 'utf8'),
        'eer.tmLanguage.json',
      ),
    theme: {
      settings: [
        {
          settings: {
            foreground: theme.colors['editor.foreground'],
            background: theme.colors['editor.background'],
          },
        },
        ...theme.tokenColors,
      ],
    },
  });
  const grammar = await registry.loadGrammar('source.eer');
  const colorMap = registry.getColorMap();
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    colors: theme.colors,
    /** One <div> per line, with colored spans. */
    html(text) {
      let state = textmate.INITIAL;
      return text.split('\n').map((line) => {
        const { tokens, ruleStack } = grammar.tokenizeLine2(line, state);
        state = ruleStack;
        let html = '';
        for (let i = 0; i < tokens.length; i += 2) {
          const start = tokens[i];
          const end = i + 2 < tokens.length ? tokens[i + 2] : line.length;
          const color = colorMap[foreground(tokens[i + 1])];
          html += `<span style="color:${color}">${escape(line.slice(start, end))}</span>`;
        }
        return html;
      });
    },
  };
}

/**
 * The color index in a token's metadata (bits 15–23, as laid out in
 * vscode-textmate's encodedTokenAttributes.ts, which it does not export).
 */
function foreground(metadata) {
  return (metadata & 0x00ff8000) >>> 15;
}

/** The folder of VS Code's built-in themes, in the copy the integration tests use. */
async function themeFolder() {
  const executable = await downloadAndUnzipVSCode({ cachePath: path.join(root, '.vscode-test') });
  for (let dir = path.dirname(executable); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    for (const app of ['resources/app', 'Resources/app', 'Contents/Resources/app']) {
      const themes = path.join(dir, app, 'extensions/theme-defaults/themes');
      if (existsSync(themes)) return themes;
    }
  }
  throw new Error(`no built-in themes found near ${executable}`);
}

/** A theme file with its `include` chain merged (later files win). */
async function loadTheme(file) {
  const theme = JSON.parse(await readFile(file, 'utf8'));
  const base = theme.include
    ? await loadTheme(path.join(path.dirname(file), theme.include))
    : { colors: {}, tokenColors: [] };
  return {
    colors: { ...base.colors, ...theme.colors },
    tokenColors: [...base.tokenColors, ...(theme.tokenColors ?? [])],
  };
}

/** The page around the preview: tabs on top, the editor on the left. */
function css(colors) {
  const c = (key, fallback) => colors[key] ?? fallback;
  return `
body { --vscode-editor-background: ${c('editor.background', '#1f1f1f')} !important;
       --vscode-editorWidget-background: ${c('editorWidget.background', '#202020')} !important; }
#tabs { position: absolute; left: 0; right: 0; top: 0; height: 35px; display: flex;
        background: ${c('editorGroupHeader.tabsBackground', '#181818')};
        font: 13px system-ui, sans-serif; }
#tabs div { display: flex; display: flex; border-left: 1px solid ${c('editorGroup.border', '#2b2b2b')}; }
#tabs span { padding: 0 16px; line-height: 35px; color: ${c('tab.activeForeground', '#ffffff')};
             background: ${c('tab.activeBackground', '#1f1f1f')};
             border-top: 1px solid ${c('tab.activeBorderTop', '#0078d4')};
             border-right: 1px solid ${c('tab.border', '#2b2b2b')}; }
#editor { position: absolute; left: 0; top: 35px; bottom: 0; width: 42%; overflow: hidden;
          background: ${c('editor.background', '#1f1f1f')};
          font: 15px/22px 'Cascadia Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Adwaita Mono', monospace;
          padding-top: 6px; white-space: pre; }
#editor .line { display: flex; }
#editor .number { width: 48px; padding-right: 22px; text-align: right;
                  color: ${c('editorLineNumber.foreground', '#6e7681')}; }
#editor .cursor { display: inline-block; width: 2px; height: 20px; vertical-align: -4px;
                  background: ${c('editorCursor.foreground', '#aeafad')}; }
#viewport { left: 42% !important; top: 35px !important;
            border-left: 1px solid ${c('editorGroup.border', '#2b2b2b')}; }
#status { left: calc(42% + 12px) !important; }
#toolbar { top: 43px !important; }
`;
}

/** Adds the tabs and the editor, and helpers to show text and send it to the preview. */
function chromeScript(file) {
  return `
    const tabs = document.createElement('div');
    tabs.id = 'tabs';
    tabs.innerHTML = '<div style="width: 42%"><span>${file}</span></div><div style="width: 58%"><span>Preview ${file}</span></div>';
    const editor = document.createElement('div');
    editor.id = 'editor';
    document.body.append(tabs, editor);
    window.__showText = (lines) => {
      editor.innerHTML = lines.map((line, i) =>
        '<div class="line"><span class="number">' + (i + 1) + '</span><span>' + line +
        (i === lines.length - 1 ? '<span class="cursor"></span>' : '') + '</span></div>').join('');
    };
    let draws = 0;
    new MutationObserver(() => draws++).observe(document.getElementById('canvas'), { childList: true });
    window.__send = async (text, version) => {
      const before = draws;
      window.postMessage({ type: 'source', text, version }, '*');
      for (let i = 0; i < 60 && draws === before; i++) await new Promise((r) => setTimeout(r, 50));
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    };`;
}
