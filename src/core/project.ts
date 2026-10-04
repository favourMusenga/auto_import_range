import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript-api';

import { EMPTY_CONTEXT, ProjectContext } from './classify';

const CODE_FILE_RE = /\.(d\.ts|[cm]?[jt]sx?|json)$/;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build']);

interface CacheEntry {
  key: string;
  ctx: ProjectContext;
}

const cache = new Map<string, CacheEntry>();

/** Builds (and caches) the project context for a file from its nearest tsconfig/jsconfig and package.json. */
export function getProjectContext(fileName: string, detectTsconfigPaths: boolean): ProjectContext {
  if (!path.isAbsolute(fileName)) {
    return EMPTY_CONTEXT;
  }
  const dir = path.dirname(fileName);
  const configPath = detectTsconfigPaths ? findUp(dir, ['tsconfig.json', 'jsconfig.json']) : undefined;
  const pkgPath = findUp(dir, ['package.json']);
  const cacheKey = `${configPath ?? ''}|${pkgPath ?? ''}`;
  const stamp = `${mtime(configPath)}|${mtime(pkgPath)}`;

  const hit = cache.get(cacheKey);
  if (hit && hit.key === stamp) {
    return hit.ctx;
  }

  const ctx: ProjectContext = { aliasPrefixes: [], aliasExact: [], baseUrlEntries: [] };
  if (configPath) {
    readTsconfig(configPath, ctx);
  }
  if (pkgPath) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string') {
        ctx.packageName = pkg.name;
      }
    } catch {
      // unreadable package.json: no self-name detection
    }
  }
  cache.set(cacheKey, { key: stamp, ctx });
  return ctx;
}

function readTsconfig(configPath: string, ctx: ProjectContext): void {
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error || !config) {
    return;
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath), undefined, configPath);
  const { paths, baseUrl } = parsed.options;

  for (const key of Object.keys(paths ?? {})) {
    const star = key.indexOf('*');
    if (star === -1) {
      ctx.aliasExact.push(key);
    } else if (star > 0) {
      ctx.aliasPrefixes.push(key.slice(0, star));
    }
  }

  if (baseUrl) {
    try {
      for (const entry of fs.readdirSync(baseUrl, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (entry.isDirectory()) {
          ctx.baseUrlEntries.push(entry.name);
        } else if (CODE_FILE_RE.test(entry.name)) {
          ctx.baseUrlEntries.push(entry.name.replace(CODE_FILE_RE, ''));
        }
      }
    } catch {
      // baseUrl does not exist
    }
  }
}

function findUp(startDir: string, names: string[]): string | undefined {
  let dir = startDir;
  for (;;) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function mtime(file: string | undefined): number {
  if (!file) {
    return 0;
  }
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
