export type GroupName =
  | 'sideEffect'
  | 'builtin'
  | 'external'
  | 'internal'
  | 'parent'
  | 'sibling'
  | 'index'
  | 'relative'
  | 'style'
  | 'type';

export interface SorterOptions {
  /** Group order; an inner array means those groups share one section. */
  groups: (GroupName | GroupName[])[];
  /** Prefixes (or `/regex/`) that mark a module as internal. */
  internalPatterns: string[];
  /** Comment written above each group, keyed by group name. */
  groupHeadings: Record<string, string>;
  blankLinesBetweenGroups: number;
  sortSpecifiers: boolean;
  mergeDuplicates: boolean;
  removeUnused: boolean;
  sortSideEffects: boolean;
  caseSensitive: boolean;
  /** 0 disables wrapping. */
  maxLineLength: number;
  indent: string;
  quoteStyle: 'preserve' | 'single' | 'double';
  semicolons: 'preserve' | 'always' | 'never';
  trailingComma: boolean;
  bracketSpacing: boolean;
  styleExtensions: string[];
}

export const DEFAULT_OPTIONS: SorterOptions = {
  groups: ['sideEffect', 'builtin', 'external', 'internal', 'relative', 'style'],
  internalPatterns: ['@/', '~/', '#'],
  groupHeadings: {},
  blankLinesBetweenGroups: 1,
  sortSpecifiers: true,
  mergeDuplicates: true,
  removeUnused: false,
  sortSideEffects: false,
  caseSensitive: false,
  maxLineLength: 100,
  indent: '  ',
  quoteStyle: 'preserve',
  semicolons: 'preserve',
  trailingComma: true,
  bracketSpacing: true,
  styleExtensions: ['.css', '.scss', '.sass', '.less', '.styl', '.pcss'],
};
