import { describe, it } from 'bun:test';
import should from 'should';
import {
  applyWardenConfigPatch,
  assignedCooldownMs,
  defaultWardenConfig,
  MINIMUM_SUS_SECONDS,
  MINIMUM_SWEEP_INTERVAL_MS,
  MINIMUM_UNATTENDED_MS,
  parseStoredWardenConfig,
  parseWardenConfigPatch,
  resolveWardenLogin,
  spawnGapMs,
  sweepIntervalMs,
  unattendedWindowMs,
  type WardenConfig,
  wardenConfigWarnings,
  wardenDetectOptions,
} from '../../../src/lib/warden/index.ts';

const config = (overrides: Partial<WardenConfig> = {}): WardenConfig => ({ ...defaultWardenConfig, ...overrides });

describe('the shipped warden defaults', () => {
  it('should watch with rules only, so a fresh daemon never spends on its own', () => {
    // Arrange / Act / Assert
    should(defaultWardenConfig.enabled).be.true();
    should(defaultWardenConfig.triage).equal('rules');
    should(defaultWardenConfig.mayActAlone.stop).be.false();
  });

  it('should name no login at all, so the machine default decides at read time', () => {
    // Arrange / Act / Assert: a login name compiled in is somebody else's machine.
    should(defaultWardenConfig.accounts).deepEqual([]);
  });

  it('should cap the whole fleet at one live warden', () => {
    // Arrange / Act / Assert
    should(defaultWardenConfig.maxAssignedWardens).equal(1);
  });
});

describe('reading a persisted warden configuration', () => {
  it('should use the defaults without complaint when no document exists', () => {
    // Arrange / Act
    const actual = parseStoredWardenConfig(undefined);

    // Assert
    should(actual).deepEqual({ config: defaultWardenConfig, warnings: [] });
  });

  it('should treat an explicit null document as absent', () => {
    // Arrange / Act
    const actual = parseStoredWardenConfig(null);

    // Assert
    should(actual.warnings).be.empty();
  });

  it('should return a valid document verbatim', () => {
    // Arrange
    const stored = config({ enabled: true, intervalMinutes: 10 });

    // Act
    const actual = parseStoredWardenConfig(stored);

    // Assert
    should(actual).deepEqual({ config: stored, warnings: [] });
  });

  it('should fall back to the defaults and say so when the document does not validate', () => {
    // Arrange
    const stored = { ...defaultWardenConfig, intervalMinutes: 0 };

    // Act
    const actual = parseStoredWardenConfig(stored);

    // Assert
    should(actual.config).deepEqual(defaultWardenConfig);
    should(actual.warnings).have.length(1);
    should(actual.warnings[0]).match(/intervalMinutes/u);
  });

  it('should fall back to rules, so an unreadable document can never authorise a spawn', () => {
    // Arrange / Act
    const actual = parseStoredWardenConfig({ triage: 'llm' });

    // Assert
    should(actual.config.triage).equal('rules');
  });

  it('should name the whole document when the failure has no field path', () => {
    // Arrange / Act
    const actual = parseStoredWardenConfig('not an object at all');

    // Assert
    should(actual.warnings[0]).match(/document:/u);
  });
});

describe('applying an operator patch', () => {
  it('should merge the failover section rather than replacing it', () => {
    // Arrange / Act
    const actual = applyWardenConfigPatch(defaultWardenConfig, { failover: { policy: 'round_robin' } });

    // Assert
    should(actual.failover).deepEqual({
      policy: 'round_robin',
      failureThreshold: defaultWardenConfig.failover.failureThreshold,
      cooldownMinutes: defaultWardenConfig.failover.cooldownMinutes,
    });
  });

  it('should merge the provider-outage section rather than replacing it', () => {
    // Arrange / Act
    const actual = applyWardenConfigPatch(defaultWardenConfig, { providerOutage: { tailLines: 60 } });

    // Assert
    should(actual.providerOutage).deepEqual({
      minDistinctSessions: defaultWardenConfig.providerOutage.minDistinctSessions,
      persistenceSweeps: defaultWardenConfig.providerOutage.persistenceSweeps,
      tailLines: 60,
    });
  });

  it('should replace top-level fields the patch names', () => {
    // Arrange / Act
    const actual = applyWardenConfigPatch(defaultWardenConfig, { enabled: true, blessMinutes: 0 });

    // Assert
    should(actual.enabled).be.true();
    should(actual.blessMinutes).equal(0);
  });

  it('should refuse a merge that would produce a document the loader could not read back', () => {
    // Arrange / Act / Assert
    should(() => applyWardenConfigPatch(defaultWardenConfig, { accounts: [{ agent: '' }] })).throw();
  });

  it('should hand the login back to the machine default when the patch empties the order', () => {
    // Arrange
    const chosen = applyWardenConfigPatch(defaultWardenConfig, { accounts: [{ agent: 'a' }] });

    // Act
    const actual = applyWardenConfigPatch(chosen, { accounts: [] });

    // Assert
    should(actual.accounts).deepEqual([]);
  });

  it('should refuse a patch naming a field that does not exist', () => {
    // Arrange / Act / Assert
    should(() => parseWardenConfigPatch({ intervalMinuts: 5 })).throw();
  });

  it('should accept a patch an operator actually stated', () => {
    // Arrange / Act
    const actual = parseWardenConfigPatch({ enabled: true });

    // Assert
    should(actual).deepEqual({ enabled: true });
  });
});

describe('which login an investigation runs on', () => {
  it("should run on the owner's own order when they chose one", () => {
    // Arrange
    const subject = config({ accounts: [{ agent: 'a', model: 'm' }, { agent: 'b' }] });

    // Act
    const actual = resolveWardenLogin(subject, ['a', 'b', 'claude-default'], 'claude-default');

    // Assert
    should(actual).deepEqual({
      accounts: [{ agent: 'a', model: 'm' }, { agent: 'b' }],
      login: { source: 'configured', unknown: [], available: ['a', 'b', 'claude-default'] },
      usable: true,
    });
  });

  it('should stand in the machine default runtime when the owner chose none', () => {
    // Arrange / Act
    const actual = resolveWardenLogin(defaultWardenConfig, ['claude-default'], ' claude-default ');

    // Assert
    should(actual.accounts).deepEqual([{ agent: 'claude-default' }]);
    should(actual.login.source).equal('machine_default');
    should(actual.usable).be.true();
  });

  it('should say not set, and never invent a name, when the machine has no default either', () => {
    // Arrange / Act
    const actual = resolveWardenLogin(defaultWardenConfig, ['claude-default'], undefined);

    // Assert
    should(actual).deepEqual({
      accounts: [],
      login: { source: 'not_set', unknown: [], available: ['claude-default'] },
      usable: false,
    });
  });

  it('should treat a blank default runtime as none', () => {
    // Arrange / Act
    const actual = resolveWardenLogin(defaultWardenConfig, [], '  ');

    // Assert
    should(actual.login.source).equal('not_set');
  });

  it('should report a login written on another machine as unknown and leave it in place', () => {
    // Arrange: a warden.yaml from the old default.
    const subject = config({ accounts: [{ agent: 'legacy-wrapper' }] });

    // Act
    const actual = resolveWardenLogin(subject, ['claude-default'], 'claude-default');

    // Assert: no silent swap to the default — the owner chooses.
    should(actual.accounts).deepEqual([{ agent: 'legacy-wrapper' }]);
    should(actual.login).deepEqual({
      source: 'configured',
      unknown: ['legacy-wrapper'],
      available: ['claude-default'],
    });
    should(actual.usable).be.false();
  });

  it('should call a default runtime the inventory lacks unknown too', () => {
    // Arrange / Act
    const actual = resolveWardenLogin(defaultWardenConfig, ['other'], 'claude-default');

    // Assert
    should(actual.login.unknown).deepEqual(['claude-default']);
    should(actual.usable).be.false();
  });

  it('should condemn nobody when the inventory is unreadable', () => {
    // Arrange / Act
    const actual = resolveWardenLogin(config({ accounts: [{ agent: 'a' }] }), [], undefined);

    // Assert
    should(actual.login.unknown).be.empty();
    should(actual.usable).be.true();
  });
});

describe('what an operator is warned about', () => {
  const warningsFor = (subject: WardenConfig, installed: readonly string[], defaultRuntime?: string) =>
    wardenConfigWarnings(subject, resolveWardenLogin(subject, installed, defaultRuntime));

  it('should warn that the Warden is off while detection still runs', () => {
    // Arrange / Act
    const actual = warningsFor(config({ enabled: false }), ['claude-default'], 'claude-default');

    // Assert
    should(actual).matchAny(/the Warden is off/u);
  });

  it('should say nothing when an enabled configuration runs on an installed login', () => {
    // Arrange / Act
    const actual = warningsFor(config({ enabled: true }), ['claude-default'], 'claude-default');

    // Assert
    should(actual).be.empty();
  });

  it('should name an unknown login and say LLM triage is unavailable when it is the only one', () => {
    // Arrange / Act
    const actual = warningsFor(config({ enabled: true, accounts: [{ agent: 'legacy-wrapper' }] }), ['other']);

    // Assert
    should(actual).deepEqual([
      "unknown login 'legacy-wrapper' — choose one in Settings › Warden (it is skipped until it exists here)",
      'no investigation login exists on this machine, so LLM triage is unavailable',
    ]);
  });

  it('should not warn about anybody when the host inventory is unreadable', () => {
    // Arrange: an empty inventory is evidence about the host, never about an account.
    const actual = warningsFor(config({ enabled: true, accounts: [{ agent: 'a' }] }), []);

    // Assert
    should(actual).be.empty();
  });

  it('should warn when one of several logins is unknown without declaring total loss', () => {
    // Arrange
    const subject = config({ enabled: true, accounts: [{ agent: 'a' }, { agent: 'b' }] });

    // Act
    const actual = warningsFor(subject, ['a']);

    // Assert
    should(actual).deepEqual([
      "unknown login 'b' — choose one in Settings › Warden (it is skipped until it exists here)",
    ]);
  });

  it('should warn when no login is set and the machine has no default runtime', () => {
    // Arrange / Act
    const actual = warningsFor(config({ enabled: true }), ['a'], undefined);

    // Assert
    should(actual).deepEqual([
      'no investigation login is set and this machine has no default runtime, so LLM triage is unavailable — choose a login in Settings › Warden',
    ]);
  });
});

describe('the thresholds the detector reasons with', () => {
  it('should drive the idle-question and the stale-wreckage windows from one knob', () => {
    // Arrange / Act
    const actual = wardenDetectOptions(config({ unattendedMinutes: 45 }));

    // Assert
    should(actual.unattendedMs).equal(45 * 60_000);
    should(actual.terminalWindowMs).equal(actual.unattendedMs);
  });

  it('should floor the sus thresholds so a small number cannot flag every healthy think', () => {
    // Arrange / Act
    const actual = wardenDetectOptions(config({ susThinkingSeconds: 1, susSubprocessSeconds: 1 }));

    // Assert
    should(actual.susThinkingSeconds).equal(MINIMUM_SUS_SECONDS);
    should(actual.susSubprocessSeconds).equal(MINIMUM_SUS_SECONDS);
  });

  it('should keep configured sus thresholds above the floor', () => {
    // Arrange / Act
    const actual = wardenDetectOptions(config({ susThinkingSeconds: 1_200, susSubprocessSeconds: 1_800 }));

    // Assert
    should(actual.susThinkingSeconds).equal(1_200);
    should(actual.susSubprocessSeconds).equal(1_800);
  });

  it('should floor the unattended window at a minute', () => {
    // Arrange / Act / Assert
    should(unattendedWindowMs(config({ unattendedMinutes: 1 }))).equal(MINIMUM_UNATTENDED_MS);
  });
});

describe('the derived timings', () => {
  it.each([
    { label: 'a configured cadence', minutes: 5, expected: 5 * 60_000 },
    { label: 'a one-minute cadence floored', minutes: 1, expected: MINIMUM_SWEEP_INTERVAL_MS },
  ])('should turn $label into a sweep interval', ({ minutes, expected }) => {
    // Arrange / Act / Assert
    should(sweepIntervalMs(config({ intervalMinutes: minutes }))).equal(expected);
  });

  it('should allow a zero spawn gap, which means no rate limit', () => {
    // Arrange / Act / Assert
    should(spawnGapMs(config({ minSpawnGapMinutes: 0 }))).equal(0);
  });

  it('should convert a configured spawn gap to milliseconds', () => {
    // Arrange / Act / Assert
    should(spawnGapMs(config({ minSpawnGapMinutes: 15 }))).equal(15 * 60_000);
  });

  it('should allow a zero assigned cooldown', () => {
    // Arrange / Act / Assert
    should(assignedCooldownMs(config({ assignedCooldownMinutes: 0 }))).equal(0);
  });

  it('should convert a configured assigned cooldown to milliseconds', () => {
    // Arrange / Act / Assert
    should(assignedCooldownMs(config({ assignedCooldownMinutes: 30 }))).equal(30 * 60_000);
  });
});
