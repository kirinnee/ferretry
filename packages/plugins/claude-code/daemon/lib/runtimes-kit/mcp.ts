import {
  isSseUrl,
  type KitDocuments,
  type KitDocumentsInput,
  type KitMcpServer,
  type KitPlumbingEntry,
  type KitPlumbingInput,
  type KitServerEnvironment,
  type KitSettingsObject,
  type RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One server as Claude's `mcpServers` entry. A server signed in to from Ferretry carries its token as an
 * `Authorization` header that names a launch variable — Claude expands `${VAR}` in a server's headers
 * (INFERRED, docs/mcp-oauth.md) — so the document holds a variable name, never a value.
 */
function renderMcpServer(server: KitMcpServer, env: KitServerEnvironment, bearer?: string): KitSettingsObject {
  if (server.url !== undefined)
    return {
      type: isSseUrl(server.url) ? 'sse' : 'http',
      url: server.url,
      ...(bearer === undefined ? {} : { headers: { Authorization: `Bearer \${${bearer}}` } }),
    };
  const variables = { ...env.literal, ...Object.fromEntries(env.forwarded.map(name => [name, `\${${name}}`])) };
  return {
    type: 'stdio',
    command: server.command,
    args: server.args ?? [],
    ...(Object.keys(variables).length > 0 ? { env: variables } : {}),
  };
}

/** Where the servers go: `.claude.json`; the hooks block rides in `settings.json`. */
function configDocuments(input: KitDocumentsInput): KitDocuments {
  return {
    settings: input.hooksBlock === undefined ? input.settings : { ...input.settings, hooks: input.hooksBlock },
    claudeJson: { mcpServers: input.servers },
  };
}

/** The person's own statusLine command, when their settings name one Claude would run. */
function ownStatuslineCommand(settings: KitSettingsObject): string | undefined {
  const statusLine = settings.statusLine;
  if (!isPlainObject(statusLine)) return undefined;
  const command = statusLine.command;
  return typeof command === 'string' && command.trim() !== '' ? command : undefined;
}

/** The keys every Claude runtime's settings carry: the status line, chained with the person's own command. */
function plumbing(input: KitPlumbingInput): readonly KitPlumbingEntry[] {
  const { statusLine } = input;
  if (statusLine === undefined) return [];
  return [
    { key: 'statusLine.type', path: ['statusLine', 'type'], value: 'command' },
    {
      key: 'statusLine.command',
      path: ['statusLine', 'command'],
      value: statusLine(ownStatuslineCommand(input.settings)),
    },
  ];
}

/** How Claude spells MCP servers and config documents. */
export const claudeMcpKit: RuntimesHarnessKit = { renderMcpServer, configDocuments, keepsPriorServers: true, plumbing };
