import { describe, it } from 'bun:test';
import should from 'should';
import {
  applyWardenConfigPatch,
  assignedCooldownMs,
  DEFAULT_WARDEN_ACCOUNT,
  defaultWardenConfig,
  MINIMUM_SUS_SECONDS,
  MINIMUM_SWEEP_INTERVAL_MS,
  MINIMUM_UNATTENDED_MS,
  parseStoredWardenConfig,
  parseWardenConfigPatch,
  spawnGapMs,
  sweepIntervalMs,
  unattendedWindowMs,
  wardenAccountsOf,
  wardenConfigWarnings,
  wardenDetectOptions,
  type WardenConfig,
} from '../../../src/lib/warden/index.ts';

const config = (overrides: Partial<WardenConfig> = {}): WardenConfig => ({ ...defaultWardenConfig, ...overrides });

describe('the shipped warden defaults', () => {
  it('should leave escalation off so a fresh daemon never spends agent sessions on its own', () => {
    // Arrange / Act / Assert
    should(defaultWardenConfig.enabled).be.false();
  });

  it('should configure exactly one triage-tier account with no pinned model', () => {
    // Arrange / Act
    const accounts = wardenAccountsOf(defaultWardenConfig);

    // Assert
    should(accounts).deepEqual([{ agent: DEFAULT_WARDEN_ACCOUNT }]);
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
    const stored = config({ enabled: true, intervalMinutes: 11 });

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

  it('should disable escalation when it falls back, so an unreadable document can never authorise a spawn', () => {
    // Arrange / Act
    const actual = parseStoredWardenConfig({ enabled: true });

    // Assert
    should(actual.config.enabled).be.false();
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
    should(() => applyWardenConfigPatch(defaultWardenConfig, { accounts: [] })).throw();
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

describe('what an operator is warned about', () => {
  it('should warn that escalation is off while detection still runs', () => {
    // Arrange / Act
    const actual = wardenConfigWarnings(config(), [DEFAULT_WARDEN_ACCOUNT]);

    // Assert
    should(actual).matchAny(/escalation is disabled/u);
  });

  it('should say nothing when an enabled configuration names an installed account', () => {
    // Arrange / Act
    const actual = wardenConfigWarnings(config({ enabled: true }), [DEFAULT_WARDEN_ACCOUNT]);

    // Assert
    should(actual).be.empty();
  });

  it('should warn about an account this host does not have', () => {
    // Arrange / Act
    const actual = wardenConfigWarnings(config({ enabled: true }), ['some-other-agent']);

    // Assert
    should(actual).matchAny(/is not installed on this host/u);
    should(actual).matchAny(/every configured warden account is missing/u);
  });

  it('should not warn about anybody when the host inventory is unreadable', () => {
    // Arrange: an empty inventory is evidence about the host, never about an account.
    const actual = wardenConfigWarnings(config({ enabled: true }), []);

    // Assert
    should(actual).be.empty();
  });

  it('should warn when one of several accounts is missing without declaring total loss', () => {
    // Arrange
    const subject = config({ enabled: true, accounts: [{ agent: 'a' }, { agent: 'b' }] });

    // Act
    const actual = wardenConfigWarnings(subject, ['a']);

    // Assert
    should(actual).deepEqual(['account b is not installed on this host (it will be skipped until it appears)']);
  });

  it('should warn when no account is configured at all', () => {
    // Arrange: only reachable by bypassing the schema, which the loader never does.
    const subject = { ...defaultWardenConfig, enabled: true, accounts: [] } as WardenConfig;

    // Act
    const actual = wardenConfigWarnings(subject, ['a']);

    // Assert
    should(actual).deepEqual(['no warden accounts are configured, so no check can ever run']);
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
