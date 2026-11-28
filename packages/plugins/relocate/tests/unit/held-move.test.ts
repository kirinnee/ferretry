import { expect, test } from 'bun:test';
import { DEFAULT_GATE_CONFIG, FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { deviceStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import { ExportResponseSchema } from '../../contract/index.ts';
import relocate from '../../daemon/index.ts';
import { fakeFerrets, fakeSource, FERRET, summaryOf } from '../support/fake-ferrets.ts';
import { newIdentity, openOffer } from '../support/identity.ts';

test('held read is per ferret, survives handed-out expiry, and exposes only a boolean and instant until release', async () => {
  const ferrets = fakeFerrets({ source: fakeSource() });
  const get = ferrets.port.get;
  Object.assign(ferrets.port, {
    get: async (id: Parameters<typeof get>[0]) =>
      id === 'other-ferret' ? { ...summaryOf('idle'), id } : await get(id),
  });
  const host = await testHost({ plugins: [relocate], fakes: { ferrets: ferrets.port } });
  const read = (id: string) => host.request('GET', `/v1/relocate/${id}/held`, { as: owner() });
  try {
    expect((await read(FERRET)).json()).toEqual({ held: false });
    expect(ferrets.calls).toEqual([]);
    expect((await read('missing')).status).toBe(404);
    const offer = await openOffer(await newIdentity(), { expiresAtMs: host.clock.nowMs() + 120_000 });
    const exported = ExportResponseSchema.parse(
      (
        await host.request('POST', `/v1/relocate/${FERRET}/export`, { as: owner(), body: { offer: offer.offer } })
      ).json(),
    );
    const held = await read(FERRET);
    expect(held.status).toBe(200);
    expect(held.json()).toEqual({ held: true, since: host.clock.now() });
    expect((await read('other-ferret')).json()).toEqual({ held: false });
    expect(
      (await host.request('GET', `/v1/relocate/exports/${exported.exportId}/chunks/0`, { as: owner() })).status,
    ).toBe(200);
    await host.clock.advance(20 * 60_000);
    expect((await read(FERRET)).json()).toEqual(held.json());
    expect(ferrets.state).toBe('stopped');
    expect(ferrets.calls).toEqual(['stop:polite']);
    expect(
      (await host.request('POST', '/v1/relocate/exports/release', { as: owner(), body: { ferretId: FERRET } })).status,
    ).toBe(200);
    expect((await read(FERRET)).json()).toEqual({ held: false });
    expect(ferrets.state).toBe('stopped');
  } finally {
    await host.stop();
  }
});

test('held read has preflight authority: person, fleet.configure, passkey and filesystem.use', async () => {
  let standing: ReturnType<typeof deviceStanding> | undefined;
  const ferrets = fakeFerrets({ source: fakeSource() });
  let gets = 0;
  const get = ferrets.port.get;
  Object.assign(ferrets.port, {
    get: async (id: Parameters<typeof get>[0]) => {
      gets++;
      return await get(id);
    },
  });
  const host = await testHost({
    plugins: [relocate],
    fakes: { ferrets: ferrets.port },
    gate: new StandInAdmission(
      () => standing,
      () => ({
        ...DEFAULT_GATE_CONFIG,
        security: { ...DEFAULT_GATE_CONFIG.security, stepUpOnActions: true },
      }),
    ),
  });
  try {
    const read = () => host.request('GET', `/v1/relocate/${FERRET}/held`);
    expect((await read()).status).toBe(401);
    standing = deviceStanding('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: true, configure: false } }, true);
    expect((await read()).status).toBe(403);
    standing = deviceStanding('phone');
    expect((await read()).status).toBe(403);
    standing = {
      ...deviceStanding('phone', undefined, true),
      governance: {
        governed: true,
        decide: demand => ({ allowed: demand.capability !== 'filesystem', refusal: 'device-not-granted' }),
      },
    };
    expect((await read()).status).toBe(403);
    expect(gets).toBe(0);
    standing = deviceStanding('phone', undefined, true);
    expect((await read()).json()).toEqual({ held: false });
  } finally {
    await host.stop();
  }
  const personHost = await testHost({ plugins: [relocate], fakes: { ferrets: ferrets.port } });
  try {
    expect((await personHost.request('GET', `/v1/relocate/${FERRET}/held`, { as: ferret('f1') })).status).toBe(403);
  } finally {
    await personHost.stop();
  }
});
