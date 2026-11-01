import { describe, it } from 'bun:test';
import {
  SIGN_IN_RULE_CLOCK_SKEW_SECONDS,
  SIGN_IN_RULE_DEFAULT_SECONDS,
  type SignInRuleRecord,
  type SignInRuleStageId,
} from '@ferretry/protocol';
import should from 'should';
import { SignInRuleError, SignInRuleProofMissing } from '../../../src/lib/sign-in-rules/index.ts';
import {
  AGENT,
  account,
  actions,
  approved,
  CREDENTIAL,
  DEVICE,
  DRAFT,
  deviceOwner,
  evidenceFor,
  GITHUB,
  HOST_OWNER,
  listing,
  MemoryRuleStore,
  NOW,
  OTHER_DEVICE,
  signIn,
  SUDO,
  T,
  tappedFact,
  totpKey,
  UNTAPPED,
  USERNAME,
  VIA_GOOGLE,
  type World,
  world,
} from './support.ts';

/** The standing-rule service over fakes (r3c-plan §5, §8, §14). */

const refusal = async (work: Promise<unknown> | (() => unknown)): Promise<SignInRuleError> => {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof SignInRuleError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const rules = (w: World): readonly SignInRuleRecord[] => w.store.document?.rules ?? [];

describe('only the owner makes, reads or changes a rule (invariant 2)', () => {
  it('should refuse a ferret on every owner method before anything is read or written', async () => {
    // Arrange
    const w = await world();
    const { staged, view } = await approved(w);
    const writes = w.store.writes;
    const stage = `srs_${'9'.repeat(24)}` as SignInRuleStageId;

    // Act
    const refused = [
      await refusal(w.service.list(AGENT)),
      await refusal(w.service.eligibility(AGENT, GITHUB)),
      await refusal(w.service.stage(AGENT, DRAFT)),
      await refusal(() => w.service.viewStage(AGENT, staged.stage)),
      await refusal(() => w.service.confirmInApp(AGENT, stage)),
      await refusal(() => w.service.drop(AGENT, stage)),
      await refusal(w.service.commit(AGENT, stage, () => evidenceFor(new Uint8Array(32)))),
      await refusal(w.service.narrow(AGENT, view.id, { uses: 1 })),
      await refusal(w.service.revoke(AGENT, view.id)),
      await refusal(w.service.revokeAccount(AGENT, view.account.id)),
    ];

    // Assert
    should(refused.map(error => [error.status, error.code])).eql(refused.map(() => [403, 'forbidden']));
    should(w.store.writes).equal(writes);
    should(rules(w)).have.length(1);
  });
});

describe('stage and commit: a fresh passkey bound to the bytes written (invariants 3, 35)', () => {
  it('should write the rule with its proof, check it again, audit it, and name no username in the audit', async () => {
    // Arrange
    const w = await world();

    // Act
    const { view, challenge } = await approved(w);

    // Assert
    const [record] = rules(w);
    should(record?.body).containDeep({
      revision: 1,
      signIn: GITHUB,
      surface: 'page',
      fields: ['username', 'password'],
      scope: { kind: 'any' },
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + SIGN_IN_RULE_DEFAULT_SECONDS * 1_000).toISOString(),
      approvedBy: { deviceId: DEVICE },
      pins: { account: 'GITHUB_WORK', username: USERNAME, placeKeys: ['github.com'], identities: ['0123456789abcdef'] },
    });
    should(record?.proof).containDeep({ deviceId: DEVICE, credentialId: CREDENTIAL });
    should(record?.proof.signature).equal(Buffer.from(challenge).toString('base64url'));
    should(view).containDeep({ status: 'active', totp: false, flags: [], approvedWith: { device: 'Pixel 9' } });
    should(w.service.verified(view.id, 1)).be.true();
    should(actions(w)).eql(['sign-in-rule-created']);
    should(w.audits[0]?.actor).eql({ kind: 'device', deviceId: DEVICE });
    should(JSON.stringify(w.audits)).not.containEql(USERNAME);
  });

  it('should hand the claim the challenge derived again from the staged body, and keep waiting without a proof', async () => {
    // Arrange
    const w = await world();
    const staged = await w.service.stage(deviceOwner(), DRAFT);
    const issued = w.service.challengeOf(staged.stage, DEVICE);
    const asked: Uint8Array[] = [];

    // Act
    const missing = await w.service
      .commit(deviceOwner(), staged.stage, expected => void asked.push(expected))
      .catch((error: unknown) => error);

    // Assert — no proof: the step-up is demanded, nothing is written, and the stage still waits for its passkey
    should(missing).be.instanceOf(SignInRuleProofMissing);
    should(asked.map(bytes => Buffer.from(bytes).toString('hex'))).eql([Buffer.from(issued ?? []).toString('hex')]);
    should(w.service.viewStage(deviceOwner(), staged.stage).state).equal('waiting');
    should(w.store.writes).equal(0);
  });

  it('should refuse a proof over other bytes, or from another device, and spend the stage', async () => {
    // Arrange
    const w = await world();
    const first = await w.service.stage(deviceOwner(), DRAFT);
    const second = await w.service.stage(deviceOwner(), { ...DRAFT, fields: ['password'] });
    const challenge = w.service.challengeOf(second.stage, DEVICE) ?? new Uint8Array();

    // Act — the claim hands over evidence made for other bytes (the registry would not, but the commit checks again)
    const otherBytes = await refusal(
      w.service.commit(deviceOwner(), second.stage, () => evidenceFor(new Uint8Array(32).fill(1))),
    );
    const third = await w.service.stage(deviceOwner(), DRAFT);
    const thirdChallenge = w.service.challengeOf(third.stage, DEVICE) ?? new Uint8Array();
    const otherDevice = await refusal(
      w.service.commit(deviceOwner(), third.stage, () => evidenceFor(thirdChallenge, OTHER_DEVICE)),
    );

    // Assert — the first stage was replaced by the second (one per sign-in); no rule exists
    should(w.service.viewStage(deviceOwner(), first.stage).state).equal('denied');
    should([otherBytes.status, otherBytes.code]).eql([403, 'proof_invalid']);
    should([otherDevice.status, otherDevice.code]).eql([403, 'proof_invalid']);
    should(w.service.viewStage(deviceOwner(), second.stage).state).equal('denied');
    should(challenge).not.be.undefined();
    should(rules(w)).eql([]);
  });

  it('should refuse a commit whose sign-in changed after the stage: 409 conflict, no rule, the proof spent', async () => {
    // Arrange
    const w = await world();
    const staged = await w.service.stage(deviceOwner(), DRAFT);
    const challenge = w.service.challengeOf(staged.stage, DEVICE) ?? new Uint8Array();
    const base = listing();
    w.state.listing = {
      ...base,
      signIns: base.signIns.map(each =>
        each.id === GITHUB ? { ...each, place: { kind: 'site', domains: ['github.com', 'gh.io'], match: [] } } : each,
      ),
    } as never;
    let claimed = 0;

    // Act
    const conflict = await refusal(
      w.service.commit(deviceOwner(), staged.stage, () => {
        claimed += 1;
        return evidenceFor(challenge);
      }),
    );

    // Assert
    should([conflict.status, conflict.code]).eql([409, 'conflict']);
    should(claimed).equal(1);
    should(rules(w)).eql([]);
    should(w.service.viewStage(deviceOwner(), staged.stage).state).equal('denied');
  });

  it('should answer a stage only to the device it waits on: another device gets no challenge and cannot commit', async () => {
    // Arrange
    const w = await world();
    const staged = await w.service.stage(deviceOwner(), DRAFT);

    // Act
    const theirs = w.service.challengeOf(staged.stage, OTHER_DEVICE);
    const commit = await refusal(
      w.service.commit(deviceOwner(OTHER_DEVICE), staged.stage, () => evidenceFor(new Uint8Array(32), OTHER_DEVICE)),
    );

    // Assert
    should(theirs).be.undefined();
    should([commit.status, commit.code]).eql([404, 'stage_not_found']);
    should(w.service.challengeOf(staged.stage, DEVICE)).not.be.undefined();
  });

  it("should put a machine stage in the app, bind it only when a device takes it, and never let the machine's token commit", async () => {
    // Arrange
    const w = await world();
    const staged = await w.service.stage(HOST_OWNER, DRAFT);

    // Act
    const beforeConfirm = await refusal(w.service.bind(deviceOwner(), staged.stage));
    const confirmed = w.service.confirmInApp(HOST_OWNER, staged.stage);
    const listed = await w.service.list(deviceOwner());
    const asked = w.service.challengeOf(staged.stage, DEVICE);
    const machineBind = await refusal(w.service.bind(HOST_OWNER, staged.stage));
    const taken = await w.service.bind(deviceOwner(), staged.stage);
    const again = await w.service.bind(deviceOwner(), staged.stage);
    const otherBind = await refusal(w.service.bind(deviceOwner(OTHER_DEVICE), staged.stage));
    const bound = w.service.challengeOf(staged.stage, DEVICE);
    const other = w.service.challengeOf(staged.stage, OTHER_DEVICE);
    const machine = await w.service.commit(HOST_OWNER, staged.stage, () => undefined).catch((error: unknown) => error);
    const made = await w.service.commit(deviceOwner(), staged.stage, () => evidenceFor(bound ?? new Uint8Array()));

    // Assert — asking for passkey options before a device took it binds nothing (secrev-1274a L3)
    should([beforeConfirm.status, beforeConfirm.code]).eql([404, 'stage_not_found']);
    should(asked).be.undefined();
    should([machineBind.status, machineBind.code]).eql([403, 'forbidden']);
    should([taken.stage, again.stage]).eql([staged.stage, staged.stage]);
    should([otherBind.status, otherBind.code]).eql([404, 'stage_not_found']);
    should(confirmed.machine?.askedAt).equal(new Date(NOW).toISOString());
    should(listed.stages.map(stage => stage.stage)).eql([staged.stage]);
    should(bound).not.be.undefined();
    should(other).be.undefined();
    should(machine).be.instanceOf(SignInRuleProofMissing);
    should(made.approvedWith.deviceId).equal(DEVICE);
  });

  it('should finish a commit while reading the device names revokes an idle device (no deadlock)', async () => {
    // Arrange — pairing expires an idle device whenever its list is read, and tells the rules through their queue
    const w = await world({
      label: async (_deviceId, service) => {
        await service.forgetDevice(OTHER_DEVICE);
        return 'Pixel 9';
      },
    });

    // Act
    const made = await Promise.race([
      approved(w).then(({ view }) => view.status),
      Bun.sleep(2_000).then(() => 'stuck'),
    ]);

    // Assert
    should(made).equal('active');
  });

  it('should refuse confirm-in-app for a stage a paired device made (secrev-1261 L3)', async () => {
    const w = await world();
    const staged = await w.service.stage(deviceOwner(), DRAFT);
    const refused = await refusal(() => w.service.confirmInApp(deviceOwner(), staged.stage));
    should([refused.status, refused.code]).eql([404, 'stage_not_found']);
  });
});

describe('what can have a rule, and the stage refusals (invariants 23, 24, 15, 36)', () => {
  it('should refuse a terminal sign-in, a provider sign-in and one the owner never tapped in, before any passkey', async () => {
    // Arrange
    const w = await world();

    // Act
    const sudo = await refusal(w.service.stage(deviceOwner(), { signIn: SUDO, fields: ['password'] }));
    const via = await refusal(w.service.stage(deviceOwner(), { ...DRAFT, signIn: VIA_GOOGLE }));
    const untapped = await refusal(w.service.stage(deviceOwner(), { ...DRAFT, signIn: UNTAPPED }));
    const eligible = await w.service.eligibility(deviceOwner(), SUDO);

    // Assert
    should([sudo.status, sudo.code]).eql([409, 'tool_not_covered']);
    should([via.status, via.code]).eql([409, 'via_provider']);
    should([untapped.status, untapped.code, untapped.message]).eql([
      409,
      'no_history',
      'Sign in yourself twice from the app first',
    ]);
    should(eligible).eql({ signIn: SUDO, eligible: false, because: 'tool-not-covered' });
    should(w.service.challengeOf(`srs_${'0'.repeat(24)}` as SignInRuleStageId, DEVICE)).be.undefined();
  });

  it('should refuse without a passkey anywhere, and say so in the eligibility', async () => {
    const w = await world({ passkeys: false });
    const refused = await refusal(w.service.stage(deviceOwner(), DRAFT));
    should([refused.status, refused.code]).eql([409, 'passkey_required']);
    should(await w.service.eligibility(deviceOwner(), GITHUB)).eql({
      signIn: GITHUB,
      eligible: false,
      because: 'no-passkey',
    });
  });

  it('should refuse the code without its acknowledgement, and without a key Ferretry makes codes for', async () => {
    // Arrange
    const w = await world();

    // Act
    const unacknowledged = await refusal(w.service.stage(deviceOwner(), { ...DRAFT, totp: true }));
    const keyless = await refusal(
      w.service.stage(deviceOwner(), { ...DRAFT, totp: true, totpAcknowledged: true } as never),
    );

    // Assert
    should([unacknowledged.status, unacknowledged.code]).eql([400, 'bad_request']);
    should([keyless.status, keyless.code]).eql([409, 'no_code_key']);
  });

  it('should pin the NEWEST key by when it was added, never the one whose code went through', async () => {
    // Arrange — the older key is the one a code "worked" for; the newer one never was
    const base = listing();
    const keys = [totpKey('tf_000000000001', '2026-09-01T00:00:00.000Z', true), totpKey('tf_000000000002', T)];
    const w = await world({
      listing: { ...base, accounts: base.accounts.map(each => ({ ...each, factors: keys })) } as never,
    });

    // Act
    const staged = await w.service.stage(deviceOwner(), { ...DRAFT, totp: true, totpAcknowledged: true });

    // Assert
    should(staged).containDeep({ totp: true, fields: ['username', 'password', 'totp'] });
    should(staged.summary[0]).equal('Ferretry types the username, password and 2FA code without asking');
    const challenge = w.service.challengeOf(staged.stage, DEVICE) ?? new Uint8Array();
    const view = await w.service.commit(deviceOwner(), staged.stage, () => evidenceFor(challenge));
    should(rules(w)[0]?.body.pins.factor).equal('tf_000000000002');
    should(view.flags).eql(['one-factor']);
  });

  it('should refuse a lifetime past 90 days or under an hour (the draft schema)', async () => {
    const w = await world();
    for (const lifetimeSeconds of [91 * 86_400, 3_599]) {
      const refused = await refusal(w.service.stage(deviceOwner(), { ...DRAFT, lifetimeSeconds }));
      should([refused.status, refused.code]).eql([400, 'bad_request']);
    }
  });

  it('should refuse a commit after the clock moved back past the skew, before the proof is claimed (secrev-1271 L4)', async () => {
    // Arrange
    const w = await world();
    const staged = await w.service.stage(deviceOwner(), DRAFT);
    w.service.challengeOf(staged.stage, DEVICE);
    w.clock.now = NOW - (SIGN_IN_RULE_CLOCK_SKEW_SECONDS + 1) * 1_000;
    let claimed = 0;

    // Act
    const refused = await refusal(
      w.service.commit(deviceOwner(), staged.stage, () => {
        claimed += 1;
        return undefined;
      }),
    );

    // Assert
    should([refused.status, refused.code]).eql([409, 'conflict']);
    should(claimed).equal(0);
    should(rules(w)).eql([]);
  });

  it('should keep one rule per sign-in: a second approval must name the rule it replaces', async () => {
    const w = await world();
    const { view } = await approved(w);
    const again = await refusal(w.service.stage(deviceOwner(), DRAFT));
    const wrong = await refusal(w.service.stage(deviceOwner(), { ...DRAFT, replaces: `sr_${'f'.repeat(24)}` }));
    should([again.code, wrong.code]).eql(['conflict', 'conflict']);
    should((await w.service.stage(deviceOwner(), { ...DRAFT, replaces: view.id })).revision).equal(2);
  });
});

describe('narrow and revoke: no passkey, only ever take away (invariant 20)', () => {
  it('should refuse a later end, more uses, a code the rule does not type, and any widening shape', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w, { ...DRAFT, uses: 5 });
    const writes = w.store.writes;

    // Act
    const refused = [
      await refusal(
        w.service.narrow(deviceOwner(), view.id, { expiresAt: new Date(NOW + 91 * 86_400_000).toISOString() }),
      ),
      await refusal(w.service.narrow(deviceOwner(), view.id, { uses: 6 })),
      await refusal(w.service.narrow(deviceOwner(), view.id, { uses: 5 })),
      await refusal(w.service.narrow(deviceOwner(), view.id, { dropTotp: true })),
      await refusal(w.service.narrow(deviceOwner(), view.id, { fields: ['username', 'password', 'totp'] } as never)),
      await refusal(w.service.narrow(deviceOwner(), view.id, { scope: { kind: 'any' } } as never)),
    ];

    // Assert
    should(refused.map(error => [error.status, error.code])).eql(refused.map(() => [400, 'bad_request']));
    should(w.store.writes).equal(writes);
  });

  it('should write a strictly narrower overlay with no passkey and audit it', async () => {
    const w = await world();
    const { view } = await approved(w, { ...DRAFT, uses: 5 });
    const end = new Date(NOW + 86_400_000).toISOString();
    const narrowed = await w.service.narrow(HOST_OWNER, view.id, { uses: 2, expiresAt: end });
    should(narrowed).containDeep({ uses: 2, remaining: 2, expiresAt: end, status: 'active' });
    should(rules(w)[0]?.narrowed).eql({ uses: 2, expiresAt: end });
    should(actions(w)).eql(['sign-in-rule-created', 'sign-in-rule-narrowed']);
  });

  it('should revoke one rule, or every rule of an account, with no passkey', async () => {
    const w = await world();
    const { view } = await approved(w);
    should(await w.service.revokeAccount(HOST_OWNER, 'GITHUB_WORK' as never)).eql({ revoked: 1 });
    should(rules(w)).eql([]);
    should((await refusal(w.service.revoke(HOST_OWNER, view.id))).code).equal('not_found');
    should(actions(w)).eql(['sign-in-rule-created', 'sign-in-rule-revoked']);
  });
});

describe('suspension: drift, sticky, never silent (invariants 16, 17, 18)', () => {
  it('should suspend on a pinned fact that drifted, stay suspended when it drifts back, and resume only with a new passkey', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w);
    const base = listing();
    const moved = {
      ...base,
      signIns: base.signIns.map(each =>
        each.id === GITHUB ? { ...each, place: { kind: 'site', domains: ['gh.io'], match: [] } } : each,
      ),
    };

    // Act
    await w.service.accountsChanged(moved as never);
    await w.service.accountsChanged(base as never);
    const listed = await w.service.list(HOST_OWNER);
    w.state.listing = base as never;
    const { view: resumed } = await approved(w, { ...DRAFT, replaces: view.id });

    // Assert
    should(listed.rules[0]).containDeep({ status: 'suspended', suspended: { because: 'place-changed' } });
    should(resumed).containDeep({ id: view.id, revision: 2, status: 'active' });
    should(rules(w)).have.length(1);
    should(actions(w)).eql(['sign-in-rule-created', 'sign-in-rule-suspended', 'sign-in-rule-resumed']);
    should(w.audits[1]?.detail).containDeep({ because: 'place-changed', revision: 1 });
  });

  it('should audit a suspension from every trigger: a passkey gone, a device revoked, a script, a fill', async () => {
    // Arrange — four sign-ins, one rule each
    const base = listing();
    const extra = ['a5', 'a6', 'a7'].map((suffix, index) =>
      signIn({
        id: `si_00000000000000${suffix}` as never,
        place: { kind: 'site', domains: [`site${String(index)}.example`], match: [] },
        observed: [tappedFact(`site${String(index)}.example`)],
      }),
    );
    const w = await world({ listing: { ...base, signIns: [...base.signIns, ...extra] } as never });
    const made = [await approved(w)];
    for (const each of extra) made.push(await approved(w, { ...DRAFT, signIn: each.id }));
    const [first, second, third, fourth] = made.map(each => each.view.id);

    // Act
    await w.service.suspend(first as never, 'did-not-move-on', { revision: 1, sessionId: 'mvv6b4qw-49d0158d' });
    await w.service.scriptedOn('site0.example');
    w.proofs.held.delete(`${DEVICE}:${CREDENTIAL}`);
    await w.service.passkeysChanged({ cause: 'member-key-forgotten', keyId: 'k' });

    // Assert
    const suspended = (await w.service.list(HOST_OWNER)).rules.map(rule => [rule.id, rule.suspended?.because]);
    should(suspended).eql([
      [first, 'did-not-move-on'],
      [second, 'scripted-origin'],
      [third, 'passkey-removed'],
      [fourth, 'passkey-removed'],
    ]);
    should(actions(w).filter(action => action === 'sign-in-rule-suspended')).have.length(4);
    should(w.audits.find(line => line.detail?.['because'] === 'did-not-move-on')?.detail).containDeep({
      session: 'mvv6b4qw-49d0158d',
    });
  });

  it('should suspend every rule a revoked device approved, whatever the passkey purge does after', async () => {
    const w = await world();
    const { view } = await approved(w);
    await w.service.forgetDevice(DEVICE);
    should((await w.service.list(HOST_OWNER)).rules[0]).containDeep({
      id: view.id,
      status: 'suspended',
      suspended: { because: 'passkey-removed' },
    });
    should(w.service.verified(view.id, 1)).be.false();
  });

  it('should keep a rule from an older revision from being suspended by a late fill', async () => {
    const w = await world();
    const { view } = await approved(w);
    await w.service.suspend(view.id, 'did-not-move-on', { revision: 7 });
    should((await w.service.list(HOST_OWNER)).rules[0]?.status).equal('active');
  });

  it('should keep a suspension in memory when the file cannot be written', async () => {
    const w = await world();
    const { view } = await approved(w);
    w.store.failWrites = true;
    await w.service.suspend(view.id, 'form-changed');
    should((await w.service.list(HOST_OWNER)).rules[0]?.suspended?.because).equal('store-write-failed');
    should(rules(w)[0]?.suspended).be.undefined();
  });

  it('should not suspend for a label, a password, verified, a proposal or a default', async () => {
    // Arrange
    const w = await world();
    await approved(w);
    const base = listing();
    const cosmetic = {
      ...base,
      accounts: base.accounts.map(each => (each.id === 'GITHUB_WORK' ? account({ label: 'Renamed label' }) : each)),
      signIns: base.signIns.map(each =>
        each.id === GITHUB
          ? { ...each, proposals: [{ id: 'rp_0000000000000001' }], updatedAt: '2026-10-31T00:00:00.000Z' }
          : each,
      ),
    };

    // Act
    await w.service.accountsChanged(cosmetic as never);

    // Assert
    should((await w.service.list(HOST_OWNER)).rules[0]?.status).equal('active');
    should(actions(w)).eql(['sign-in-rule-created']);
  });
});

describe('load: strict, fails closed, checks every proof again (invariants 5, 8, 9)', () => {
  it('should hold zero rules when the file is damaged, audit it, and move it aside before the next write', async () => {
    // Arrange
    const store = new MemoryRuleStore();
    store.damaged = 'v: 2';
    const w = await world({ store });

    // Act
    const before = await w.service.list(HOST_OWNER);
    await approved(w);

    // Assert
    should(before).eql({ health: 'damaged', rules: [], stages: [] });
    should(actions(w)[0]).equal('sign-in-rules-damaged');
    should(w.audits[0]?.outcome).equal('failed');
    should(store.setAsides).have.length(1);
    should((await w.service.list(HOST_OWNER)).health).equal('ok');
  });

  it('should keep rules across a restart and check each proof again', async () => {
    const first = await world();
    const { view } = await approved(first);
    const again = await world({ store: first.store });
    should((await again.service.list(HOST_OWNER)).rules.map(rule => rule.id)).eql([view.id]);
    should(again.service.verified(view.id, 1)).be.true();
    should(again.proofs.checks).equal(1);
  });

  it('should suspend a record whose signed body was edited on disk (proof-invalid)', async () => {
    // Arrange
    const first = await world();
    await approved(first);
    const document = first.store.document;
    if (document?.rules[0] === undefined) throw new Error('no rule');
    document.rules[0] = {
      ...document.rules[0],
      body: { ...document.rules[0].body, scope: { kind: 'session', session: 'mvv6b4qw-49d0158d' } },
    };

    // Act
    const again = await world({ store: first.store });

    // Assert
    const [rule] = (await again.service.list(HOST_OWNER)).rules;
    should(rule).containDeep({ status: 'suspended', suspended: { because: 'proof-invalid' } });
    should(again.store.document?.rules[0]?.suspended?.because).equal('proof-invalid');
    should(actions(again)).eql(['sign-in-rule-suspended']);
  });

  it('should suspend a record whose device is gone, and one created in the future (secrev-1271 L4)', async () => {
    // Arrange
    const first = await world();
    await approved(first);
    first.proofs.held.clear();

    // Act
    const gone = await world({ store: first.store, proofs: first.proofs });
    const future = await world();
    future.clock.now = NOW + 3_600_000;
    await approved(future);
    const back = await world({ store: future.store });

    // Assert
    should((await gone.service.list(HOST_OWNER)).rules[0]?.suspended?.because).equal('passkey-removed');
    should((await back.service.list(HOST_OWNER)).rules[0]?.suspended?.because).equal('proof-invalid');
  });

  it('should not suspend when the registry cannot be read, but hold the rule unverified', async () => {
    const first = await world();
    const { view } = await approved(first);
    first.proofs.broken = true;
    const again = await world({ store: first.store, proofs: first.proofs });
    should((await again.service.list(HOST_OWNER)).rules[0]?.status).equal('active');
    should(again.service.verified(view.id, 1)).be.false();
  });
});

describe('expiry', () => {
  it('should audit a rule reaching its end once, and remove a rule for a deleted sign-in at its end', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w, { ...DRAFT, lifetimeSeconds: 3_600 });
    const base = listing();
    await w.service.accountsChanged({ ...base, signIns: base.signIns.filter(each => each.id !== GITHUB) } as never);

    // Act
    w.clock.now = NOW + 3_600_000;
    await w.service.sweepRules();
    await w.service.sweepRules();

    // Assert
    should(actions(w)).eql(['sign-in-rule-created', 'sign-in-rule-suspended', 'sign-in-rule-expired']);
    should(w.audits[1]?.detail?.['because']).equal('sign-in-gone');
    should(rules(w).map(rule => rule.body.id)).not.containEql(view.id);
  });
});
