import { describe, it } from 'bun:test';
import { SIGN_IN_RULE_MAX, type SignInId, type SignInRuleStageId } from '@ferretry/protocol';
import should from 'should';
import { FINISHED_STAGES_KEPT, SignInRuleError } from '../../../src/lib/sign-in-rules/index.ts';
import {
  actions,
  approved,
  DEVICE,
  DRAFT,
  deviceOwner,
  evidenceFor,
  GITHUB,
  HOST_OWNER,
  listing,
  NOW,
  OTHER_DEVICE,
  signIn,
  tappedFact,
  type World,
  world,
} from './support.ts';

/**
 * Every refusal of the standing-rule service, one by one: what it answers, that nothing is written, and that no proof is
 * claimed when it refuses before the claim (r3c-plan §5).
 */

const refusal = async (work: Promise<unknown> | (() => unknown)): Promise<SignInRuleError> => {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof SignInRuleError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** `count` more eligible sign-ins beside the fixture's, each at its own host. */
const many = (count: number) => {
  const base = listing();
  const extra = Array.from({ length: count }, (_, index) =>
    signIn({
      id: `si_${index.toString(16).padStart(16, '0')}` as SignInId,
      place: { kind: 'site', domains: [`site${String(index)}.example`], match: [] },
      observed: [tappedFact(`site${String(index)}.example`)],
    }),
  );
  return { listing: { ...base, signIns: [...base.signIns, ...extra] }, ids: extra.map(each => each.id) };
};

/** Stages a rule and answers the challenge of `deviceId` for it. */
async function staged(w: World, signInId: SignInId = GITHUB) {
  const stage = await w.service.stage(deviceOwner(), { ...DRAFT, signIn: signInId });
  return { stage: stage.stage, challenge: w.service.challengeOf(stage.stage, DEVICE) ?? new Uint8Array() };
}

describe('the service before it has read its file', () => {
  it('should refuse every owner read and change with 503 until it has loaded', async () => {
    const w = await world({ load: false });
    const refused = [
      await refusal(w.service.list(HOST_OWNER)),
      await refusal(w.service.stage(deviceOwner(), DRAFT)),
      await refusal(w.service.revoke(HOST_OWNER, `sr_${'0'.repeat(24)}`)),
    ];
    should(refused.map(error => [error.status, error.code])).eql(refused.map(() => [503, 'unavailable']));
    should(w.store.writes).equal(0);
  });

  it('should keep every rule unverified while the accounts cannot be read, and check them on a later sweep', async () => {
    // Arrange — a rule whose domains changed while the daemon was down
    const first = await world();
    const { view } = await approved(first);
    const again = await world({ store: first.store, load: false });
    again.state.listingBroken = true;

    // Act
    await again.service.load();
    const atLoad = {
      verified: again.service.verified(view.id, 1),
      view: (await again.service.list(HOST_OWNER)).rules[0],
    };
    await again.service.sweepRules();
    const stillBroken = again.service.verified(view.id, 1);
    const base = listing();
    again.state.listingBroken = false;
    again.state.listing = {
      ...base,
      signIns: base.signIns.map(each =>
        each.id === GITHUB ? { ...each, place: { kind: 'site', domains: ['gh.io'], match: [] } } : each,
      ),
    } as never;
    await again.service.sweepRules();

    // Assert — never verified (so never filling) until the check could be made; then the drift suspends it
    should(atLoad.verified).be.false();
    should(atLoad.view).containDeep({ status: 'active', unverified: true });
    should(stillBroken).be.false();
    should((await again.service.list(HOST_OWNER)).rules[0]?.suspended?.because).equal('place-changed');
    should(again.warnings[0]).startWith('the accounts could not be read');
  });

  it('should keep a rule unverified while the passkeys cannot be read, and verify it on a later sweep', async () => {
    const first = await world();
    const { view } = await approved(first);
    first.proofs.broken = true;
    const again = await world({ store: first.store, proofs: first.proofs });
    should(again.service.verified(view.id, 1)).be.false();
    await again.service.sweepRules();
    should(again.service.verified(view.id, 1)).be.false();
    first.proofs.broken = false;
    await again.service.sweepRules();
    should(again.service.verified(view.id, 1)).be.true();
    should((await again.service.list(HOST_OWNER)).rules[0]?.unverified).be.undefined();
  });

  it('should answer 503 to the list while load is still checking the rules, never show them as active', async () => {
    // Arrange — a registry that answers only when the test lets it
    const first = await world();
    await approved(first);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const verify = first.proofs.verify.bind(first.proofs);
    first.proofs.verify = async (proof, challenge) => {
      await gate;
      return await verify(proof, challenge);
    };
    const again = await world({ store: first.store, proofs: first.proofs, load: false });

    // Act
    const loading = again.service.load();
    await Bun.sleep(0);
    const during = await refusal(again.service.list(HOST_OWNER));
    release();
    await loading;

    // Assert
    should([during.status, during.code]).eql([503, 'unavailable']);
    should((await again.service.list(HOST_OWNER)).rules[0]?.status).equal('active');
  });
});

describe('stage refusals', () => {
  it('should refuse an unknown sign-in, and accounts that cannot be read, before anything is held', async () => {
    const w = await world();
    const unknown = await refusal(w.service.stage(deviceOwner(), { ...DRAFT, signIn: 'si_0000000000000fff' }));
    w.state.listingBroken = true;
    const unreadable = await refusal(w.service.stage(deviceOwner(), DRAFT));
    should([unknown.status, unknown.code]).eql([404, 'not_found']);
    should([unreadable.status, unreadable.code]).eql([503, 'unavailable']);
    should(w.store.writes).equal(0);
  });

  it('should refuse a stage for a device whose id is not a paired device id, or a nonce never drawn', async () => {
    const odd = await world();
    const malformed = await refusal(odd.service.stage(deviceOwner('phone-1'), DRAFT));
    const broken = await world({ nonce: () => 'not-a-nonce' });
    const noNonce = await refusal(broken.service.stage(deviceOwner(), DRAFT));
    should([malformed.status, malformed.code]).eql([400, 'bad_request']);
    should([noNonce.status, noNonce.code]).eql([400, 'bad_request']);
  });

  it('should word a project scope and a session scope on the passkey dialog', async () => {
    const w = await world();
    const project = await w.service.stage(deviceOwner(), {
      ...DRAFT,
      scope: { kind: 'project', project: '6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
    });
    const session = await w.service.stage(deviceOwner(), {
      ...DRAFT,
      scope: { kind: 'session', session: 'mvv6b4qw-49d0158d' },
    });
    should(project.summary).containEql('only for ferrets in board project 6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    should(session.summary).containEql('only for session mvv6b4qw-49d0158d');
  });

  it(`should hold at most ${String(SIGN_IN_RULE_MAX)} rules: the stage refuses past it, and so does a commit that raced`, async () => {
    // Arrange — 63 rules, then two stages for two more sign-ins
    const { listing: wide, ids } = many(SIGN_IN_RULE_MAX + 1);
    const w = await world({ listing: wide as never });
    for (const id of ids.slice(0, SIGN_IN_RULE_MAX - 1)) await approved(w, { ...DRAFT, signIn: id });
    const last = await staged(w, ids[SIGN_IN_RULE_MAX - 1]);
    const raced = await staged(w, ids[SIGN_IN_RULE_MAX]);

    // Act
    await w.service.commit(deviceOwner(), last.stage, () => evidenceFor(last.challenge));
    const commit = await refusal(w.service.commit(deviceOwner(), raced.stage, () => evidenceFor(raced.challenge)));
    const stage = await refusal(w.service.stage(deviceOwner(), DRAFT));

    // Assert
    should([commit.status, commit.code, stage.status, stage.code]).eql([429, 'capacity', 429, 'capacity']);
    should(w.store.document?.rules).have.length(SIGN_IN_RULE_MAX);
  });
});

describe('drop and commit refusals', () => {
  it('should drop a stage with no passkey: it then answers nothing to anyone', async () => {
    const w = await world();
    const { stage } = await staged(w);
    w.service.drop(deviceOwner(), stage);
    should(w.service.viewStage(deviceOwner(), stage).state).equal('denied');
    should(w.service.challengeOf(stage, DEVICE)).be.undefined();
    should((await refusal(() => w.service.drop(deviceOwner(), stage))).code).equal('stage_not_found');
  });

  it('should refuse an assertion that is not usable as a stored proof, and spend the stage', async () => {
    const w = await world();
    const { stage, challenge } = await staged(w);
    const refused = await refusal(
      w.service.commit(deviceOwner(), stage, () => ({ ...evidenceFor(challenge), signature: 'not base64url!' })),
    );
    should([refused.status, refused.code]).eql([403, 'proof_invalid']);
    should(w.service.viewStage(deviceOwner(), stage).state).equal('denied');
    should(w.store.writes).equal(0);
  });

  it('should refuse when the passkeys cannot be read, and approve nothing', async () => {
    const w = await world();
    const { stage, challenge } = await staged(w);
    w.proofs.broken = true;
    const refused = await refusal(w.service.commit(deviceOwner(), stage, () => evidenceFor(challenge)));
    should([refused.status, refused.code]).eql([503, 'unavailable']);
    should(w.store.writes).equal(0);
  });

  it('should refuse a renewal whose rule was revoked while it waited for its passkey', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w);
    const renewal = await w.service.stage(deviceOwner(), { ...DRAFT, replaces: view.id });
    const challenge = w.service.challengeOf(renewal.stage, DEVICE) ?? new Uint8Array();
    await w.service.revoke(HOST_OWNER, view.id);

    // Act
    const refused = await refusal(w.service.commit(deviceOwner(), renewal.stage, () => evidenceFor(challenge)));

    // Assert
    should([refused.status, refused.code]).eql([409, 'conflict']);
    should(w.store.document?.rules).eql([]);
  });

  it('should refuse a commit whose file cannot be written, and hold nothing in memory', async () => {
    const w = await world();
    const { stage, challenge } = await staged(w);
    w.store.failWrites = true;
    const refused = await refusal(w.service.commit(deviceOwner(), stage, () => evidenceFor(challenge)));
    should([refused.status, refused.code]).eql([503, 'unavailable']);
    should((await w.service.list(HOST_OWNER)).rules).eql([]);
  });

  it('should refuse a narrowing whose file cannot be written, and keep the rule as it was', async () => {
    const w = await world();
    const { view } = await approved(w, { ...DRAFT, uses: 5 });
    w.store.failWrites = true;
    const refused = await refusal(w.service.narrow(HOST_OWNER, view.id, { uses: 1 }));
    should([refused.status, refused.code]).eql([503, 'unavailable']);
    should((await w.service.list(HOST_OWNER)).rules[0]?.uses).equal(5);
  });
});

describe('approving a rule again', () => {
  it('should audit a re-approval of a rule in force as widened, and of one that ended as renewed', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w, { ...DRAFT, lifetimeSeconds: 3_600 });

    // Act
    await approved(w, { ...DRAFT, lifetimeSeconds: 3_600, replaces: view.id });
    w.clock.now = NOW + 3_600_000;
    await approved(w, { ...DRAFT, replaces: view.id });

    // Assert
    should(actions(w)).eql(['sign-in-rule-created', 'sign-in-rule-widened', 'sign-in-rule-renewed']);
    should(w.store.document?.rules[0]?.body.revision).equal(3);
  });

  it('should name no device on a rule whose device has no name any more', async () => {
    const w = await world();
    const { view } = await approved(w, DRAFT, deviceOwner(OTHER_DEVICE), OTHER_DEVICE);
    should(view.approvedWith).eql({ deviceId: OTHER_DEVICE });
  });
});

describe('eligibility and revoking', () => {
  it('should say a sign-in can have a rule, and name its rule once it has one', async () => {
    const w = await world();
    should(await w.service.eligibility(HOST_OWNER, GITHUB)).eql({ signIn: GITHUB, eligible: true });
    const { view } = await approved(w);
    should(await w.service.eligibility(HOST_OWNER, GITHUB)).eql({ signIn: GITHUB, eligible: true, rule: view.id });
    should((await refusal(w.service.eligibility(HOST_OWNER, 'si_0000000000000fff'))).code).equal('not_found');
  });

  it('should revoke one rule with no passkey: gone from the file, memory and the proof checks', async () => {
    const w = await world();
    const { view } = await approved(w);
    await w.service.revoke(deviceOwner(), view.id);
    should(w.store.document?.rules).eql([]);
    should(w.service.verified(view.id, 1)).be.false();
    should(actions(w)).eql(['sign-in-rule-created', 'sign-in-rule-revoked']);
    should(await w.service.revokeAccount(HOST_OWNER, 'GITHUB_WORK' as never)).eql({ revoked: 0 });
  });

  it('should drop a waiting stage when its device is revoked', async () => {
    const w = await world();
    const { stage } = await staged(w);
    await w.service.forgetDevice(DEVICE);
    should(w.service.viewStage(deviceOwner(), stage as SignInRuleStageId)).containDeep({ state: 'denied' });
  });
});

describe('a fill under a rule is counted (used)', () => {
  it('should count each use with its time and session, and ignore an older revision', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w);

    // Act
    await w.service.used(view.id, 1, 'mvv6b4qw-49d0158d');
    await w.service.used(view.id, 2, 'mvv6b4qw-49d0158d');

    // Assert
    should(w.store.document?.rules[0]?.usage).eql({
      count: 1,
      lastUsedAt: new Date(NOW).toISOString(),
      lastSession: 'mvv6b4qw-49d0158d',
    });
  });

  it('should suspend a rule in memory when its use cannot be saved, so an uncounted use never fills again', async () => {
    const w = await world();
    const { view } = await approved(w);
    w.store.failWrites = true;
    await w.service.used(view.id, 1, 'mvv6b4qw-49d0158d');
    const [rule] = (await w.service.list(HOST_OWNER)).rules;
    should(rule).containDeep({
      status: 'suspended',
      suspended: { because: 'store-write-failed' },
      usage: { count: 1 },
    });
    should(w.store.document?.rules[0]?.usage.count).equal(0);
    should(actions(w)).eql(['sign-in-rule-created', 'sign-in-rule-suspended']);
  });
});

describe('finished stages are bounded (secrev-1274a N2)', () => {
  it(`should keep at most ${String(FINISHED_STAGES_KEPT)} finished stages for a poll, dropping the oldest`, async () => {
    const w = await world();
    const stages: SignInRuleStageId[] = [];
    for (let index = 0; index < FINISHED_STAGES_KEPT + 3; index += 1)
      stages.push((await w.service.stage(deviceOwner(), DRAFT)).stage);
    should((await refusal(() => w.service.viewStage(deviceOwner(), stages[0] as SignInRuleStageId))).code).equal(
      'stage_not_found',
    );
    should(w.service.viewStage(deviceOwner(), stages.at(-2) as SignInRuleStageId).state).equal('denied');
    should(w.service.viewStage(deviceOwner(), stages.at(-1) as SignInRuleStageId).state).equal('waiting');
  });
});

describe('a device taking a machine stage (secrev-1274a L3)', () => {
  it('should let a device with a passkey take it and approve it', async () => {
    const w = await world();
    const { view } = await approved(w, DRAFT, HOST_OWNER);
    should(view.approvedWith.deviceId).equal(DEVICE);
  });

  it('should refuse a device with no passkey, and a device id that cannot be signed, leaving the stage untaken', async () => {
    // Arrange
    const keyless = await world({ devicePasskeys: false });
    const machine = await keyless.service.stage(HOST_OWNER, DRAFT);
    keyless.service.confirmInApp(HOST_OWNER, machine.stage);
    const odd = await world();
    const other = await odd.service.stage(HOST_OWNER, DRAFT);
    odd.service.confirmInApp(HOST_OWNER, other.stage);

    // Act
    const noPasskey = await refusal(keyless.service.bind(deviceOwner(), machine.stage));
    const unsigned = await refusal(odd.service.bind(deviceOwner('phone-1'), other.stage));

    // Assert
    should([noPasskey.status, noPasskey.code]).eql([409, 'passkey_required']);
    should([unsigned.status, unsigned.code]).eql([404, 'stage_not_found']);
    should(await odd.service.bind(deviceOwner(), other.stage)).containDeep({ stage: other.stage });
  });
});
