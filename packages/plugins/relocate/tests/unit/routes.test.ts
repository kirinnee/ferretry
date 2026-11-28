import { describe, expect, test } from 'bun:test';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import { ExportResponseSchema, PreflightResponseSchema } from '../../contract/index.ts';
import relocate from '../../daemon/index.ts';
import { fakeFerrets, fakeSource, FERRET } from '../support/fake-ferrets.ts';
import { newIdentity, openOffer } from '../support/identity.ts';

async function started() {
  const ferrets = fakeFerrets({ state: 'idle', source: fakeSource(), folder: undefined });
  const host = await testHost({ plugins: [relocate], fakes: { ferrets: ferrets.port } });
  const target = await newIdentity();
  return { host, ferrets, target };
}

describe('the four routes', () => {
  test('preflight answers the table for a ferret on this machine', async () => {
    const { host, target } = await started();
    const response = await host.request('POST', `/v1/relocate/${FERRET}/preflight`, {
      as: owner(),
      body: { to: target.daemonId },
    });
    expect(response.status).toBe(200);
    const view = PreflightResponseSchema.parse(response.json());
    expect(view.ok).toBe(true);
    expect(view.stays.map(row => row.id)).toContain('session-credential');
    await host.stop();
  });

  test('a ferret can never move itself or another: every route is a person’s', async () => {
    const { host, ferrets, target } = await started();
    const refused = await host.request('POST', `/v1/relocate/${FERRET}/preflight`, {
      as: ferret('f1'),
      body: { to: target.daemonId },
    });
    expect(refused.status).toBe(403);
    expect(ferrets.calls).toEqual([]);
    await host.stop();
  });

  test('a body that is not the route’s shape is a 400, and an unknown ferret a 404', async () => {
    const { host, target } = await started();
    expect(
      (await host.request('POST', `/v1/relocate/${FERRET}/preflight`, { as: owner(), body: { to: 'x' } })).status,
    ).toBe(400);
    expect((await host.request('POST', `/v1/relocate/${FERRET}/export`, { as: owner(), body: {} })).status).toBe(400);
    expect(
      (await host.request('POST', '/v1/relocate/nobody/preflight', { as: owner(), body: { to: target.daemonId } }))
        .status,
    ).toBe(404);
    await host.stop();
  });

  test('export → chunks → complete over the routes, and the ferret is then a stub', async () => {
    const { host, ferrets, target } = await started();
    const made = await openOffer(target, { expiresAtMs: host.clock.nowMs() + 120_000 });
    const exported = await host.request('POST', `/v1/relocate/${FERRET}/export`, {
      as: owner(),
      body: { offer: made.offer },
    });
    expect(exported.status).toBe(200);
    const result = ExportResponseSchema.parse(exported.json());
    expect(ferrets.calls).toEqual(['stop:polite']);
    for (let index = 0; index < result.header.chunks; index += 1)
      expect(
        (await host.request('GET', `/v1/relocate/exports/${result.exportId}/chunks/${String(index)}`, { as: owner() }))
          .status,
      ).toBe(200);
    expect(
      (
        await host.request('GET', `/v1/relocate/exports/${result.exportId}/chunks/${String(result.header.chunks)}`, {
          as: owner(),
        })
      ).status,
    ).toBe(404);
    const done = await host.request('POST', `/v1/relocate/exports/${result.exportId}/complete`, {
      as: owner(),
      body: { to: { daemonId: target.daemonId, ferretId: 'f-on-b' } },
    });
    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({ ferretId: FERRET, movedTo: { ferretId: 'f-on-b' } });
    // the record is durable (state/relocate/moved.json): a second move of the same ferret is refused
    const again = await host.request('POST', `/v1/relocate/${FERRET}/preflight`, {
      as: owner(),
      body: { to: target.daemonId },
    });
    expect(again.status).toBe(409);
    expect(again.json()).toMatchObject({ code: 'already_moved' });
    // and the fleet list can read where it went: ids and instants, to a person only
    const ledger = await host.request('GET', '/v1/relocate/moved', { as: owner() });
    expect(ledger.status).toBe(200);
    expect(ledger.json()).toMatchObject({ moved: { [FERRET]: { daemonId: target.daemonId, ferretId: 'f-on-b' } } });
    expect((await host.request('GET', '/v1/relocate/moved', { as: ferret('f1') })).status).toBe(403);
    await host.stop();
  });

  test('before any move the ledger is empty, not an error', async () => {
    const { host } = await started();
    const ledger = await host.request('GET', '/v1/relocate/moved', { as: owner() });
    expect(ledger.status).toBe(200);
    expect(ledger.json()).toEqual({ moved: {} });
    await host.stop();
  });
});
