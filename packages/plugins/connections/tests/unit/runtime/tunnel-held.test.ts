/**
 * Turning the tunnel on is HELD for the owner (it loosens how the machine is reached). Over the composed daemon half and
 * the kernel's real config service: the route answers 202 with what is held (never a 500), the tunnel stays off meanwhile,
 * and when the owner confirms the held edit the running switch follows the document and shows on.
 */
import { expect, test } from 'bun:test';
import type { RouteHandler } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../../core/kernel/host/state/memory-fs.ts';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { TunnelHeldAnswerSchema, TunnelStatusViewSchema } from '../../../contract/index.ts';
import { composeOtherConnections, kernelTunnelHost } from '../../../daemon/compose-b.ts';
import { buildConnections, kernelConnectionBindings } from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

const noWorld = {
  fetch: (url: URL): never => {
    throw new Error(`no real network in a composition test: ${url.host}`);
  },
  spawn: (program: string): never => {
    throw new Error(`no real child in a composition test: ${program}`);
  },
};

test('a held "turn on" answers 202 and keeps the tunnel off; confirming it makes the tunnel show on', async () => {
  const memory = createMemoryHostFs();
  memory.seed('/home/fy/config/connections.yaml', new TextEncoder().encode('tunnel:\n  enabled: false\n'));
  const cancel = () => undefined;
  const real = createConfigFiles({
    home: '/home/fy',
    fs: memory,
    clock: { nowMs: () => 0, after: () => cancel, every: () => cancel },
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => undefined } as never,
    binary: 'fy',
    defs: [{ plugin: 'connections', def: manifest.data.config[0] as never }],
  });
  await real.reload();
  let other: ReturnType<typeof composeOtherConnections> | undefined;
  const plugin = implementDaemon(manifest, {
    build: ctx => {
      other = composeOtherConnections({
        kernel: { ...ctx.kernel, config: real.port('connections') },
        config: undefined,
        host: kernelTunnelHost(ctx.kernel),
        publishTunnel: () => {},
      });
      return buildConnections(ctx, kernelConnectionBindings(ctx.kernel));
    },
  });
  const host = await testHost({ plugins: [plugin], ...noWorld });
  try {
    const call = { request: { text: async () => JSON.stringify({ enabled: true }) } } as Parameters<RouteHandler>[0];
    const answer = await other!.tunnelChange(call);

    // Held is an answer, not a failure: 202, what is held, and the tunnel as it still is.
    expect(answer.status).toBe(202);
    const held = TunnelHeldAnswerSchema.parse(JSON.parse(answer.body));
    expect(held.held.length).toBeGreaterThan(0);
    expect(held.view).toMatchObject({ enabled: false });
    expect(TunnelStatusViewSchema.parse(await other!.tunnelStatus())).toMatchObject({ enabled: false });
    expect(real.held().map(edit => edit.path)).toEqual(['connections.yaml']);

    // The owner confirms the held edit, as `fy config confirm connections.yaml` does; the running switch follows it.
    expect(await real.confirm(real.held()[0]!.id)).toBe(true);
    await Bun.sleep(20);
    expect(TunnelStatusViewSchema.parse(await other!.tunnelStatus())).toMatchObject({ enabled: true, explicit: true });
  } finally {
    await host.stop();
  }
});
