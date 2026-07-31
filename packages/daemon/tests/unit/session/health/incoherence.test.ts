import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultSessionHealthSettings,
  emptyIncoherenceLedger,
  recordIncoherencePass,
  type IncoherencePass,
} from '../../../../src/lib/session/health/index.ts';

const SETTINGS = defaultSessionHealthSettings;

function pass(overrides: Partial<IncoherencePass> = {}): IncoherencePass {
  return { missingFromIndex: [], staleRows: [], zombies: [], repaired: [], unhealable: [], ...overrides };
}

describe('index incoherence ledger', () => {
  it('should stay silent on a pass that found nothing', () => {
    // Arrange
    const clean = pass();

    // Act
    const actual = recordIncoherencePass(emptyIncoherenceLedger, clean, SETTINGS);

    // Assert
    should(actual).deepEqual({ ledger: { consecutive: 0 }, escalate: false, event: undefined });
  });

  it('should not advance the streak for damage it successfully repaired', () => {
    // Arrange
    const healed = pass({ missingFromIndex: ['a', 'b'], repaired: ['a', 'b'] });

    // Act
    const actual = recordIncoherencePass({ consecutive: 2 }, healed, SETTINGS);

    // Assert
    should(actual.ledger.consecutive).equal(0);
    should(actual.escalate).be.false();
    should(actual.event?.data.repaired).deepEqual(['a', 'b']);
  });

  it('should advance the streak only on damage that survived repair', () => {
    // Arrange
    const resisted = pass({ missingFromIndex: ['a'], repaired: ['a'], unhealable: ['a'] });

    // Act
    const actual = recordIncoherencePass({ consecutive: 1 }, resisted, SETTINGS);

    // Assert
    should(actual.ledger.consecutive).equal(2);
    should(actual.escalate).be.false();
    // A "repair" the verification pass disproved is not reported as one.
    should(actual.event?.data.repaired).deepEqual([]);
  });

  it('should escalate once the streak reaches the configured threshold', () => {
    // Arrange
    const resisted = pass({ unhealable: ['a', 'b'] });

    // Act
    const actual = recordIncoherencePass({ consecutive: SETTINGS.incoherentRestartThreshold - 1 }, resisted, SETTINGS);

    // Assert
    should(actual.ledger.consecutive).equal(SETTINGS.incoherentRestartThreshold);
    should(actual.escalate).be.true();
  });

  it('should announce the one clean pass that clears a degrading streak', () => {
    // Arrange
    const clean = pass();

    // Act
    const actual = recordIncoherencePass({ consecutive: 2 }, clean, SETTINGS);

    // Assert
    should(actual.ledger.consecutive).equal(0);
    should(actual.event?.type).equal('fleet.index_incoherent');
    should(actual.event?.data.recovered).be.true();
  });

  it('should report every category of damage it found', () => {
    // Arrange
    const damaged = pass({ staleRows: ['s'], zombies: ['z'], unhealable: ['u'] });

    // Act
    const actual = recordIncoherencePass(emptyIncoherenceLedger, damaged, SETTINGS);

    // Assert
    should(actual.event?.data).deepEqual({
      missingFromIndex: [],
      staleRows: ['s'],
      zombies: ['z'],
      repaired: [],
      unhealable: ['u'],
      consecutive: 1,
      recovered: false,
    });
  });
});
