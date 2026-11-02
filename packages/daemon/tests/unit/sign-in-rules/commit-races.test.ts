import { describe, it } from 'bun:test';
import type { StoredStepUpProof } from '@ferretry/protocol';
import should from 'should';
import { SignInRuleError, type SignInRulePorts } from '../../../src/lib/sign-in-rules/index.ts';
import {
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
  signIn,
  tappedFact,
  type World,
  world,
} from './support.ts';

/**
 * What happens BETWEEN the steps of a commit, and after a write fails (secrev-1274a L1/L2, secrev-1274b M1/L3): the
 * proof is checked inside the change queue, a suspension that lands after the stage is never cleared unseen, and a
 * suspension that could not be written is written later.
 */

const refusal = async (work: Promise<unknown>): Promise<SignInRuleError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof SignInRuleError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** A registry whose next check waits for the test, having read the registry `before` or `after` it waits. */
function gateVerify(w: World, reads: 'before' | 'after') {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const inside = new Promise<void>(resolve => {
    entered = resolve;
  });
  const verify = w.proofs.verify.bind(w.proofs);
  w.proofs.verify = async (proof: StoredStepUpProof, challenge: Uint8Array) => {
    entered();
    if (reads === 'after') await gate;
    const answer = await verify(proof, challenge);
    if (reads === 'before') await gate;
    return answer;
  };
  return { release: () => release(), inside };
}

describe('a revocation during a commit never leaves an active rule (secrev-1274b M1)', () => {
  for (const reads of ['before', 'after'] as const)
    it(`should end suspended and unverified when the device is revoked while the proof is checked (${reads} the read)`, async () => {
      // Arrange
      const w = await world();
      const staged = await w.service.stage(deviceOwner(), DRAFT);
      const challenge = w.service.challengeOf(staged.stage, DEVICE) ?? new Uint8Array();
      const gate = gateVerify(w, reads);

      // Act — the commit is inside its proof check when pairing revokes the device and purges its passkeys
      const committing = w.service
        .commit(deviceOwner(), staged.stage, () => evidenceFor(challenge))
        .catch((error: unknown) => error);
      await gate.inside;
      w.proofs.held.delete(`${DEVICE}:${CREDENTIAL}`);
      const purged = Promise.all([
        w.service.passkeysChanged({ cause: 'device-forgotten', deviceId: DEVICE }),
        w.service.forgetDevice(DEVICE),
      ]);
      gate.release();
      const committed = await committing;
      await purged;

      // Assert — refused outright, or written and then suspended by the purge queued behind it: never in force
      const rules = (await w.service.list(HOST_OWNER)).rules;
      if (committed instanceof SignInRuleError) {
        should(committed.code).equal('proof_invalid');
        should(rules).eql([]);
      } else {
        should(rules[0]).containDeep({ status: 'suspended', suspended: { because: 'passkey-removed' } });
        should(w.service.verified(rules[0]?.id ?? 'sr_', 1)).be.false();
      }
    });

  it('should refuse a commit whose passkey went before its proof was checked', async () => {
    const w = await world();
    const staged = await w.service.stage(deviceOwner(), DRAFT);
    const challenge = w.service.challengeOf(staged.stage, DEVICE) ?? new Uint8Array();
    w.proofs.held.delete(`${DEVICE}:${CREDENTIAL}`);
    const refused = await refusal(w.service.commit(deviceOwner(), staged.stage, () => evidenceFor(challenge)));
    should([refused.status, refused.code]).eql([403, 'proof_invalid']);
    should(refused.message).containEql('is gone');
    should(w.store.writes).equal(0);
  });
});

describe('a suspension that lands after the stage is never cleared unseen (secrev-1274a L2)', () => {
  it('should refuse a widen whose rule was suspended while it waited, naming why', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w);
    const widen = await w.service.stage(deviceOwner(), { ...DRAFT, uses: 10, replaces: view.id });
    const challenge = w.service.challengeOf(widen.stage, DEVICE) ?? new Uint8Array();

    // Act — a ferret's page script on the pinned host, before the owner's passkey tap
    await w.service.scriptedOn('github.com');
    const refused = await refusal(w.service.commit(deviceOwner(), widen.stage, () => evidenceFor(challenge)));

    // Assert
    should([refused.status, refused.code]).eql([409, 'not_this_rule']);
    should(refused.message).containEql('suspended after this approval was staged');
    should((await w.service.list(HOST_OWNER)).rules[0]).containDeep({
      revision: 1,
      status: 'suspended',
      suspended: { because: 'scripted-origin' },
    });
  });

  it('should resume a suspended rule when the owner saw why, and say why on the passkey dialog', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w);
    await w.service.scriptedOn('github.com');

    // Act
    const resume = await w.service.stage(deviceOwner(), { ...DRAFT, replaces: view.id });
    const challenge = w.service.challengeOf(resume.stage, DEVICE) ?? new Uint8Array();
    const resumed = await w.service.commit(deviceOwner(), resume.stage, () => evidenceFor(challenge));

    // Assert
    should(resume.rows.some(row => row.label === 'Note' && row.value.startsWith('Suspended: '))).be.true();
    should(
      resume.rows.some(row => row.label === 'Note' && row.value === 'Replaces this sign-in’s rule (revision 2)'),
    ).be.true();
    should(resumed).containDeep({ revision: 2, status: 'active' });
    should(actions(w).at(-1)).equal('sign-in-rule-resumed');
  });
});

describe('a suspension whose write failed is written later (secrev-1274b L3)', () => {
  it('should retry the write on the next sweep, and on any later write', async () => {
    // Arrange — two rules
    const base = listing();
    const other = signIn({
      id: 'si_00000000000000b1' as never,
      place: { kind: 'site', domains: ['gitlab.example'], match: [] },
      observed: [tappedFact('gitlab.example')],
    });
    const w = await world({ listing: { ...base, signIns: [...base.signIns, other] } as never });
    const first = (await approved(w)).view;
    const second = (await approved(w, { ...DRAFT, signIn: other.id, uses: 5 })).view;

    // Act — the suspension's write fails; the sweep lands it
    w.store.failWrites = true;
    await w.service.scriptedOn('github.com');
    const unwritten = w.store.document?.rules.find(rule => rule.body.id === first.id)?.suspended;
    w.store.failWrites = false;
    await w.service.sweepRules();
    const swept = w.store.document?.rules.find(rule => rule.body.id === first.id)?.suspended?.because;

    // Then a use that cannot be written is carried by the next owner write (a narrowing of the other rule)
    w.store.failWrites = true;
    await w.service.used(second.id, 1, 'mvv6b4qw-49d0158d');
    w.store.failWrites = false;
    await w.service.narrow(HOST_OWNER, second.id, { uses: 4 });

    // Assert
    should(unwritten).be.undefined();
    should(swept).equal('store-write-failed');
    should(w.store.document?.rules.find(rule => rule.body.id === second.id)).containDeep({
      usage: { count: 1 },
      suspended: { because: 'store-write-failed' },
      narrowed: { uses: 4 },
    });
  });

  it('should write what is owed at shutdown', async () => {
    const w = await world();
    const { view } = await approved(w);
    w.store.failWrites = true;
    await w.service.suspend(view.id, 'did-not-move-on');
    w.store.failWrites = false;
    const writes = w.store.writes;
    await w.service.flush();
    await w.service.flush();
    should(w.store.writes).equal(writes + 1);
    should(w.store.document?.rules[0]?.suspended?.because).equal('store-write-failed');
  });
});

describe('a suspension raises nothing in a ferret’s session (R3c §18, secrev-1271 L6)', () => {
  it('should have no agenda, notice or message port at all, so it cannot', () => {
    // A port the service could raise a card or tell a session through would have to be one of these.
    const ports: readonly (keyof SignInRulePorts)[] = [
      'store',
      'accounts',
      'proofs',
      'passkeys',
      'devices',
      'audit',
      'clock',
      'ids',
      'warn',
      // A yes-or-no the build answers (`sign-in-rules-terminal.1`), never a way to reach a session.
      'terminalRules',
    ];
    const every: Record<keyof SignInRulePorts, true> = {
      store: true,
      accounts: true,
      proofs: true,
      passkeys: true,
      devices: true,
      audit: true,
      clock: true,
      ids: true,
      warn: true,
      terminalRules: true,
    };
    should(Object.keys(every)).eql([...ports]);
  });

  it('should record a fill-caused suspension only in the owner’s audit, with the session as a detail', async () => {
    const w = await world();
    const { view } = await approved(w);
    await w.service.suspend(view.id, 'did-not-move-on', { sessionId: 'mvv6b4qw-49d0158d' });
    const line = w.audits.at(-1);
    should(line).containDeep({ actor: { kind: 'host' }, cause: 'daemon', subject: view.id });
    should(line?.detail).containDeep({ action: 'sign-in-rule-suspended', session: 'mvv6b4qw-49d0158d' });
    should(GITHUB).equal(view.signIn);
  });
});

/** Holds the store's next write until the test releases it; `entered` resolves once a write is waiting. */
function holdWrites(w: World) {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const inside = new Promise<void>(resolve => {
    entered = resolve;
  });
  w.store.beforeWrite = async () => {
    entered();
    await gate;
  };
  return { release: () => release(), inside };
}

describe('verified() never reads true while a check is owed (secrev-1274-delta F1, F2)', () => {
  it('should not re-verify a rule on a passkey change while its pinned facts are unchecked', async () => {
    // Arrange — the accounts can't be read at load, so drift is owed
    const first = await world();
    const { view } = await approved(first);
    const again = await world({ store: first.store, load: false });
    again.state.listingBroken = true;
    await again.service.load();

    // Act — a passkey change re-checks every proof, and they all pass
    await again.service.passkeysChanged({ cause: 'member-key-forgotten', keyId: 'k' });
    const afterPasskeys = again.service.verified(view.id, 1);
    again.state.listingBroken = false;
    await again.service.sweepRules();

    // Assert — still owed until the sweep checked the facts
    should(afterPasskeys).be.false();
    should(again.service.verified(view.id, 1)).be.true();
  });

  it('should read false while a suspension is being written', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w);
    const held = holdWrites(w);

    // Act
    const suspending = w.service.scriptedOn('github.com');
    await held.inside;
    const during = w.service.verified(view.id, 1);
    held.release();
    await suspending;

    // Assert
    should(during).be.false();
    should(w.service.verified(view.id, 1)).be.false();
  });

  it('should read false while a re-check that will suspend the rule is still running', async () => {
    // Arrange — drift owed at load, then the accounts come back with the domains changed
    const first = await world();
    const { view } = await approved(first);
    const again = await world({ store: first.store, load: false });
    again.state.listingBroken = true;
    await again.service.load();
    const base = listing();
    again.state.listingBroken = false;
    again.state.listing = {
      ...base,
      signIns: base.signIns.map(each =>
        each.id === GITHUB ? { ...each, place: { kind: 'site', domains: ['gh.io'], match: [] } } : each,
      ),
    } as never;
    const held = holdWrites(again);

    // Act — the sweep's re-check passes the proof, finds the drift, and writes the suspension
    const sweeping = again.service.sweepRules();
    await held.inside;
    const during = again.service.verified(view.id, 1);
    held.release();
    await sweeping;

    // Assert
    should(during).be.false();
    should((await again.service.list(HOST_OWNER)).rules[0]?.suspended?.because).equal('place-changed');
  });
});

describe('a narrowing made after the stage is never undone unseen (secrev-1274-delta N1)', () => {
  it('should refuse a widen whose rule the owner narrowed while it waited', async () => {
    // Arrange
    const w = await world();
    const { view } = await approved(w, { ...DRAFT, uses: 5 });
    const widen = await w.service.stage(deviceOwner(), { ...DRAFT, uses: 10, replaces: view.id });
    const challenge = w.service.challengeOf(widen.stage, DEVICE) ?? new Uint8Array();

    // Act
    await w.service.narrow(HOST_OWNER, view.id, { uses: 2 });
    const refused = await refusal(w.service.commit(deviceOwner(), widen.stage, () => evidenceFor(challenge)));

    // Assert
    should([refused.status, refused.code]).eql([409, 'not_this_rule']);
    should(refused.message).containEql('narrowed after this approval was staged');
    should((await w.service.list(HOST_OWNER)).rules[0]).containDeep({ revision: 1, uses: 2 });
  });
});
