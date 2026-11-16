import { describe, it } from 'bun:test';
import should from 'should';
import type { StepUpSubject } from '@ferretry/core-gate/contract';
import {
  ChallengeLedger,
  StepUpRegistry,
  StepUpService,
  type StepUpServiceDeps,
} from '../../../../daemon/lib/step-up/index.ts';
import { stepUpProvider } from '../../../../daemon/step-up-provider.ts';
import { deviceId } from '../push/support.ts';

/**
 * `step-up:device` over the REAL chain: provider -> StepUpService -> StepUpRegistry. Gate's own tests stand a fake
 * witness in front of this, so only a test through the whole chain can tell whether `notAfterMs` survives each hop.
 */

const NOW = 1_700_000_000_000;
const phone: StepUpSubject = { deviceId: deviceId('a'), appSession: 'tab-one' };
/** The ports a claim never touches: any use of one fails loudly rather than answering. */
const unused = <T>(): T => new Proxy({}, { get: () => () => Promise.reject(new Error('unused port')) }) as T;

function chain() {
  const clock = { now: NOW };
  const registry = new StepUpRegistry({ nowMs: () => clock.now });
  registry.open(phone);
  const service = new StepUpService({
    store: unused<StepUpServiceDeps['store']>(),
    verifier: unused<StepUpServiceDeps['verifier']>(),
    registry,
    challenges: new ChallengeLedger(),
    random: { bytes: length => new Uint8Array(length) },
    clock: { nowMs: () => clock.now },
    devices: unused<StepUpServiceDeps['devices']>(),
    allowedOrigins: () => [],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    audit: unused<StepUpServiceDeps['audit']>(),
  });
  return { clock, registry, witness: stepUpProvider(() => service) };
}

describe('stepUpProvider (followups row 27)', () => {
  it('should refuse a proof made after the bound, leave it in place, and let a later bound take it (row 27)', () => {
    // Arrange — the owner proves a minute AFTER the instant a call was admitted.
    const { clock, registry, witness } = chain();
    clock.now = NOW + 60_000;
    registry.grant(phone, clock.now);

    // Act
    const boundedByAdmission = witness.claimFresh(phone, undefined, undefined, NOW);

    // Assert — the admission-bounded claim got nothing and spent nothing; a bound at the proof's own instant takes it.
    should(boundedByAdmission).be.false();
    should(registry.freshlyHeld(phone, clock.now)).be.true();
    should(witness.claimFresh(phone, undefined, undefined, NOW + 60_000)).be.true();
    should(registry.freshlyHeld(phone, clock.now)).be.false();
  });

  it('should take a proof made at or before the bound, once (row 27)', () => {
    // Arrange
    const { registry, witness } = chain();
    registry.grant(phone, NOW);

    // Act / Assert
    should(witness.claimFresh(phone, undefined, undefined, NOW)).be.true();
    should(witness.claimFresh(phone, undefined, undefined, NOW)).be.false();
  });

  it('should refuse every claim while no step-up service is open (row 27)', () => {
    // Arrange
    const witness = stepUpProvider(() => undefined);

    // Act / Assert
    should(witness.claimFresh(phone, undefined, undefined, NOW)).be.false();
    should(witness.unlockRequired(phone)).be.true();
  });
});
