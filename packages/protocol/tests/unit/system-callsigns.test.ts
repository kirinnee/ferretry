import { describe, it } from 'bun:test';
import should from 'should';
import {
  displaySystemCallsign,
  isSystemCallsign,
  nextSystemCallsignSequence,
  SYSTEM_CALLSIGN_MAX_SEQUENCE,
  SYSTEM_CALLSIGN_PREFIXES,
  systemCallsignName,
  systemCallsignSequence,
} from '../../src/lib/system-callsigns.ts';

describe('system callsigns', () => {
  it('should name a session of every prefix with six hex digits, stored lowercase', () => {
    // Act + Assert
    should(SYSTEM_CALLSIGN_PREFIXES).deepEqual(['warden', 'learning', 'pack']);
    should(systemCallsignName('warden', 42)).equal('warden-00002a');
    should(systemCallsignName('learning', 42)).equal('learning-00002a');
    should(systemCallsignName('pack', 1)).equal('pack-000001');
    should(systemCallsignName('pack', SYSTEM_CALLSIGN_MAX_SEQUENCE)).equal('pack-ffffff');
  });

  it('should read the sequence back only for its own prefix', () => {
    // Act + Assert
    should(systemCallsignSequence('learning', 'learning-00002a')).equal(42);
    should(systemCallsignSequence('learning', 'Learning-00002A')).equal(42);
    should(systemCallsignSequence('learning', 'pack-00002a')).be.undefined();
    should(systemCallsignSequence('pack', 'learning-00002a')).be.undefined();
    should(systemCallsignSequence('pack', 'pack-000000')).be.undefined();
    should(systemCallsignSequence('pack', undefined)).be.undefined();
  });

  it('should recognise every prefix and never a pool name or a near miss', () => {
    // Act + Assert
    for (const name of ['warden-000001', 'learning-00002a', 'pack-ABCDEF']) should(isSystemCallsign(name)).be.true();
    for (const other of [
      'pack',
      'hadi',
      'pack-1',
      'pack-0000001',
      'pack-00000g',
      'pack-000000',
      'other-000001',
      undefined,
    ])
      should(isSystemCallsign(other)).be.false();
  });

  it('should show the hex digits uppercase for every prefix and leave any other name alone', () => {
    // Act + Assert
    should(displaySystemCallsign('learning-00002a')).equal('learning-00002A');
    should(displaySystemCallsign('pack-00002a')).equal('pack-00002A');
    should(displaySystemCallsign('warden-00002a')).equal('warden-00002A');
    should(displaySystemCallsign('hadi')).equal('hadi');
  });

  it('should count on, wrap after FFFFFF to 1, and step past ids still in use', () => {
    // Act + Assert
    should(nextSystemCallsignSequence(0, new Set())).equal(1);
    should(nextSystemCallsignSequence(41, new Set([42, 43]))).equal(44);
    should(nextSystemCallsignSequence(SYSTEM_CALLSIGN_MAX_SEQUENCE, new Set())).equal(1);
    should(
      nextSystemCallsignSequence(SYSTEM_CALLSIGN_MAX_SEQUENCE - 1, new Set([SYSTEM_CALLSIGN_MAX_SEQUENCE, 1])),
    ).equal(2);
    should(nextSystemCallsignSequence(-5, new Set())).equal(1);
  });

  it('should give no id when every one is in use', () => {
    // Arrange: a set that holds every id, without building one of 16,777,215 entries
    const everyId: ReadonlySet<number> = { has: () => true } as unknown as ReadonlySet<number>;

    // Act
    const next = nextSystemCallsignSequence(41, everyId);

    // Assert
    should(next).be.undefined();
  });
});
