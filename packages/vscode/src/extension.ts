/**
 * Entry point of the extension: syntax errors as diagnostics with Quick
 * Fixes, completion, the live preview with its layout file, and export.
 *
 * The preview draws in its own Web Worker (see webview/), so while the user
 * types, the extension host only parses (for diagnostics, fixes and
 * completion). Layout runs in the host only for an export the user asked for.
 */
import * as vscode from 'vscode';
import { suggestionsAt, type SuggestionKind } from './completion';
import { registerDiagnostics } from './diagnostics';
import { Exporter, type ExportFormat } from './export';
import { PreviewManager } from './preview';
import { registerQuickFixes } from './quickfix';

export function activate(context: vscode.ExtensionContext): void {
  registerDiagnostics(context);
  registerQuickFixes(context);
  registerCompletion(context);
  const previews = new PreviewManager(context);
  previews.register();
  registerExport(context, previews);
}

export function deactivate(): void {}

function registerExport(context: vscode.ExtensionContext, previews: PreviewManager): void {
  const exporter = new Exporter(context.extensionUri, (uri) => previews.positionsFor(uri));
  const command = (format: ExportFormat) => async (uri?: vscode.Uri, target?: vscode.Uri) => {
    const document = previews.target(uri);
    if (!document) return undefined;
    try {
      const written = await exporter.export(document, format, target);
      // Tests pass `target` and need no notification.
      if (written && !target) {
        const name = written.path.slice(written.path.lastIndexOf('/') + 1);
        void vscode.window.showInformationMessage(`Exported ${name}.`, 'Open').then((choice) => {
          if (choice === 'Open') void vscode.commands.executeCommand('vscode.open', written);
        });
      }
      return written;
    } catch (error) {
      void vscode.window.showErrorMessage(`Export failed: ${error}`);
      return undefined;
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('drawEer.exportSvg', command('svg')),
    vscode.commands.registerCommand('drawEer.exportPng', command('png')),
  );
}

const KINDS: Record<SuggestionKind, vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  entity: vscode.CompletionItemKind.Class,
  snippet: vscode.CompletionItemKind.Snippet,
  value: vscode.CompletionItemKind.Value,
};

function registerCompletion(context: vscode.ExtensionContext): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      return suggestionsAt(document.getText(), document.offsetAt(position)).map((s, i) => {
        const item = new vscode.CompletionItem(s.label, KINDS[s.kind]);
        // Keep the order given (key, key2, partial, …) instead of VS Code's alphabetical one.
        item.sortText = String(i).padStart(4, '0');
        if (s.insertText !== undefined) {
          item.insertText =
            s.kind === 'snippet' ? new vscode.SnippetString(s.insertText) : s.insertText;
        }
        if (s.detail !== undefined) item.detail = s.detail;
        return item;
      });
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'eer' }, provider, ':', ' '),
  );
}
