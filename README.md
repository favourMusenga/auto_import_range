# Import Sorter — isort for TypeScript / JavaScript

Sorts and groups the imports in `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.vue` and `.svelte` files, the way Python's **isort** does.

**Before**

```ts
import { helper } from './helper';
import React, { useState } from 'react';
import { join } from 'path';
import { Button } from '@/components/Button';
import fs from 'node:fs';
import { useEffect } from 'react';
import './styles.css';
```

**After** (`Shift+Alt+S`)

```ts
import fs from 'node:fs';
import { join } from 'path';

import React, { useEffect, useState } from 'react';

import { Button } from '@/components/Button';

import { helper } from './helper';

import './styles.css';
```

## Features

- **isort-style groups**: side-effect imports → Node built-ins → installed packages → your own aliases → relative files → stylesheets. You can change the order.
- **Detects your aliases automatically** from `tsconfig.json`/`jsconfig.json` (`paths`, `baseUrl`), from `package.json` `name` (self-imports) and from `#subpath` imports.
- **Sorts named imports**: `{ c, a, b }` → `{ a, b, c }`.
- **Merges duplicate imports** from the same module.
- **Removes unused imports** (opt-in).
- **Group headings** like isort's `import_heading_*`, e.g. `// Third party`.
- **Wraps long imports** over several lines, and puts short ones back on one line.
- **Keeps comments** attached to their import; leaves license headers, `'use client'` and shebangs where they are.
- **Safe**: side-effect imports keep their order, imports with comments inside braces are left as written, and files with broken import syntax are not changed.
- **Sort on save**, a **code action** for `editor.codeActionsOnSave`, and **Sort Imports in Folder** from the Explorer context menu.
- **Vue / Svelte** `<script>` blocks.
- Keeps your quote style, semicolons and line endings (or forces them).

## Usage

| How | What |
| --- | --- |
| `Shift+Alt+S` / right-click → **Sort Imports** | Sort the current file |
| Explorer right-click on a folder → **Sort Imports in Folder** | Sort every JS/TS file under it (skips `node_modules`, `dist`, …) |
| `"importSorter.sortOnSave": true` | Sort on every save |
| `"editor.codeActionsOnSave": { "source.importSorter": "explicit" }` | Sort on save together with your other code actions |

To exclude a file, add this comment anywhere in it:

```ts
// import-sorter: skip-file
```

> If you use this extension, turn off VS Code's built-in `source.organizeImports` on save, or the two will fight over the order.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `importSorter.sortOnSave` | `false` | Sort when saving. |
| `importSorter.groups` | `["sideEffect","builtin","external","internal","relative","style"]` | Group order. Use a nested array to put several groups in one section, e.g. `["builtin", ["external","internal"], "relative"]`. Groups: `sideEffect`, `builtin`, `external`, `internal`, `parent`, `sibling`, `index`, `relative`, `style`, `type`. |
| `importSorter.internalPatterns` | `["@/", "~/", "#"]` | Prefixes treated as your own code. `/regex/` is supported. |
| `importSorter.detectTsconfigPaths` | `true` | Read aliases from tsconfig/jsconfig. |
| `importSorter.groupHeadings` | `{}` | e.g. `{ "builtin": "Node", "external": "Third party", "internal": "Project", "relative": "Local" }` |
| `importSorter.blankLinesBetweenGroups` | `1` | Blank lines between groups. |
| `importSorter.sortSpecifiers` | `true` | Sort names inside `{ }`. |
| `importSorter.mergeDuplicates` | `true` | Merge imports from the same module. |
| `importSorter.removeUnused` | `false` | Remove names that are never used. |
| `importSorter.sortSideEffects` | `false` | Also sort `import 'x'` (their order can matter). |
| `importSorter.caseSensitive` | `false` | Case-sensitive ordering. |
| `importSorter.maxLineLength` | `100` | Wrap longer imports; `0` = never wrap. |
| `importSorter.quoteStyle` | `preserve` | `preserve`, `single` or `double`. |
| `importSorter.semicolons` | `preserve` | `preserve`, `always` or `never`. |
| `importSorter.trailingComma` | `true` | Trailing comma in wrapped imports. |
| `importSorter.bracketSpacing` | `true` | `{ a }` vs `{a}`. |
| `importSorter.styleExtensions` | `.css, .scss, …` | Side-effect imports with these extensions go in the `style` group. |

Example: put `import type` statements in their own group at the end, with headings:

```jsonc
"importSorter.groups": ["sideEffect", "builtin", "external", "internal", "relative", "style", "type"],
"importSorter.groupHeadings": { "external": "Packages", "internal": "App", "type": "Types" }
```

## Development

```bash
npm install
npm test          # unit tests for the sorting logic
npm run compile   # type-check + bundle to dist/
npm run vsix      # build an installable .vsix
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

### TypeScript version

The project is compiled and type-checked with **TypeScript 7** (the native Go compiler, `typescript@7`).
TypeScript 7 no longer ships an in-process JavaScript API (its `typescript/unstable/*` API talks to a native `tsc` binary over IPC), so the sorter parses code with **TypeScript 6** installed under the alias `typescript-api` (`npm:typescript@^6`). That parser is bundled into `dist/extension.js`, so the extension has no runtime dependencies and needs no native binary.
