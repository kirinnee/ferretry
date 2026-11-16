/**
 * @ferretry/plugin-mcp/contract/testing — the fake and the conformance suite (§7.8). The real implementation and the
 * fake pass the same suite.
 */
import { err, ok, type Result } from '@ferretry/std';
import {
  type McpApi,
  type McpCheckResult,
  McpCheckResultSchema,
  type McpInventory,
  McpInventorySchema,
  type McpOAuthConnection,
  McpOAuthConnectionSchema,
} from '../index.ts';

export const EMPTY_INVENTORY: McpInventory = { servers: [], problems: [] };

export interface FakeMcp extends McpApi {
  setInventory(inventory: McpInventory): void;
  setCheck(id: string, result: McpCheckResult): void;
  setConnections(connections: readonly McpOAuthConnection[]): void;
}

export function fakeMcp(): FakeMcp {
  let inventory = EMPTY_INVENTORY;
  let connections: readonly McpOAuthConnection[] = [];
  const checks = new Map<string, McpCheckResult>();
  return {
    inventory: async () => inventory,
    check: async id =>
      checks.get(id) ?? {
        id,
        name: id,
        transport: 'stdio',
        outcome: 'error',
        message: 'no such server in the fake',
        elapsedMs: 0,
        checkedAt: '2026-01-01T00:00:00Z',
      },
    connections: async () => connections,
    setInventory: next => {
      inventory = next;
    },
    setCheck: (id, result) => {
      checks.set(id, result);
    },
    setConnections: next => {
      connections = next;
    },
  };
}

/** What every implementation of `McpApi` must satisfy. */
export async function mcpConformance(make: () => McpApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  if (!McpInventorySchema.safeParse(await api.inventory()).success)
    failures.push('inventory() returns an McpInventory');
  if (!McpCheckResultSchema.safeParse(await api.check('unknown')).success)
    failures.push('check() of an unknown server still returns an McpCheckResult (an error outcome), never a throw');
  for (const connection of await api.connections())
    if (!McpOAuthConnectionSchema.safeParse(connection).success)
      failures.push('connections() returns McpOAuthConnections');
  // S174: a connection lists secret NAMES and has no field that could carry a token.
  const leaky = McpOAuthConnectionSchema.safeParse({
    component: 'x',
    state: 'signed-in',
    renewable: true,
    secrets: [],
    accessToken: 'abc',
  });
  if (leaky.success) failures.push('a connection carries no token field');
  return failures.length === 0 ? ok(true) : err(failures);
}
