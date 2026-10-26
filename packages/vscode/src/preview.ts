/**
 * The live preview: one webview panel per `.eer` document.
 *
 * The extension host only sends the document's text, after typing pauses
 * (`drawEer.preview.updateDelay`). The webview draws it in a Web Worker
 * (webview/worker.ts), so even a large diagram never blocks the editor or
 * other extensions; while the worker is busy, only the newest text waits.
 */
import * as vscode from 'vscode';
import type { ToWebview, FromWebview, PreviewState } from '../webview/protocol';
import { createNonce, previewHtml } from './html';

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
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly document: vscode.TextDocument,
    extensionUri: vscode.Uri,
  ) {
    const webview = panel.webview;
    webview.html = previewHtml({
      cspSource: webview.cspSource,
      asset: (path) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', path)).toString(),
      nonce: createNonce(),
      document: document.uri.toString(),
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: FromWebview) => {
        if (message.type === 'ready') this.update();
      }),
      // A hidden webview is torn down and rebuilt when shown again; its
      // `ready` message then asks for the text.
    );
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
    const message: ToWebview = {
      type: 'source',
      text: this.document.getText(),
      version: this.document.version,
    };
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
