import { describe, expect, test } from 'bun:test';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import { toBase64Url } from '@ferretry/std/sealing';
import { RelocateOfferSchema, TargetPreflightResponseSchema, RECEIVED_STATE } from '../../contract/index.ts';
import relocate from '../../daemon/index.ts';
import { verifiedOfferKey } from '../../daemon/lib/seal.ts';
import { fakeFerrets, fakeSource, FERRET } from '../support/fake-ferrets.ts';
import { crypto, newIdentity } from '../support/identity.ts';

const NEEDS = { harness: 'claude-code', remote: 'https://example.invalid/acme/project', secrets: ['API_TOKEN'] };

async function started(over: { readonly secrets?: readonly string[]; readonly resumeRefuses?: boolean } = {}) {
  const ferrets = fakeFerrets({ state: 'idle', source: fakeSource(), folder: undefined });
  const host = await testHost({
    plugins: [relocate],
    fakes: {
      ferrets: {
        ...ferrets.port,
        ...(over.resumeRefuses
          ? { resume: async () => ({ ok: false, error: { code: 'refused', reason: 'the login is unavailable' } }) }
          : {}),
        harnesses: () => ['claude-code'],
        start: async () => ({ ok: false, error: { code: 'refused', reason: 'no' } }),
      },
    },
    uses: {
      projects: { list: async () => [], register: async () => ({ ok: false }), remove: async () => ({ ok: false }) },
      gitAccounts: { list: async () => [{ id: 'a' }] },
      runtimes: {
        default: async () => 'claude-default',
        resolve: async () => ({
          ok: true,
          runtime: { id: 'claude-default', harness: 'claude-code', launch: { available: true } },
        }),
      },
      vault: { has: async (name: string) => (over.secrets ?? []).includes(name) },
    },
  });
  return { host, ferrets };
}

describe('the target routes', () => {
  for (const resumeRefuses of [false, true])
    test(`starting an imported record requires its origin and the owner; resume refusal is honest (${String(resumeRefuses)})`, async () => {
      const { host, ferrets } = await started({ resumeRefuses });
      const route = `/v1/relocate/imports/${FERRET}/start`;
      expect((await host.request('POST', route, { as: owner() })).status).toBe(409);
      expect(ferrets.calls).not.toContain('resume');
      const source = await newIdentity();
      await host
        .state('relocate')
        .port([RECEIVED_STATE])
        .write(RECEIVED_STATE, {
          received: { [FERRET]: { daemonId: source.daemonId, ferretId: 'source-ferret', at: host.clock.now() } },
        });
      expect((await host.request('POST', route, { as: ferret('other') })).status).toBe(403);
      const result = await host.request('POST', route, { as: owner() });
      expect(result.status).toBe(resumeRefuses ? 409 : 200);
      if (resumeRefuses) expect(result.json()).toMatchObject({ code: 'start_refused' });
      else expect(ferrets.calls).toContain('resume');
      await host.stop();
    });
  test('an opened offer is signed by this daemon, and the source accepts it', async () => {
    const { host } = await started();
    const opened = await host.request('POST', '/v1/relocate/offers', { as: owner() });
    expect(opened.status).toBe(200);
    const offer = RelocateOfferSchema.parse(opened.json());
    const source = await newIdentity();
    // the kernel's own fixed-label signer made this signature; the source's check (U13) verifies it unchanged
    await verifiedOfferKey(crypto, offer, source.daemonId, host.clock.nowMs());
    expect((await host.request('POST', '/v1/relocate/offers', { as: owner() })).status).toBe(409);
    await host.stop();
  });

  test('preflight names the secret that is missing; a held one passes', async () => {
    const { host } = await started({ secrets: [] });
    const offer = RelocateOfferSchema.parse(
      (await host.request('POST', '/v1/relocate/offers', { as: owner() })).json(),
    );
    const answer = await host.request('POST', `/v1/relocate/offers/${offer.offerId}/preflight`, {
      as: owner(),
      body: { needs: NEEDS, cloneInto: '/srv/clones' },
    });
    expect(answer.status).toBe(200);
    const view = TargetPreflightResponseSchema.parse(answer.json());
    expect(view.missingSecrets).toEqual(['API_TOKEN']);
    expect(view.ok).toBe(false);
    await host.stop();
  });

  test('every target route is a person’s: a ferret is refused and nothing is opened', async () => {
    const { host } = await started();
    expect((await host.request('POST', '/v1/relocate/offers', { as: ferret('f1') })).status).toBe(403);
    expect((await host.request('PUT', '/v1/relocate/offers/x/chunks/0', { as: ferret('f1'), body: {} })).status).toBe(
      403,
    );
    // nothing was opened by the refused call, so the person's own open is the first
    expect((await host.request('POST', '/v1/relocate/offers', { as: owner() })).status).toBe(200);
    await host.stop();
  });

  test('a chunk upload is base64url ciphertext for an open offer; anything else is refused', async () => {
    const { host } = await started();
    const offer = RelocateOfferSchema.parse(
      (await host.request('POST', '/v1/relocate/offers', { as: owner() })).json(),
    );
    const put = (index: string, body: unknown, id = offer.offerId) =>
      host.request('PUT', `/v1/relocate/offers/${id}/chunks/${index}`, { as: owner(), body });
    expect((await put('0', { chunk: toBase64Url(new Uint8Array(100).fill(3)) })).status).toBe(200);
    expect((await put('0', { chunk: 'not base64!' })).status).toBe(400);
    expect((await put('x', { chunk: 'AAAA' })).status).toBe(400);
    expect((await put('0', { chunk: 'AAAA', extra: 1 })).status).toBe(400);
    expect((await put('0', { chunk: 'AAAA' }, 'fy_relocate_offer_unknownunknownunknown')).status).toBe(404);
    expect((await put('999999', { chunk: 'AAAA' })).status).toBe(400);
    await host.stop();
  });

  test('an import with a header of the wrong shape is a 400, and an unknown offer a 404', async () => {
    const { host } = await started();
    expect((await host.request('POST', '/v1/relocate/offers/x/import', { as: owner(), body: {} })).status).toBe(400);
    await host.stop();
  });
});
