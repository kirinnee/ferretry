/** Paths relative to one ferret's private home; the descriptor and every native process share these names. */
export const OPENCODE_HOME_ENV = {
  HOME: 'home',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  XDG_CACHE_HOME: 'cache',
  OPENCODE_DB: 'data/opencode.db',
  OPENCODE_CONFIG: 'opencode.json',
  TMPDIR: 'tmp',
};

/** Every OpenCode process gets the same private storage, including its otherwise shared /tmp/opencode. */
export function isolatedEnvironment(home: string): Readonly<Record<string, string>> {
  if (
    !/^\/(?:[A-Za-z0-9_. -]+\/)*[A-Za-z0-9_. -]+$/u.test(home) ||
    home.split('/').some(part => part === '.' || part === '..')
  )
    throw new Error('OpenCode needs a canonical absolute private home');
  return Object.fromEntries(Object.entries(OPENCODE_HOME_ENV).map(([name, relative]) => [name, `${home}/${relative}`]));
}

/** These inherited selectors must never attach to a shared server or carry an Anthropic subscription. */
const UNSET = [
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_SERVER',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDECODE',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
] as const;

/** Prefixing opaque Vault environments changes only public selectors; no credential is opened here. */
export function isolatedCommand(home: string, binary: string, args: readonly string[]): readonly string[] {
  return [
    'env',
    ...UNSET.flatMap(name => ['-u', name]),
    ...Object.entries(isolatedEnvironment(home)).map(([name, value]) => `${name}=${value}`),
    binary,
    ...args,
    '--standalone',
  ];
}
