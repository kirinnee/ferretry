/** `import text from './file.md' with { type: 'text' }`: the bundler inlines the file; the generated `instructions.ts` uses it. */
declare module '*.md' {
  const text: string;
  export default text;
}
