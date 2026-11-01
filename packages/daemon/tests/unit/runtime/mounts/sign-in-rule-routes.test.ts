import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE, type SignInRuleStageId } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import type { CapabilityGuard } from '../../../../src/lib/api/capability.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { signInRuleRoutes } from '../../../../src/lib/runtime/mounts/sign-in-rules.ts';
import { stepUpRoutes } from '../../../../src/lib/runtime/mounts/step-up.ts';
import { SignInRuleService } from '../../../../src/lib/sign-in-rules/index.ts';
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
  const rules = new SignInRuleService({
    store: ruleStore,
    accounts: {
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
    },
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
  const routes = [
    ...stepUpRoutes(stepUp, undefined, undefined, {
      challengeOf: (stage, device) => {
        const challenge = rules.challengeOf(stage, device);
        if (challenge !== undefined) verifier.issued.add(b64(challenge));
        return challenge;
      },
    }),
    ...signInRuleRoutes(rules),
  ];
  const credentials = {
    ...CREDENTIALS,
    devices: { has: (id: string) => id === deviceId, grants: () => DEFAULT_CAPABILITY_GRANTS },
  };
  const dispatcherWith = (guard: CapabilityGuard) =>
    new ApiDispatcher(new ApiRouter(routes), credentials, guard, undefined, stepUp);
  return { clock, rules, ruleStore, routes, stepUp, dispatch: dispatcherWith(GRANTED), dispatcherWith };
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
        ['POST', `/v1/sign-in-rules/stages/${stageId}/commit`],
        ['DELETE', `/v1/sign-in-rules/stages/${stageId}`],
        ['POST', `/v1/sign-in-rules/${rule}/narrow`],
        ['DELETE', `/v1/sign-in-rules/${rule}`],
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
      'GET /v1/sign-in-rules person secrets.use',
      'GET /v1/sign-in-rules/eligibility person secrets.use',
      'POST /v1/sign-in-rules/stages person secrets.configure',
      'GET /v1/sign-in-rules/stages/:stage person secrets.use',
      'POST /v1/sign-in-rules/stages/:stage/confirm-in-app person secrets.configure',
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
    await ceremony(s, 'approve-sign-in-rule', stageId);

    // Act
    const machine = await s.dispatch.dispatch(atMachine('POST', `/v1/sign-in-rules/stages/${stageId}/commit`, {}));
    const phone = await commit(s.dispatch, stageId);

    // Assert
    should([staged.status, shown.status]).eql([201, 201]);
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
