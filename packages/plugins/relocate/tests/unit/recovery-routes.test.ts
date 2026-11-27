import { expect, test } from 'bun:test';
import { deviceStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { owner, testHost } from '@ferretry/kernel/testing';
import { ExportResponseSchema } from '../../contract/index.ts';
import relocate from '../../daemon/index.ts';
import { fakeFerrets, fakeSource, FERRET } from '../support/fake-ferrets.ts';
import { newIdentity, openOffer } from '../support/identity.ts';

async function started(options: { readonly gate?: StandInAdmission; readonly damage?: () => boolean } = {}) {
  const ferrets = fakeFerrets({ source: fakeSource() });
  const build = relocate.build;
  if (build === undefined) throw new Error('relocate has no daemon build');
  const plugin = {
    ...relocate,
    build: (ctx: Parameters<typeof build>[0]) =>
      build({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          state: {
            ...ctx.kernel.state,
            update: async (...args: Parameters<typeof ctx.kernel.state.update>) =>
              options.damage?.() === true
                ? {
                    ok: false as const,
                    error: { code: 'store_damaged' as const, path: 'moved.json', reason: 'synthetic damage' },
                  }
                : await ctx.kernel.state.update(...args),
          },
        },
      } as Parameters<typeof build>[0]),
  };
  const host = await testHost({ plugins: [plugin], fakes: { ferrets: ferrets.port }, gate: options.gate });
  const target = await newIdentity();
  const made = await openOffer(target, { expiresAtMs: host.clock.nowMs() + 120_000 });
  const response = await host.request('POST', `/v1/relocate/${FERRET}/export`, {
    as: owner(),
    body: { offer: made.offer },
  });
  expect(response.status).toBe(200);
  const exported = ExportResponseSchema.parse(response.json());
  return { host, target, exported, ferrets };
}

test('filesystem.use is required for chunks AND complete after Gate admits fleet.configure', async () => {
  let filesystem = true;
  const gate = new StandInAdmission(() => ({
    ...deviceStanding('phone', undefined, true),
    governance: {
      governed: true,
      decide: demand => ({
        allowed: demand.capability !== 'filesystem' || filesystem,
        refusal: filesystem ? 'granted' : 'device-not-granted',
      }),
    },
  }));
  const { host, target, exported } = await started({ gate });
  try {
    filesystem = false;
    expect((await host.request('GET', `/v1/relocate/exports/${exported.exportId}/chunks/0`)).status).toBe(403);
    expect(
      (
        await host.request('POST', `/v1/relocate/exports/${exported.exportId}/complete`, {
          body: { to: { daemonId: target.daemonId, ferretId: 'target' } },
        })
      ).status,
    ).toBe(403);
    filesystem = true;
    expect((await host.request('GET', `/v1/relocate/exports/${exported.exportId}/chunks/0`)).status).toBe(200);
    expect(
      (
        await host.request('POST', `/v1/relocate/exports/${exported.exportId}/complete`, {
          body: { to: { daemonId: target.daemonId, ferretId: 'target' } },
        })
      ).status,
    ).toBe(200);
  } finally {
    await host.stop();
  }
});

test('MUST 5 a damaged moved ledger retains the export for a durable completion retry', async () => {
  let damage = true;
  const { host, target, exported, ferrets } = await started({ damage: () => damage });
  try {
    const url = `/v1/relocate/exports/${exported.exportId}/complete`;
    const body = { to: { daemonId: target.daemonId, ferretId: 'target' } };
    expect((await host.request('POST', url, { body })).status).toBe(500);
    expect((await host.request('GET', `/v1/relocate/exports/${exported.exportId}/chunks/0`)).status).toBe(200);
    expect(ferrets.state).toBe('stopped');
    damage = false;
    expect((await host.request('POST', url, { body })).status).toBe(200);
  } finally {
    await host.stop();
  }
});

test('MUST 5 daemon clock expiry recovers an abandoned source without another request', async () => {
  const { host, ferrets } = await started();
  try {
    await host.clock.advance(20 * 60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(ferrets.state).toBe('idle');
  } finally {
    await host.stop();
  }
});

test('R4 the preparation deadline recovers a stalled read without another request and cancels further reads', async () => {
  let release!: (bytes: Uint8Array) => void;
  let started!: () => void;
  const stalled = new Promise<Uint8Array>(resolve => {
    release = resolve;
  });
  const reading = new Promise<void>(resolve => {
    started = resolve;
  });
  const source = fakeSource();
  let reads = 0;
  source.read = async () => {
    reads++;
    started();
    return await stalled;
  };
  const ferrets = fakeFerrets({ source });
  const host = await testHost({ plugins: [relocate], fakes: { ferrets: ferrets.port } });
  try {
    const made = await openOffer(await newIdentity(), { expiresAtMs: host.clock.nowMs() + 120_000 });
    const pending = host.request('POST', `/v1/relocate/${FERRET}/export`, { as: owner(), body: { offer: made.offer } });
    await reading;
    expect(ferrets.state).toBe('stopped');
    // A preparing export has a one-minute deadline, shorter than the fifteen-minute ciphertext retention.
    await host.clock.advance(61_000);
    expect((await pending).status).toBe(409);
    expect(ferrets.state).toBe('idle');
    release(new Uint8Array());
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(ferrets.calls.filter(call => call === 'resume')).toHaveLength(1);
  } finally {
    release(new Uint8Array());
    await host.stop();
  }
});
