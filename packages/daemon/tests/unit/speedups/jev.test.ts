import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AuthorizedOutcome,
  boundedTriageState,
  buildJevRequestBody,
  JevTriageGuard,
  parseJevReply,
  TRIAGE_CRITERIA,
  TRIAGE_INSTRUCTIONS,
  TRIAGE_LIMITS,
  type TriageSnapshot,
  triageDecision,
  triageFailureForStatus,
} from '../../../src/lib/index.ts';
import { ScriptedAuthorizer, SteppingClock } from './fakes.ts';

/**
 * Jev as the Warden's triage guard. The rule every case defends: the guard never acts, and anything
 * that is not a confident, readable `skip` is an investigation.
 */

const snapshot: TriageSnapshot = {
  anomaly: 'unattended_question',
  summary: 'A question has been waiting for 12 minutes.',
  facts: { waitingMinutes: 12, hasMonitor: false, harness: 'claude' },
  recentTurns: ['user: run the tests', 'assistant: should I also update snapshots?'],
  paneTail: 'Do you want to proceed? (y/n)',
};

const reply = (choice: string, extra: Record<string, unknown> = {}): AuthorizedOutcome => ({
  kind: 'completion',
  payload: {
    model: 'jev-2026-09',
    answers: { triage: { type: 'choice', choice, probabilities: { skip: 0.9, investigate: 0.1 }, confidence: 0.9 } },
    usage: { input_tokens: 400, output_tokens: 1 },
    ...extra,
  },
});

const context = { model: 'jev-latest', latencyMs: 75 };

describe('the Jev request', () => {
  it('should ask one choice question with skip and investigate as the only options', () => {
    // Act
    const actual = buildJevRequestBody(snapshot, 'jev-latest');

    // Assert
    should(actual.model).equal('jev-latest');
    should(actual.questions).deepEqual({
      triage: { type: 'choice', instructions: TRIAGE_INSTRUCTIONS, criteria: TRIAGE_CRITERIA },
    });
    should(Object.keys(TRIAGE_CRITERIA)).deepEqual(['skip', 'investigate']);
    should(actual.state).deepEqual(boundedTriageState(snapshot));
  });

  it('should bound every part of the snapshot, keeping the newest turns and tails', () => {
    // Arrange
    const huge: TriageSnapshot = {
      anomaly: 'loop',
      summary: `${'s'.repeat(TRIAGE_LIMITS.maxSummaryChars)}END`,
      facts: Object.fromEntries(
        Array.from({ length: TRIAGE_LIMITS.maxFacts + 5 }, (_, index) => [`f${index}`, 'v'.repeat(500)]),
      ),
      recentTurns: Array.from(
        { length: TRIAGE_LIMITS.maxTurns + 3 },
        (_, index) => `turn ${index} ${'x'.repeat(2_000)}`,
      ),
    };

    // Act
    const actual = boundedTriageState(huge) as {
      summary: string;
      facts: Record<string, string>;
      recentTurns: string[];
      paneTail?: string;
    };

    // Assert
    should(actual.summary.length).equal(TRIAGE_LIMITS.maxSummaryChars);
    should(actual.summary.endsWith('END')).be.true();
    should(Object.keys(actual.facts)).have.length(TRIAGE_LIMITS.maxFacts);
    should(actual.facts.f0?.length).equal(TRIAGE_LIMITS.maxFactChars);
    should(actual.recentTurns).have.length(TRIAGE_LIMITS.maxTurns);
    should(actual.recentTurns.every(turn => turn.length === TRIAGE_LIMITS.maxTurnChars)).be.true();
    should(actual).not.have.property('paneTail');
    should((boundedTriageState({ ...huge, paneTail: 'p'.repeat(9_000) }) as { paneTail: string }).paneTail).have.length(
      TRIAGE_LIMITS.maxPaneTailChars,
    );
  });
});

describe('reading a Jev reply', () => {
  it('should read the choice, confidence, model and input tokens', () => {
    // Act
    const actual = parseJevReply((reply('skip') as { payload: unknown }).payload);

    // Assert
    should(actual).deepEqual({ choice: 'skip', confidence: 0.9, model: 'jev-2026-09', inputTokens: 400 });
  });

  it('should fall back to the chosen probability, and refuse an answer with neither', () => {
    // Act
    const actual = {
      probability: parseJevReply({
        answers: { triage: { choice: 'investigate', probabilities: { investigate: 0.6 } } },
      }),
      neither: parseJevReply({ answers: { triage: { choice: 'skip' } } }),
      outOfRange: parseJevReply({ answers: { triage: { choice: 'skip', confidence: 1.5 } } }),
    };

    // Assert
    should(actual.probability).deepEqual({ choice: 'investigate', confidence: 0.6, inputTokens: 0 });
    should(actual.neither).be.undefined();
    should(actual.outOfRange).be.undefined();
  });

  it('should refuse anything that is not a triage answer', () => {
    // Act
    const actual = [
      parseJevReply(null),
      parseJevReply([]),
      parseJevReply({ answers: [] }),
      parseJevReply({ answers: { other: {} } }),
      parseJevReply({ answers: { triage: { choice: 3 } } }),
    ];

    // Assert
    should(actual.every(answer => answer === undefined)).be.true();
  });

  it('should treat a malformed usage block as zero tokens rather than a guess', () => {
    // Act
    const actual = parseJevReply({
      answers: { triage: { choice: 'skip', confidence: 0.8 } },
      usage: { input_tokens: -2 },
    });

    // Assert
    should(actual?.inputTokens).equal(0);
  });
});

describe('the triage decision', () => {
  it('should skip only on an explicit skip, carrying its confidence and the reported model', () => {
    // Act
    const actual = triageDecision(reply('skip'), context);

    // Assert
    should(actual).deepEqual({
      verdict: 'skip',
      confidence: 0.9,
      model: 'jev-2026-09',
      inputTokens: 400,
      latencyMs: 75,
    });
  });

  it('should investigate on investigate, and on an option it never offered with zero confidence', () => {
    // Act
    const actual = {
      investigate: triageDecision(reply('investigate'), context),
      unknown: triageDecision(reply('kill'), context),
    };

    // Assert
    should(actual.investigate.verdict).equal('investigate');
    should(actual.investigate.confidence).equal(0.9);
    should(actual.unknown).containDeep({ verdict: 'investigate', confidence: 0 });
  });

  it('should price a decision only when a price was configured', () => {
    // Act
    const actual = triageDecision(reply('skip', { model: undefined }), { ...context, usdPerMillionInputTokens: 0.5 });

    // Assert
    should(actual.costUsd).equal(0.0002);
    should(actual.model).equal('jev-latest');
  });

  it('should fail toward investigating on every outcome that is not a readable answer', () => {
    // Arrange
    const outcomes: [AuthorizedOutcome, string][] = [
      [{ kind: 'secret_missing' }, 'not_set'],
      [{ kind: 'vault_damaged' }, 'vault_damaged'],
      [{ kind: 'refused' }, 'misconfigured'],
      [{ kind: 'timeout' }, 'timeout'],
      [{ kind: 'unreachable' }, 'unreachable'],
      [{ kind: 'oversized' }, 'malformed'],
      [{ kind: 'unreadable' }, 'malformed'],
      [{ kind: 'completion', payload: {} }, 'malformed'],
      [{ kind: 'status', status: 401 }, 'rejected'],
    ];

    // Act
    const actual = outcomes.map(([outcome]) => triageDecision(outcome, context));

    // Assert
    should(actual.map(decision => decision.failure?.code)).deepEqual(outcomes.map(([, code]) => code));
    should(actual.every(decision => decision.verdict === 'investigate' && decision.confidence === 0)).be.true();
    should(actual[0]).deepEqual({
      verdict: 'investigate',
      confidence: 0,
      model: 'jev-latest',
      inputTokens: 0,
      latencyMs: 75,
      failure: { code: 'not_set' },
    });
  });

  it('should map each documented Jev status, keeping a usable retry-after', () => {
    // Act
    const actual = [400, 401, 403, 413, 422, 429, 500, 529].map(status => triageFailureForStatus(status).code);

    // Assert
    should(actual).deepEqual([
      'invalid_request',
      'rejected',
      'rejected',
      'too_large',
      'invalid_request',
      'rate_limited',
      'provider_error',
      'overloaded',
    ]);
    should(triageFailureForStatus(429, 2.5)).deepEqual({ code: 'rate_limited', retryAfterMs: 2_500 });
    should(triageFailureForStatus(429, -1)).deepEqual({ code: 'rate_limited' });
  });
});

describe('the Jev guard', () => {
  it('should send the bounded snapshot to the configured endpoint under the Jev key, and time it', async () => {
    // Arrange
    const authorizer = new ScriptedAuthorizer(reply('skip'));
    const guard = new JevTriageGuard(authorizer, new SteppingClock([100, 160]));

    // Act
    const actual = await guard.decide(snapshot);

    // Assert
    should(actual).deepEqual({
      verdict: 'skip',
      confidence: 0.9,
      model: 'jev-2026-09',
      inputTokens: 400,
      latencyMs: 60,
    });
    const call = authorizer.calls[0];
    should(call?.secretName).equal('JEV_API_KEY');
    should(call?.hosts).deepEqual(['api.typesafe.ai']);
    should(call?.request).containDeep({
      method: 'POST',
      url: 'https://api.typesafe.ai/v1/systemone',
      timeoutMs: 3_000,
    });
    should(call?.request.headers).not.have.property('authorization');
    should(JSON.parse(call?.request.body ?? '{}')).deepEqual(buildJevRequestBody(snapshot, 'jev-latest'));
  });

  it('should take endpoint, model, hosts, timeout and price from its options', async () => {
    // Arrange
    const authorizer = new ScriptedAuthorizer(reply('investigate', { model: undefined }));
    const guard = new JevTriageGuard(authorizer, new SteppingClock([5, 1]), {
      endpoint: 'https://jev.internal.example/v1/systemone',
      model: 'jev-pinned',
      hosts: ['jev.internal.example'],
      timeoutMs: 900,
      usdPerMillionInputTokens: 1,
    });

    // Act
    const actual = await guard.decide(snapshot);

    // Assert
    should(actual).deepEqual({
      verdict: 'investigate',
      confidence: 0.9,
      model: 'jev-pinned',
      inputTokens: 400,
      latencyMs: 0,
      costUsd: 0.0004,
    });
    should(authorizer.calls[0]?.hosts).deepEqual(['jev.internal.example']);
    should(authorizer.calls[0]?.request.timeoutMs).equal(900);
  });
});
