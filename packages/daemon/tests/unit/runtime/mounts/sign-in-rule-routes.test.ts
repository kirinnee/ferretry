import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE, type SignInRuleStageId } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import type { CapabilityGuard } from '../../../../src/lib/api/capability.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { signInRuleRoutes } from '../../../../src/lib/runtime/mounts/sign-in-rules.ts';
import { stepUpRoutes } from '../../../../src/lib/runtime/mounts/step-up.ts';
import { SignInRuleService, SignInRuleSuggestions } from '../../../../src/lib/sign-in-rules/index.ts';
import {
  ChallengeLedger,
  type PasskeyStore,
  type PasskeyVerifierPort,
  StepUpRegistry,
  StepUpService,
  type StoredPasskey,
} from '../../../../src/lib/step-up/index.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { MemoryRuleStore, listing, signIn, tappedFact } from '../../sign-in-rules/support.ts';
import { agentIn, CREDENTIALS, fromFerret, GRANTED, human, withoutGrant } from './support.ts';

/**
 * THE STANDING-RULE ROUTES through the real router, boundary, step-up service and registry (r3c-plan §5, invariants 1,
 * 3, 31): a ferret never reaches one; a rule is committed only with the KEPT `approve-sign-in-rule` assertion over its
 * own stage's bytes, from a paired device; and a device denied the accounts reads and spends nothing.
 */

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ORIGIN = 'https://app.example.test';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const browser = { deviceId, appSession: 'app-one' } as const;
const b64 = (bytes: ArrayLike<number>): string => Buffer.from(Uint8Array.from(bytes)).toString('base64url');
const CREDENTIAL_ID = b64([1, 2, 3, 4]);
const GITHUB = 'si_00000000000000a1';
const GITLAB = 'si_00000000000000a5';
const json = (value: unknown): string => JSON.stringify(value);
const assertionBody = json({
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'Y2xpZW50',
  authenticatorData: 'YXV0aA',
  signature: 'c2ln',
});

class MemoryStore implements PasskeyStore {
  constructor(public held: StoredPasskey[] = []) {}
  async list(id: string): Promise<readonly StoredPasskey[]> {
    return this.held.filter(passkey => passkey.deviceId === id);
  }
  async holder(credentialId: string): Promise<string | undefined> {
    return this.held.find(passkey => passkey.credentialId === credentialId)?.deviceId;
  }
  async add(passkey: StoredPasskey): Promise<void> {
    this.held = [...this.held, passkey];
  }
  async updateSignCount(): Promise<boolean> {
    return true;
  }
  async forgetDevice(id: string): Promise<void> {
    this.held = this.held.filter(passkey => passkey.deviceId !== id);
  }
}

/** Live ceremonies pass; a KEPT one passes only against a challenge a staged rule really issued. */
class FakeVerifier implements PasskeyVerifierPort {
  readonly issued = new Set<string>();
  async verifyRegistration(): ReturnType<PasskeyVerifierPort['verifyRegistration']> {
    return { ok: false, reason: 'not exercised' };
  }
  async verifyAssertion(): ReturnType<PasskeyVerifierPort['verifyAssertion']> {
    return { ok: true, signCount: 5, origin: ORIGIN };
  }
  async verifyStoredAssertion(input: {
    readonly expectedChallenge: Uint8Array;
  }): ReturnType<PasskeyVerifierPort['verifyAssertion']> {
    return this.issued.has(b64(input.expectedChallenge))
      ? { ok: true, signCount: 0, origin: ORIGIN }
      : { ok: false, reason: 'bad signature' };
  }
}

async function served() {
  const clock = { now: NOW };
  const store = new MemoryStore([
    {
      credentialId: CREDENTIAL_ID,
      deviceId,
      algorithm: -7,
      publicKeySpki: b64([9, 9, 9, 9]),
      signCount: 1,
      origin: ORIGIN,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ]);
  const verifier = new FakeVerifier();
  const registry = new StepUpRegistry({ nowMs: () => clock.now });
  registry.open(browser);
  const stepUp = new StepUpService({
    store,
    verifier,
    registry,
    challenges: new ChallengeLedger(),
    random: { bytes: length => new Uint8Array(length).fill(7) },
    clock: { nowMs: () => clock.now },
    devices: {
      device: async id => (id === deviceId ? { name: 'Pixel 9', createdAt: '2026-10-01T00:00:00.000Z' } : undefined),
    },
    allowedOrigins: () => [ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    audit: { record: async () => undefined },
  });
  const base = listing();
  const ruleStore = new MemoryRuleStore();
  const accounts = {
    listing: async () => ({
      ...base,
      signIns: [
        ...base.signIns,
        signIn({
          id: GITLAB as never,
          place: { kind: 'site', domains: ['gitlab.com'], match: [] },
          observed: [tappedFact('gitlab.com')],
        }),
      ],
    }),
  };
  const rules = new SignInRuleService({
    store: ruleStore,
    accounts,
    proofs: {
      holds: async (id, credentialId) => (await store.holder(credentialId)) === id,
      verify: async (proof, challenge) => await stepUp.verifyStoredProof(proof, challenge),
    },
    passkeys: { any: async () => true, of: async id => (await store.list(id)).length > 0 },
    audit: { record: async () => undefined },
    clock: { now: () => clock.now },
    warn: () => undefined,
  });
  await rules.load();
  const raised: string[] = [];
  const suggestions = new SignInRuleSuggestions({
    accounts,
    agenda: {
      raise: async (_session, card) => {
        raised.push(card.ask);
        return { ok: true, id: `A${String(raised.length)}` };
      },
      isOpen: async () => true,
      close: async () => undefined,
    },
    redact: async text => text,
    audit: { record: async () => undefined },
    clock: { now: () => clock.now },
  });
  /** Stages whose ceremony a test makes over OTHER bytes than the stage's own (a challenge with one bit flipped). */
  const tampered = new Set<string>();
  const routes = [
    ...stepUpRoutes(
      stepUp,
      // A 2FA seed and a task-plan selection waiting for their passkeys, so their proofs can be made too.
      { boundSubjectOf: () => 'b'.repeat(64) },
      { boundSubjectOf: () => 'c'.repeat(64) },
      {
        challengeOf: (stage, device) => {
          const challenge = rules.challengeOf(stage, device);
          if (challenge === undefined) return undefined;
          const issued = tampered.has(stage)
            ? challenge.map((byte, index) => (index === 0 ? byte ^ 1 : byte))
            : challenge;
          verifier.issued.add(b64(issued));
          return issued;
        },
      },
    ),
    ...signInRuleRoutes(rules, suggestions),
  ];
  const credentials = {
    ...CREDENTIALS,
    devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
  };
  const dispatcherWith = (guard: CapabilityGuard) =>
    new ApiDispatcher(new ApiRouter(routes), credentials, guard, undefined, stepUp);
  return {
    clock,
    rules,
    suggestions,
    raised,
    ruleStore,
    routes,
    stepUp,
    tampered,
    dispatch: dispatcherWith(GRANTED),
    dispatcherWith,
  };
}

type Served = Awaited<ReturnType<typeof served>>;

/** A path with its query split off, as the server hands a route both. */
const at = (target: string) => {
  const [path = '', query] = target.split('?');
  return { path, query: [...new URLSearchParams(query ?? '')].map(([name, value]) => [name, value] as const) };
};

const asDevice = (method: string, target: string, body?: unknown) =>
  request({
    method,
    ...at(target),
    device: browser,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: json(body) }),
  });

async function stage(s: Served, signInId = GITHUB): Promise<SignInRuleStageId> {
  const staged = await s.dispatch.dispatch(
    asDevice('POST', '/v1/sign-in-rules/stages', { signIn: signInId, fields: ['username', 'password'] }),
  );
  should(staged.status).equal(201);
  return jsonBody(staged)['stage'] as SignInRuleStageId;
}

/** The app's passkey ceremony for `act` (and its subject), as the device runs it. */
async function ceremony(s: Served, act?: string, subject?: string) {
  const options = await s.dispatch.dispatch(
    asDevice('POST', '/v1/step-up/options', {
      origin: ORIGIN,
      ...(act === undefined ? {} : { act }),
      ...(subject === undefined ? {} : { subject }),
    }),
  );
  const stepped = await s.dispatch.dispatch(
    request({ method: 'POST', path: '/v1/step-up', body: assertionBody, device: browser }),
  );
  return { options: options.status, stepped: stepped.status };
}

const commit = async (dispatch: ApiDispatcher, stageId: string) =>
  await dispatch.dispatch(asDevice('POST', `/v1/sign-in-rules/stages/${stageId}/commit`, {}));

describe('a ferret never reaches a rule route (invariant 1)', () => {
  it('should refuse a ferret on every route before reading a body', async () => {
    // Arrange
    const s = await served();
    const reads = bodyReads();
    const stageId = `srs_${'0'.repeat(24)}`;
    const rule = `sr_${'0'.repeat(24)}`;
    const ask = (method: string, target: string, headers: Record<string, string>) =>
      request({
        method,
        ...at(target),
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
        reads,
      });

    // Act
    const answers = [];
    for (const [index, headers] of [agentIn('mvv6b4qw-49d0158d'), human].entries())
      for (const [method, path] of [
        ['GET', '/v1/sign-in-rules'],
        ['GET', `/v1/sign-in-rules/eligibility?signIn=${GITHUB}`],
        ['POST', '/v1/sign-in-rules/stages'],
        ['GET', `/v1/sign-in-rules/stages/${stageId}`],
        ['POST', `/v1/sign-in-rules/stages/${stageId}/confirm-in-app`],
        ['POST', `/v1/sign-in-rules/stages/${stageId}/bind`],
        ['POST', `/v1/sign-in-rules/stages/${stageId}/commit`],
        ['DELETE', `/v1/sign-in-rules/stages/${stageId}`],
        ['POST', `/v1/sign-in-rules/${rule}/narrow`],
        ['DELETE', `/v1/sign-in-rules/${rule}`],
        ['GET', '/v1/sign-in-rules/suggestions'],
        ['DELETE', `/v1/sign-in-rules/suggestions/srg_${'0'.repeat(16)}`],
        ['POST', '/v1/accounts/GITHUB_WORK/sign-in-rules/revoke'],
      ] as const) {
        const asked = ask(method, path, headers);
        answers.push(await s.dispatch.dispatch(index === 1 ? fromFerret(asked) : asked));
      }

    // Assert
    should(answers.map(answer => [answer.status, jsonBody(answer).code])).eql(answers.map(() => [403, 'owner_only']));
    should(reads.consumed).be.false();
    should(s.ruleStore.writes).equal(0);
  });

  it('should have no route that edits a rule body: no PUT or PATCH', async () => {
    const s = await served();
    should(
      s.routes
        .filter(route => route.path.includes('sign-in-rules'))
        .map(
          route =>
            `${route.method} ${route.path} ${route.caller} ${route.capability?.capability ?? ''}.${route.capability?.axis ?? ''}`,
        ),
    ).eql([
      'GET /v1/sign-in-rules/suggestions person secrets.use',
      'DELETE /v1/sign-in-rules/suggestions/:sid person secrets.use',
      'GET /v1/sign-in-rules person secrets.use',
      'GET /v1/sign-in-rules/eligibility person secrets.use',
      'POST /v1/sign-in-rules/stages person secrets.configure',
      'GET /v1/sign-in-rules/stages/:stage person secrets.use',
      'POST /v1/sign-in-rules/stages/:stage/confirm-in-app person secrets.configure',
      'POST /v1/sign-in-rules/stages/:stage/bind person secrets.configure',
      'POST /v1/sign-in-rules/stages/:stage/commit person secrets.configure',
      'DELETE /v1/sign-in-rules/stages/:stage person secrets.use',
      'POST /v1/sign-in-rules/:id/narrow person secrets.use',
      'DELETE /v1/sign-in-rules/:id person secrets.use',
      'POST /v1/accounts/:id/sign-in-rules/revoke person secrets.use',
    ]);
  });
});

describe('a rule is committed only with the kept proof over its own stage (invariant 3)', () => {
  it('should commit with the approve-sign-in-rule passkey bound to the stage, once', async () => {
    // Arrange
    const s = await served();
    const stageId = await stage(s);

    // Act
    const proved = await ceremony(s, 'approve-sign-in-rule', stageId);
    const made = await commit(s.dispatch, stageId);
    const again = await commit(s.dispatch, stageId);

    // Assert
    should(proved).eql({ options: 200, stepped: 200 });
    should(made.status).equal(201);
    should(jsonBody(made)).containDeep({ status: 'active', approvedWith: { deviceId } });
    should(s.ruleStore.document?.rules).have.length(1);
    should(jsonBody(again).code).equal('stage_not_found');
  });

  it("should refuse the machine's own token even for the rule it staged: it holds no passkey", async () => {
    // Arrange — `fy rules add`: staged at the machine, put in the app, proved on the phone
    const s = await served();
    const atMachine = (method: string, path: string, body?: unknown) =>
      request({
        method,
        path,
        headers: { ...human, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: json(body) }),
        loopback: true,
        privilegedLoopback: true,
      });
    const staged = await s.dispatch.dispatch(
      atMachine('POST', '/v1/sign-in-rules/stages', { signIn: GITHUB, fields: ['username', 'password'] }),
    );
    const stageId = jsonBody(staged)['stage'] as string;
    const shown = await s.dispatch.dispatch(
      atMachine('POST', `/v1/sign-in-rules/stages/${stageId}/confirm-in-app`, {}),
    );
    const unbound = await ceremony(s, 'approve-sign-in-rule', stageId);
    const taken = await s.dispatch.dispatch(asDevice('POST', `/v1/sign-in-rules/stages/${stageId}/bind`, {}));
    await ceremony(s, 'approve-sign-in-rule', stageId);

    // Act
    const machine = await s.dispatch.dispatch(atMachine('POST', `/v1/sign-in-rules/stages/${stageId}/commit`, {}));
    const phone = await commit(s.dispatch, stageId);

    // Assert
    should([staged.status, shown.status, taken.status]).eql([201, 201, 201]);
    // Passkey options for a machine stage nobody took yet mint nothing (secrev-1274a L3).
    should(unbound.options).equal(404);
    should(machine.status).equal(403);
    should(jsonBody(machine)).containDeep({ code: STEP_UP_REQUIRED_CODE, demand: { act: 'approve-sign-in-rule' } });
    should(phone.status).equal(201);
  });

  it('should refuse a window step-up, an act-less proof and another stage’s proof, and spend none of them', async () => {
    // Arrange — two rules waiting; the passkey is proved for the second
    const s = await served();
    const first = await stage(s, GITHUB);
    const second = await stage(s, GITLAB);
    await ceremony(s);

    // Act
    const windowed = await commit(s.dispatch, first);
    await ceremony(s, 'approve-sign-in-rule', second);
    const borrowed = await commit(s.dispatch, first);
    const own = await commit(s.dispatch, second);

    // Assert
    for (const refused of [windowed, borrowed]) {
      should(refused.status).equal(403);
      should(jsonBody(refused)).containDeep({ code: STEP_UP_REQUIRED_CODE, demand: { act: 'approve-sign-in-rule' } });
    }
    should(own.status).equal(201);
    should(s.ruleStore.document?.rules.map(rule => rule.body.signIn)).eql([GITLAB]);
  });

  it('should refuse a used proof for a new approval, and a stage that lapsed', async () => {
    // Arrange
    const s = await served();
    const stageId = await stage(s);
    await ceremony(s, 'approve-sign-in-rule', stageId);
    const made = await commit(s.dispatch, stageId);
    const rule = jsonBody(made)['id'] as string;

    // Act
    const renewed = await s.dispatch.dispatch(
      asDevice('POST', '/v1/sign-in-rules/stages', {
        signIn: GITHUB,
        fields: ['username', 'password'],
        replaces: rule,
      }),
    );
    const reused = await commit(s.dispatch, jsonBody(renewed)['stage'] as string);
    const lapsing = await stage(s, GITLAB);
    await ceremony(s, 'approve-sign-in-rule', lapsing);
    s.clock.now = NOW + 121_000;
    const lapsed = await commit(s.dispatch, lapsing);

    // Assert
    should(jsonBody(reused).code).equal(STEP_UP_REQUIRED_CODE);
    should([lapsed.status, jsonBody(lapsed).code]).eql([404, 'stage_not_found']);
    should(s.ruleStore.document?.rules.map(each => each.body.revision)).eql([1]);
  });
});

describe('no other proof commits a rule (invariant 3, secrev-1274a TG1)', () => {
  it('should refuse an unlock, an approve-task-plan proof and an add-2fa-key proof, and spend none of them', async () => {
    // Arrange
    const s = await served();
    const stageId = await stage(s);

    // Act — each other kind of passkey proof, then a commit with it
    const answers = [];
    const unlockOptions = await s.dispatch.dispatch(asDevice('POST', '/v1/unlock/options', { origin: ORIGIN }));
    const unlocked = await s.dispatch.dispatch(
      request({ method: 'POST', path: '/v1/unlock', body: assertionBody, device: browser }),
    );
    answers.push(await commit(s.dispatch, stageId));
    const plan = await ceremony(s, 'approve-task-plan', `tps_${'c'.repeat(24)}`);
    answers.push(await commit(s.dispatch, stageId));
    const seed = await ceremony(s, 'add-2fa-key', `st_${'a'.repeat(24)}`);
    answers.push(await commit(s.dispatch, stageId));

    // Assert — every proof was really made, and none bought the rule
    should([unlockOptions.status, unlocked.status, plan, seed]).eql([
      200,
      200,
      { options: 200, stepped: 200 },
      { options: 200, stepped: 200 },
    ]);
    for (const answer of answers) {
      should(answer.status).equal(403);
      should(jsonBody(answer)).containDeep({ code: STEP_UP_REQUIRED_CODE, demand: { act: 'approve-sign-in-rule' } });
    }
    should(s.ruleStore.writes).equal(0);
    should(s.stepUp.claimFresh(browser, 'add-2fa-key', 'b'.repeat(64))).be.true();
  });

  it('should hand the commit no proof made over other bytes for the same stage, and leave that proof unspent', async () => {
    // Arrange — the ceremony for this stage answered a challenge that is not the one its body derives
    const s = await served();
    const stageId = await stage(s);
    s.tampered.add(stageId);
    await ceremony(s, 'approve-sign-in-rule', stageId);
    const derived = s.rules.challengeOf(stageId, deviceId) ?? new Uint8Array();
    const issued = derived.map((byte, index) => (index === 0 ? byte ^ 1 : byte));

    // Act
    const refused = await commit(s.dispatch, stageId);

    // Assert — the claim compared the kept challenge with the re-derived one and handed nothing over
    should(refused.status).equal(403);
    should(jsonBody(refused).code).equal(STEP_UP_REQUIRED_CODE);
    should(s.stepUp.claimStoredProof(browser, 'approve-sign-in-rule', stageId, issued)).containDeep({ deviceId });
    should(s.ruleStore.writes).equal(0);
  });
});

describe('a machine stage is taken only by a device that could commit it (secrev-1274a L3)', () => {
  it('should refuse a device denied the configure grant, and leave the stage for the owner’s phone', async () => {
    // Arrange
    const s = await served();
    const staged = await s.dispatch.dispatch(
      request({
        method: 'POST',
        path: '/v1/sign-in-rules/stages',
        headers: { ...human, 'content-type': 'application/json' },
        body: json({ signIn: GITHUB, fields: ['username', 'password'] }),
        loopback: true,
        privilegedLoopback: true,
      }),
    );
    const stageId = jsonBody(staged)['stage'] as string;
    s.rules.confirmInApp({ kind: 'owner', actor: { kind: 'host' } }, stageId as SignInRuleStageId);
    const narrowed = s.dispatcherWith(withoutGrant({ capability: 'secrets', axis: 'configure' }));

    // Act
    const refused = await narrowed.dispatch(asDevice('POST', `/v1/sign-in-rules/stages/${stageId}/bind`, {}));
    const taken = await s.dispatch.dispatch(asDevice('POST', `/v1/sign-in-rules/stages/${stageId}/bind`, {}));

    // Assert
    should(refused.status).equal(403);
    should(taken.status).equal(201);
  });
});

describe('names need secrets.use (invariant 31)', () => {
  it('should refuse a device denied the accounts on every rule read and on the commit, and spend no proof', async () => {
    // Arrange — the passkey is proved through the full grant; the same device is then narrowed
    const s = await served();
    const stageId = await stage(s);
    await ceremony(s, 'approve-sign-in-rule', stageId);
    const narrowed = s.dispatcherWith(withoutGrant({ capability: 'secrets', axis: 'use' }));

    // Act
    const refused = [
      await narrowed.dispatch(asDevice('GET', '/v1/sign-in-rules')),
      await narrowed.dispatch(asDevice('GET', `/v1/sign-in-rules/eligibility?signIn=${GITHUB}`)),
      await narrowed.dispatch(asDevice('POST', '/v1/sign-in-rules/stages', { signIn: GITHUB, fields: ['password'] })),
      await narrowed.dispatch(asDevice('GET', `/v1/sign-in-rules/stages/${stageId}`)),
      await commit(narrowed, stageId),
    ];
    const allowed = await commit(s.dispatch, stageId);

    // Assert
    should(refused.map(answer => answer.status)).eql(refused.map(() => 403));
    for (const answer of refused) should(JSON.stringify(jsonBody(answer))).not.containEql('kirin-UNIQUE-username');
    should(allowed.status).equal(201);
  });
});

/** A rule committed through the routes, as the app would make it. */
async function made(s: Served): Promise<string> {
  const stageId = await stage(s);
  await ceremony(s, 'approve-sign-in-rule', stageId);
  return jsonBody(await commit(s.dispatch, stageId))['id'] as string;
}

describe('the owner on every route', () => {
  it('should list the rules, all or one sign-in’s, and refuse a sign-in that is not one', async () => {
    // Arrange
    const s = await served();
    const rule = await made(s);

    // Act
    const all = await s.dispatch.dispatch(asDevice('GET', '/v1/sign-in-rules'));
    const one = await s.dispatch.dispatch(asDevice('GET', `/v1/sign-in-rules?signIn=${GITLAB}`));
    const bad = await s.dispatch.dispatch(asDevice('GET', '/v1/sign-in-rules?signIn=github'));

    // Assert
    should(all.status).equal(200);
    should(jsonBody(all)).containDeep({ health: 'ok', rules: [{ id: rule, signIn: GITHUB }], stages: [] });
    should(jsonBody(one)['rules']).eql([]);
    should([bad.status, jsonBody(bad).code]).eql([400, 'bad_request']);
  });

  it('should answer the eligibility, and refuse a missing or unknown sign-in', async () => {
    const s = await served();
    const yes = await s.dispatch.dispatch(asDevice('GET', `/v1/sign-in-rules/eligibility?signIn=${GITHUB}`));
    const missing = await s.dispatch.dispatch(asDevice('GET', '/v1/sign-in-rules/eligibility'));
    const unknown = await s.dispatch.dispatch(
      asDevice('GET', '/v1/sign-in-rules/eligibility?signIn=si_0000000000000fff'),
    );
    should([yes.status, jsonBody(yes)['eligible']]).eql([200, true]);
    should([missing.status, jsonBody(missing).code]).eql([400, 'bad_request']);
    should([unknown.status, jsonBody(unknown).code]).eql([404, 'not_found']);
  });

  it('should read a stage, drop it, and answer a stage id it never minted as not waiting', async () => {
    // Arrange
    const s = await served();
    const stageId = await stage(s);

    // Act
    const read = await s.dispatch.dispatch(asDevice('GET', `/v1/sign-in-rules/stages/${stageId}`));
    const dropped = await s.dispatch.dispatch(asDevice('DELETE', `/v1/sign-in-rules/stages/${stageId}`));
    const again = await s.dispatch.dispatch(asDevice('DELETE', `/v1/sign-in-rules/stages/${stageId}`));
    const minted = await s.dispatch.dispatch(asDevice('GET', '/v1/sign-in-rules/stages/tps_not-a-rule-stage'));

    // Assert
    should([read.status, jsonBody(read)['state']]).eql([200, 'waiting']);
    should(jsonBody(dropped)).eql({ stage: stageId, dropped: true });
    should([again.status, jsonBody(again).code]).eql([404, 'stage_not_found']);
    should([minted.status, jsonBody(minted).code]).eql([404, 'stage_not_found']);
    should(s.ruleStore.writes).equal(0);
  });

  it('should narrow a rule with no passkey, and refuse a rule id that is not one or a widening', async () => {
    const s = await served();
    const rule = await made(s);
    const end = new Date(NOW + 86_400_000).toISOString();
    const narrowed = await s.dispatch.dispatch(
      asDevice('POST', `/v1/sign-in-rules/${rule}/narrow`, { expiresAt: end }),
    );
    const later = await s.dispatch.dispatch(
      asDevice('POST', `/v1/sign-in-rules/${rule}/narrow`, { expiresAt: new Date(NOW + 2 * 86_400_000).toISOString() }),
    );
    const bad = await s.dispatch.dispatch(asDevice('POST', '/v1/sign-in-rules/rule-1/narrow', { uses: 1 }));
    should([narrowed.status, jsonBody(narrowed)['expiresAt']]).eql([200, end]);
    should([later.status, jsonBody(later).code]).eql([400, 'bad_request']);
    should([bad.status, jsonBody(bad).code]).eql([400, 'bad_request']);
  });

  it('should revoke one rule, and every rule of an account, with no passkey', async () => {
    // Arrange
    const s = await served();
    const rule = await made(s);

    // Act
    const one = await s.dispatch.dispatch(asDevice('DELETE', `/v1/sign-in-rules/${rule}`));
    const gone = await s.dispatch.dispatch(asDevice('DELETE', `/v1/sign-in-rules/${rule}`));
    const account = await s.dispatch.dispatch(asDevice('POST', '/v1/accounts/GITHUB_WORK/sign-in-rules/revoke', {}));
    const bad = await s.dispatch.dispatch(asDevice('POST', '/v1/accounts/not%20a%20handle/sign-in-rules/revoke', {}));

    // Assert
    should(jsonBody(one)).eql({ id: rule, revoked: true });
    should([gone.status, jsonBody(gone).code]).eql([404, 'not_found']);
    should(jsonBody(account)).eql({ account: 'GITHUB_WORK', revoked: 0 });
    should([bad.status, jsonBody(bad).code]).eql([400, 'invalid_account_id']);
    should(s.ruleStore.document?.rules).eql([]);
  });

  it('should list a ferret’s suggestion for a paired device, and give it no way to stage, commit or widen anything', async () => {
    // Arrange
    const s = await served();
    await s.suggestions.suggest('mvv6b4qw-49d0158d', { signIn: GITHUB, why: 'I sign in here daily.' });

    // Act
    const listed = await s.dispatch.dispatch(asDevice('GET', '/v1/sign-in-rules/suggestions'));

    // Assert — a card was raised, and nothing else exists: no stage, no rule, no write
    should(listed.status).equal(200);
    should(jsonBody(listed)['suggestions']).match([
      { signIn: GITHUB, host: 'github.com', why: 'I sign in here daily.' },
    ]);
    should(s.raised).eql(['A ferret suggests a standing rule for a sign-in on github.com.']);
    should(s.ruleStore.writes).equal(0);
    should(s.ruleStore.document?.rules ?? []).eql([]);
    const rules = await s.dispatch.dispatch(asDevice('GET', '/v1/sign-in-rules'));
    should(jsonBody(rules)['rules']).eql([]);
  });

  it('should let the owner turn a suggestion down, once', async () => {
    // Arrange
    const s = await served();
    const { suggestion } = await s.suggestions.suggest('mvv6b4qw-49d0158d', { signIn: GITHUB, why: 'daily' });

    // Act
    const first = await s.dispatch.dispatch(asDevice('DELETE', `/v1/sign-in-rules/suggestions/${suggestion}`));
    const again = await s.dispatch.dispatch(asDevice('DELETE', `/v1/sign-in-rules/suggestions/${suggestion}`));
    const bad = await s.dispatch.dispatch(asDevice('DELETE', '/v1/sign-in-rules/suggestions/nope'));

    // Assert
    should([first.status, jsonBody(first)['dismissed']]).eql([200, true]);
    should([again.status, jsonBody(again)['dismissed']]).eql([200, false]);
    should(bad.status).equal(400);
  });

  it('should answer a fault that is not a refusal as one, never dressed as a refusal', async () => {
    // Arrange — a service that fails as a bug would, not with one of its refusals
    const broken = {
      list: async () => {
        throw new TypeError('a bug');
      },
      drop: () => {
        throw new TypeError('a bug');
      },
    } as never;
    const dispatch = new ApiDispatcher(
      new ApiRouter(signInRuleRoutes(broken, {} as never)),
      {
        ...CREDENTIALS,
        devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
      },
      GRANTED,
    );

    // Act
    const list = await dispatch.dispatch(asDevice('GET', '/v1/sign-in-rules'));
    const drop = await dispatch.dispatch(asDevice('DELETE', `/v1/sign-in-rules/stages/srs_${'0'.repeat(24)}`));

    // Assert
    should([list.status, drop.status]).eql([500, 500]);
  });
});
