import type {
  KitDocuments,
  KitDocumentsInput,
  KitMcpServer,
  KitPlumbingEntry,
  KitPlumbingInput,
  KitServerEnvironment,
  KitSettingsObject,
  RuntimesHarnessKit,
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

/** How Codex spells MCP servers and config documents. */
export const codexMcpKit: RuntimesHarnessKit = { renderMcpServer, configDocuments, plumbing };
