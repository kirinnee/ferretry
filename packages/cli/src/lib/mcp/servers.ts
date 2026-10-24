/**
 * `fy mcp ls` and `fy mcp check`: every MCP server a ferret sees, from every scope, and whether one
 * answers (docs/mcp-scopes.md).
 *
 * Inside a ferret both default to THAT ferret — what its harness actually reads, from its runtime's own
 * home and its project — so an agent can ask "why is my server not there?" and get the scope, the
 * approval and the check in words. Outside one, or with `--machine`, they read the whole machine.
 */
import {
  type IFyApiClient,
  MCP_CHECK_PATH,
  MCP_INVENTORY_PATH,
  McpCheckRequestSchema,
  type McpCheckResult,
  McpCheckResultSchema,
  type McpInventory,
  McpInventorySchema,
  type McpInventoryServer,
} from '@ferretry/protocol';

/** The only client capability the gateway consumes. */
export type McpServersApiClient = Pick<IFyApiClient, 'request'>;

export interface IMcpServersGateway {
  /** One ferret's view, or the machine's when `sessionId` is absent. */
  list(sessionId?: string): Promise<McpInventory>;
  check(id: string, sessionId?: string): Promise<McpCheckResult>;
}

export class ProtocolMcpServersGateway implements IMcpServersGateway {
  constructor(private readonly client: McpServersApiClient) {}

  async list(sessionId?: string): Promise<McpInventory> {
    return await this.client.request(
      sessionId === undefined ? MCP_INVENTORY_PATH : `/v1/sessions/${encodeURIComponent(sessionId)}/mcp/servers`,
      McpInventorySchema,
    );
  }

  async check(id: string, sessionId?: string): Promise<McpCheckResult> {
    return await this.client.request(MCP_CHECK_PATH, McpCheckResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(McpCheckRequestSchema.parse({ id, ...(sessionId === undefined ? {} : { sessionId }) })),
    });
  }
}

export interface IMcpServersOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

export interface McpServersOptions {
  readonly session?: string;
  readonly machine?: boolean;
  readonly json?: boolean;
}

export interface McpCheckOptions extends McpServersOptions {
  readonly scope?: string;
}

const SCOPE_WORD: Readonly<Record<McpInventoryServer['scope'], string>> = {
  ferretry: 'Ferretry',
  component: 'Component',
  user: 'User',
  project: 'Project',
  local: 'Local',
};

const APPROVAL_WORD = { approved: 'approved', pending: 'not approved yet', disabled: 'disabled here' } as const;

/** What one row says about itself after its name: transport, where it points, approval, sign-in, shadow. */
function rowFacts(server: McpInventoryServer): string {
  const facts: string[] = [server.transport, server.target];
  const approvals = server.runtimes.flatMap(use =>
    use.approval === undefined ? [] : [`${use.runtime}: ${APPROVAL_WORD[use.approval]}`],
  );
  if (approvals.length > 0) facts.push(approvals.join(', '));
  if (server.connection !== undefined) facts.push(server.connection.state.replaceAll('-', ' '));
  else if (server.signIn?.required === true) facts.push('needs sign-in');
  if (server.shadowedBy !== undefined) facts.push(`hidden by the ${SCOPE_WORD[server.shadowedBy]} one`);
  return facts.join(' · ');
}

/** The listing, grouped by scope in the order the harness weighs them. */
export function renderMcpInventory(inventory: McpInventory): string {
  if (inventory.servers.length === 0 && inventory.problems.length === 0) return 'No MCP servers.';
  const lines: string[] = [];
  for (const scope of ['ferretry', 'local', 'project', 'user', 'component'] as const) {
    const servers = inventory.servers.filter(server => server.scope === scope);
    if (servers.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${SCOPE_WORD[scope]}:`);
    for (const server of servers)
      lines.push(`  ${server.name}${server.harness === 'codex' ? ' (codex)' : ''}  ${rowFacts(server)}`);
  }
  if (inventory.problems.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Could not read:');
    for (const problem of inventory.problems) lines.push(`  ${problem.message}`);
  }
  return lines.join('\n');
}

export function renderMcpCheck(result: McpCheckResult): string {
  const head =
    result.outcome === 'connected'
      ? `${result.name}: connected${result.serverName === undefined ? '' : ` (${result.serverName})`} · ${result.toolCount ?? 0} tools · ${result.elapsedMs} ms`
      : `${result.name}: ${result.outcome.replaceAll('-', ' ')} · ${result.elapsedMs} ms`;
  const tools = result.tools !== undefined && result.tools.length > 0 ? [`  ${result.tools.join(', ')}`] : [];
  return [head, ...tools, ...(result.message === undefined ? [] : [`  ${result.message}`])].join('\n');
}

export class McpServersController {
  constructor(
    private readonly gateway: IMcpServersGateway,
    private readonly out: IMcpServersOutput,
    /** The ferret this command runs in, when it runs in one. */
    private readonly ownSessionId: string | undefined,
  ) {}

  async list(options: McpServersOptions): Promise<void> {
    const inventory = await this.gateway.list(this.#session(options));
    this.out.success(options.json === true ? JSON.stringify(inventory, null, 2) : renderMcpInventory(inventory));
  }

  async check(target: string, options: McpCheckOptions): Promise<void> {
    const session = this.#session(options);
    const { servers } = await this.gateway.list(session);
    const matches = servers.filter(
      server =>
        (server.id === target || server.name === target) &&
        (options.scope === undefined || server.scope === options.scope),
    );
    if (matches.length !== 1) {
      this.out.error(
        matches.length === 0
          ? `No MCP server “${target}” here. \`fy mcp ls\` lists them.`
          : `“${target}” is declared in more than one scope (${matches.map(server => server.scope).join(', ')}). Add --scope <scope>, or name it by id: ${matches.map(server => server.id).join(', ')}.`,
      );
      this.out.setExitCode(2);
      return;
    }
    const result = await this.gateway.check((matches[0] as McpInventoryServer).id, session);
    this.out.success(options.json === true ? JSON.stringify(result, null, 2) : renderMcpCheck(result));
    if (result.outcome !== 'connected') this.out.setExitCode(1);
  }

  #session(options: McpServersOptions): string | undefined {
    if (options.machine === true) return undefined;
    return options.session ?? this.ownSessionId;
  }
}
