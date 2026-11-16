import { describe, expect, test } from 'bun:test';
import { CheckSpawnReach, ReachedProbe } from '../../daemon/lib/check-reach.ts';
import type { McpProbeAnswer, McpProbeSpec } from '../../daemon/lib/inventory/check.ts';

describe('what a check may start', () => {
  test('answers nothing until a program is permitted, and nothing again once it is released', () => {
    const reach = new CheckSpawnReach();
    expect(reach.programs()).toEqual([]);
    const release = reach.permit('npx');
    expect(reach.programs()).toEqual(['npx']);
    release();
    expect(reach.programs()).toEqual([]);
  });

  test('keeps a program allowed until every check holding it has released', () => {
    const reach = new CheckSpawnReach();
    const first = reach.permit('npx');
    const second = reach.permit('npx');
    reach.permit('uvx');
    first();
    expect(reach.programs()).toEqual(['npx', 'uvx']);
    second();
    expect(reach.programs()).toEqual(['uvx']);
  });

  test('a release counts once: calling it again does not take another check’s hold away', () => {
    const reach = new CheckSpawnReach();
    const first = reach.permit('npx');
    reach.permit('npx');
    first();
    first();
    expect(reach.programs()).toEqual(['npx']);
  });
});

describe('a probe that makes the reach current first', () => {
  const stdio: McpProbeSpec = { transport: 'stdio', command: 'npx', args: [], env: {} };
  const http: McpProbeSpec = { transport: 'http', url: 'https://mcp.example.test/mcp', headers: {} };
  const answer: McpProbeAnswer = { serverName: 'acme', tools: ['a'] };

  test('allows a stdio command only for the length of its own probe', async () => {
    const reach = new CheckSpawnReach();
    let during: readonly string[] = [];
    const inner = {
      probe: async () => {
        during = reach.programs();
        return answer;
      },
    };
    const probe = new ReachedProbe(inner, reach, async () => {
      throw new Error('a stdio probe lists no servers');
    });
    expect(await probe.probe(stdio, new AbortController().signal)).toBe(answer);
    expect(during).toEqual(['npx']);
    expect(reach.programs()).toEqual([]);
  });

  test('releases the command when the probe fails, and passes the failure on', async () => {
    const reach = new CheckSpawnReach();
    const probe = new ReachedProbe(
      {
        probe: async () => {
          throw new Error('no session');
        },
      },
      reach,
      async () => undefined,
    );
    await expect(probe.probe(stdio, new AbortController().signal)).rejects.toThrow('no session');
    expect(reach.programs()).toEqual([]);
  });

  test('lists the servers afresh before a web address is reached, and reaches it even if the listing fails', async () => {
    const order: string[] = [];
    const inner = {
      probe: async () => {
        order.push('probe');
        return answer;
      },
    };
    const listed = new ReachedProbe(inner, new CheckSpawnReach(), async () => {
      order.push('list');
    });
    expect(await listed.probe(http, new AbortController().signal)).toBe(answer);
    const failing = new ReachedProbe(inner, new CheckSpawnReach(), async () => {
      order.push('list-fails');
      throw new Error('listing failed');
    });
    expect(await failing.probe(http, new AbortController().signal)).toBe(answer);
    expect(order).toEqual(['list', 'probe', 'list-fails', 'probe']);
  });
});
