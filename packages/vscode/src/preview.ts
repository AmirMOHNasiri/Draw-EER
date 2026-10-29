/**
 * The live preview: one webview panel per `.eer` document.
 *
 * The extension host only sends the document's text, after typing pauses
 * (`drawEer.preview.updateDelay`), and the positions from its layout file.
 * The webview draws it in a Web Worker (webview/worker.ts), so even a large
 * diagram never blocks the editor or other extensions; while the worker is
 * busy, only the newest text waits. Shapes dragged in the preview come back
 * as `moved` messages and are saved to the layout file (layoutFile.ts).
 */
import * as vscode from 'vscode';
import type { Positions } from '@draw-eer/core';
import type { ToWebview, FromWebview, PreviewState } from '../webview/protocol';
import { createNonce, previewHtml } from './html';
import { LayoutFile, layoutFileUri } from './layoutFile';

const VIEW_TYPE = 'drawEer.preview';

export class PreviewManager {
  private readonly previews = new Map<string, Preview>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  register(): void {
    const { subscriptions } = this.context;
    subscriptions.push(
      vscode.commands.registerCommand('drawEer.openPreview', (uri?: vscode.Uri) =>
        this.open(uri, false),
      ),
      vscode.commands.registerCommand('drawEer.openPreviewToSide', (uri?: vscode.Uri) =>
        this.open(uri, true),
      ),
      vscode.commands.registerCommand('drawEer.resetLayout', (uri?: vscode.Uri) => {
        const document = this.target(uri);
        return document && this.resetLayout(document);
      }),
      // Ctrl+Z and Ctrl+Shift+Z while a preview is focused (see package.json keybindings).
      vscode.commands.registerCommand('drawEer.undoLayoutChange', () =>
        this.active()?.layout.undo(),
      ),
      vscode.commands.registerCommand('drawEer.redoLayoutChange', () =>
        this.active()?.layout.redo(),
      ),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.previews.get(event.document.uri.toString())?.scheduleUpdate(),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('drawEer')) {
          for (const preview of this.previews.values()) preview.scheduleUpdate();
        }
      }),
      // Previews left open when VS Code closed come back on restart.
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: PreviewState | undefined) => {
          if (!state?.uri) {
            panel.dispose();
            return;
          }
          const uri = vscode.Uri.parse(state.uri);
          try {
            const document = await vscode.workspace.openTextDocument(uri);
            this.attach(panel, document);
          } catch {
            panel.dispose();
          }
        },
      }),
    );
  }

  /**
   * The document a command is for: the one it was given (from the Explorer
   * or a preview's toolbar), else the focused preview's, else the active
   * editor's.
   */
  target(uri: vscode.Uri | undefined): vscode.Uri | undefined {
    const target =
      uri ?? this.active()?.document.uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) void vscode.window.showInformationMessage('Open an .eer file first.');
    return target;
  }

  /** The positions an open preview of `document` holds, if there is one. */
  positionsFor(document: vscode.Uri): Positions | undefined {
    return this.previews.get(document.toString())?.layout.positions;
  }

  private active(): Preview | undefined {
    return [...this.previews.values()].find((p) => p.panel.active);
  }

  /** Back to the automatic layout, with an Undo button in the notification. */
  private async resetLayout(document: vscode.Uri): Promise<void> {
    const preview = this.previews.get(document.toString());
    let restore: () => Promise<void>;
    if (preview) {
      await preview.layout.reset();
      restore = () => preview.layout.undo();
    } else {
      // No preview, so no layout state in memory: just the file.
      const file = layoutFileUri(document);
      const old =
        file &&
        (await vscode.workspace.fs.readFile(file).then(
          (b) => b,
          () => null,
        ));
      if (!file || !old) {
        void vscode.window.showInformationMessage('Nothing to reset: no shape has been moved.');
        return;
      }
      await vscode.workspace.fs.delete(file);
      restore = () => Promise.resolve(vscode.workspace.fs.writeFile(file, old));
    }
    // Not awaited: the command is done once the layout is reset, not when
    // the notification goes away.
    void vscode.window
      .showInformationMessage('The layout was reset to the automatic one.', 'Undo')
      .then((choice) => (choice === 'Undo' ? restore() : undefined));
  }

  private async open(uri: vscode.Uri | undefined, toSide: boolean): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showInformationMessage('Open an .eer file to preview it.');
      return;
    }
    const existing = this.previews.get(target.toString());
    const column = toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    if (existing) {
      existing.panel.reveal(column, toSide);
      return;
    }
    const document = await vscode.workspace.openTextDocument(target);
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      previewTitle(document.uri),
      { viewColumn: column, preserveFocus: toSide },
      webviewOptions(this.context.extensionUri),
    );
    this.attach(panel, document);
  }

  private attach(panel: vscode.WebviewPanel, document: vscode.TextDocument): void {
    panel.title = previewTitle(document.uri);
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'preview.svg');
    panel.webview.options = webviewOptions(this.context.extensionUri);
    const key = document.uri.toString();
    const preview = new Preview(panel, document, this.context.extensionUri);
    this.previews.set(key, preview);
    panel.onDidDispose(() => {
      preview.dispose();
      this.previews.delete(key);
    });
  }
}

class Preview {
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly layout: LayoutFile;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly document: vscode.TextDocument,
    extensionUri: vscode.Uri,
  ) {
    this.layout = new LayoutFile(document.uri);
    const webview = panel.webview;
    webview.html = previewHtml({
      cspSource: webview.cspSource,
      asset: (path) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', path)).toString(),
      nonce: createNonce(),
      document: document.uri.toString(),
    });
    this.disposables.push(
      this.layout,
      this.layout.onDidChange((positions) => this.post({ type: 'positions', positions })),
      panel.webview.onDidReceiveMessage((message: FromWebview) => {
        switch (message.type) {
          case 'ready':
            // A hidden webview is torn down and rebuilt when shown again; its
            // `ready` message then asks for everything again.
            this.post({ type: 'positions', positions: this.layout.positions });
            this.update();
            break;
          case 'moved':
            void this.layout.move(message.positions);
            break;
          case 'placed':
            void this.layout.place(message.positions);
            break;
          case 'command':
            void vscode.commands.executeCommand(`drawEer.${message.command}`, document.uri);
            break;
        }
      }),
    );
    void this.layout.reload();
  }

  scheduleUpdate(): void {
    clearTimeout(this.timer);
    const delay = vscode.workspace
      .getConfiguration('drawEer.preview')
      .get<number>('updateDelay', 300);
    this.timer = setTimeout(() => this.update(), delay);
  }

  private update(): void {
    clearTimeout(this.timer);
    this.post({ type: 'source', text: this.document.getText(), version: this.document.version });
  }

  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

function previewTitle(uri: vscode.Uri): string {
  const name = uri.path.split('/').pop() ?? 'diagram';
  return `Preview ${name}`;
}

function webviewOptions(
  extensionUri: vscode.Uri,
): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    // Only the built files: scripts, the HarfBuzz .wasm and the fonts.
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
  };
}
