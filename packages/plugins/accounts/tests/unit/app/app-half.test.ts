import { describe, it } from 'bun:test';
import should from 'should';
import * as api from '../../../app/features/accounts/accounts-api.ts';
import { SignInRuleSuggestionHost } from '../../../app/features/secure-copy/sign-in-rule-suggestion-host.tsx';
import { TaskPlanHost } from '../../../app/features/secure-copy/task-plan-host.tsx';
import { PhoneApprovalHost } from '../../../app/features/sign-in-approval/phone-approval-host.tsx';
import { TwoFactorSeedHost } from '../../../app/features/two-factor/two-factor-seed-host.tsx';
import { grantRefusalNotice } from '../../../app/shell.tsx';
import { signInApprovalRenderer } from '../../../app/surfaces.tsx';
import manifest from '../../../manifest.ts';
import { RULE_ID } from '../../support/app/sign-in-rule-fixtures.ts';

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

  it('S101 should draw a staged 2FA seed ask as the seed card, from the daemon-set ref alone', () => {
    const { client } = recording({});
    const Renderer = signInApprovalRenderer(client);
    const seed = Renderer({
      value: {
        ref: { kind: 'two-factor-seed', stage: STAGE },
        subject: 'Save automatic codes?',
        why: 'w',
        ferret: 'sess-1',
        ferretName: 'judson',
      },
    }) as { type: unknown; props: { item: { twoFactorSeed?: { stage: string } } } };
    should(seed.type).equal(TwoFactorSeedHost);
    should(seed.props.item.twoFactorSeed?.stage).equal(STAGE);
    should(Renderer({ value: 'not an ask' })).be.null();
  });

  it('should draw each other sign-in approval kind as its own card, read from the daemon by id, for the ask’s ferret', () => {
    const { client } = recording({});
    const Renderer = signInApprovalRenderer(client);
    const PLAN = 'a'.repeat(32);
    const drawn = (ref: unknown, ferret = 'sess-1') =>
      Renderer({ value: { ref, ferret, ferretName: 'judson', subject: 's', why: 'w' } }) as {
        type: unknown;
        props: Record<string, unknown>;
      };
    const task = drawn({ kind: 'task-plan', planId: PLAN });
    should(task.type).equal(TaskPlanHost);
    should(task.props).match({ ferret: 'sess-1', planId: PLAN });
    // A paste plan has no card of its own: the one-step approve was a widening outside any stage.
    should(drawn({ kind: 'copy-plan', planId: PLAN }).type).equal('section');
    const suggestion = drawn({ kind: 'rule-suggestion', suggestion: 'srg_dddddddddddddddd' });
    should(suggestion.type).equal(SignInRuleSuggestionHost);
    should(suggestion.props).match({ suggestionId: 'srg_dddddddddddddddd', ferret: 'sess-1' });
    const phone = drawn({ kind: 'phone-approval', id: `pa_${'0'.repeat(23)}1` });
    should(phone.type).equal(PhoneApprovalHost);
    should(phone.props).match({ approvalId: `pa_${'0'.repeat(23)}1`, ferret: 'sess-1' });
  });

  it('should draw a ref it cannot read a card for, a suspended rule and a recipe proposal as the daemon’s words and where to act', () => {
    const { client } = recording({});
    const Renderer = signInApprovalRenderer(client);
    const plain = (ref: unknown, ferret = 'sess-1') =>
      Renderer({ value: { ref, ferret, ferretName: 'judson', subject: 'Approve a rule?', why: 'because' } }) as {
        type: unknown;
        props: { children: unknown[] };
      };
    should(plain({ kind: 'sign-in-rule' }).type).equal('section');
    // An ask that names no ferret is not an ask (Asks' contract requires one): nothing is drawn from a guess.
    should(
      Renderer({ value: { ref: { kind: 'task-plan', planId: 'a'.repeat(32) }, subject: 's', why: 'w' } }),
    ).be.null();
    const text = (node: unknown): string => JSON.stringify(node);
    should(text(plain({ kind: 'rule-suspended', rule: RULE_ID }))).containEql('Standing sign-in rules');
    should(
      text(plain({ kind: 'recipe-proposal', signIn: 'si_0000000000000001', proposal: 'rp_0123456789abcdef' })),
    ).containEql('Settings › Accounts');
  });
});
