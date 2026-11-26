/** Every OpenCode process gets the same private storage, including its otherwise shared /tmp/opencode. */
export function isolatedEnvironment(home: string): Readonly<Record<string, string>> {
  if (
    !/^\/(?:[A-Za-z0-9_. -]+\/)*[A-Za-z0-9_. -]+$/u.test(home) ||
    home.split('/').some(part => part === '.' || part === '..')
  )
    throw new Error('OpenCode needs a canonical absolute private home');
  return {
    HOME: `${home}/home`,
    XDG_CONFIG_HOME: `${home}/config`,
    XDG_DATA_HOME: `${home}/data`,
    XDG_STATE_HOME: `${home}/state`,
    XDG_CACHE_HOME: `${home}/cache`,
    OPENCODE_DB: `${home}/data/opencode.db`,
    OPENCODE_CONFIG: `${home}/opencode.json`,
    TMPDIR: `${home}/tmp`,
  };
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
