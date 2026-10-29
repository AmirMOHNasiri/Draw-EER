/**
 * Export to SVG and PNG. Runs in the extension host, so it works from the
 * editor, the Explorer and the preview alike, with or without an open
 * preview: parse → layout (pinned positions from the layout file, new
 * elements placed around them; see `arrange` in core) → SVG.
 *
 * Exports are black on white whatever the theme. The SVG embeds the fonts,
 * cut down to the characters used (a few KB instead of about 330 KB); the
 * PNG is drawn from that SVG by resvg, which is given the fonts directly
 * because it ignores @font-face.
 */
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  arrange,
  buildDiagram,
  createSubsetter,
  exportSvg,
  parse,
  renderPng,
  sizeDiagram,
  type FontData,
  type Positions,
  type ResvgModule,
  type Subsetter,
  type TextMeasurer,
} from '@draw-eer/core';
import { createMeasurer } from './harfbuzz';
import { readPositions } from './layoutFile';

export type ExportFormat = 'svg' | 'png';

interface Assets {
  measurer: TextMeasurer;
  fonts: FontData;
  subsetter: Subsetter;
}

export class Exporter {
  private assets: Promise<Assets> | null = null;
  private resvg: Promise<ResvgModule> | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Positions the open preview of a document holds (for untitled documents). */
    private readonly openPositions: (document: vscode.Uri) => Positions | undefined,
  ) {}

  /**
   * Exports `document` in `format`. Asks where to save unless `target` is
   * given (tests pass one). Returns the file written, or undefined if the
   * user cancelled.
   */
  async export(
    document: vscode.Uri,
    format: ExportFormat,
    target?: vscode.Uri,
  ): Promise<vscode.Uri | undefined> {
    const defaultUri = defaultTarget(document, format);
    const destination =
      target ??
      (await vscode.window.showSaveDialog({
        ...(defaultUri ? { defaultUri } : {}),
        filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
        title: `Export diagram as ${format.toUpperCase()}`,
      }));
    if (!destination) return undefined;

    const bytes = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Exporting ${format.toUpperCase()}` },
      () => this.render(document, format),
    );
    await vscode.workspace.fs.writeFile(destination, bytes);
    return destination;
  }

  private async render(document: vscode.Uri, format: ExportFormat): Promise<Uint8Array> {
    const [text, assets, positions] = await Promise.all([
      vscode.workspace.openTextDocument(document).then((d) => d.getText()),
      this.loadAssets(),
      this.openPositions(document) ?? readPositions(document),
    ]);
    const sized = sizeDiagram(buildDiagram(parse(text).file), assets.measurer);
    const { layout } = arrange(sized, positions);
    const svg = exportSvg(sized, layout, assets.fonts, assets.subsetter);
    if (format === 'svg') return new TextEncoder().encode(svg);
    const scale = vscode.workspace.getConfiguration('drawEer.export').get<number>('pngScale', 3);
    return renderPng(svg, await this.loadResvg(), assets.fonts, scale);
  }

  private loadAssets(): Promise<Assets> {
    this.assets ??= (async () => {
      const [wasm, subsetWasm, regular, bold] = await Promise.all(
        [
          'harfbuzz.wasm',
          'harfbuzz-subset.wasm',
          'fonts/Vazirmatn-Regular.ttf',
          'fonts/Vazirmatn-Bold.ttf',
        ].map((file) => this.read(file)),
      );
      const fonts = { regular: regular!, bold: bold! };
      return {
        measurer: await createMeasurer(wasm!, fonts),
        fonts,
        subsetter: await createSubsetter(subsetWasm!),
      };
    })();
    return this.assets;
  }

  /** resvg only when a PNG is exported: it is the largest piece (about 2.5 MB). */
  private loadResvg(): Promise<ResvgModule> {
    this.resvg ??= (async () => {
      const resvg = await import('@resvg/resvg-wasm');
      await resvg.initWasm(await this.read('resvg.wasm'));
      return resvg;
    })();
    return this.resvg;
  }

  private read(file: string): Promise<Uint8Array> {
    return readFile(vscode.Uri.joinPath(this.extensionUri, 'dist', file).fsPath);
  }
}

/** `name.svg` next to `name.eer`; in the first workspace folder for untitled documents. */
function defaultTarget(document: vscode.Uri, format: ExportFormat): vscode.Uri | undefined {
  if (document.scheme === 'untitled') {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return folder ? vscode.Uri.joinPath(folder, `diagram.${format}`) : undefined;
  }
  return document.with({ path: document.path.replace(/(\.eer)?$/, `.${format}`) });
}
