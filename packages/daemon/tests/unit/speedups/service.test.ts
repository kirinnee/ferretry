import type { SpeedupTestResult } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AuthorizedOutcome,
  modelListCode,
  parseTestLedger,
  SecretStoreError,
  SPEEDUP_CATALOG,
  SPEEDUP_TEST_MESSAGES,
  SpeedupsService,
  type TriageDecision,
  testIsStale,
} from '../../../src/lib/index.ts';
import { FixedSecretNames, MemoryLedger, ScriptedAuthorizer, ScriptedTriageGuard, SteppingClock } from './fakes.ts';

/**
 * The Speed-ups service: "set" is a name lookup, and a Test spends a key once — through the outbound
 * holder for a model list, through the guard for Jev — and remembers the answer. Every port is a fake;
 * nothing here reaches a network.
 */

const NOW = '2026-10-16T10:00:00.000Z';

const passed = (provider: 'jev' | 'groq' | 'cerebras', at = '2026-10-15T00:00:00.000Z'): SpeedupTestResult => ({
  provider,
  secretName: SPEEDUP_CATALOG[provider].secretName,
  ok: true,
  code: 'ok',
  message: 'The key works.',
  latencyMs: 40,
  at,
});

function service(
  overrides: {
    outcome?: AuthorizedOutcome;
    names?: FixedSecretNames;
    ledger?: MemoryLedger;
    guard?: ScriptedTriageGuard;
  } = {},
) {
  const authorizer = new ScriptedAuthorizer(overrides.outcome ?? { kind: 'completion', payload: { data: [] } });
  const ledger = overrides.ledger ?? new MemoryLedger();
  const guard = overrides.guard ?? new ScriptedTriageGuard();
  const instance = new SpeedupsService({
    authorizer,
    secrets: overrides.names ?? new FixedSecretNames(),
    ledger,
    clock: new SteppingClock([1_000, 1_150], NOW),
    guard,
  });
  return { authorizer, ledger, guard, instance };
}

describe('the speed-ups view', () => {
  it('should list the three providers in order, set by name, with their last test', async () => {
    // Arrange
    const { instance } = service({
      names: new FixedSecretNames([
        { name: 'GROQ_API_KEY', updatedAt: '2026-10-14T00:00:00.000Z' },
        { name: 'UNRELATED', updatedAt: '2026-10-14T00:00:00.000Z' },
      ]),
      ledger: new MemoryLedger({ v: 1, results: { groq: passed('groq') } }),
    });

    // Act
    const actual = await instance.view();

    // Assert
    should(actual.vault).equal('ok');
    should(actual.providers.map(provider => [provider.provider, provider.set])).deepEqual([
      ['jev', false],
      ['groq', true],
      ['cerebras', false],
    ]);
    const groq = actual.providers[1];
    should(groq).containDeep({
      secretName: 'GROQ_API_KEY',
      secretUpdatedAt: '2026-10-14T00:00:00.000Z',
      lastTest: passed('groq'),
      testStale: false,
      keyUrl: 'https://console.groq.com/keys',
    });
    should(actual.providers[0]).not.have.property('lastTest');
    should(actual.providers[0]).not.have.property('secretUpdatedAt');
  });

  it('should say the vault is damaged rather than reporting every key unset without a reason', async () => {
    // Arrange
    const { instance } = service({ names: new FixedSecretNames(new SecretStoreError('unreadable', 'bad document')) });

    // Act
    const actual = await instance.view();

    // Assert
    should(actual.vault).equal('damaged');
    should(actual.providers.every(provider => !provider.set)).be.true();
  });

  it('should let an unexpected listing failure escape', async () => {
    // Arrange
    const { instance } = service({ names: new FixedSecretNames(new TypeError('defect')) });

    // Act & Assert
    await should(instance.view()).be.rejectedWith(TypeError);
  });
});

describe('a speed-up Test', () => {
  it('should list Groq models with the Groq key, GET only, and remember a pass', async () => {
    // Arrange
    const { authorizer, ledger, instance } = service();

    // Act
    const actual = await instance.test('groq');

    // Assert
    should(actual).deepEqual({
      provider: 'groq',
      secretName: 'GROQ_API_KEY',
      ok: true,
      code: 'ok',
      message: SPEEDUP_TEST_MESSAGES.ok,
      latencyMs: 150,
      at: NOW,
    });
    should(authorizer.calls).have.length(1);
    should(authorizer.calls[0]).containDeep({
      secretName: 'GROQ_API_KEY',
      hosts: ['api.groq.com'],
      request: { method: 'GET', url: 'https://api.groq.com/openai/v1/models' },
    });
    should(authorizer.calls[0]?.request).not.have.property('body');
    should(ledger.document).deepEqual({ v: 1, results: { groq: actual } });
  });

  it('should keep other providers’ results when it records a new one', async () => {
    // Arrange
    const ledger = new MemoryLedger({ v: 1, results: { jev: passed('jev') } });
    const { instance } = service({ ledger, outcome: { kind: 'status', status: 401 } });

    // Act
    const actual = await instance.test('cerebras');

    // Assert
    should(actual).containDeep({ ok: false, code: 'rejected', secretName: 'CEREBRAS_API_KEY' });
    should(ledger.document).deepEqual({ v: 1, results: { jev: passed('jev'), cerebras: actual } });
  });

  it('should test Jev through the guard with the made-up probe, never the outbound list call', async () => {
    // Arrange
    const guard = new ScriptedTriageGuard();
    const { authorizer, instance } = service({ guard });

    // Act
    const actual = await instance.test('jev');

    // Assert
    should(actual).containDeep({ provider: 'jev', ok: true, code: 'ok', secretName: 'JEV_API_KEY' });
    should(guard.seen.map(seen => seen.anomaly)).deepEqual(['connection_test']);
    should(authorizer.calls).be.empty();
  });

  it('should translate every guard failure into the code the Settings screen reads', async () => {
    // Arrange
    const failures = [
      ['not_set', 'not_set'],
      ['vault_damaged', 'vault_damaged'],
      ['rejected', 'rejected'],
      ['rate_limited', 'rate_limited'],
      ['overloaded', 'rate_limited'],
      ['timeout', 'timeout'],
      ['unreachable', 'unreachable'],
      ['malformed', 'malformed'],
      ['misconfigured', 'provider_error'],
      ['invalid_request', 'provider_error'],
      ['too_large', 'provider_error'],
      ['provider_error', 'provider_error'],
    ] as const;

    // Act
    const actual = await Promise.all(
      failures.map(async ([failure]) => {
        const decision: TriageDecision = {
          verdict: 'unsure',
          confidence: 0,
          model: 'jev-latest',
          inputTokens: 0,
          latencyMs: 1,
          failure: { code: failure },
        };
        return (await service({ guard: new ScriptedTriageGuard(decision) }).instance.test('jev')).code;
      }),
    );

    // Assert
    should(actual).deepEqual(failures.map(([, code]) => code));
  });

  it('should classify every model-list observation', () => {
    // Arrange
    const cases: [AuthorizedOutcome, string][] = [
      [{ kind: 'completion', payload: {} }, 'ok'],
      [{ kind: 'oversized' }, 'ok'],
      [{ kind: 'unreadable' }, 'malformed'],
      [{ kind: 'secret_missing' }, 'not_set'],
      [{ kind: 'vault_damaged' }, 'vault_damaged'],
      [{ kind: 'timeout' }, 'timeout'],
      [{ kind: 'unreachable' }, 'unreachable'],
      [{ kind: 'refused' }, 'provider_error'],
      [{ kind: 'status', status: 403 }, 'rejected'],
      [{ kind: 'status', status: 429 }, 'rate_limited'],
      [{ kind: 'status', status: 503 }, 'provider_error'],
    ];

    // Act
    const actual = cases.map(([outcome]) => modelListCode(outcome));

    // Assert
    should(actual).deepEqual(cases.map(([, code]) => code));
  });
});

describe('the test ledger', () => {
  it('should read back valid results and drop anything else', () => {
    // Act
    const actual = {
      absent: parseTestLedger(undefined),
      notObject: parseTestLedger('nope'),
      noResults: parseTestLedger({ v: 1 }),
      nullResults: parseTestLedger({ results: null }),
      mixed: parseTestLedger({
        results: { groq: passed('groq'), jev: { provider: 'jev' }, cerebras: passed('groq'), extra: passed('jev') },
      }),
    };

    // Assert
    should(actual).deepEqual({
      absent: {},
      notObject: {},
      noResults: {},
      nullResults: {},
      mixed: { groq: passed('groq') },
    });
  });

  it('should call a test stale only when the key changed after it', () => {
    // Act
    const actual = {
      newer: testIsStale(passed('groq', '2026-10-01T00:00:00.000Z'), '2026-10-02T00:00:00.000Z'),
      older: testIsStale(passed('groq', '2026-10-03T00:00:00.000Z'), '2026-10-02T00:00:00.000Z'),
      untested: testIsStale(undefined, '2026-10-02T00:00:00.000Z'),
      unset: testIsStale(passed('groq'), undefined),
    };

    // Assert
    should(actual).deepEqual({ newer: true, older: false, untested: false, unset: false });
  });
});
