import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { CallStanding, FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import type { SignInRuleSuggestionId } from '../../../../contract/routes/index.ts';
import { signInRuleRoutes } from '../../../../daemon/lib/runtime/mounts/sign-in-rules.ts';
import { SignInRuleSuggestionError, SignInRuleSuggestions } from '../../../../daemon/lib/sign-in-rules/index.ts';
import {
  approved,
  DEVICE,
  DRAFT,
  evidenceFor,
  GITHUB,
  listing,
  NOW,
  UNTAPPED,
  world as rulesWorld,
} from '../sign-in-rules/support.ts';
import { allowedDevice, driverOf, machine, without as deviceWithout } from './driver.ts';

/**
 * The owner's standing sign-in rule routes, driven on the route table with a real SignInRuleService and a real
 * SignInRuleSuggestions. Only the ports are fakes: the rules file, the accounts listing, the passkey registry, the agenda.
 */

const without = (...capabilities: string[]) => deviceWithout(capabilities, {}, DEVICE);
const phone = (claims: Parameters<typeof allowedDevice>[0] = {}) => allowedDevice(claims, DEVICE);

class RefusingSuggestions extends SignInRuleSuggestions {
  constructor(
    ports: ConstructorParameters<typeof SignInRuleSuggestions>[0],
    private readonly code: SignInRuleSuggestionError['code'],
  ) {
    super(ports);
  }
  override list(): never {
    throw new SignInRuleSuggestionError(this.code, `the suggestions say ${this.code}`);
  }
}

function suggestionPorts(): ConstructorParameters<typeof SignInRuleSuggestions>[0] {
  let cards = 0;
  let ids = 0;
  return {
    accounts: { listing: async () => listing() },
    agenda: {
      raise: async () => ({ ok: true, id: `A${String(++cards)}` }),
      close: async () => undefined,
    },
    redact: async text => text,
    audit: { record: async () => undefined },
    clock: { now: () => NOW },
    ids: { suggestionId: () => `srg_${String(++ids).padStart(16, '0')}` as SignInRuleSuggestionId },
    terminalRules: () => true,
  };
}

async function mounted(options: Parameters<typeof rulesWorld>[0] = {}) {
  const w = await rulesWorld(options);
  const suggestions = new SignInRuleSuggestions(suggestionPorts());
  return { w, suggestions, call: driverOf(signInRuleRoutes(w.service, suggestions)) };
}

const stageRoute = '/v1/sign-in-rules/stages/:stage';
const ruleRoute = '/v1/sign-in-rules/:id';

/** Stages the draft from the device that will approve it, answering the stage id. */
async function stagedBy(m: Awaited<ReturnType<typeof mounted>>, standing: CallStanding = phone()) {
  const staged = await m.call('POST', '/v1/sign-in-rules/stages', { body: DRAFT, standing });
  should(staged.status).equal(201);
  return (staged.body as { stage: `srs_${string}` }).stage;
}

describe('reading the rules', () => {
  it('should list the rules to the owner, all or for one sign-in, and nothing for a sign-in with none', async () => {
    const m = await mounted();
    await approved(m.w);

    const all = await m.call('GET', '/v1/sign-in-rules');
    const one = await m.call('GET', '/v1/sign-in-rules', { query: { signIn: GITHUB } });
    const other = await m.call('GET', '/v1/sign-in-rules', { query: { signIn: UNTAPPED } });

    should(all.status).equal(200);
    should((all.body as { rules: unknown[] }).rules).have.length(1);
    should((one.body as { rules: unknown[] }).rules).have.length(1);
    should((other.body as { rules: unknown[] }).rules).have.length(0);
  });

  it('should refuse a sign-in name that is not one, and a device denied the accounts', async () => {
    const m = await mounted();
    const bad = await m.call('GET', '/v1/sign-in-rules', { query: { signIn: 'github' } });
    const denied = await m.call('GET', '/v1/sign-in-rules', { standing: without('secrets') });
    should(bad).match({ status: 400, code: 'bad_request', body: 'name a sign-in as ?signIn=si_…' });
    should(denied).match({ status: 403, code: 'grant_not_granted' });
    should(denied.body).match({ error: /read the standing sign-in rules/u });
  });

  it('should answer whether a sign-in may have a rule, and refuse to guess which sign-in is meant', async () => {
    const m = await mounted();
    const ok = await m.call('GET', '/v1/sign-in-rules/eligibility', { query: { signIn: GITHUB } });
    const missing = await m.call('GET', '/v1/sign-in-rules/eligibility');
    const denied = await m.call('GET', '/v1/sign-in-rules/eligibility', {
      query: { signIn: GITHUB },
      standing: without('secrets'),
    });
    should(ok).match({ status: 200, body: { eligible: true } });
    should(missing).match({ status: 400, code: 'bad_request' });
    should(denied.status).equal(403);
  });
});

describe('staging a rule', () => {
  it('should hold the draft for its passkey and answer 201 with the stage, approving nothing', async () => {
    const m = await mounted();
    const staged = await m.call('POST', '/v1/sign-in-rules/stages', { body: DRAFT, standing: phone() });
    should(staged).match({ status: 201, body: { stage: /^srs_/u } });
    should((await m.call('GET', '/v1/sign-in-rules')).body).match({ rules: [] });
  });

  it('should demand the accounts and the page permission of whoever loosens what fills a page', async () => {
    const m = await mounted();
    for (const [denied, words] of [
      ['secrets', /read the accounts a standing rule names/u],
      ['browser', /approve a sign-in into a page in advance/u],
    ] as const) {
      const refused = await m.call('POST', '/v1/sign-in-rules/stages', { body: DRAFT, standing: without(denied) });
      should(refused).match({ status: 403, code: 'grant_not_granted' });
      should(refused.body).match({ error: words });
    }
    should(m.w.audits).have.length(0);
  });

  it('should refuse a body that is not a draft, and a sign-in the service says cannot have a rule', async () => {
    const m = await mounted();
    const bad = await m.call('POST', '/v1/sign-in-rules/stages', { body: { signIn: 'x' }, standing: phone() });
    const unknown = await m.call('POST', '/v1/sign-in-rules/stages', {
      body: { ...DRAFT, signIn: 'si_00000000000000ff' },
      standing: phone(),
    });
    should(bad).match({ status: 400, code: 'invalid_request' });
    should(unknown.status).be.within(400, 499);
    should(unknown.code).be.a.String();
  });
});

describe('a staged rule', () => {
  it('should read where it stands, and call a stage name this daemon never minted not waiting', async () => {
    const m = await mounted();
    const stage = await stagedBy(m);

    const view = await m.call('GET', stageRoute, { params: { stage }, standing: phone() });
    const forged = await m.call('GET', stageRoute, { params: { stage: 'srs_nope' } });
    const unknown = await m.call('GET', stageRoute, { params: { stage: `srs_${'f'.repeat(24)}` } });
    const denied = await m.call('GET', stageRoute, { params: { stage }, standing: without('secrets') });

    should(view).match({ status: 200, body: { state: 'waiting' } });
    should(forged).match({ status: 404, code: 'stage_not_found' });
    should(unknown.status).equal(404);
    should(denied).match({ status: 403, code: 'grant_not_granted' });
  });

  it('should drop a stage with no passkey', async () => {
    const m = await mounted();
    const stage = await stagedBy(m);
    const dropped = await m.call('DELETE', stageRoute, { params: { stage }, standing: phone() });
    const again = await m.call('DELETE', stageRoute, { params: { stage }, standing: phone() });
    should(dropped).match({ status: 200, body: { stage, dropped: true } });
    should(again.status).equal(404);
  });

  it('should show a stage the machine made in the app, and let a paired device take it for its own passkey', async () => {
    const m = await mounted();
    const stage = await stagedBy(m, machine());
    const confirm = '/v1/sign-in-rules/stages/:stage/confirm-in-app';
    const bind = '/v1/sign-in-rules/stages/:stage/bind';

    const confirmed = await m.call('POST', confirm, { params: { stage } });
    const bound = await m.call('POST', bind, { params: { stage }, standing: phone() });

    should(confirmed).match({ status: 201, body: { stage } });
    should(bound).match({ status: 201, body: { stage } });
    should(m.w.service.challengeOf(stage, DEVICE)).not.be.undefined();
  });

  it('should demand the same permissions to show or take a stage as to commit one', async () => {
    const m = await mounted();
    const stage = await stagedBy(m, machine());
    for (const route of ['confirm-in-app', 'bind']) {
      const refused = await m.call('POST', `/v1/sign-in-rules/stages/:stage/${route}`, {
        params: { stage },
        standing: without('browser'),
      });
      should(refused).match({ status: 403, code: 'grant_not_granted' });
    }
    should(m.w.service.challengeOf(stage, DEVICE)).be.undefined();
  });

  it('should refuse the machine taking a stage: only a paired device approves, with its passkey', async () => {
    const m = await mounted();
    const stage = await stagedBy(m, machine());
    const refused = await m.call('POST', '/v1/sign-in-rules/stages/:stage/bind', { params: { stage } });
    should(refused).match({ status: 403, code: 'forbidden' });
  });
});

describe('committing a rule', () => {
  const commit = '/v1/sign-in-rules/stages/:stage/commit';

  it('should answer the step-up demand naming the act when the kept proof is missing, the machine included', async () => {
    // One stage per world: a second stage of the same draft replaces the first.
    const device = await mounted();
    const stage = await stagedBy(device);
    const atTheMachine = await mounted();
    const machineStage = await stagedBy(atTheMachine, machine());

    const demanded = await device.call('POST', commit, { params: { stage }, standing: phone() });
    const atMachine = await atTheMachine.call('POST', commit, {
      params: { stage: machineStage },
      standing: machine(),
    });
    const m = device;

    for (const refused of [demanded, atMachine])
      should(refused).match({
        status: 403,
        code: STEP_UP_REQUIRED_CODE,
        body: { demand: { capability: 'secrets', axis: 'configure', act: 'approve-sign-in-rule' } },
      });
    should((await m.call('GET', '/v1/sign-in-rules')).body).match({ rules: [] });
  });

  it('should make the rule with the proof over this stage’s bytes, and take the ferret’s suggestions of it off the list', async () => {
    const m = await mounted();
    await m.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });
    should((await m.call('GET', '/v1/sign-in-rules/suggestions')).body).match({ suggestions: [{}] });
    const stage = await stagedBy(m);
    const challenge = m.w.service.challengeOf(stage, DEVICE);
    if (challenge === undefined) throw new Error('no challenge for the device');
    const claims: string[] = [];

    const made = await m.call('POST', commit, {
      params: { stage },
      standing: phone({
        claimStoredProof: ((act: string, subject: string) => {
          claims.push(`${act}:${subject}`);
          return evidenceFor(challenge, DEVICE);
        }) as CallStanding['claimStoredProof'],
      }),
    });

    should(made).match({ status: 201, body: { signIn: GITHUB } });
    should(claims).eql([`approve-sign-in-rule:${stage}`]);
    should((await m.call('GET', '/v1/sign-in-rules')).body).match({ rules: [{}] });
    should((await m.call('GET', '/v1/sign-in-rules/suggestions')).body).match({ suggestions: [] });
  });

  it('should refuse, claiming no proof, when the device may not reach a page or the accounts', async () => {
    const m = await mounted();
    const stage = await stagedBy(m);
    let claimed = 0;
    const claimStoredProof = (() => {
      claimed += 1;
      return undefined;
    }) as CallStanding['claimStoredProof'];

    const refused = await m.call('POST', commit, {
      params: { stage },
      standing: deviceWithout(['browser'], { claimStoredProof }, DEVICE),
    });

    should(refused).match({ status: 403, code: 'grant_not_granted' });
    should(claimed).equal(0);
  });

  it('should answer a proof for other bytes as the service’s own refusal, never as a made rule', async () => {
    const m = await mounted();
    const stage = await stagedBy(m);
    const refused = await m.call('POST', commit, {
      params: { stage },
      standing: phone({
        claimStoredProof: (() => evidenceFor(new Uint8Array(32), DEVICE)) as CallStanding['claimStoredProof'],
      }),
    });
    should(refused.status).be.within(400, 499);
    should(refused.status).not.equal(201);
    should((await m.call('GET', '/v1/sign-in-rules')).body).match({ rules: [] });
  });

  it('should find a stage that is gone, or could not be minted, not waiting', async () => {
    const m = await mounted();
    const stage = await stagedBy(m);
    await m.call('DELETE', stageRoute, { params: { stage }, standing: phone() });
    should((await m.call('POST', commit, { params: { stage }, standing: phone() })).status).equal(404);
    should(await m.call('POST', commit, { params: { stage: 'nope' }, standing: phone() })).match({
      status: 404,
      code: 'stage_not_found',
    });
  });
});

describe('narrowing and revoking', () => {
  async function withRule() {
    const m = await mounted();
    const { view } = await approved(m.w);
    return { m, id: view.id };
  }

  it('should narrow a rule with no passkey, and refuse anything that is not strictly narrower', async () => {
    const { m, id } = await withRule();
    const narrow = '/v1/sign-in-rules/:id/narrow';

    const narrowed = await m.call('POST', narrow, { params: { id }, body: { uses: 1 } });
    const widened = await m.call('POST', narrow, { params: { id }, body: { uses: 2 } });
    const empty = await m.call('POST', narrow, { params: { id }, body: {} });

    should(narrowed.status).equal(200);
    should(widened).match({ status: 400, code: 'bad_request' });
    should(empty).match({ status: 400, code: 'invalid_request' });
  });

  it('should refuse a rule name that is not one, and a device denied the accounts', async () => {
    const { m, id } = await withRule();
    const narrow = '/v1/sign-in-rules/:id/narrow';
    const bad = await m.call('POST', narrow, { params: { id: 'rule-1' }, body: { uses: 1 } });
    const denied = await m.call('POST', narrow, { params: { id }, body: { uses: 1 }, standing: without('secrets') });
    should(bad).match({ status: 400, code: 'bad_request', body: 'the rule in the path is not usable' });
    should(denied).match({ status: 403, code: 'grant_not_granted' });
  });

  it('should revoke one rule at a tap, and find it gone the second time', async () => {
    const { m, id } = await withRule();
    const revoked = await m.call('DELETE', ruleRoute, { params: { id } });
    const again = await m.call('DELETE', ruleRoute, { params: { id } });
    should(revoked).match({ status: 200, body: { id, revoked: true } });
    should(again.status).equal(404);
    should((await m.call('GET', '/v1/sign-in-rules')).body).match({ rules: [] });
  });

  it('should revoke every rule of one account, naming the account the way the path spells it', async () => {
    const { m } = await withRule();
    const route = '/v1/accounts/:id/sign-in-rules/revoke';

    const revoked = await m.call('POST', route, { params: { id: 'GITHUB_WORK' } });
    const none = await m.call('POST', route, { params: { id: 'GITHUB_WORK' } });
    const bad = await m.call('POST', route, { params: { id: 'not an account' } });
    const encoded = await m.call('POST', route, { params: { id: '%E0%A4%A' } });

    should(revoked).match({ status: 200, body: { account: 'GITHUB_WORK', revoked: 1 } });
    should(none).match({ status: 200, body: { revoked: 0 } });
    should(bad).match({ status: 400, code: 'invalid_account_id' });
    should(encoded).match({ status: 400, code: 'invalid_account_id' });
  });
});

describe('the ferrets’ suggestions', () => {
  it('should list the suggestions waiting, and dismiss one off the owner’s list alone', async () => {
    const m = await mounted();
    const suggested = await m.suggestions.suggest('s-one', { signIn: GITHUB, why: 'daily' });

    const listed = await m.call('GET', '/v1/sign-in-rules/suggestions');
    const dismissed = await m.call('DELETE', '/v1/sign-in-rules/suggestions/:sid', {
      params: { sid: suggested.suggestion },
    });
    const again = await m.call('DELETE', '/v1/sign-in-rules/suggestions/:sid', {
      params: { sid: suggested.suggestion },
    });

    should(listed).match({ status: 200, body: { suggestions: [{ id: suggested.suggestion }] } });
    should(dismissed).match({ status: 200, body: { id: suggested.suggestion, dismissed: true } });
    should(again).match({ status: 200, body: { dismissed: false } });
    should((await m.call('GET', '/v1/sign-in-rules/suggestions')).body).match({ suggestions: [] });
    // The ferret still reads it as waiting: an answer never shows on the ferret's side.
    should(m.suggestions.waiting('s-one', GITHUB)).be.true();
  });

  it('should refuse a device denied the accounts the list, and a suggestion name that is not one', async () => {
    const m = await mounted();
    const denied = await m.call('GET', '/v1/sign-in-rules/suggestions', { standing: without('secrets') });
    const bad = await m.call('DELETE', '/v1/sign-in-rules/suggestions/:sid', { params: { sid: 'srg_x' } });
    should(denied).match({ status: 403, code: 'grant_not_granted' });
    should(bad).match({ status: 400, code: 'bad_request', body: 'the suggestion in the path is not usable' });
  });

  it('should answer each refusal of the suggestions as a status the person can act on, never a 500', async () => {
    const statuses = { bad_request: 400, not_found: 404, capacity: 429, unavailable: 503 } as const;
    for (const [code, status] of Object.entries(statuses) as [SignInRuleSuggestionError['code'], number][]) {
      const w = await rulesWorld();
      const call = driverOf(signInRuleRoutes(w.service, new RefusingSuggestions(suggestionPorts(), code)));
      const refused = await call('GET', '/v1/sign-in-rules/suggestions');
      should(refused).match({ status, code, body: `the suggestions say ${code}` });
    }
  });
});

describe('who may use these routes', () => {
  it('should refuse a ferret every route that reads the owner first, in the owner-only words', async () => {
    const m = await mounted();
    const standing = ferretStanding('F1' as FerretId);
    const refused = await Promise.all([
      m.call('DELETE', ruleRoute, { params: { id: `sr_${'0'.repeat(24)}` }, standing }),
      m.call('DELETE', stageRoute, { params: { stage: `srs_${'0'.repeat(24)}` }, standing }),
      m.call('POST', '/v1/accounts/:id/sign-in-rules/revoke', { params: { id: 'GITHUB_WORK' }, standing }),
      m.call('POST', '/v1/sign-in-rules/stages', { body: DRAFT, standing }),
    ]);
    for (const answer of refused) should(answer).match({ status: 403, code: 'owner_only' });
    should(refused[0]?.body).containEql('makes, changes or reads standing rules');
  });

  it('should rethrow a failure that is no refusal of the service rather than dress it as one', async () => {
    const w = await rulesWorld();
    class Broken extends SignInRuleSuggestions {
      override list(): never {
        throw new TypeError('a bug, not a refusal');
      }
    }
    const call = driverOf(signInRuleRoutes(w.service, new Broken(suggestionPorts())));
    await should(call('GET', '/v1/sign-in-rules/suggestions')).be.rejectedWith(TypeError);
  });

  it('should refuse a proof that is held by no device at all, as the service says', async () => {
    const m = await mounted({ passkeys: false });
    const refused = await m.call('POST', '/v1/sign-in-rules/stages', { body: DRAFT, standing: phone() });
    should(refused.status).equal(409);
    should(refused.code).be.a.String();
  });
});
