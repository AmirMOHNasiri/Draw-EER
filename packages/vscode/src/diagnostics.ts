/**
 * Syntax errors as VS Code diagnostics (red squiggles and the Problems
 * panel). Only syntax is checked; whatever parses is drawn.
 */
import * as vscode from 'vscode';
import { parse } from '@draw-eer/core';

/** How long to wait after a change before parsing again, in ms. Parsing is fast. */
const DELAY = 150;

export function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('eer');
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const check = (document: vscode.TextDocument) => {
    if (document.languageId !== 'eer') return;
    const { errors } = parse(document.getText());
    collection.set(
      document.uri,
      errors.map((error) => {
        const range = new vscode.Range(
          error.range.start.line,
          error.range.start.column,
          error.range.end.line,
          error.range.end.column,
        );
        const diagnostic = new vscode.Diagnostic(
          range,
          error.message,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'eer';
        return diagnostic;
      }),
    );
  };

  const schedule = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        check(document);
      }, DELAY),
    );
  };

  vscode.workspace.textDocuments.forEach(check);
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearTimeout(timers.get(document.uri.toString()));
      collection.delete(document.uri);
    }),
  );
}
