/**
 * The languages a code fence is highlighted in: the one list that the Markdown pipeline loads grammars for (`lib/markdown.tsx`, one
 * literal import each) and that the authoring prompt prints for the author. Pure data, so the prompt can import it without the renderer.
 * A language that is not here is drawn as plain text, which is not an error.
 *
 * To add a language: add its Shiki grammar name here and its import to `LANGUAGE_LOADERS` in `lib/markdown.tsx` (the type of that table
 * makes a missing or an extra entry a compile error, and `code-languages.test.ts` checks the imports and a sample of each language).
 */
export const CODE_LANGUAGES = [
  'java',
  'typescript',
  'tsx',
  'javascript',
  'python',
  'bash',
  'sql',
  'json',
  'yaml',
  'xml',
  'diff',
  'shellsession',
  'go',
  'rust',
  'html',
  'css',
  'dockerfile',
  'toml',
  'markdown',
  'ini',
] as const

export type CodeLanguage = (typeof CODE_LANGUAGES)[number]
