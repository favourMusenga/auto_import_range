import { builtinModules } from 'node:module';

export type SourceKind = 'builtin' | 'external' | 'internal' | 'parent' | 'sibling' | 'index';

/** Project facts that help tell "your code" apart from installed packages. */
export interface ProjectContext {
  /** Prefix aliases from tsconfig `paths`, e.g. `@/` for `"@/*"`. */
  aliasPrefixes: string[];
  /** Exact aliases from tsconfig `paths` without a wildcard, e.g. `config`. */
  aliasExact: string[];
  /** Top-level file/folder names under tsconfig `baseUrl` (so `components/Button` is internal). */
  baseUrlEntries: string[];
  /** `name` from the nearest package.json (self-imports are internal). */
  packageName?: string;
}

export const EMPTY_CONTEXT: ProjectContext = { aliasPrefixes: [], aliasExact: [], baseUrlEntries: [] };

const BUILTINS = new Set(builtinModules);
const RUNTIME_PREFIXES = ['node:', 'bun:'];
const INDEX_RE = /^\.\/?(index(\.[cm]?[jt]sx?)?)?$/;

export function classifySource(source: string, internalPatterns: string[], ctx: ProjectContext): SourceKind {
  if (RUNTIME_PREFIXES.some((p) => source.startsWith(p)) || BUILTINS.has(source)) {
    return 'builtin';
  }
  if (INDEX_RE.test(source)) {
    return 'index';
  }
  if (source === '..' || source.startsWith('../')) {
    return 'parent';
  }
  if (source.startsWith('./')) {
    return 'sibling';
  }
  if (source.startsWith('/') || isInternal(source, internalPatterns, ctx)) {
    return 'internal';
  }
  return 'external';
}

function isInternal(source: string, patterns: string[], ctx: ProjectContext): boolean {
  for (const pattern of patterns) {
    if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        if (new RegExp(pattern.slice(1, -1)).test(source)) {
          return true;
        }
      } catch {
        // invalid regex in settings: ignore it
      }
    } else if (pattern && source.startsWith(pattern)) {
      return true;
    }
  }
  if (ctx.aliasPrefixes.some((p) => source.startsWith(p))) {
    return true;
  }
  const firstSegment = packageRoot(source);
  if (ctx.aliasExact.includes(source) || ctx.aliasExact.includes(firstSegment)) {
    return true;
  }
  if (ctx.packageName && firstSegment === ctx.packageName) {
    return true;
  }
  return ctx.baseUrlEntries.includes(source.split('/')[0]);
}

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`. */
function packageRoot(source: string): string {
  const parts = source.split('/');
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
