import { describe, it } from 'bun:test';
import should from 'should';
import { UnimplementedFleetCapabilityError, unimplementedCapabilities } from '../../src/lib/capabilities.ts';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-00000000c1a1';

const config = (patch: Record<string, unknown> = {}): FleetConfig =>
  FleetConfigSchema.parse({
    agents: [
      {
        name: 'work',
        kind: 'claude',
        routes: {
          default: {
            id: ID_CLAUDE,
            wrapper: 'fy-claude-work',
            home: '~/.claude-work',
            defaultModel: 'opus',
            models: ['opus'],
          },
        },
      },
    ],
    ...patch,
  });

const keysOf = (value: FleetConfig): readonly string[] => unimplementedCapabilities(value).map(item => item.key);

describe('unimplementedCapabilities', () => {
  it('should report nothing for a configuration that carries only defaults', () => {
    // Act
    const actual = unimplementedCapabilities(config());

    // Assert — every one of these sections parses; none of them is a request.
    should(actual).deepEqual([]);
  });

  it('should report nothing when the sections are present but disabled', () => {
    // Act
    const actual = keysOf(
      config({
        sharedHistory: { claude: false, codex: false },
        health: { enabled: false, interval: 300, concurrency: 8, timeout: 90 },
        usage: { enabled: true, interval: 60, jitter: 0.25, concurrency: 6, timeout: 15, cliProxy: [] },
      }),
    );

    // Assert
    should(actual).deepEqual([]);
  });

  it('should not report shared history now that both harness pools are implemented', () => {
    // Act
    const claude = keysOf(config({ sharedHistory: { claude: true } }));
    const codex = keysOf(config({ sharedHistory: { codex: true } }));

    // Assert
    should(claude).deepEqual([]);
    should(codex).deepEqual([]);
  });

  it('should refuse a declared CLIProxy source', () => {
    // Act
    const actual = keysOf(
      config({
        usage: {
          cliProxy: [{ url: 'http://127.0.0.1:8317', managementKey: '$FY_TEST_KEY', accounts: [ID_CLAUDE] }],
        },
      }),
    );

    // Assert
    should(actual).deepEqual(['usage.cliProxy']);
  });

  it('should refuse background health probing and unspreadable probes together', () => {
    // Act
    const actual = keysOf(config({ health: { enabled: true }, usage: { jitter: 0.5 } }));

    // Assert — reported together, so one apply tells the operator everything to fix.
    should(actual).deepEqual(['health.enabled', 'usage.jitter']);
  });

  it('should accept a declared re-probe interval, which the daemon feed now runs on', () => {
    // Act — the one name for that cadence. The daemon's own `usage.refreshSeconds` is gone.
    const actual = keysOf(config({ usage: { interval: 900 } }));

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('UnimplementedFleetCapabilityError', () => {
  it('should name every offending key, what it would do, and what happens instead', () => {
    // Arrange
    const capabilities = unimplementedCapabilities(config({ health: { enabled: true }, usage: { jitter: 0.5 } }));

    // Act
    const actual = new UnimplementedFleetCapabilityError(capabilities);

    // Assert
    should(actual.name).equal('UnimplementedFleetCapabilityError');
    should(actual.capabilities).have.length(2);
    should(actual.message).match(/capabilities this build does not implement/);
    should(actual.message).match(/health\.enabled —/);
    should(actual.message).match(/usage\.jitter —/);
    should(actual.message).match(/refused rather than ignored/);
  });

  it('should say "a capability" when only one key offends', () => {
    // Act
    const actual = new UnimplementedFleetCapabilityError(
      unimplementedCapabilities(config({ health: { enabled: true } })),
    );

    // Assert
    should(actual.message).match(/asks for a capability this build does not implement/);
  });
});
