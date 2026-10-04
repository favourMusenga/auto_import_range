import * as ts from 'typescript-api';

import { classifySource, EMPTY_CONTEXT, ProjectContext, SourceKind } from './classify';
import { DEFAULT_OPTIONS, GroupName, SorterOptions } from './options';

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

/** Put this comment anywhere in a file to make the sorter leave it alone. */
export const SKIP_FILE_MARKER = 'import-sorter: skip-file';

interface Specifier {
  /** Imported name as written (may be a string literal for arbitrary names). */
  name: string;
  alias?: string;
  isType: boolean;
}

interface ImportEntry {
  index: number;
  specifierText: string;
  source: string;
  typeOnly: boolean;
  defaultName?: string;
  namespaceName?: string;
  named: Specifier[];
  hasBraces: boolean;
  sideEffect: boolean;
  attributes: string;
  leading: string[];
  trailing: string[];
  originalText: string;
  /** Contains comments or syntax we do not rewrite: printed exactly as written. */
  preserve: boolean;
  group: number;
  kindRank: number;
}

const SCRIPT_BLOCK_RE = /(<script\b[^>]*>)([\s\S]*?)<\/script>/gi;

/**
 * Computes the edits needed to sort the imports of a file.
 * Returns an empty array when the imports are already sorted.
 */
export function sortImports(
  text: string,
  fileName: string,
  options: Partial<SorterOptions> = {},
  ctx: ProjectContext = EMPTY_CONTEXT,
): TextEdit[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (text.includes(SKIP_FILE_MARKER)) {
    return [];
  }
  if (/\.(vue|svelte)$/i.test(fileName)) {
    return sortScriptBlocks(text, opts, ctx);
  }
  return sortModule(text, fileName, opts, ctx);
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

/** Vue / Svelte: sort each <script> block independently. */
function sortScriptBlocks(text: string, opts: SorterOptions, ctx: ProjectContext): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const match of text.matchAll(SCRIPT_BLOCK_RE)) {
    const [, openTag, body] = match;
    const isTs = /\blang=["']?(ts|tsx)\b/.test(openTag);
    const offset = match.index! + openTag.length;
    for (const edit of sortModule(body, isTs ? 'block.ts' : 'block.js', opts, ctx)) {
      edits.push({ start: edit.start + offset, end: edit.end + offset, newText: edit.newText });
    }
  }
  return edits;
}

function sortModule(text: string, fileName: string, opts: SorterOptions, ctx: ProjectContext): TextEdit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parseErrors: readonly ts.Diagnostic[] = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];

  const runs: ts.ImportDeclaration[][] = [];
  let current: ts.ImportDeclaration[] = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      current.push(statement);
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) {
    runs.push(current);
  }
  if (!runs.length) {
    return [];
  }

  const useSemicolons =
    opts.semicolons === 'always' ||
    (opts.semicolons === 'preserve' && runs.flat().some((d) => d.getText().trimEnd().endsWith(';')));
  const used = opts.removeUnused ? collectUsedNames(sf, text) : undefined;
  const headingLines = new Set(Object.values(opts.groupHeadings).map((h) => `// ${h}`.trim()));

  const edits: TextEdit[] = [];
  for (const run of runs) {
    const edit = sortRun(run, { text, sf, opts, ctx, eol, useSemicolons, used, headingLines });
    if (!edit) {
      continue;
    }
    const brokenSyntax = parseErrors.some((d) => d.start !== undefined && d.start >= edit.start && d.start <= edit.end);
    if (!brokenSyntax && text.slice(edit.start, edit.end) !== edit.newText) {
      edits.push(edit);
    }
  }
  return edits;
}

interface RunContext {
  text: string;
  sf: ts.SourceFile;
  opts: SorterOptions;
  ctx: ProjectContext;
  eol: string;
  useSemicolons: boolean;
  used?: Set<string>;
  headingLines: Set<string>;
}

function sortRun(run: ts.ImportDeclaration[], rc: RunContext): TextEdit | undefined {
  const { text, opts } = rc;
  let start = run[0].getStart();
  let end = run[run.length - 1].end;

  let entries: ImportEntry[] = run.map((decl, i) => {
    const leadingRanges = attachedLeadingComments(text, decl, i === 0, rc.headingLines);
    if (i === 0 && leadingRanges.length) {
      start = leadingRanges[0].pos;
    }
    const trailingRanges = ts.getTrailingCommentRanges(text, decl.end) ?? [];
    if (i === run.length - 1 && trailingRanges.length) {
      end = trailingRanges[trailingRanges.length - 1].end;
    }
    const entry = parseImport(decl, i, rc);
    entry.leading = leadingRanges.map((r) => normalizeEol(text.slice(r.pos, r.end))).filter((c) => !rc.headingLines.has(c.trim()));
    entry.trailing = trailingRanges.map((r) => normalizeEol(text.slice(r.pos, r.end)));
    return entry;
  });

  if (rc.used) {
    entries = removeUnused(entries, rc.used, rc.sf);
  }
  if (opts.mergeDuplicates) {
    entries = mergeDuplicates(entries);
  }
  if (opts.sortSpecifiers) {
    for (const entry of entries) {
      if (!entry.preserve) {
        entry.named.sort((a, b) => compareStrings(a.name, b.name, opts.caseSensitive) || compareStrings(a.alias ?? '', b.alias ?? '', opts.caseSensitive));
      }
    }
  }
  for (const entry of entries) {
    entry.group = resolveGroup(entry, opts, rc.ctx);
  }

  const byGroup = new Map<number, ImportEntry[]>();
  for (const entry of entries) {
    byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry]);
  }

  const sections: string[] = [];
  for (const group of [...byGroup.keys()].sort((a, b) => a - b)) {
    const members = byGroup.get(group)!;
    const keepOrder = !opts.sortSideEffects && members.every((m) => m.sideEffect);
    if (!keepOrder) {
      members.sort((a, b) => compareEntries(a, b, opts));
    }
    const lines: string[] = [];
    const heading = headingFor(group, opts);
    if (heading) {
      lines.push(`// ${heading}`);
    }
    for (const member of members) {
      lines.push(...member.leading);
      const statement = formatEntry(member, rc);
      lines.push(member.trailing.length ? `${statement} ${member.trailing.join(' ')}` : statement);
    }
    sections.push(lines.join('\n'));
  }

  let newText = sections.join('\n'.repeat(opts.blankLinesBetweenGroups + 1));
  if (!newText) {
    // every import was removed: also swallow the whitespace that followed the block
    while (end < text.length && /\s/.test(text[end])) {
      end++;
    }
  }
  newText = newText.replace(/\n/g, rc.eol);
  return { start, end, newText };
}

/**
 * Comments directly above an import travel with it. For the first import of a block,
 * comments separated by a blank line, or sitting at the very top of the file (license
 * headers, `@ts-check`), stay where they are.
 */
function attachedLeadingComments(
  text: string,
  decl: ts.ImportDeclaration,
  isFirst: boolean,
  headingLines: Set<string>,
): ts.CommentRange[] {
  const ranges = ts.getLeadingCommentRanges(text, decl.getFullStart()) ?? [];
  if (!isFirst) {
    return ranges;
  }
  const attached: ts.CommentRange[] = [];
  let nextStart = decl.getStart();
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i];
    const gap = text.slice(range.end, nextStart);
    const isHeading = headingLines.has(text.slice(range.pos, range.end).trim());
    const atFileStart = /^﻿?(#![^\n]*\n)?\s*$/.test(text.slice(0, range.pos));
    if ((gap.match(/\n/g)?.length ?? 0) > 1 || (atFileStart && !isHeading)) {
      break;
    }
    attached.unshift(range);
    nextStart = range.pos;
  }
  return attached;
}

function parseImport(decl: ts.ImportDeclaration, index: number, rc: RunContext): ImportEntry {
  const specifierText = decl.moduleSpecifier.getText();
  const source = ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : specifierText;
  const attrNode = (decl as { attributes?: ts.Node }).attributes ?? (decl as { assertClause?: ts.Node }).assertClause;
  const attributes = attrNode ? ` ${attrNode.getText()}` : '';
  const originalText = decl.getText();
  const clause = decl.importClause;

  const withoutStrings = originalText.replace(specifierText, '').replace(attributes.trim(), '');
  const hasInnerComments = /\/\/|\/\*/.test(withoutStrings);
  const hasPhaseModifier = clause !== undefined && (clause as { phaseModifier?: ts.SyntaxKind }).phaseModifier === ts.SyntaxKind.DeferKeyword;

  const entry: ImportEntry = {
    index,
    specifierText,
    source,
    typeOnly: clause?.isTypeOnly ?? false,
    defaultName: clause?.name?.text,
    named: [],
    hasBraces: false,
    sideEffect: !clause,
    attributes,
    leading: [],
    trailing: [],
    originalText: normalizeEol(originalText),
    preserve: hasInnerComments || hasPhaseModifier,
    group: 0,
    kindRank: 0,
  };

  const bindings = clause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    entry.namespaceName = bindings.name.text;
  } else if (bindings && ts.isNamedImports(bindings)) {
    entry.hasBraces = true;
    entry.named = bindings.elements.map((el) => ({
      name: el.propertyName ? el.propertyName.getText() : el.name.text,
      alias: el.propertyName ? el.name.text : undefined,
      isType: el.isTypeOnly,
    }));
  }
  return entry;
}

function removeUnused(entries: ImportEntry[], used: Set<string>, sf: ts.SourceFile): ImportEntry[] {
  const isJsx = sf.languageVariant === ts.LanguageVariant.JSX;
  const isUsed = (name: string) => used.has(name) || (isJsx && name === 'React');
  return entries.filter((entry) => {
    if (entry.preserve || entry.sideEffect) {
      return true;
    }
    const hadBindings = Boolean(entry.defaultName || entry.namespaceName || entry.named.length);
    if (entry.defaultName && !isUsed(entry.defaultName)) {
      entry.defaultName = undefined;
    }
    if (entry.namespaceName && !isUsed(entry.namespaceName)) {
      entry.namespaceName = undefined;
    }
    entry.named = entry.named.filter((s) => isUsed(s.alias ?? s.name));
    const hasBindings = Boolean(entry.defaultName || entry.namespaceName || entry.named.length);
    // `import {} from 'x'` written on purpose is kept; imports emptied by us are dropped.
    return hasBindings || !hadBindings;
  });
}

function collectUsedNames(sf: ts.SourceFile, text: string): Set<string> {
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      return;
    }
    if (ts.isIdentifier(node)) {
      used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  // Names referenced only from JSDoc ({@link Foo}, @type {Foo}, @see Foo) still count as used.
  for (const match of text.matchAll(/@(?:link|linkcode|linkplain|see|type|param|returns?|typedef)\b[^\n]*/g)) {
    for (const word of match[0].match(/[A-Za-z_$][\w$]*/g) ?? []) {
      used.add(word);
    }
  }
  return used;
}

function mergeDuplicates(entries: ImportEntry[]): ImportEntry[] {
  const result: ImportEntry[] = [];
  for (const entry of entries) {
    const target = entry.preserve ? undefined : result.find((t) => canMerge(t, entry));
    if (!target) {
      result.push(entry);
      continue;
    }
    target.defaultName ??= entry.defaultName;
    target.hasBraces ||= entry.hasBraces;
    for (const spec of entry.named) {
      const existing = target.named.find((s) => s.name === spec.name && s.alias === spec.alias);
      if (!existing) {
        target.named.push(spec);
      } else if (!spec.isType) {
        existing.isType = false; // a value import also covers the type
      }
    }
    target.leading.push(...entry.leading);
    target.trailing.push(...entry.trailing);
  }
  return result;
}

function canMerge(a: ImportEntry, b: ImportEntry): boolean {
  if (a.preserve || a.source !== b.source || a.typeOnly !== b.typeOnly || a.attributes !== b.attributes) {
    return false;
  }
  if (a.sideEffect || b.sideEffect) {
    return a.sideEffect && b.sideEffect;
  }
  if (a.namespaceName || b.namespaceName) {
    // only exact duplicates of namespace imports
    return a.namespaceName === b.namespaceName && a.defaultName === b.defaultName && !a.named.length && !b.named.length;
  }
  return !a.defaultName || !b.defaultName || a.defaultName === b.defaultName;
}

function resolveGroup(entry: ImportEntry, opts: SorterOptions, ctx: ProjectContext): number {
  const candidates: GroupName[] = [];
  const isStyle = opts.styleExtensions.some((ext) => entry.source.toLowerCase().endsWith(ext.toLowerCase()));
  if (entry.sideEffect) {
    candidates.push(...(isStyle ? (['style', 'sideEffect'] as const) : (['sideEffect'] as const)));
  }
  if (entry.typeOnly) {
    candidates.push('type');
  }
  const kind = classifySource(entry.source, opts.internalPatterns, ctx);
  entry.kindRank = KIND_RANK[kind];
  candidates.push(kind);
  if (kind === 'parent' || kind === 'sibling' || kind === 'index') {
    candidates.push('relative', 'internal');
  }
  candidates.push('external');

  for (const candidate of candidates) {
    const index = opts.groups.findIndex((g) => (Array.isArray(g) ? g.includes(candidate) : g === candidate));
    if (index !== -1) {
      return index;
    }
  }
  return opts.groups.length;
}

function headingFor(group: number, opts: SorterOptions): string | undefined {
  const entry = opts.groups[group];
  if (entry === undefined) {
    return undefined;
  }
  const names = Array.isArray(entry) ? entry : [entry];
  for (const name of names) {
    if (opts.groupHeadings[name]) {
      return opts.groupHeadings[name];
    }
  }
  return undefined;
}

/** Order of kinds that end up sharing one group (e.g. `relative` = parent, sibling, index). */
const KIND_RANK: Record<SourceKind, number> = { builtin: 0, external: 1, internal: 2, parent: 3, sibling: 4, index: 5 };

function compareEntries(a: ImportEntry, b: ImportEntry, opts: SorterOptions): number {
  return (
    a.kindRank - b.kindRank ||
    compareStrings(a.source, b.source, opts.caseSensitive) ||
    Number(a.typeOnly) - Number(b.typeOnly) ||
    Number(Boolean(b.namespaceName)) - Number(Boolean(a.namespaceName)) ||
    a.index - b.index
  );
}

function compareStrings(a: string, b: string, caseSensitive: boolean): number {
  if (!caseSensitive) {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la !== lb) {
      return la < lb ? -1 : 1;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatEntry(entry: ImportEntry, rc: RunContext): string {
  if (entry.preserve) {
    return entry.originalText;
  }
  const { opts } = rc;
  const semi = rc.useSemicolons ? ';' : '';
  const spec = requote(entry.specifierText, opts.quoteStyle);

  if (entry.sideEffect) {
    return `import ${spec}${entry.attributes}${semi}`;
  }

  const head = `import ${entry.typeOnly ? 'type ' : ''}`;
  const tail = ` from ${spec}${entry.attributes}${semi}`;
  const prefix: string[] = [];
  if (entry.defaultName) {
    prefix.push(entry.defaultName);
  }
  if (entry.namespaceName) {
    prefix.push(`* as ${entry.namespaceName}`);
  }
  const specifiers = entry.named.map((s) => `${s.isType ? 'type ' : ''}${s.name}${s.alias ? ` as ${s.alias}` : ''}`);
  const showBraces = specifiers.length > 0 || (entry.hasBraces && prefix.length === 0);
  if (!showBraces) {
    return `${head}${prefix.join(', ')}${tail}`;
  }

  const pad = opts.bracketSpacing && specifiers.length ? ' ' : '';
  const braces = `{${pad}${specifiers.join(', ')}${pad}}`;
  const oneLine = `${head}${[...prefix, braces].join(', ')}${tail}`;
  if (opts.maxLineLength <= 0 || oneLine.length <= opts.maxLineLength || specifiers.length === 0) {
    return oneLine;
  }

  const body = specifiers.map((s, i) => `${opts.indent}${s}${i < specifiers.length - 1 || opts.trailingComma ? ',' : ''}`);
  const lead = prefix.length ? `${prefix.join(', ')}, ` : '';
  return `${head}${lead}{\n${body.join('\n')}\n}${tail}`;
}

function requote(literal: string, style: SorterOptions['quoteStyle']): string {
  if (style === 'preserve') {
    return literal;
  }
  const quote = style === 'single' ? "'" : '"';
  const inner = literal.slice(1, -1);
  if (inner.includes("'") || inner.includes('"') || inner.includes('\\')) {
    return literal;
  }
  return `${quote}${inner}${quote}`;
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function scriptKind(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
