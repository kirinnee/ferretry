/**
 * The highlighter's language for a file path, from the extension only (nothing is guessed from content). An id the
 * app's highlighter does not register is plain text there, so a missing entry costs colour and nothing else.
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  nix: 'nix',
  lua: 'lua',
  scala: 'scala',
  r: 'r',
  pl: 'perl',
  diff: 'diff',
  patch: 'diff',
};

const BY_NAME: Readonly<Record<string, string>> = { dockerfile: 'dockerfile' };

export function languageOf(path: string): string | undefined {
  const name = (path.split('/').pop() ?? path).toLowerCase();
  const byName = BY_NAME[name];
  if (byName !== undefined) return byName;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : BY_EXTENSION[name.slice(dot + 1)];
}
