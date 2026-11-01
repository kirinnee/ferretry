import { describe, it } from 'bun:test';
import { PASSKEY_CHALLENGE_TTL_SECONDS, STEP_UP_TTL_SECONDS, type StoredStepUpProof } from '@ferretry/protocol';
import should from 'should';
import {
  APP_SESSION_GRACE_MS,
  ChallengeLedger,
  type KeptProof,
  StepUpRegistry,
  type StepUpSubject,
} from '../../../src/lib/step-up/index.ts';
import { deviceId } from '../push/support.ts';

const NOW = 1_700_000_000_000;
const phone: StepUpSubject = { deviceId: deviceId('a'), appSession: 'tab-one' };
const phoneOtherTab: StepUpSubject = { deviceId: phone.deviceId, appSession: 'tab-two' };
const laptop: StepUpSubject = { deviceId: deviceId('b'), appSession: 'tab-one' };
const bytes = (fill: number) => new Uint8Array(32).fill(fill);

/** Every subject here holds a live session throughout; ending one is the span tests' subject. */
const openRegistry = (): StepUpRegistry => {
  const registry = new StepUpRegistry({ nowMs: () => NOW });
  for (const subject of [phone, phoneOtherTab, laptop]) registry.open(subject);
  return registry;
};

describe('StepUpRegistry', () => {
  it('should hold a granted step-up for its window and forget it once lapsed', () => {
    // Arrange
    const registry = openRegistry();

    // Act
    const expiresAtMs = registry.grant(phone, NOW);

    // Assert
    should(expiresAtMs).equal(NOW + STEP_UP_TTL_SECONDS * 1_000);
    should(registry.held(phone, NOW)).be.true();
    should(registry.expiresAt(phone, expiresAtMs - 1)).equal(expiresAtMs);
    // The window is half-open: at the instant it lapses, it is gone, and stays gone.
    should(registry.held(phone, expiresAtMs)).be.false();
    should(registry.expiresAt(phone, NOW)).be.undefined();
  });

  it('should bind a step-up to one app session of one device', () => {
    // Arrange
    const registry = openRegistry();

    // Act
    registry.grant(phone, NOW);

    // Assert
    should(registry.held(phoneOtherTab, NOW)).be.false();
    should(registry.held(laptop, NOW)).be.false();
  });

  it('should end every app session of a revoked device and no other device', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW);
    registry.grant(phoneOtherTab, NOW);
    registry.grant(laptop, NOW);

    // Act
    registry.forgetDevice(phone.deviceId);

    // Assert
    should(registry.held(phone, NOW)).be.false();
    should(registry.held(phoneOtherTab, NOW)).be.false();
    should(registry.held(laptop, NOW)).be.true();
  });
});

describe('StepUpRegistry fresh proof (acts that add access)', () => {
  it('should count a passkey as FRESH for one challenge lifetime, inside a step-up that lasts longer', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW);
    const lifetime = PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;

    // Act + Assert — the step-up still covers ordinary acts; adding a device wants a passkey just now.
    should(registry.freshlyHeld(phone, NOW + lifetime - 1)).be.true();
    should(registry.freshlyHeld(phone, NOW + lifetime)).be.false();
    should(registry.held(phone, NOW + lifetime)).be.true();
    // Never without a step-up of its own: another tab of the same device proved nothing.
    should(registry.freshlyHeld(phoneOtherTab, NOW)).be.false();
  });

  it('should hold a step-up that is not a proof for an act (the unlock), and forget an older proof', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW);

    // Act
    registry.grant(phone, NOW + 1, false);

    // Assert
    should(registry.held(phone, NOW + 1)).be.true();
    should(registry.freshlyHeld(phone, NOW + 1)).be.false();
  });

  it('should hand one fresh proof to exactly one of two acts that race for it', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW);

    // Act — nothing awaits between the check and the spend, so the second finds it gone.
    const claims = [registry.claimFresh(phone, NOW), registry.claimFresh(phone, NOW)];

    // Assert
    should(claims).deepEqual([true, false]);
    should(registry.held(phone, NOW)).be.true();
    registry.grant(phone, NOW + 1);
    should(registry.claimFresh(phone, NOW + 1)).be.true();
  });

  it('should claim a proof for an act only when it was proved for that very act', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW, true, 'loosen-config');

    // Act / Assert — a leftover proof for another act is not a catalog-install proof, and is kept.
    should(registry.claimFresh(phone, NOW, 'catalog-install')).be.false();
    should(registry.freshlyHeld(phone, NOW)).be.true();
    should(registry.claimFresh(phone, NOW, 'loosen-config')).be.true();
    should(registry.claimFresh(phone, NOW, 'loosen-config')).be.false();
  });

  it('should not count a proof with no act, or an unlock, as a proof for a named act', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW);
    registry.grant(laptop, NOW, false);

    // Act / Assert
    should(registry.claimFresh(phone, NOW, 'catalog-install')).be.false();
    should(registry.claimFresh(laptop, NOW, 'catalog-install')).be.false();
    should(registry.claimFresh(phone, NOW)).be.true();
  });

  it('should hand a proof for an act to exactly one of two claims that race for it', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW, true, 'catalog-install');

    // Act
    const claims = [
      registry.claimFresh(phone, NOW, 'catalog-install'),
      registry.claimFresh(phone, NOW, 'catalog-install'),
    ];

    // Assert
    should(claims).deepEqual([true, false]);
  });

  it('should replace the act a proof was stamped for when the next passkey is proved for another', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW, true, 'catalog-install');

    // Act
    registry.grant(phone, NOW + 1, true, 'loosen-config');

    // Assert
    should(registry.claimFresh(phone, NOW + 1, 'catalog-install')).be.false();
    should(registry.claimFresh(phone, NOW + 1, 'loosen-config')).be.true();
  });

  it('should claim no proof that was never given, that lapsed, or that another tab holds', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW);

    // Act / Assert
    should(registry.claimFresh(phoneOtherTab, NOW)).be.false();
    should(registry.claimFresh(laptop, NOW)).be.false();
    should(registry.claimFresh(phone, NOW + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000)).be.false();
  });

  it('should spend the fresh proof on one act and keep the step-up, until the next passkey', () => {
    // Arrange
    const registry = openRegistry();
    registry.grant(phone, NOW);

    // Act
    registry.spendFresh(phone);

    // Assert
    should(registry.freshlyHeld(phone, NOW)).be.false();
    should(registry.held(phone, NOW)).be.true();
    registry.grant(phone, NOW + 1);
    should(registry.freshlyHeld(phone, NOW + 1)).be.true();
  });

  it('should forget the fresh proof with the device, and when its page closes', () => {
    // Arrange
    const clock = { now: NOW };
    const registry = new StepUpRegistry({ nowMs: () => clock.now });
    const closePhone = registry.open(phone);
    registry.open(laptop);
    registry.grant(phone, NOW);
    registry.grant(laptop, NOW);

    // Act
    registry.forgetDevice(laptop.deviceId);
    closePhone();
    clock.now = NOW + APP_SESSION_GRACE_MS;
    // The same page id coming back begins a new life that proved nothing.
    registry.open(phone);

    // Assert
    should(registry.freshlyHeld(laptop, NOW)).be.false();
    should(registry.freshlyHeld(phone, clock.now)).be.false();
  });
});

describe('StepUpRegistry window (B6)', () => {
  /** A registry whose window is a value the case can change, as the saved setting is. */
  const windowed = (minutes: number) => {
    const window = { minutes };
    const registry = new StepUpRegistry({ nowMs: () => NOW }, () => window.minutes);
    registry.open(phone);
    return { window, registry };
  };

  it('should hold a step-up for the window the setting names, not the default', () => {
    // Arrange
    const { registry } = windowed(5);

    // Act
    const expiresAtMs = registry.grant(phone, NOW);

    // Assert
    should(expiresAtMs).equal(NOW + 5 * 60_000);
    should(registry.held(phone, NOW + 5 * 60_000 - 1)).be.true();
    should(registry.held(phone, NOW + 5 * 60_000)).be.false();
  });

  it('should apply a shortened window to a step-up that is already held', () => {
    // Arrange
    const { window, registry } = windowed(15);
    registry.grant(phone, NOW);
    const later = NOW + 6 * 60_000;
    should(registry.held(phone, later)).be.true();

    // Act
    window.minutes = 5;

    // Assert
    should(registry.expiresAt(phone, later)).be.undefined();
    should(registry.held(phone, NOW)).be.false();
  });

  it('should hold a step-up for a challenge’s life only when the window is 0, and spend it on one act', () => {
    // Arrange
    const { registry } = windowed(0);

    // Act
    const expiresAtMs = registry.grant(phone, NOW);

    // Assert
    should(expiresAtMs).equal(NOW + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000);
    should(registry.held(phone, expiresAtMs - 1)).be.true();
    registry.spend(phone);
    should(registry.held(phone, NOW)).be.false();
  });

  it('should let a window of 0 lapse on its own when no act spends it', () => {
    // Arrange
    const { registry } = windowed(0);
    const expiresAtMs = registry.grant(phone, NOW);

    // Act / Assert
    should(registry.held(phone, expiresAtMs)).be.false();
  });

  it('should leave a step-up alone when an act is admitted under a window above 0', () => {
    // Arrange
    const { registry } = windowed(15);
    registry.grant(phone, NOW);

    // Act
    registry.spend(phone);
    registry.spend(phone);

    // Assert
    should(registry.held(phone, NOW)).be.true();
  });
});

describe('ChallengeLedger', () => {
  it('should answer a challenge exactly once', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'step-up', bytes(1), NOW);

    // Act
    const first = ledger.take(phone, 'step-up', NOW);
    const second = ledger.take(phone, 'step-up', NOW);

    // Assert
    should(first).eql(bytes(1));
    should(second).be.undefined();
  });

  it('should hand back the act a challenge was issued for, once', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'step-up', bytes(1), NOW, undefined, { kind: 'act', act: 'catalog-install' });
    ledger.issue(laptop, 'step-up', bytes(2), NOW);

    // Act / Assert
    const first = ledger.takeWithAct(phone, 'step-up', NOW);
    should(first?.bytes).eql(bytes(1));
    should(first?.stamp).eql({ kind: 'act', act: 'catalog-install' });
    should(ledger.takeWithAct(phone, 'step-up', NOW)).be.undefined();
    const plain = ledger.takeWithAct(laptop, 'step-up', NOW);
    should(plain?.bytes).eql(bytes(2));
    should(plain?.stamp).be.undefined();
  });

  it('should refuse a lapsed challenge and spend it in the same call', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'register', bytes(1), NOW);
    const lapse = NOW + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;

    // Act / Assert
    should(ledger.take(phone, 'register', lapse)).be.undefined();
    ledger.issue(phone, 'register', bytes(2), NOW);
    should(ledger.take(phone, 'register', lapse - 1)).eql(bytes(2));
  });

  it('should keep the purposes apart, so a registration challenge answers no assertion', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'register', bytes(1), NOW);

    // Act / Assert
    should(ledger.take(phone, 'step-up', NOW)).be.undefined();
    should(ledger.take(phone, 'register', NOW)).eql(bytes(1));
  });

  it('should bind a challenge to one app session of one device', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'step-up', bytes(1), NOW);

    // Act / Assert
    should(ledger.take(phoneOtherTab, 'step-up', NOW)).be.undefined();
    should(ledger.take(laptop, 'step-up', NOW)).be.undefined();
    should(ledger.take(phone, 'step-up', NOW)).eql(bytes(1));
  });

  it('should replace an outstanding challenge when asked again', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'step-up', bytes(1), NOW);

    // Act
    ledger.issue(phone, 'step-up', bytes(2), NOW);

    // Assert
    should(ledger.take(phone, 'step-up', NOW)).eql(bytes(2));
  });

  it('should forget a revoked device’s challenges and no other device’s', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'step-up', bytes(1), NOW);
    ledger.issue(phoneOtherTab, 'register', bytes(2), NOW);
    ledger.issue(laptop, 'step-up', bytes(3), NOW);

    // Act
    ledger.forgetDevice(phone.deviceId);

    // Assert
    should(ledger.take(phone, 'step-up', NOW)).be.undefined();
    should(ledger.take(phoneOtherTab, 'register', NOW)).be.undefined();
    should(ledger.take(laptop, 'step-up', NOW)).eql(bytes(3));
  });

  it('should sweep lapsed challenges on every issue, so unanswered ones never accumulate', () => {
    // A device opening a session per fresh appSession, asking once and leaving (review L1).
    // Arrange
    const ledger = new ChallengeLedger();
    for (let index = 0; index < 50; index += 1)
      ledger.issue({ deviceId: phone.deviceId, appSession: `tab-${index}` }, 'step-up', bytes(index), NOW);
    const live = ledger.size;

    // Act — two minutes later, one more is asked for
    ledger.issue(laptop, 'step-up', bytes(9), NOW + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000);

    // Assert — the fifty unanswered ones are gone, and the new one still answers
    should(live).equal(50);
    should(ledger.size).equal(1);
    should(ledger.take(laptop, 'step-up', NOW + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000)).eql(bytes(9));
  });

  it('should pair a confirmation only with the registration challenge it was issued with, and spend it either way', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'register-confirm', bytes(5), NOW, bytes(1));

    // Act
    const mismatched = ledger.takeConfirmation(phone, bytes(2), NOW);
    ledger.issue(phone, 'register-confirm', bytes(5), NOW, bytes(1));
    const crossed = ledger.takeConfirmation(phoneOtherTab, bytes(1), NOW);
    const matched = ledger.takeConfirmation(phone, bytes(1), NOW);
    const replayed = ledger.takeConfirmation(phone, bytes(1), NOW);
    ledger.issue(phone, 'register-confirm', bytes(5), NOW);
    const unbound = ledger.takeConfirmation(phone, bytes(1), NOW);
    ledger.issue(phone, 'step-up', bytes(5), NOW, bytes(1));
    const wrongPurpose = ledger.takeConfirmation(phone, bytes(1), NOW);

    // Assert
    should(mismatched).be.undefined();
    should(crossed).be.undefined();
    should(matched).eql(bytes(5));
    should(replayed).be.undefined();
    should(unbound).be.undefined();
    should(wrongPurpose).be.undefined();
  });
});

describe('StepUpRegistry bound proof (an act every caller must prove)', () => {
  const STAGE_A = 'a'.repeat(64);
  const STAGE_B = 'b'.repeat(64);

  it('should take a bound proof only for its act and its exact subject, once', () => {
    // Arrange
    const registry = openRegistry();
    registry.grantBound(phone, NOW, 'add-2fa-key', STAGE_A);

    // Act + Assert — another subject does not count, and does not spend it
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', STAGE_B)).be.false();
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', '')).be.false();
    should(registry.claimFresh(phoneOtherTab, NOW, 'add-2fa-key', STAGE_A)).be.false();
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', STAGE_A)).be.true();
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', STAGE_A)).be.false();
  });

  it('should never let a bound proof satisfy an act-less check, a step-up or another act', () => {
    // Arrange
    const registry = openRegistry();

    // Act
    registry.grantBound(phone, NOW, 'add-2fa-key', STAGE_A);

    // Assert — the dispatcher's `freshStepUp`, a window step-up, an act-less claim and a stamped act all see nothing
    should(registry.freshlyHeld(phone, NOW)).be.false();
    should(registry.held(phone, NOW)).be.false();
    should(registry.claimFresh(phone, NOW)).be.false();
    should(registry.claimFresh(phone, NOW, 'add-device')).be.false();
    should(registry.claimFresh(phone, NOW, 'catalog-install')).be.false();
    // …and it is still there for the save it was proved for.
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', STAGE_A)).be.true();
  });

  it('should never let a step-up, a fresh proof or an unlock stand in for an act every caller must prove', () => {
    // Arrange — every other kind of proof this copy can hold
    const registry = openRegistry();
    registry.grant(phone, NOW);
    registry.grant(phoneOtherTab, NOW, false);

    // Act + Assert
    should(registry.freshlyHeld(phone, NOW)).be.true();
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', STAGE_A)).be.false();
    should(registry.claimFresh(phoneOtherTab, NOW, 'add-2fa-key', STAGE_A)).be.false();
    // @ts-expect-error — an act every caller must prove names what its proof is bound to
    should(registry.claimFresh(phone, NOW, 'add-2fa-key')).be.false();
    // The fresh proof was not spent by those refusals.
    should(registry.claimFresh(phone, NOW)).be.true();
  });

  it('should lapse a bound proof after one challenge lifetime', () => {
    // Arrange
    const lifetime = PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
    const registry = openRegistry();

    // Act
    const until = registry.grantBound(phone, NOW, 'add-2fa-key', STAGE_A);
    registry.grantBound(phoneOtherTab, NOW, 'add-2fa-key', STAGE_A);

    // Assert
    should(until).equal(NOW + lifetime);
    should(registry.claimFresh(phone, NOW + lifetime, 'add-2fa-key', STAGE_A)).be.false();
    should(registry.claimFresh(phoneOtherTab, NOW + lifetime - 1, 'add-2fa-key', STAGE_A)).be.true();
  });

  it('should end a bound proof with the page that proved it', () => {
    // Arrange
    let now = NOW;
    const registry = new StepUpRegistry({ nowMs: () => now });
    const close = registry.open(laptop);
    registry.grantBound(laptop, NOW, 'add-2fa-key', STAGE_B);

    // Act — the page closes, and stays closed past the grace
    close();
    now = NOW + APP_SESSION_GRACE_MS;

    // Assert
    should(registry.claimFresh(laptop, now, 'add-2fa-key', STAGE_B)).be.false();
  });

  it('should forget every bound proof of a revoked device', () => {
    // Arrange
    const registry = openRegistry();
    registry.grantBound(laptop, NOW, 'add-2fa-key', STAGE_B);

    // Act
    registry.forgetDevice(laptop.deviceId);

    // Assert
    should(registry.claimFresh(laptop, NOW, 'add-2fa-key', STAGE_B)).be.false();
  });
});

describe('ChallengeLedger binding', () => {
  it('should hand back what a step-up challenge was bound to, with its act', () => {
    // Arrange
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'step-up', bytes(1), NOW, undefined, {
      kind: 'bound',
      act: 'add-2fa-key',
      bound: 'c'.repeat(64),
    });

    // Act
    const taken = ledger.takeWithAct(phone, 'step-up', NOW);

    // Assert
    should(taken?.stamp).eql({ kind: 'bound', act: 'add-2fa-key', bound: 'c'.repeat(64) });
  });
});

describe("StepUpRegistry stored proof (a standing rule's kept assertion, invariant 6)", () => {
  /** A kept proof is bound to the staged rule it approves. */
  const RULE = `srs_${'a'.repeat(24)}`;
  const OTHER = `srs_${'b'.repeat(24)}`;
  /** The challenge the live ceremony verified, derived from the rule's bytes; and one derived from other bytes. */
  const CHALLENGE = bytes(7);
  const ANOTHER = bytes(8);
  const evidence = (deviceIdOf: string = phone.deviceId): StoredStepUpProof => ({
    deviceId: deviceIdOf,
    credentialId: 'Y3JlZGVudGlhbA',
    clientDataJSON: 'Y2xpZW50',
    authenticatorData: 'YXV0aA',
    signature: 'c2ln',
  });
  const kept = (deviceIdOf?: string): KeptProof => ({ evidence: evidence(deviceIdOf), challenge: CHALLENGE });

  it('should hand the kept assertion over once, for its act, its exact stage and its own challenge only', () => {
    // Arrange
    const registry = openRegistry();
    registry.grantBound(phone, NOW, 'approve-sign-in-rule', RULE, kept());

    // Act + Assert — another stage, tab, device or challenge neither takes it nor spends it
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', OTHER, CHALLENGE)).be.undefined();
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', '', CHALLENGE)).be.undefined();
    should(registry.claimStoredProof(phoneOtherTab, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
    should(registry.claimStoredProof(laptop, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', RULE, ANOTHER)).be.undefined();
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', RULE, CHALLENGE.subarray(1))).be.undefined();
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).eql(evidence());
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
  });

  it('should never let claimFresh take a stored proof, in any form', () => {
    // Arrange
    const registry = openRegistry();
    registry.grantBound(phone, NOW, 'approve-sign-in-rule', RULE, kept());

    // Act + Assert — every fresh claim, and every check a step-up answers, sees nothing
    // @ts-expect-error — a stored-proof act is claimed only as a stored proof
    should(registry.claimFresh(phone, NOW, 'approve-sign-in-rule', RULE)).be.false();
    should(registry.claimFresh(phone, NOW, 'approve-task-plan', RULE)).be.false();
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', RULE)).be.false();
    should(registry.claimFresh(phone, NOW)).be.false();
    should(registry.claimFresh(phone, NOW, 'add-device')).be.false();
    should(registry.freshlyHeld(phone, NOW)).be.false();
    should(registry.held(phone, NOW)).be.false();
    // …and it is still there for the commit it was proved for.
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).eql(evidence());
  });

  it("should never let claimStoredProof take another act's proof, nor a step-up", () => {
    // Arrange — a bound proof for a spent act on the same subject, and a fresh step-up on another tab
    const registry = openRegistry();
    registry.grantBound(phone, NOW, 'approve-task-plan', RULE);
    registry.grant(phoneOtherTab, NOW, true);

    // Act + Assert
    should(registry.claimStoredProof(phone, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
    should(registry.claimStoredProof(phoneOtherTab, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
    // @ts-expect-error — only a stored-proof act is ever answered
    should(registry.claimStoredProof(phone, NOW, 'approve-task-plan', RULE, CHALLENGE)).be.undefined();
    // Neither was spent by those refusals.
    should(registry.claimFresh(phone, NOW, 'approve-task-plan', RULE)).be.true();
    should(registry.claimFresh(phoneOtherTab, NOW)).be.true();
  });

  it('should refuse a grant that keeps the wrong thing, loudly, and record nothing', () => {
    // Arrange
    const registry = openRegistry();
    const grantLoosely = registry.grantBound.bind(registry) as unknown as (
      ...args: readonly unknown[]
    ) => number | undefined;

    // Act + Assert — a kept proof for an act whose proof is spent, and none for the act that keeps it
    should(() => grantLoosely(phone, NOW, 'add-2fa-key', RULE, kept())).throw(TypeError);
    should(() => grantLoosely(phoneOtherTab, NOW, 'approve-sign-in-rule', RULE)).throw(TypeError);
    should(registry.claimFresh(phone, NOW, 'add-2fa-key', RULE)).be.false();
    should(registry.claimStoredProof(phoneOtherTab, NOW, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
  });

  it('should lapse a stored proof after one challenge lifetime (120 s)', () => {
    // Arrange
    const lifetime = PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
    const registry = openRegistry();

    // Act
    const until = registry.grantBound(phone, NOW, 'approve-sign-in-rule', RULE, kept());
    registry.grantBound(phoneOtherTab, NOW, 'approve-sign-in-rule', RULE, kept());

    // Assert
    should(lifetime).equal(120_000);
    should(until).equal(NOW + lifetime);
    should(registry.claimStoredProof(phone, NOW + lifetime, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
    should(registry.claimStoredProof(phoneOtherTab, NOW + lifetime - 1, 'approve-sign-in-rule', RULE, CHALLENGE)).eql(
      evidence(),
    );
  });

  it('should end a stored proof with its page, and with its revoked device', () => {
    // Arrange
    let now = NOW;
    const registry = new StepUpRegistry({ nowMs: () => now });
    const close = registry.open(laptop);
    registry.open(phone);
    registry.grantBound(laptop, NOW, 'approve-sign-in-rule', RULE, kept(laptop.deviceId));
    registry.grantBound(phone, NOW, 'approve-sign-in-rule', RULE, kept());

    // Act — the laptop's page closes past the grace; the phone is revoked
    close();
    now = NOW + APP_SESSION_GRACE_MS;
    registry.forgetDevice(phone.deviceId);

    // Assert
    should(registry.claimStoredProof(laptop, now, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
    should(registry.claimStoredProof(phone, now, 'approve-sign-in-rule', RULE, CHALLENGE)).be.undefined();
  });
});
