/**
 * Quick Fixes (the light bulb, Ctrl+.) for syntax errors. The parser attaches
 * a fix to every error it knows how to repair (`ParseError.fix`); this
 * provider only turns those into VS Code edits.
 *
 * It parses the document again instead of reading the diagnostics, so a fix
 * always matches the current text even if the diagnostics are a few
 * milliseconds behind the typing (they are updated after a short delay).
 */
import * as vscode from 'vscode';
import { parse } from '@draw-eer/core';
import { toRange } from './diagnostics';

export function registerQuickFixes(context: vscode.ExtensionContext): void {
  const provider: vscode.CodeActionProvider = {
    provideCodeActions(document, range, codeActionContext) {
      const actions: vscode.CodeAction[] = [];
      for (const error of parse(document.getText()).errors) {
        if (!error.fix) continue;
        const errorRange = toRange(error.range);
        // Touching counts: the cursor right after a misspelled word still gets its fix.
        if (!errorRange.intersection(range)) continue;

        const action = new vscode.CodeAction(error.fix.title, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        for (const edit of error.fix.edits) {
          action.edit.replace(document.uri, toRange(edit.range), edit.newText);
        }
        action.diagnostics = codeActionContext.diagnostics.filter(
          (d) => d.message === error.message && d.range.isEqual(errorRange),
        );
        // Preferred fixes also run with "Auto Fix" (Shift+Alt+.).
        action.isPreferred = true;
        actions.push(action);
      }
      return actions;
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ language: 'eer' }, provider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
  );
}
