import { describe, it } from 'bun:test';
import { PASSKEY_CHALLENGE_TTL_SECONDS, STEP_UP_TTL_SECONDS } from '@ferretry/protocol';
import should from 'should';
import { ChallengeLedger, StepUpRegistry, type StepUpSubject } from '../../../src/lib/step-up/index.ts';
import { deviceId } from '../push/support.ts';

const NOW = 1_700_000_000_000;
const phone: StepUpSubject = { deviceId: deviceId('a'), appSession: 'tab-one' };
const phoneOtherTab: StepUpSubject = { deviceId: phone.deviceId, appSession: 'tab-two' };
const laptop: StepUpSubject = { deviceId: deviceId('b'), appSession: 'tab-one' };
const bytes = (fill: number) => new Uint8Array(32).fill(fill);

describe('StepUpRegistry', () => {
  it('should hold a granted step-up for its window and forget it once lapsed', () => {
    // Arrange
    const registry = new StepUpRegistry();

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
    const registry = new StepUpRegistry();

    // Act
    registry.grant(phone, NOW);

    // Assert
    should(registry.held(phoneOtherTab, NOW)).be.false();
    should(registry.held(laptop, NOW)).be.false();
  });

  it('should end every app session of a revoked device and no other device', () => {
    // Arrange
    const registry = new StepUpRegistry();
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
});
