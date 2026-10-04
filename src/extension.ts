import * as vscode from 'vscode';

import { DEFAULT_OPTIONS, SorterOptions } from './core/options';
import { getProjectContext } from './core/project';
import { applyEdits, sortImports, TextEdit } from './core/sorter';

const LANGUAGES = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue', 'svelte'];
const FILE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,svelte}';
const EXCLUDE_GLOB = '**/{node_modules,dist,out,build,coverage,.git,.next}/**';
const CODE_ACTION_KIND = vscode.CodeActionKind.Source.append('importSorter');

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Import Sorter');
  const selector = LANGUAGES.map((language) => ({ language }));

  context.subscriptions.push(
    output,
    vscode.commands.registerTextEditorCommand('importSorter.sortImports', async (editor) => {
      const edits = computeEdits(editor.document, editor.options);
      if (!edits.length) {
        vscode.window.setStatusBarMessage('Import Sorter: imports already sorted', 2000);
        return;
      }
      await editor.edit((builder) => {
        for (const edit of edits) {
          builder.replace(edit.range, edit.newText);
        }
      });
    }),

    vscode.commands.registerCommand('importSorter.sortImportsInFolder', (uri?: vscode.Uri) => sortFolder(uri)),

    vscode.workspace.onWillSaveTextDocument((event) => {
      const { document } = event;
      if (!LANGUAGES.includes(document.languageId) || event.reason === vscode.TextDocumentSaveReason.AfterDelay) {
        return;
      }
      if (!vscode.workspace.getConfiguration('importSorter', document.uri).get<boolean>('sortOnSave')) {
        return;
      }
      event.waitUntil(Promise.resolve(computeEdits(document)));
    }),

    // Lets users opt in via "editor.codeActionsOnSave": { "source.importSorter": "explicit" }
    vscode.languages.registerCodeActionsProvider(
      selector,
      {
        provideCodeActions(document, _range, ctx) {
          if (ctx.only && !CODE_ACTION_KIND.intersects(ctx.only)) {
            return [];
          }
          const edits = computeEdits(document);
          if (!edits.length) {
            return [];
          }
          const action = new vscode.CodeAction('Sort imports (Import Sorter)', CODE_ACTION_KIND);
          action.edit = new vscode.WorkspaceEdit();
          action.edit.set(document.uri, edits);
          return [action];
        },
      },
      { providedCodeActionKinds: [CODE_ACTION_KIND] },
    ),
  );
}

export function deactivate(): void {}

function computeEdits(document: vscode.TextDocument, editorOptions?: vscode.TextEditorOptions): vscode.TextEdit[] {
  try {
    const text = document.getText();
    return sortText(text, document.uri, document.languageId, editorOptions).map(
      (e) => new vscode.TextEdit(new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.newText),
    );
  } catch (err) {
    output.appendLine(`Failed to sort ${document.uri.fsPath}: ${err instanceof Error ? err.stack : String(err)}`);
    return [];
  }
}

function sortText(text: string, uri: vscode.Uri, languageId: string, editorOptions?: vscode.TextEditorOptions): TextEdit[] {
  const options = readOptions(uri, languageId, editorOptions);
  const detectPaths = vscode.workspace.getConfiguration('importSorter', uri).get<boolean>('detectTsconfigPaths', true);
  const ctx = getProjectContext(uri.scheme === 'file' ? uri.fsPath : '', detectPaths);
  return sortImports(text, fileNameFor(uri, languageId), options, ctx);
}

/** Untitled documents have no extension, so derive one from the language. */
function fileNameFor(uri: vscode.Uri, languageId: string): string {
  if (/\.[a-z]+$/i.test(uri.path)) {
    return uri.path;
  }
  const ext: Record<string, string> = { typescriptreact: '.tsx', javascript: '.js', javascriptreact: '.jsx', vue: '.vue', svelte: '.svelte' };
  return `${uri.path}${ext[languageId] ?? '.ts'}`;
}

function readOptions(uri: vscode.Uri, languageId: string, editorOptions?: vscode.TextEditorOptions): SorterOptions {
  const cfg = vscode.workspace.getConfiguration('importSorter', uri);
  const editorCfg = vscode.workspace.getConfiguration('editor', { uri, languageId });
  const insertSpaces = editorOptions?.insertSpaces ?? editorCfg.get<boolean>('insertSpaces', true);
  const tabSize = Number(editorOptions?.tabSize ?? editorCfg.get<number>('tabSize', 2)) || 2;

  const get = <K extends keyof SorterOptions>(key: K): SorterOptions[K] => cfg.get<SorterOptions[K]>(key, DEFAULT_OPTIONS[key]);
  return {
    groups: get('groups'),
    internalPatterns: get('internalPatterns'),
    groupHeadings: get('groupHeadings'),
    blankLinesBetweenGroups: Math.max(0, Math.floor(get('blankLinesBetweenGroups'))),
    sortSpecifiers: get('sortSpecifiers'),
    mergeDuplicates: get('mergeDuplicates'),
    removeUnused: get('removeUnused'),
    sortSideEffects: get('sortSideEffects'),
    caseSensitive: get('caseSensitive'),
    maxLineLength: get('maxLineLength'),
    indent: insertSpaces ? ' '.repeat(tabSize) : '\t',
    quoteStyle: get('quoteStyle'),
    semicolons: get('semicolons'),
    trailingComma: get('trailingComma'),
    bracketSpacing: get('bracketSpacing'),
    styleExtensions: get('styleExtensions'),
  };
}

async function sortFolder(uri?: vscode.Uri): Promise<void> {
  const base = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!base) {
    vscode.window.showWarningMessage('Import Sorter: open a folder first.');
    return;
  }
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(base, FILE_GLOB), EXCLUDE_GLOB);
  if (!files.length) {
    vscode.window.showInformationMessage('Import Sorter: no JS/TS files found.');
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    `Sort imports in ${files.length} file(s) under ${vscode.workspace.asRelativePath(base)}?`,
    { modal: true },
    'Sort',
  );
  if (answer !== 'Sort') {
    return;
  }

  let changed = 0;
  let failed = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Sorting imports', cancellable: true },
    async (progress, token) => {
      for (const file of files) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({ increment: 100 / files.length, message: vscode.workspace.asRelativePath(file) });
        try {
          const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString());
          if (open) {
            // Open documents are edited in the editor so unsaved changes are not clobbered.
            const edits = computeEdits(open);
            if (edits.length) {
              const edit = new vscode.WorkspaceEdit();
              edit.set(open.uri, edits);
              await vscode.workspace.applyEdit(edit);
              changed++;
            }
            continue;
          }
          const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
          const edits = sortText(text, file, languageFor(file.path));
          if (edits.length) {
            await vscode.workspace.fs.writeFile(file, Buffer.from(applyEdits(text, edits), 'utf8'));
            changed++;
          }
        } catch (err) {
          failed++;
          output.appendLine(`Failed to sort ${file.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  );

  const suffix = failed ? ` (${failed} failed, see the "Import Sorter" output)` : '';
  vscode.window.showInformationMessage(`Import Sorter: updated ${changed} of ${files.length} file(s)${suffix}.`);
}

function languageFor(path: string): string {
  if (/\.tsx$/i.test(path)) return 'typescriptreact';
  if (/\.[cm]?ts$/i.test(path)) return 'typescript';
  if (/\.jsx$/i.test(path)) return 'javascriptreact';
  if (/\.vue$/i.test(path)) return 'vue';
  if (/\.svelte$/i.test(path)) return 'svelte';
  return 'javascript';
}
