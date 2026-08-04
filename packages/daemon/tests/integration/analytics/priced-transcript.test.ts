import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeTranscriptSource } from '../../../src/adapters/transcript/index.ts';
import { snapshotAnalyticsUsagePricing } from '../../../src/lib/analytics/pricing.ts';
import { foldAnalyticsSessionUsage } from '../../../src/lib/analytics/usage-fold.ts';
import { parseDaemonConfig } from '../../../src/lib/runtime/config.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';

/**
 * The whole cost chain, over bytes on disk.
 *
 * Nothing here is a stand-in: an operator catalog is parsed by the real configuration schema, a real
 * transcript file is read by the real adapter and parser, and the resulting money comes out of the
 * production fold and pricing snapshot. That matters because the honest failure of this feature
 * would be a chain whose links each pass in isolation and whose ends never meet.
 */

const CATALOG = [
  {
    pricingKey: 'operator:claude-opus-5:2026-08',
    modelId: 'claude-opus-5',
    aliases: [],
    provider: 'anthropic',
    ratesUsdMicrosPerMillion: {
      input: 15_000_000,
      cachedRead: 1_500_000,
      cacheWrite5m: 18_750_000,
      cacheWrite1h: 30_000_000,
      output: 75_000_000,
    },
    verifiedAt: '2026-08-01T00:00:00.000Z',
    validFrom: '2026-08-01T00:00:00.000Z',
  },
];

/** One assistant record, in the shape Claude Code actually writes. */
function assistantRecord(usage: Record<string, unknown>, index: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: '11111111-1111-4111-8111-111111111111',
    uuid: `record-${index}`,
    timestamp: '2026-08-02T00:00:00.000Z',
    message: {
      id: `message-${index}`,
      role: 'assistant',
      model: 'claude-opus-5',
      usage,
      content: [{ type: 'text', text: 'synthetic turn' }],
    },
  });
}

const directories: string[] = [];

async function transcriptFile(lines: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fy-analytics-'));
  directories.push(directory);
  const file = join(directory, 'transcript.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

async function evidence(file: string) {
  const batch = await new NodeTranscriptSource(new ClaudeTranscriptParser()).read(file);
  return {
    kind: 'read' as const,
    harness: 'claude' as const,
    events: batch.events,
    issues: batch.issues.map(issue => issue.code),
    pendingBytes: batch.cursor.pendingBytes,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('analytics pricing over a real transcript', () => {
  it('should turn an operator catalog and transcript bytes into an amount of money', async () => {
    // Arrange: two billed requests. Anthropic reports uncached input, so the gross input the rates
    // are applied to is 100 + 40 + 20 = 160 on the first turn and 200 + 60 = 260 on the second.
    const file = await transcriptFile([
      assistantRecord(
        {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 20,
          cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 },
        },
        1,
      ),
      assistantRecord({ input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 60 }, 2),
    ]);
    const config = parseDaemonConfig({ analyticsPricing: CATALOG });

    // Act
    const fold = foldAnalyticsSessionUsage(await evidence(file));
    should(fold.kind).equal('usage');
    if (fold.kind !== 'usage') return;
    const priced = snapshotAnalyticsUsagePricing(
      { ...fold.usage, createdAt: '2026-08-02T00:00:00.000Z' },
      config.analyticsPricing,
    );

    // Assert: uncached 300 @ 15, cached 100 @ 1.5, 5m write 12 @ 18.75, 1h write 8 @ 30, output 40 @ 75.
    should(fold.usage).containDeep({ inputTokens: 420, outputTokens: 40, cachedInputTokens: 100 });
    should(priced.kind).equal('priced');
    if (priced.kind !== 'priced') return;
    should(priced.rate.pricingKey).equal('operator:claude-opus-5:2026-08');
    should(priced.equivalentApiCostUsdMicros).equal(
      Math.round((300 * 15_000_000 + 100 * 1_500_000 + 12 * 18_750_000 + 8 * 30_000_000 + 40 * 75_000_000) / 1_000_000),
    );
  });

  it('should refuse to price a model the operator did not supply, rather than valuing it at zero', async () => {
    const file = await transcriptFile([assistantRecord({ input_tokens: 100, output_tokens: 10 }, 1)]);
    const config = parseDaemonConfig({ analyticsPricing: [] });

    const fold = foldAnalyticsSessionUsage(await evidence(file));
    should(fold.kind).equal('usage');
    if (fold.kind !== 'usage') return;
    const priced = snapshotAnalyticsUsagePricing(
      { ...fold.usage, createdAt: '2026-08-02T00:00:00.000Z' },
      config.analyticsPricing,
    );

    // The tokens are known and reported; only the money is withheld.
    should(fold.usage).containDeep({ inputTokens: 100, outputTokens: 10 });
    should(priced).containDeep({ kind: 'unpriced', reason: 'unknown_pricing_model' });
  });

  it('should refuse a total when the transcript ends mid-record', async () => {
    // A finished session whose last line has no terminating newline was cut off mid-write; the
    // missing bytes could carry the largest request the session made. The adapter reports the
    // unterminated tail as a lost line rather than as retained bytes, so the refusal arrives as
    // damaged evidence — the reason differs, the refusal does not.
    const directory = await mkdtemp(join(tmpdir(), 'fy-analytics-'));
    directories.push(directory);
    const file = join(directory, 'transcript.jsonl');
    await writeFile(
      file,
      `${assistantRecord({ input_tokens: 100, output_tokens: 10 }, 1)}\n{"type":"assistant","message":{"role":`,
      { mode: 0o600 },
    );

    const fold = foldAnalyticsSessionUsage(await evidence(file));

    should(fold).deepEqual({ kind: 'refused', reason: 'transcript_damaged' });
  });

  it('should refuse to price a cache write whose retention the harness did not record', async () => {
    // Anthropic bills a 5-minute and a 1-hour write at different rates. Without the split there is
    // no defensible amount, so the session reports tokens and no cost.
    const file = await transcriptFile([
      assistantRecord({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20 }, 1),
    ]);
    const config = parseDaemonConfig({ analyticsPricing: CATALOG });

    const fold = foldAnalyticsSessionUsage(await evidence(file));
    should(fold.kind).equal('usage');
    if (fold.kind !== 'usage') return;
    const priced = snapshotAnalyticsUsagePricing(
      { ...fold.usage, createdAt: '2026-08-02T00:00:00.000Z' },
      config.analyticsPricing,
    );

    should(fold.usage).containDeep({ cacheWriteInputTokens: 20, cacheWrite5mInputTokens: null });
    should(priced).containDeep({ kind: 'unpriced', reason: 'missing_anthropic_cache_write_split' });
  });
});
