/**
 * Entry point of the extension: syntax errors as diagnostics, completion,
 * and the live preview. The preview draws in its own Web Worker (see
 * webview/), so the extension host only parses for diagnostics and never
 * runs layout.
 */
import * as vscode from 'vscode';
import { suggestionsAt, type SuggestionKind } from './completion';
import { registerDiagnostics } from './diagnostics';
import { PreviewManager } from './preview';

export function activate(context: vscode.ExtensionContext): void {
  registerDiagnostics(context);
  registerCompletion(context);
  new PreviewManager(context).register();
}

export function deactivate(): void {}

const KINDS: Record<SuggestionKind, vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  entity: vscode.CompletionItemKind.Class,
  snippet: vscode.CompletionItemKind.Snippet,
  value: vscode.CompletionItemKind.Value,
};

function registerCompletion(context: vscode.ExtensionContext): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      return suggestionsAt(document.getText(), document.offsetAt(position)).map((s) => {
        const item = new vscode.CompletionItem(s.label, KINDS[s.kind]);
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
