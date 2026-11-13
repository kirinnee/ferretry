/**
 * A machine with two runtimes, one project and one worktree of it, whose harness documents declare an
 * MCP server in every scope — held in memory, so the inventory reads exactly these and nothing else.
 */
import type { McpOAuthConnection } from '../../../contract/index.ts';
import { claudeApproval, claudeApprovalKeys, claudeProjectEntry } from '../../../daemon/lib/inventory/declarations.ts';
import {
  KnownAndFerretFolders,
  type McpInventoryFolder,
  mcpProjectKey,
} from '../../../daemon/lib/inventory/folders.ts';
import {
  McpDocumentUnreadable,
  type McpFerretView,
  type McpHarnessDocuments,
  type McpInventoryAccount,
  type McpInventoryComponent,
  type McpInventoryDeps,
} from '../../../daemon/lib/inventory/service.ts';
import {
  type McpProjectApprovals,
  type McpProjectApprovalsRequest,
} from '../../../daemon/lib/inventory/project-sign-in.ts';

export const CLAUDE_HOME = '/fy/fleet/homes/claude-work-id';
export const CODEX_HOME = '/fy/fleet/homes/codex-work-id';
export const PROJECT = '/work/app';
export const WORKTREE = '/wt/app-feature';
export const PROJECT_KEY = mcpProjectKey(PROJECT);

/** A variable reference, spelled without a template the linter reads as a mistake. */
export const variable = (name: string): string => `\${${name}}`;

export const ACCOUNTS: readonly McpInventoryAccount[] = [
  { runtime: 'claude-work', harness: 'claude-code', home: CLAUDE_HOME, wrapper: '/fy/fleet/bin/claude-work' },
  { runtime: 'codex-work', harness: 'codex', home: CODEX_HOME, wrapper: '/fy/fleet/bin/codex-work' },
];

export const COMPONENTS: readonly McpInventoryComponent[] = [
  { name: 'linear', runtimes: ['claude-work', 'codex-work'], auth: 'oauth' },
];

export const FOLDERS: readonly McpInventoryFolder[] = [
  { root: PROJECT, project: PROJECT, name: 'app' },
  { root: WORKTREE, project: PROJECT, name: 'app' },
];

/** The folder source the inventory, the sign-in list and a launch share, over fixed known folders and ferret folders. */
export const knownFolders = (
  known: readonly McpInventoryFolder[],
  ferrets: readonly string[] = [],
): KnownAndFerretFolders =>
  new KnownAndFerretFolders(
    async () => known,
    async () => ferrets,
  );

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

export const session = (folder = `${PROJECT}/src`, agent = '/fy/fleet/bin/claude-work'): McpFerretView => ({
  id: 's1',
  harness: agent.includes('codex') ? 'codex' : 'claude-code',
  folder,
  runtime: agent.slice(agent.lastIndexOf('/') + 1),
});

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
      folders: knownFolders(FOLDERS),
      connections: async () => built.connections,
      documents,
      ferrets: {
        get: async (id: string) => (id === 's1' ? session() : id === 's2' ? session(`${WORKTREE}`) : undefined),
      },
    } satisfies McpInventoryDeps,
  });
}

/**
 * The launch harness's answer to `approvedProjectServers`, the way the Claude Code plugin reads its own home (today's
 * rules), over these in-memory documents: a Claude home that is `BROKEN` cannot answer; Codex takes no project server.
 */
export const documentApprovals =
  (files: Map<string, unknown>) =>
  async ({ account, root, servers }: McpProjectApprovalsRequest): Promise<McpProjectApprovals> => {
    if (account.harness !== 'claude-code') return { state: 'not-taken', reason: 'Codex takes no project server.' };
    const home = files.get(`${account.home}/.claude.json`) ?? null;
    const settings = files.get(`${account.home}/settings.json`) ?? null;
    if (home === BROKEN || settings === BROKEN) return { state: 'unreadable', reason: 'a home document is not JSON.' };
    return {
      state: 'read',
      servers: Object.fromEntries(
        servers.map(name => [
          name,
          claudeApproval(name, claudeProjectEntry(home, root), [claudeApprovalKeys(settings)]),
        ]),
      ),
    };
  };
