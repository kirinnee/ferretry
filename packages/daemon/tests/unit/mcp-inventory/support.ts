/**
 * A machine with two runtimes, one project and one worktree of it, whose harness documents declare an
 * MCP server in every scope — held in memory, so the inventory reads exactly these and nothing else.
 */
import type { McpOAuthConnection, SessionView } from '@ferretry/protocol';
import {
  McpDocumentUnreadable,
  type McpHarnessDocuments,
  type McpInventoryAccount,
  type McpInventoryComponent,
  type McpInventoryDeps,
  type McpInventoryFolder,
  mcpProjectKey,
} from '../../../src/lib/mcp-inventory/index.ts';
import { sessionView } from '../runtime/mounts/support.ts';

export const CLAUDE_HOME = '/fy/fleet/homes/claude-work-id';
export const CODEX_HOME = '/fy/fleet/homes/codex-work-id';
export const PROJECT = '/work/app';
export const WORKTREE = '/wt/app-feature';
export const PROJECT_KEY = mcpProjectKey(PROJECT);

/** A variable reference, spelled without a template the linter reads as a mistake. */
export const variable = (name: string): string => `\${${name}}`;

export const ACCOUNTS: readonly McpInventoryAccount[] = [
  { runtime: 'claude-work', harness: 'claude', home: CLAUDE_HOME, wrapper: '/fy/fleet/bin/claude-work' },
  { runtime: 'codex-work', harness: 'codex', home: CODEX_HOME, wrapper: '/fy/fleet/bin/codex-work' },
];

export const COMPONENTS: readonly McpInventoryComponent[] = [
  { name: 'linear', runtimes: ['claude-work', 'codex-work'], auth: 'oauth' },
];

export const FOLDERS: readonly McpInventoryFolder[] = [
  { root: PROJECT, project: PROJECT, name: 'app' },
  { root: WORKTREE, project: PROJECT, name: 'app' },
];

/** The documents, by path. A value of `BROKEN` reads as a file that is there and does not parse. */
export const BROKEN = Symbol('broken');

export const documents = (): Map<string, unknown> =>
  new Map<string, unknown>([
    [
      `${CLAUDE_HOME}/.claude.json`,
      {
        mcpServers: {
          linear: {
            type: 'http',
            url: 'https://mcp.linear.app/mcp',
            headers: { Authorization: `Bearer ${variable('FY_MCP_LINEAR_0123456789ABCDEF_TOKEN')}` },
          },
          // A key in its arguments: the wire must never carry them.
          scratch: { command: 'uvx', args: ['scratch', '--key', 'sk-live-NEVER-ON-THE-WIRE'] },
        },
        projects: {
          [PROJECT]: {
            hasTrustDialogAccepted: true,
            enabledMcpjsonServers: ['docs'],
            disabledMcpjsonServers: ['tracker'],
            mcpServers: {
              mine: { command: 'node', args: ['mine.js'] },
              // Ferretry's own delivery of the project server's sign-in: the project server, not another.
              docs: {
                type: 'http',
                url: 'https://docs.example.com/mcp',
                headers: { Authorization: `Bearer ${variable('FY_MCP_DOCS_0123456789ABCDEF_TOKEN')}` },
              },
            },
          },
        },
      },
    ],
    [`${CLAUDE_HOME}/settings.json`, {}],
    [
      `${PROJECT}/.mcp.json`,
      {
        mcpServers: {
          docs: { type: 'http', url: 'https://docs.example.com/mcp?team=1' },
          tracker: { command: 'npx', args: ['tracker'] },
          lint: { command: 'npx', args: ['lint'], env: { LINT_HOME: variable('HOME') } },
          linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
        },
      },
    ],
    [
      `${CODEX_HOME}/config.toml`,
      {
        mcp_servers: {
          linear: { url: 'https://mcp.linear.app/mcp', bearer_token_env_var: 'FY_MCP_LINEAR_0123456789ABCDEF_TOKEN' },
        },
        projects: { [PROJECT]: { trust_level: 'trusted' } },
      },
    ],
    [
      `${PROJECT}/.codex/config.toml`,
      {
        mcp_servers: {
          search: { url: 'https://search.example.com/sse' },
          off: { command: 'off-server', enabled: false },
        },
      },
    ],
  ]);

export class MemoryDocuments implements McpHarnessDocuments {
  readonly reads: string[] = [];
  constructor(readonly files: Map<string, unknown> = documents()) {}

  async read(path: string): Promise<unknown> {
    this.reads.push(path);
    const value = this.files.get(path);
    if (value === BROKEN)
      throw new McpDocumentUnreadable(`${path} is not valid JSON, so its MCP servers cannot be read.`);
    return value ?? null;
  }
}

export const session = (cwd = `${PROJECT}/src`, agent = '/fy/fleet/bin/claude-work'): SessionView =>
  sessionView('s1', { cwd, agent, harness: agent.includes('codex') ? 'codex' : 'claude' });

export interface InventoryWorld {
  readonly documents: MemoryDocuments;
  connections: McpOAuthConnection[];
  readonly deps: McpInventoryDeps;
}

export function inventoryWorld(files?: Map<string, unknown>): InventoryWorld {
  const documents = new MemoryDocuments(files);
  const built = { documents, connections: [] as McpOAuthConnection[] } as InventoryWorld;
  return Object.assign(built, {
    deps: {
      accounts: async () => ACCOUNTS,
      components: async () => COMPONENTS,
      folders: async () => FOLDERS,
      connections: async () => built.connections,
      documents,
      sessions: {
        get: async (id: string) => (id === 's1' ? session() : id === 's2' ? session(`${WORKTREE}`) : undefined),
      },
    } satisfies McpInventoryDeps,
  });
}
