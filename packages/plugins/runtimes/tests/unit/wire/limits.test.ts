import { describe, it } from 'bun:test';
import should from 'should';
import { classifyConfigPath, configFilePath } from '../../src/lib/config-files.ts';
import {
  DEFAULT_LIMITS_CONFIG,
  GIBIBYTE,
  LimitsFileSchema,
  limitsLoosening,
  parseLimitSize,
  reserveBytes,
  resolveLimits,
} from '../../src/lib/limits.ts';

/** The measured box: 61 GiB of RAM, a 48 GiB `MemoryHigh` on the user slice above the daemon, 32 cores. */
const THIS_BOX = { memoryCeilingBytes: 48 * GIBIBYTE };
const gib = (bytes: number | null): number | null =>
  bytes === null ? null : Math.round((bytes / GIBIBYTE) * 100) / 100;

describe('parseLimitSize', () => {
  it.each([
    ['40G', { kind: 'bytes', bytes: 40 * GIBIBYTE }],
    ['512M', { kind: 'bytes', bytes: 512 * 1024 ** 2 }],
    ['1.5 GiB', { kind: 'bytes', bytes: 1.5 * GIBIBYTE }],
    ['25%', { kind: 'percent', percent: 25 }],
    ['infinity', { kind: 'unlimited' }],
    [4096, { kind: 'bytes', bytes: 4096 }],
  ] as const)('should read %p', (written, expected) => {
    // Arrange / Act
    const actual = parseLimitSize(written);
    // Assert
    should(actual).deepEqual(expected);
  });

  it.each(['', 'lots', '0G', '101%', '-5G', '12 parsecs', 0, -1, 1.5])('should refuse %p', written => {
    // Arrange / Act
    const actual = parseLimitSize(written);
    // Assert
    should(actual).equal(undefined);
  });
});

describe('resolveLimits: the worked example for this box (48 GiB budget, 61 GiB RAM, 32 cores; the fixed 4 GiB reserve)', () => {
  it('should reserve a fixed 4 GiB, whatever the budget', () => {
    // Arrange / Act
    const actual = reserveBytes(48 * GIBIBYTE);
    // Assert
    should(gib(actual)).equal(4);
    should(gib(reserveBytes(128 * GIBIBYTE))).equal(4);
  });

  it('should compute every default from the budget', () => {
    // Arrange / Act
    const actual = resolveLimits(DEFAULT_LIMITS_CONFIG, THIS_BOX);
    // Assert
    should(actual.enabled).equal(true);
    should(actual.ionice).equal(true);
    should(actual.fleet.cpuWeight).equal(50);
    should(gib(actual.fleet.memoryHigh)).equal(44);
    should(gib(actual.fleet.memoryMax)).equal(46);
    should(gib(actual.fleet.swapMax)).equal(4.8);
    should(actual.fleet.tasksMax).equal(16_384);
    should(actual.fleet.cpuPercent).equal(null);
    should(gib(actual.perFerret.memoryHigh)).equal(12);
    should(gib(actual.perFerret.memoryMax)).equal(14.4);
    should(actual.perFerret.tasksMax).equal(4_096);
    should(actual.perFerret.cpuWeight).equal(100);
    should(actual.perFerret.interactiveCpuWeight).equal(200);
    should(actual.perFerret.cpuPercent).equal(null);
  });

  it('should reserve 4 GiB, and never more than half a small budget', () => {
    // Arrange / Act
    const sixteen = reserveBytes(16 * GIBIBYTE);
    const four = reserveBytes(4 * GIBIBYTE);
    // Assert
    should(sixteen).equal(4 * GIBIBYTE);
    should(four).equal(2 * GIBIBYTE);
  });

  it('should let a written value win, as bytes, a size or a percent of the budget', () => {
    // Arrange
    const config = LimitsFileSchema.parse({
      fleet: { memoryHigh: '30G', memoryMax: '80%', swapMax: 1024, cpuPercent: 50, cpuWeight: 30 },
      perFerret: { memoryHigh: '10%', tasksMax: 'infinity' },
    });
    // Act
    const actual = resolveLimits(config, THIS_BOX);
    // Assert
    should(gib(actual.fleet.memoryHigh)).equal(30);
    should(gib(actual.fleet.memoryMax)).equal(38.4);
    should(actual.fleet.swapMax).equal(1024);
    should(actual.fleet.cpuPercent).equal(50);
    should(actual.fleet.cpuWeight).equal(30);
    should(gib(actual.perFerret.memoryHigh)).equal(4.8);
    should(actual.perFerret.tasksMax).equal(null);
  });

  it('should say so and use the hard limit when a soft limit is written above it', () => {
    // Arrange
    const config = LimitsFileSchema.parse({ perFerret: { memoryHigh: '50%', memoryMax: '20%' } });
    // Act
    const actual = resolveLimits(config, THIS_BOX);
    // Assert
    should(actual.perFerret.memoryHigh).equal(actual.perFerret.memoryMax);
    should(actual.warnings.length).equal(1);
  });
});

describe('LimitsFileSchema', () => {
  it('should accept an empty file, and refuse a key it does not know', () => {
    // Arrange / Act
    const empty = LimitsFileSchema.safeParse({});
    const unknown = LimitsFileSchema.safeParse({ fleet: { memoryHi: '1G' } });
    // Assert
    should(empty.success).equal(true);
    should(unknown.success).equal(false);
  });

  it('should refuse a size that is not one', () => {
    // Arrange / Act
    const actual = LimitsFileSchema.safeParse({ fleet: { memoryMax: 'lots' } });
    // Assert
    should(actual.success).equal(false);
  });
});

describe('limitsLoosening', () => {
  const ceiling = 48 * GIBIBYTE;
  const file = (value: unknown) => LimitsFileSchema.parse(value);

  it('should hold switching limits off', () => {
    // Arrange / Act
    const actual = limitsLoosening({}, file({ enabled: false }), ceiling);
    // Assert
    should(actual.length).equal(1);
    should(actual[0]).match(/switched off/u);
  });

  it('should not hold switching them off again, or on', () => {
    // Arrange / Act
    const again = limitsLoosening(file({ enabled: false }), file({ enabled: false }), ceiling);
    const on = limitsLoosening(file({ enabled: false }), {}, ceiling);
    // Assert
    should(again).deepEqual([]);
    should(on).deepEqual([]);
  });

  it('should hold turning disk priority off, and not turning it on', () => {
    // Arrange / Act
    const off = limitsLoosening({}, file({ ionice: false }), ceiling);
    const on = limitsLoosening(file({ ionice: false }), file({ ionice: true }), ceiling);
    // Assert
    should(off.length).equal(1);
    should(on).deepEqual([]);
  });

  it('should hold a cap raised above the computed default, and let one lowered below it through', () => {
    // Arrange / Act
    const raised = limitsLoosening({}, file({ fleet: { memoryMax: '47G' } }), ceiling);
    const lowered = limitsLoosening({}, file({ fleet: { memoryMax: '30G' } }), ceiling);
    // Assert
    should(raised.length).equal(1);
    should(raised[0]).match(/hard memory limit for all ferrets/u);
    should(lowered).deepEqual([]);
  });

  it('should compare percents and unparsable values without a budget: only a provably smaller edit passes', () => {
    // Arrange
    const percent = (value: string) => file({ fleet: { memoryMax: value } });

    // Act / Assert
    should(limitsLoosening(percent('50%'), percent('60%')).length).equal(1);
    should(limitsLoosening(percent('60%'), percent('50%'))).deepEqual([]);
    const lots = { fleet: { memoryMax: 'lots' } } as never;
    const many = { fleet: { memoryMax: 'many' } } as never;
    should(limitsLoosening(lots, many)).deepEqual([]);
  });

  it('should hold taking a cap away', () => {
    // Arrange
    const before = file({ perFerret: { tasksMax: 100 } });
    // Act
    const actual = limitsLoosening(before, {}, ceiling);
    // Assert
    should(actual.length).equal(1);
    should(actual[0]).match(/processes each ferret/u);
  });

  it('should hold raising a weight, and a quota being lifted, but not setting one', () => {
    // Arrange / Act
    const weight = limitsLoosening({}, file({ fleet: { cpuWeight: 80 } }), ceiling);
    const lifted = limitsLoosening(file({ fleet: { cpuPercent: 50 } }), {}, ceiling);
    const set = limitsLoosening({}, file({ fleet: { cpuPercent: 50 } }), ceiling);
    // Assert
    should(weight.length).equal(1);
    should(lifted.length).equal(1);
    should(set).deepEqual([]);
  });

  it('should compare a percent with bytes by what each means on this machine', () => {
    // Arrange
    const before = file({ perFerret: { memoryHigh: '10G' } });
    // Act
    const tighter = limitsLoosening(before, file({ perFerret: { memoryHigh: '10%' } }), ceiling);
    const looser = limitsLoosening(before, file({ perFerret: { memoryHigh: '25%' } }), ceiling);
    // Assert
    should(tighter).deepEqual([]);
    should(looser.length).equal(1);
  });

  describe('without the budget (fy config check on another host)', () => {
    it('should pass only edits that are provably not looser', () => {
      // Arrange / Act
      const sameUnitLower = limitsLoosening(
        file({ fleet: { memoryMax: '40G' } }),
        file({ fleet: { memoryMax: '30G' } }),
      );
      const sameUnitHigher = limitsLoosening(
        file({ fleet: { memoryMax: '30G' } }),
        file({ fleet: { memoryMax: '40G' } }),
      );
      const unitChanged = limitsLoosening(file({ fleet: { memoryMax: '30G' } }), file({ fleet: { memoryMax: '50%' } }));
      const backToDefault = limitsLoosening(file({ fleet: { memoryMax: '30G' } }), {});
      const newCap = limitsLoosening({}, file({ fleet: { memoryMax: '30G' } }));
      const noCap = limitsLoosening({}, file({ fleet: { memoryMax: 'infinity', swapMax: 'infinity' } }));
      const underDefaultPercent = limitsLoosening({}, file({ perFerret: { memoryMax: '20%' } }));
      const overDefaultPercent = limitsLoosening({}, file({ perFerret: { memoryMax: '40%' } }));
      // Assert
      should(sameUnitLower).deepEqual([]);
      should(sameUnitHigher.length).equal(1);
      should(unitChanged.length).equal(1);
      should(backToDefault.length).equal(1);
      should(newCap.length).equal(1);
      should(noCap.length).equal(2);
      should(underDefaultPercent).deepEqual([]);
      should(overDefaultPercent.length).equal(1);
    });
  });
});

describe('limits.yaml as a configuration file', () => {
  it('should live at the top of the config directory and classify back', () => {
    // Arrange / Act
    const path = configFilePath({ kind: 'limits' });
    // Assert
    should(path).equal('limits.yaml');
    should(classifyConfigPath(path)).deepEqual({ kind: 'limits' });
  });
});
