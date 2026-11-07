import { describe, it } from 'bun:test';
import should from 'should';
import * as api from '../../../app/features/accounts/accounts-api.ts';
import { TwoFactorSeedHost } from '../../../app/features/two-factor/two-factor-seed-host.tsx';
import { grantRefusalNotice } from '../../../app/shell.tsx';
import { signInApprovalRenderer } from '../../../app/surfaces.tsx';
import manifest from '../../../manifest.ts';

/** A client that records the route key and init of every call, answering what the caller's schema reads. */
function recording(answer: unknown) {
  const calls: { route: string; init: unknown }[] = [];
  return {
    calls,
    client: {
      call: async <A>(route: string, init?: unknown): Promise<A> => {
        calls.push({ route, init });
        return answer as A;
      },
    },
  };
}

const STAGE = 'st_0123456789abcdef01234567';
const declared: ReadonlySet<string> = new Set((manifest.actions?.routes ?? []).map(each => each.key));

describe('the app half', () => {
  it('should call only routes the manifest declares, by key, with each path part as a param', async () => {
    const { calls, client } = recording({});
    const id = 'GITHUB' as never;
    const runs: (() => Promise<unknown>)[] = [
      () => api.putAccount(client, id, { label: 'GitHub' }),
      () => api.removeAccount(client, id),
      () => api.addSignIn(client, id, { place: { kind: 'site', match: ['github.com'] } } as never),
      () => api.putSignIn(client, 's_1' as never, {} as never),
      () => api.removeSignIn(client, 's_1' as never),
      () => api.decideProposal(client, 's_1' as never, 'p1', 'approve'),
      () => api.addTwoFactorKey(client, id, { kind: 'sms', label: 'Phone' } as never),
      () => api.removeTwoFactorKey(client, id, 'k1' as never),
      () => api.readLookAlike(client),
      () => api.mergeAccounts(client, id, 'OTHER' as never),
      () => api.keepApart(client, id, 'OTHER' as never),
      () => api.readAccounts(client),
      () => api.putAccountDefault(client, {} as never),
      () => api.commitSeed(client, id, 'st_a' as never),
      () => api.dropSeed(client, id, 'st_a' as never),
      () => api.readSeedStage(client, undefined, 'st_a' as never),
      () => api.readSeedStage(client, id, 'st_a' as never),
    ];
    for (const run of runs) await run().catch(() => undefined);
    // Two bodies here are refused by their own request schema before any call: that is the parse-at-the-edge kept.
    should(new Set(calls.map(call => call.route)).size).be.greaterThanOrEqual(14);
    for (const call of calls) should(declared.has(call.route)).be.true(`${call.route} is not a declared route`);
  });

  it('S89 should send a pasted 2FA key in once, to the staging route, and parse no value back', async () => {
    const { calls, client } = recording({ stage: 'st_a', expiresAt: '2026-11-07T00:00:00.000Z' });
    await api
      .stageSeed(client, 'GITHUB' as never, { padded: 'x', totpAcknowledged: true } as never)
      .catch(() => undefined);
    should(calls.map(call => call.route)).eql(['POST /v1/accounts/:id/factors/seed']);
  });

  it('should word a Gate refusal, and leave every other failure to its own words', () => {
    should(grantRefusalNotice({ status: 403, code: 'grant_device_withheld', message: 'not on this device' })).match({
      detail: 'not on this device',
    });
    should(grantRefusalNotice({ status: 409, code: 'grant_device_withheld' })).be.null();
    should(grantRefusalNotice({ status: 403, code: 'passkey_required' })).be.null();
  });

  it('should draw a staged 2FA seed ask as the seed card, and any other sign-in approval as its own words', () => {
    const { client } = recording({});
    const Renderer = signInApprovalRenderer(client);
    const seed = Renderer({
      value: { ref: { kind: 'two-factor-seed', stage: STAGE }, subject: 'Save automatic codes?', why: 'w' },
    }) as { type: unknown; props: { item: { twoFactorSeed?: { stage: string } } } };
    should(seed.type).equal(TwoFactorSeedHost);
    should(seed.props.item.twoFactorSeed?.stage).equal(STAGE);
    const other = Renderer({ value: { ref: { kind: 'sign-in-rule' }, subject: 'Approve a rule?' } }) as {
      type: unknown;
    };
    should(other.type).equal('section');
    should(Renderer({ value: 'not an ask' })).be.null();
  });
});
