import { describe, it } from 'bun:test';
import { PASSKEY_CHALLENGE_TTL_SECONDS, STEP_UP_TTL_SECONDS } from '@ferretry/protocol';
import should from 'should';
import {
  APP_SESSION_GRACE_MS,
  ChallengeLedger,
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
