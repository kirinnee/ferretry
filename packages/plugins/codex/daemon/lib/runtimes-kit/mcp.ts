import {
  isSseUrl,
  type KitDocuments,
  type KitDocumentsInput,
  type KitMcpServer,
  type KitPartialSupportInput,
  type KitPartialSupportNote,
  type KitPlumbingEntry,
  type KitPlumbingInput,
  type KitServerEnvironment,
  type KitSettingsObject,
  type RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The key Codex reads where its sign-in lives, and the value that keeps it in `auth.json` rather than a keyring. */
const CREDENTIAL_STORE_KEY = 'cli_auth_credentials_store';
const CREDENTIAL_STORE_FILE = 'file';

/** The table of `config.toml` that holds MCP servers. */
const SERVERS_TABLE = 'mcp_servers';

/** One server as Codex's `[mcp_servers.<name>]` table; a signed-in one names its token's variable. */
function renderMcpServer(server: KitMcpServer, env: KitServerEnvironment, bearer?: string): KitSettingsObject {
  if (server.url !== undefined)
    return { url: server.url, ...(bearer === undefined ? {} : { bearer_token_env_var: bearer }) };
  return {
    command: server.command,
    ...(server.args !== undefined && server.args.length > 0 ? { args: server.args } : {}),
    ...(Object.keys(env.literal).length > 0 ? { env: env.literal } : {}),
    ...(env.forwarded.length > 0 ? { env_vars: env.forwarded } : {}),
  };
}

/** Where the servers go: the `mcp_servers` table of `config.toml`, beside any the person's own settings already hold. */
function configDocuments(input: KitDocumentsInput): KitDocuments {
  const names = Object.keys(input.servers);
  if (names.length === 0) return { settings: input.settings, serversAt: [SERVERS_TABLE] };
  const existing = input.settings[SERVERS_TABLE];
  return {
    settings: {
      ...input.settings,
      [SERVERS_TABLE]: { ...(isPlainObject(existing) ? existing : {}), ...input.servers },
    },
    serversAt: [SERVERS_TABLE],
  };
}

/** The keys every Codex runtime's `config.toml` carries: the file credential store, and the shared history pool. */
function plumbing(input: KitPlumbingInput): readonly KitPlumbingEntry[] {
  if (input.sqliteHome === undefined) return [];
  return [
    {
      key: CREDENTIAL_STORE_KEY,
      path: [CREDENTIAL_STORE_KEY],
      value: CREDENTIAL_STORE_FILE,
      replacesOwn: true,
    },
    { key: 'sqlite_home', path: ['sqlite_home'], value: input.sqliteHome, replacesOwn: true },
  ];
}

/**
 * Claude skill frontmatter keys Codex does not honour, and what that means, in the product's words.
 * INFERRED from Codex's skill loader, which reads a skill's name, description and metadata only.
 */
export const CODEX_IGNORED_SKILL_KEYS: Readonly<Record<string, (item: string) => string>> = {
  'allowed-tools': item => `${item} limits which tools it may use. Codex ignores that limit and loads the rest.`,
  model: item => `${item} picks its own model. Codex ignores that and uses the runtime's model.`,
  hooks: item => `${item} carries its own hooks. Codex ignores them and loads the rest.`,
};

/** A line of a Claude instructions file that pulls in another file: `@path/to/file.md`. */
const CLAUDE_IMPORT_LINE = /^\s*@[^\s@]+\s*$/m;

/** Whether an instructions body pulls in other files the way Claude's `@path` imports do. */
export const usesClaudeImports = (body: string): boolean => CLAUDE_IMPORT_LINE.test(body);

/** What Codex only half reads among the components that reach it: `@path` imports, SSE servers and some skill frontmatter. */
function partialSupport(input: KitPartialSupportInput): readonly KitPartialSupportNote[] {
  const notes: KitPartialSupportNote[] = [];
  for (const { name, body } of input.instructions) {
    if (!usesClaudeImports(body)) continue;
    notes.push({
      kind: 'instructions',
      name,
      reason: `${name} pulls in other files with @path lines. Codex reads those lines as plain text and does not open the files.`,
    });
  }
  for (const { name, url } of input.mcp) {
    if (!isSseUrl(url)) continue;
    notes.push({
      kind: 'mcp',
      name,
      reason: `${name} is reached over SSE. Codex connects to servers over streamable HTTP, so it may not reach this one.`,
    });
  }
  for (const { name, items } of input.skills) {
    for (const item of items) {
      for (const key of input.skillFrontmatter[item] ?? []) {
        const reason = CODEX_IGNORED_SKILL_KEYS[key];
        if (reason !== undefined) notes.push({ kind: 'skills', name, reason: reason(item) });
      }
    }
  }
  return notes;
}

/** How Codex spells MCP servers and config documents, and what it only half reads. */
export const codexMcpKit: RuntimesHarnessKit = { renderMcpServer, configDocuments, partialSupport, plumbing };
