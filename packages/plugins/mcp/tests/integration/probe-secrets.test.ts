/**
 * A command's stored secrets reach ITS environment only: a value that names `${secret:NAME}` is opened by the Vault for
 * that one child (the handle goes to the spawn port), never expanded here. A name the Vault does not hold is said by name.
 */
import { describe, expect, test } from 'bun:test';
import type { ChildEnvironment } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { type ProbePorts, TransportMcpProbe } from '../../daemon/adapters/probe.ts';
import { McpProbeFailure } from '../../daemon/lib/inventory/check.ts';

const HANDLE = Object.freeze({ names: ['TOKEN'] }) as unknown as ChildEnvironment;

/** A spawn port whose child dies at once; it keeps the options it was started with. */
function ports() {
  const started: { env: unknown }[] = [];
  const spawn = {
    start: (_program: string, _args: readonly string[], options?: { env?: unknown }) => {
      started.push({ env: options?.env });
      return {
        pid: 1,
        stdout: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
        stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
        write: () => undefined,
        kill: () => undefined,
        exited: Promise.resolve(1),
      };
    },
  };
  return { started, ports: { spawn, fetch: {}, clock: { sleep: async () => undefined } } as unknown as ProbePorts };
}

const spec = (env: Record<string, string>) =>
  ({ transport: 'stdio', command: 'acme', args: [], env }) as Parameters<TransportMcpProbe['probe']>[0];

describe('a command whose environment names stored secrets', () => {
  test('is started with the Vault’s handle for that child, not with the reference text', async () => {
    const { started, ports: stub } = ports();
    const asked: Record<string, string>[] = [];
    const probe = new TransportMcpProbe(stub, {
      childEnvironment: async env => {
        asked.push({ ...env });
        return ok(HANDLE);
      },
    });

    await probe
      .probe(spec({ TOKEN: '${secret:ACME_TOKEN}', HOME: '/home/owner' }), AbortSignal.timeout(2000))
      .catch(() => undefined);

    expect(asked).toEqual([{ TOKEN: '${secret:ACME_TOKEN}', HOME: '/home/owner' }]);
    expect(started).toHaveLength(1);
    expect(started[0]?.env).toBe(HANDLE);
  });

  test('a secret the Vault does not hold is refused by name before anything starts', async () => {
    const { started, ports: stub } = ports();
    const probe = new TransportMcpProbe(stub, { childEnvironment: async () => err({ unknown: ['ACME_TOKEN'] }) });

    const failure = await probe
      .probe(spec({ TOKEN: '${secret:ACME_TOKEN}' }), AbortSignal.timeout(2000))
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(McpProbeFailure);
    expect((failure as McpProbeFailure).message).toContain('ACME_TOKEN');
    expect(started).toHaveLength(0);
  });

  test('an environment that names none never asks the Vault, and passes as plain values', async () => {
    const { started, ports: stub } = ports();
    let asked = 0;
    const probe = new TransportMcpProbe(stub, {
      childEnvironment: async () => {
        asked += 1;
        return ok(HANDLE);
      },
    });

    await probe.probe(spec({ HOME: '/home/owner' }), AbortSignal.timeout(2000)).catch(() => undefined);

    expect(asked).toBe(0);
    expect(started[0]?.env).toEqual({ HOME: '/home/owner' });
  });
});

describe('a remote check that carries a held sign-in', () => {
  const remote = {
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: {},
    credential: { secret: 'MCP_X_0123456789ABCDEF_ACCESS', header: 'Authorization', scheme: 'Bearer' },
  } as Parameters<TransportMcpProbe['probe']>[0];

  const reply = (id: number | undefined, result: unknown): Response =>
    new Response(id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id, result }), {
      status: id === undefined ? 202 : 200,
      headers: { 'content-type': 'application/json' },
    });

  test('is sent through the Vault’s minted exchange with the secret’s NAME, and never through the plain fetch', async () => {
    const plain: string[] = [];
    const asked: { secret: string; placement: unknown; method: string }[] = [];
    const stub = {
      spawn: {},
      clock: {},
      fetch: {
        request: async (url: string) => {
          plain.push(url);
          return new Response('', { status: 200 });
        },
      },
    } as unknown as ProbePorts;
    const probe = new TransportMcpProbe(stub, {
      childEnvironment: async () => ok(HANDLE),
      fetchMinted: async (secret, request, placement) => {
        asked.push({ secret, placement, method: request.method });
        const body = JSON.parse(request.body ?? '{}') as { id?: number; method?: string };
        if (request.method === 'DELETE') return { kind: 'response', response: new Response('', { status: 200 }) };
        if (body.method === 'initialize')
          return { kind: 'response', response: reply(body.id, { serverInfo: { name: 'Remote' } }) };
        if (body.method === 'tools/list')
          return { kind: 'response', response: reply(body.id, { tools: [{ name: 'a' }] }) };
        return { kind: 'response', response: reply(undefined, {}) };
      },
    });

    const answer = await probe.probe(remote, AbortSignal.timeout(2000));

    expect(answer).toEqual({ serverName: 'Remote', tools: ['a'] });
    expect(plain).toEqual([]);
    expect(asked.length).toBeGreaterThan(0);
    for (const call of asked) {
      expect(call.secret).toBe('MCP_X_0123456789ABCDEF_ACCESS');
      expect(call.placement).toEqual({ header: 'Authorization', scheme: 'Bearer' });
    }
  });

  test('says in words, and sends nothing, when the Vault refuses to present the sign-in', async () => {
    const stub = { spawn: {}, clock: {}, fetch: { request: async () => new Response('') } } as unknown as ProbePorts;
    const probe = new TransportMcpProbe(stub, {
      childEnvironment: async () => ok(HANDLE),
      fetchMinted: async () => ({ kind: 'refused' }),
    });

    const failure = await probe.probe(remote, AbortSignal.timeout(2000)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(McpProbeFailure);
    expect((failure as McpProbeFailure).message).toContain('mcp.example.com');
  });

  test('refuses to send a held sign-in at all when the Vault offers no way to present it', async () => {
    const stub = { spawn: {}, clock: {}, fetch: { request: async () => new Response('') } } as unknown as ProbePorts;
    const probe = new TransportMcpProbe(stub, { childEnvironment: async () => ok(HANDLE) });

    const failure = await probe.probe(remote, AbortSignal.timeout(2000)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(McpProbeFailure);
  });
});
