import { describe, expect, test } from 'bun:test';
import { McpServer, TOOL_DISCOVERY_WAIT_MS } from '../../../cli/lib/serve/server.ts';
import { MCP_TOOLS } from '../../../cli/lib/serve/tools.ts';

// A harness gives tool discovery a deadline (Codex 0.170.0: 10 s) and, past it, loses EVERY tool. `tools/list` asks the
// plugin inventory which packages are on, and an inventory that is slow (a daemon restart waited out, a loaded host)
// must cost at most the discovery bound, never its own time. The correctness half (every tool is listed once the bound
// passes; an inventory inside the bound is applied) is in `tests/unit/cli/server.test.ts`.

const listed = async (server: McpServer) => {
  const started = performance.now();
  const answer = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
    result: { tools: { name: string }[] };
  };
  return { names: answer.result.tools.map(tool => tool.name), tookMs: performance.now() - started };
};

const slowInventory = (delayMs: number, info: { discoveryWaitMs?: number } = {}) =>
  new McpServer(
    {
      call: async () => ({ text: 'ok' }),
      isOn: async () => {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return false;
      },
    },
    {
      name: 'ferretry',
      version: '9.9.9',
      sleep: async ms => await new Promise<void>(resolve => setTimeout(resolve, ms)),
      ...info,
    },
  );

describe('tools/list against a slow plugin inventory', () => {
  test('answers within a small bound of the discovery wait when the inventory takes 11 s (Codex gives up at 10 s)', async () => {
    const { names, tookMs } = await listed(slowInventory(11_000));
    expect(TOOL_DISCOVERY_WAIT_MS).toBeLessThanOrEqual(2000);
    expect(tookMs).toBeLessThan(TOOL_DISCOVERY_WAIT_MS + 500);
    expect(names).toEqual(MCP_TOOLS.map(tool => tool.name));
  });

  test('honours a shorter bound the server is given', async () => {
    const { tookMs } = await listed(slowInventory(5000, { discoveryWaitMs: 50 }));
    expect(tookMs).toBeLessThan(500);
  });
});
