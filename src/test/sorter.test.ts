import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectContext } from '../core/classify';
import { SorterOptions } from '../core/options';
import { applyEdits, sortImports } from '../core/sorter';

function sort(input: string, options: Partial<SorterOptions> = {}, fileName = 'file.ts', ctx?: ProjectContext): string {
  return applyEdits(input, sortImports(input, fileName, options, ctx));
}

const lines = (...l: string[]) => l.join('\n');

describe('grouping', () => {
  it('orders builtin, external, internal, relative like isort', () => {
    const input = lines(
      "import { helper } from './helper';",
      "import React from 'react';",
      "import { join } from 'path';",
      "import { Button } from '@/components/Button';",
      "import fs from 'node:fs';",
      "import { z } from 'zod';",
      "import config from '../config';",
      '',
      'console.log(1);',
    );
    assert.equal(
      sort(input),
      lines(
        "import fs from 'node:fs';",
        "import { join } from 'path';",
        '',
        "import React from 'react';",
        "import { z } from 'zod';",
        '',
        "import { Button } from '@/components/Button';",
        '',
        "import config from '../config';",
        "import { helper } from './helper';",
        '',
        'console.log(1);',
      ),
    );
  });

  it('keeps side-effect imports first and styles last, in original order', () => {
    const input = lines("import './b.css';", "import x from 'x';", "import 'zone.js';", "import './a.css';", "import 'reflect-metadata';");
    assert.equal(
      sort(input),
      lines("import 'zone.js';", "import 'reflect-metadata';", '', "import x from 'x';", '', "import './b.css';", "import './a.css';"),
    );
  });

  it('detects tsconfig aliases and baseUrl folders from the project context', () => {
    const ctx: ProjectContext = { aliasPrefixes: ['@app/'], aliasExact: ['config'], baseUrlEntries: ['components'], packageName: 'my-lib' };
    const input = lines(
      "import a from '@app/a';",
      "import b from 'components/b';",
      "import c from 'config';",
      "import d from 'my-lib/utils';",
      "import e from 'lodash';",
    );
    assert.equal(
      sort(input, {}, 'file.ts', ctx),
      lines("import e from 'lodash';", '', "import a from '@app/a';", "import b from 'components/b';", "import c from 'config';", "import d from 'my-lib/utils';"),
    );
  });

  it('supports a separate type group and headings', () => {
    const input = lines("import type { Foo } from './foo';", "import { bar } from './bar';", "import fs from 'fs';");
    const options: Partial<SorterOptions> = {
      groups: ['builtin', 'external', 'relative', 'type'],
      groupHeadings: { builtin: 'Node', relative: 'Local', type: 'Types' },
    };
    const expected = lines(
      '// Node',
      "import fs from 'fs';",
      '',
      '// Local',
      "import { bar } from './bar';",
      '',
      '// Types',
      "import type { Foo } from './foo';",
    );
    assert.equal(sort(input, options), expected);
    // Headings are recognised on re-run, not duplicated.
    assert.equal(sort(expected, options), expected);
  });

  it('sorts parent, then sibling, then index paths (deepest parent first)', () => {
    const input = lines("import a from './a';", "import b from '../b';", "import c from '../../c';", "import d from '.';");
    assert.equal(sort(input), lines("import c from '../../c';", "import b from '../b';", "import a from './a';", "import d from '.';"));
  });
});

describe('statements', () => {
  it('sorts specifiers and merges duplicate imports', () => {
    const input = lines("import { b, a } from 'x';", "import X, { c, type T } from 'x';", "import { a } from 'x';");
    assert.equal(sort(input), lines("import X, { a, b, c, type T } from 'x';"));
  });

  it('does not merge type-only and value imports or namespace imports', () => {
    const input = lines("import type { A } from 'x';", "import { b } from 'x';", "import * as ns from 'x';");
    assert.equal(sort(input), lines("import * as ns from 'x';", "import { b } from 'x';", "import type { A } from 'x';"));
  });

  it('wraps long imports', () => {
    const input = "import { alphaAlpha, betaBeta, gammaGamma } from 'some-module';";
    assert.equal(
      sort(input, { maxLineLength: 40 }),
      lines('import {', '  alphaAlpha,', '  betaBeta,', '  gammaGamma,', "} from 'some-module';"),
    );
  });

  it('unwraps imports that fit on one line', () => {
    assert.equal(sort(lines('import {', '  b,', '  a', "} from 'x';")), "import { a, b } from 'x';");
  });

  it('preserves missing semicolons and can force quotes', () => {
    assert.equal(sort(lines('import b from "b"', 'import a from "a"'), { quoteStyle: 'single' }), lines("import a from 'a'", "import b from 'b'"));
  });

  it('keeps import attributes', () => {
    assert.equal(sort(lines("import z from 'z';", "import data from './data.json' with { type: 'json' };")), lines("import z from 'z';", '', "import data from './data.json' with { type: 'json' };"));
  });
});

describe('comments and layout', () => {
  it('moves comments with their import but keeps the file header in place', () => {
    const input = lines(
      '/* license header */',
      '',
      "'use client';",
      '',
      "import b from 'b'; // trailing b",
      '// about a',
      "import a from 'a';",
      '',
      'export const x = 1;',
    );
    assert.equal(
      sort(input),
      lines('/* license header */', '', "'use client';", '', '// about a', "import a from 'a';", "import b from 'b'; // trailing b", '', 'export const x = 1;'),
    );
  });

  it('leaves imports with inner comments untouched', () => {
    const input = lines("import { b /* keep */, a } from 'z';", "import y from 'y';");
    assert.equal(sort(input), lines("import y from 'y';", "import { b /* keep */, a } from 'z';"));
  });

  it('preserves CRLF line endings', () => {
    const input = "import b from './b';\r\nimport a from 'a';\r\n";
    assert.equal(sort(input), "import a from 'a';\r\n\r\nimport b from './b';\r\n");
  });

  it('respects the skip-file marker', () => {
    const input = lines('// import-sorter: skip-file', "import b from 'b';", "import a from 'a';");
    assert.equal(sort(input), input);
  });

  it('does not touch files with broken import syntax', () => {
    const input = lines("import { b from 'b';", "import a from 'a';");
    assert.equal(sort(input), input);
  });

  it('returns no edits when already sorted', () => {
    assert.deepEqual(sortImports(lines("import a from 'a';", "import b from 'b';"), 'f.ts'), []);
  });
});

describe('removeUnused', () => {
  it('removes unused names and empty imports', () => {
    const input = lines("import { used, unused } from 'a';", "import Gone from 'gone';", "import 'side-effect';", '', 'used();');
    assert.equal(sort(input, { removeUnused: true }), lines("import 'side-effect';", '', "import { used } from 'a';", '', 'used();'));
  });

  it('keeps React in JSX files and names referenced from JSDoc', () => {
    const input = lines("import React from 'react';", "import { Foo } from './foo';", '', '/** See {@link Foo} */', 'export const el = <div />;');
    assert.equal(sort(input, { removeUnused: true }, 'x.tsx'), lines("import React from 'react';", '', "import { Foo } from './foo';", '', '/** See {@link Foo} */', 'export const el = <div />;'));
  });
});

describe('vue / svelte', () => {
  it('sorts inside <script> blocks', () => {
    const input = lines('<template><div /></template>', '<script setup lang="ts">', "import { ref } from 'vue';", "import fs from 'fs';", '</script>');
    assert.equal(sort(input, {}, 'App.vue'), lines('<template><div /></template>', '<script setup lang="ts">', "import fs from 'fs';", '', "import { ref } from 'vue';", '</script>'));
  });
});
