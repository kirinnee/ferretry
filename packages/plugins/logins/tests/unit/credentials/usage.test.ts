import { describe, it } from 'bun:test';
import should from 'should';
import {
  claudeStatuslineCommand,
  clampUsagePercent,
  isAtLimit,
  normalizeResetAt,
  PassiveUsageRecordSchema,
  ProviderResponseFingerprintSchema,
} from '../../../daemon/lib/credentials/usage.ts';

describe('fleet usage normalization', () => {
  it('clamps percentages into the public range', () => {
    // Arrange
    const over = 180;

    // Act
    const clamped = clampUsagePercent(over);

    // Assert
    should(clamped).equal(100);
    should(clampUsagePercent(-5)).equal(0);
    should(clampUsagePercent(Number.NaN)).equal(undefined);
  });

  it('normalizes ISO values and epoch seconds into milliseconds', () => {
    // Arrange
    const iso = '2024-01-01T00:00:00.000Z';

    // Act
    const fromIso = normalizeResetAt(iso);
    const fromSeconds = normalizeResetAt(1_704_067_200);

    // Assert
    should(fromIso).equal(1_704_067_200_000);
    should(fromSeconds).equal(1_704_067_200_000);
    should(normalizeResetAt('not a date')).equal(undefined);
  });

  it('exhausts on either known window reaching the threshold', () => {
    // Arrange
    const exhausted = { usedPercent: 100, resetAt: 1_700_000_000_000 };
    const spare = { usedPercent: 20, resetAt: 1_700_100_000_000 };

    // Act / Assert
    should(isAtLimit(exhausted, spare)).equal(true);
    should(isAtLimit(spare, exhausted)).equal(true);
    should(isAtLimit(spare, spare)).equal(false);
    should(isAtLimit(undefined, undefined)).equal(false);
    should(isAtLimit(spare, undefined, 20)).equal(true);
  });

  it('keeps provider-controlled response text outside the public fingerprint schema', () => {
    // Arrange — persistence validates this schema, so accepting one arbitrary value here would give
    // an edge response a durable free-text channel despite the producer's own categorization.
    const fingerprint = {
      status: 401,
      contentType: 'application/json',
      headerNames: ['content-type'],
      bodyLength: 2,
      bodySha256: 'a'.repeat(64),
      json: { type: 'object', fields: [{ path: 'error.type', type: 'string' }] },
    };
    const parse =
      (patch: Record<string, unknown>): (() => unknown) =>
      () =>
        ProviderResponseFingerprintSchema.parse({ ...fingerprint, ...patch });

    // Act / Assert
    should(parse({ contentType: 'application/opaque-secret' })).throw();
    should(parse({ headerNames: ['x-opaque-secret'] })).throw();
    should(parse({ headers: { server: 'opaque-secret' } })).throw();
    should(parse({ json: { type: 'object', fields: [{ path: 'opaque-secret', type: 'string' }] } })).throw();
    should(parse({ json: { type: 'object', fields: [], errorCode: 'opaque-secret' } })).throw();
  });
});

describe('claudeStatuslineCommand', () => {
  it('should spell the plain command from the derived binary name', () => {
    should(claudeStatuslineCommand('fy')).equal("'fy' statusline");
    should(claudeStatuslineCommand('fy', '   ')).equal("'fy' statusline");
  });

  it("should chain the person's own command as one inert word, never replace it", () => {
    should(claudeStatuslineCommand('fy', " echo 'hi' $(whoami) ")).equal(
      "'fy' statusline --then 'echo '\\''hi'\\'' $(whoami)'",
    );
  });
});

describe('PassiveUsageRecordSchema', () => {
  it('should accept a reading with unknown windows and refuse an unknown version or source', () => {
    should(PassiveUsageRecordSchema.parse({ version: 1, source: 'codex-rollout', at: 5 })).deepEqual({
      version: 1,
      source: 'codex-rollout',
      at: 5,
    });
    should(PassiveUsageRecordSchema.safeParse({ version: 2, source: 'codex-rollout', at: 5 }).success).be.false();
    should(PassiveUsageRecordSchema.safeParse({ version: 1, source: 'guess', at: 5 }).success).be.false();
  });
});
