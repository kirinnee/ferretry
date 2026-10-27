/**
 * MCP server declarations, read out of the documents each harness reads them from. Pure.
 *
 * Every function takes a document already parsed (JSON or TOML: the adapter parses, so this module
 * never touches a file) and answers what the HARNESS would make of it — the transport it infers, the
 * names it uses — or a problem in words when a document is not what the harness accepts. The
 * declaration keeps the command's arguments and environment and the headers, because a check must
 * reach the server the way the harness does; none of that leaves the daemon (see `toWire` in
 * `./service.ts`).
 */
import type { McpApproval, McpTransport } from '@ferretry/protocol';

/** Claude Code's `oauth` block on an HTTP or SSE server: `clientId`, and the fixed `callbackPort` it was registered with. */
export interface ClaudeOAuthClient {
  readonly clientId: string;
  readonly callbackPort?: number;
}

/** One server as one document declares it. */
export type McpDeclaration =
  | {
      readonly name: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly disabled?: true;
    }
  | {
      readonly name: string;
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** Codex's `bearer_token_env_var`: a variable the harness reads the token from. */
      readonly bearerVariable?: string;
      /** Claude's `oauth` block: a client registered by hand with the provider (`.mcp.json` only). */
      readonly oauth?: ClaudeOAuthClient;
      readonly disabled?: true;
    };

export interface DeclarationsRead {
  readonly servers: readonly McpDeclaration[];
  /** Entries the harness would refuse too, each said once. */
  readonly problems: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const stringRecord = (value: unknown): Readonly<Record<string, string>> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {};

/** An address ending in `/sse` is the legacy SSE transport, as both harnesses and the fleet adapter read it. */
export const isSseAddress = (url: string): boolean => /\/sse\/?(?:[?#].*)?$/iu.test(url);

/** What a person may be shown of an address: no credentials, no query, no fragment. */
export function displayAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'an address that does not parse';
  }
}

/** What a person may be shown of a command: the program, never its arguments (they can hold keys). */
export const displayCommand = (command: string): string => command.trim().split(/\s+/u)[0] ?? command;

export const displayTarget = (declaration: McpDeclaration): string =>
  declaration.transport === 'stdio' ? displayCommand(declaration.command) : displayAddress(declaration.url);

/** Claude's `oauth` block, when it names a client: the two fields a sign-in can use, and nothing else. */
function claudeOAuthClient(value: unknown): ClaudeOAuthClient | undefined {
  if (!isRecord(value) || typeof value.clientId !== 'string' || value.clientId.trim() === '') return undefined;
  const port = value.callbackPort;
  const usable = typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
  return { clientId: value.clientId.trim(), ...(usable ? { callbackPort: port } : {}) };
}

/** One Claude `mcpServers` entry (`.claude.json`, `.mcp.json`, a project's local scope). */
function claudeServer(name: string, value: unknown): McpDeclaration | string {
  if (!isRecord(value)) return `“${name}” is not an object`;
  const type = typeof value.type === 'string' ? value.type : undefined;
  if (typeof value.url === 'string' && type !== 'stdio') {
    const transport: Exclude<McpTransport, 'stdio'> =
      type === 'sse' ? 'sse' : type === 'http' ? 'http' : isSseAddress(value.url) ? 'sse' : 'http';
    const oauth = claudeOAuthClient(value.oauth);
    return {
      name,
      transport,
      url: value.url,
      headers: stringRecord(value.headers),
      ...(oauth === undefined ? {} : { oauth }),
    };
  }
  if (typeof value.command === 'string' && value.command.trim() !== '')
    return {
      name,
      transport: 'stdio',
      command: value.command,
      args: strings(value.args),
      env: stringRecord(value.env),
    };
  return `“${name}” has neither a command nor a url`;
}

/** Claude's `mcpServers` object, wherever it sits. */
export function claudeServers(document: unknown): DeclarationsRead {
  const table = isRecord(document) ? document.mcpServers : undefined;
  if (table === undefined) return { servers: [], problems: [] };
  if (!isRecord(table)) return { servers: [], problems: ['"mcpServers" is not an object'] };
  const servers: McpDeclaration[] = [];
  const problems: string[] = [];
  for (const [name, value] of Object.entries(table)) {
    const read = claudeServer(name, value);
    if (typeof read === 'string') problems.push(read);
    else servers.push(read);
  }
  return { servers, problems };
}

/** Codex's `[mcp_servers.<name>]` tables, in a home's or a project's `config.toml`. */
export function codexServers(document: unknown): DeclarationsRead {
  const table = isRecord(document) ? document.mcp_servers : undefined;
  if (table === undefined) return { servers: [], problems: [] };
  if (!isRecord(table)) return { servers: [], problems: ['"mcp_servers" is not a table'] };
  const servers: McpDeclaration[] = [];
  const problems: string[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (!isRecord(value)) {
      problems.push(`“${name}” is not a table`);
      continue;
    }
    const disabled = value.enabled === false ? { disabled: true as const } : {};
    if (typeof value.url === 'string') {
      servers.push({
        name,
        transport: isSseAddress(value.url) ? 'sse' : 'http',
        url: value.url,
        headers: stringRecord(value.http_headers),
        ...(typeof value.bearer_token_env_var === 'string' ? { bearerVariable: value.bearer_token_env_var } : {}),
        ...disabled,
      });
    } else if (typeof value.command === 'string' && value.command.trim() !== '') {
      servers.push({
        name,
        transport: 'stdio',
        command: value.command,
        args: strings(value.args),
        env: stringRecord(value.env),
        ...disabled,
      });
    } else problems.push(`“${name}” has neither a command nor a url`);
  }
  return { servers, problems };
}

/**
 * Whether a Claude local-scope entry is one Ferretry wrote to deliver a project server's sign-in
 * (`./project-sign-in.ts`): its `Authorization` header names a Ferretry sign-in variable and nothing else.
 */
export const isFerretryLocalEntry = (entry: unknown): boolean => {
  if (!isRecord(entry) || !isRecord(entry.headers)) return false;
  const authorization = entry.headers.Authorization;
  return typeof authorization === 'string' && /^Bearer \$\{FY_MCP_[A-Z0-9_]+_TOKEN\}$/u.test(authorization);
};

/** The approval keys Claude reads, from wherever one document holds them. */
export interface ClaudeApprovalKeys {
  readonly enableAll?: boolean;
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
}

export function claudeApprovalKeys(document: unknown): ClaudeApprovalKeys {
  if (!isRecord(document)) return { enabled: [], disabled: [] };
  return {
    ...(typeof document.enableAllProjectMcpServers === 'boolean'
      ? { enableAll: document.enableAllProjectMcpServers }
      : {}),
    enabled: strings(document.enabledMcpjsonServers),
    disabled: strings(document.disabledMcpjsonServers),
  };
}

/** One project's entry in a Claude home's `.claude.json` (`projects[<root>]`), or undefined. */
export function claudeProjectEntry(claudeJson: unknown, root: string): unknown {
  if (!isRecord(claudeJson) || !isRecord(claudeJson.projects)) return undefined;
  return claudeJson.projects[root];
}

/**
 * Whether Claude in one home runs one `.mcp.json` server for one project.
 *
 * Read off Claude Code 2.1.281 with `claude mcp list` against a scratch config directory: a server is
 * "Pending approval" until it is in `projects[<root>].enabledMcpjsonServers` AND the folder's trust
 * question has been answered (`hasTrustDialogAccepted`); one in `disabledMcpjsonServers` is not listed
 * at all. `enableAllProjectMcpServers` (in the project entry or any settings document) approves every
 * one. A deny anywhere wins over an allow anywhere, the way Claude's settings merge denials.
 */
export function claudeApproval(
  name: string,
  projectEntry: unknown,
  settings: readonly ClaudeApprovalKeys[],
): McpApproval {
  const sources = [claudeApprovalKeys(projectEntry), ...settings];
  if (sources.some(keys => keys.disabled.includes(name))) return 'disabled';
  const trusted = isRecord(projectEntry) && projectEntry.hasTrustDialogAccepted === true;
  const allowed = sources.some(keys => keys.enableAll === true || keys.enabled.includes(name));
  return allowed && trusted ? 'approved' : 'pending';
}

/**
 * Whether Codex in one home reads a project's `.codex/config.toml` at all: only for a project its
 * `config.toml` marks `trust_level = "trusted"` (codex-cli 0.156.1, `codex mcp list` against a scratch
 * home — an untrusted project's servers are not listed).
 */
export function codexTrusted(codexConfig: unknown, root: string): boolean {
  if (!isRecord(codexConfig) || !isRecord(codexConfig.projects)) return false;
  const entry = codexConfig.projects[root];
  return isRecord(entry) && entry.trust_level === 'trusted';
}
