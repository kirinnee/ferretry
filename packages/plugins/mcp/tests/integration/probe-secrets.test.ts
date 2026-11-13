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
