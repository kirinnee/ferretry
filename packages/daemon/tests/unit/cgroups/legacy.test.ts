import { describe, it } from 'bun:test';
import { LimitsFileSchema } from '@ferretry/protocol';
import should from 'should';
import { LegacyLimitsMigration, type LegacyLimitsPorts, legacyLimitsFile } from '../../../src/lib/cgroups/index.ts';

const OLD_DEFAULTS = {
  enabled: true,
  fleet: { cpuPercent: 90, memoryPercent: 90 },
  perAgent: { cpuPercent: 25, memoryPercent: 25 },
};

describe('what the retired cgroups/config.json means as limits.yaml', () => {
  it('should keep an explicit on, and carry none of the old defaults (they are computed now)', () => {
    // Arrange / Act
    const actual = legacyLimitsFile(OLD_DEFAULTS);

    // Assert
    should(actual).deepEqual({ enabled: true });
  });

  it('should keep an explicit off', () => {
    // Arrange / Act
    const actual = legacyLimitsFile({ ...OLD_DEFAULTS, enabled: false });

    // Assert
    should(actual).deepEqual({ enabled: false });
  });

  it('should carry a share the operator changed, as a percent of the budget, and a CPU share as a share', () => {
    // Arrange
    const old = {
      enabled: true,
      fleet: { cpuPercent: 50, memoryPercent: 70 },
      perAgent: { cpuPercent: 10, memoryPercent: 20 },
    };

    // Act
    const actual = legacyLimitsFile(old);

    // Assert
    should(actual).deepEqual({
      enabled: true,
      fleet: { memoryMax: '70%', cpuPercent: 50 },
      perFerret: { memoryMax: '20%', cpuPercent: 10 },
    });
    should(LimitsFileSchema.safeParse(actual).success).equal(true);
  });

  it('should not recognise a document that is not the old shape', () => {
    // Arrange / Act / Assert
    should(legacyLimitsFile({ enabled: 'yes' })).equal(undefined);
    should(legacyLimitsFile('{ broken')).equal(undefined);
    should(legacyLimitsFile(null)).equal(undefined);
  });
});

describe('the one-time move', () => {
  function subject(old: unknown, existing: { exists: boolean; text?: string } = { exists: false }) {
    const writes: string[] = [];
    let retired = 0;
    const ports: LegacyLimitsPorts = {
      readOld: async () => old,
      readLimits: async () => ({ exists: existing.exists, text: existing.text ?? '', etag: 'etag-1' }),
      writeLimits: async text => void writes.push(text),
      retireOld: async () => {
        retired += 1;
      },
    };
    return { migration: new LegacyLimitsMigration(ports), writes, retired: () => retired };
  }

  it('should write limits.yaml with its schema line and put the old file away', async () => {
    // Arrange
    const { migration, writes, retired } = subject({ ...OLD_DEFAULTS, fleet: { cpuPercent: 90, memoryPercent: 70 } });

    // Act
    const actual = await migration.run();

    // Assert
    should(actual.outcome).equal('migrated');
    should(writes).have.length(1);
    should(writes[0]).match(/^# yaml-language-server: \$schema=\.schema\/limits\.json/mu);
    should(writes[0]).match(/enabled: true/u);
    should(writes[0]).match(/memoryMax: 70%/u);
    should(retired()).equal(1);
  });

  it('should do nothing when there is no old document', async () => {
    // Arrange
    const { migration, writes, retired } = subject(undefined);

    // Act
    const actual = await migration.run();

    // Assert
    should(actual.outcome).equal('nothing');
    should(writes).deepEqual([]);
    should(retired()).equal(0);
  });

  it('should leave a document it does not understand exactly where it is, and say so', async () => {
    // Arrange
    const { migration, writes, retired } = subject({ something: 'else' });

    // Act
    const actual = await migration.run();

    // Assert
    should(actual.outcome).equal('kept');
    should(writes).deepEqual([]);
    should(retired()).equal(0);
  });

  it('should never overwrite a limits.yaml that already exists: it is the operator’s newer word', async () => {
    // Arrange
    const { migration, writes, retired } = subject(OLD_DEFAULTS, { exists: true, text: 'enabled: false\n' });

    // Act
    const actual = await migration.run();

    // Assert
    should(actual.outcome).equal('migrated');
    should(writes).deepEqual([]);
    should(retired()).equal(1);
  });
});
