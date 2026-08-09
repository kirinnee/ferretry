import { describe, it } from 'bun:test';
import should from 'should';
import { type AnalyticsTranscriptEvidence, foldAnalyticsSessionUsage } from '../../../src/lib/analytics/usage-fold.ts';
import type { TranscriptEvent, TranscriptHarness } from '../../../src/lib/transcript/types.ts';

type UsageFigures = NonNullable<Extract<TranscriptEvent, { kind: 'usage' }>>['usage'];

const usageEvent = (usage: UsageFigures, harness: TranscriptHarness = 'claude'): TranscriptEvent => ({
  harness,
  role: 'system',
  kind: 'usage',
  usage,
});

const settingsEvent = (model: string, harness: TranscriptHarness = 'claude'): TranscriptEvent => ({
  harness,
  role: 'system',
  kind: 'settings',
  settings: { model },
});

const messageEvent = (harness: TranscriptHarness = 'claude'): TranscriptEvent => ({
  harness,
  role: 'assistant',
  kind: 'message',
  text: 'not a usage record',
});

const read = (
  events: readonly TranscriptEvent[],
  patch: Partial<Extract<AnalyticsTranscriptEvidence, { kind: 'read' }>> = {},
): AnalyticsTranscriptEvidence => ({ kind: 'read', harness: 'claude', events, issues: [], pendingBytes: 0, ...patch });

describe('analytics session usage fold', () => {
  it('should sum every request a Claude session billed and report gross input', () => {
    // Arrange: two turns, each billing its own full input. Anthropic reports uncached input only,
    // so the gross figure has to add the cache read and the cache write back in.
    const evidence = read([
      settingsEvent('claude-opus-5'),
      usageEvent({
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 2,
        cacheWrite5mInputTokens: 2,
        cacheWrite1hInputTokens: 0,
        model: 'claude-opus-5',
      }),
      messageEvent(),
      usageEvent({
        inputTokens: 20,
        outputTokens: 6,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 1,
        cacheWrite5mInputTokens: 1,
        cacheWrite1hInputTokens: 0,
        model: 'claude-opus-5',
      }),
    ]);

    // Act
    const actual = foldAnalyticsSessionUsage(evidence);

    // Assert
    should(actual).deepEqual({
      kind: 'usage',
      usage: {
        pricingModel: 'claude-opus-5',
        inputTokens: 15 + 26,
        outputTokens: 10,
        cachedInputTokens: 8,
        cacheWriteInputTokens: 3,
        cacheWrite5mInputTokens: 3,
        cacheWrite1hInputTokens: 0,
        // Anthropic bills extended thinking as ordinary output tokens and names no separate figure,
        // so no part of this session's output is reclassified as reasoning.
        reasoningTokens: null,
      },
    });
  });

  it('should treat a Codex prompt total as already containing its cached portion', () => {
    // Arrange: Codex names the cached tokens as a subset of the prompt total, so gross input is the
    // reported figure and must not have the cached part added to it a second time. Codex records its
    // model in the turn context rather than on the usage record.
    const evidence = read(
      [
        settingsEvent('gpt-5.6-codex', 'codex'),
        usageEvent({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 10 }, 'codex'),
      ],
      { harness: 'codex' },
    );

    // Act
    const actual = foldAnalyticsSessionUsage(evidence);

    // Assert
    should(actual).deepEqual({
      kind: 'usage',
      usage: {
        pricingModel: 'gpt-5.6-codex',
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        // This record states no reasoning figure at all, which is not the same as stating zero.
        reasoningTokens: null,
      },
    });
  });

  it('should report tokens but claim no pricing model when a session ran under several', () => {
    // A token count does not depend on which model produced it, so the total still stands. A single
    // price cannot be attributed across two models, so none is claimed and the cost stays unpriced.
    const actual = foldAnalyticsSessionUsage(
      read([
        usageEvent({ inputTokens: 4, outputTokens: 1, model: 'claude-opus-5' }),
        usageEvent({ inputTokens: 6, outputTokens: 2, model: 'claude-sonnet-5' }),
      ]),
    );

    should(actual).deepEqual({
      kind: 'usage',
      usage: {
        pricingModel: null,
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        reasoningTokens: null,
      },
    });
  });

  it('should read two catalog-aliased spellings in one session as one pricing model', () => {
    // THE DEFECT THIS CLOSES. A session addressed by both of a model's configured spellings is one
    // model, and folding it without the operator's alias groups made it look like a mixed-model run —
    // so `pricingModel` came back null and a perfectly priceable session was reported unpriced. The
    // refusal happened HERE, and nothing downstream could undo it: by then the second spelling was
    // already gone.
    // Arrange
    const evidence = read([
      usageEvent({ inputTokens: 4, outputTokens: 1, model: 'gpt-5.6-codex' }, 'codex'),
      usageEvent({ inputTokens: 6, outputTokens: 2, model: 'gpt-5.6-codex-preview' }, 'codex'),
    ]);

    // Act
    const aliased = foldAnalyticsSessionUsage(evidence, [
      { modelId: 'gpt-5.6-codex', aliases: ['gpt-5.6-codex-preview'] },
    ]);
    const unaliased = foldAnalyticsSessionUsage(evidence);

    // Assert
    should(aliased).containDeep({ kind: 'usage', usage: { pricingModel: 'gpt-5.6-codex', inputTokens: 10 } });
    // Without the catalog saying so, the two spellings genuinely are two models to this daemon.
    should(unaliased).containDeep({ kind: 'usage', usage: { pricingModel: null, inputTokens: 10 } });
  });

  it('should still refuse a pricing model when the alias groups do not join the spellings', () => {
    // Aliases make one model addressable twice; they do not make two models one. A session that
    // really did run under two must stay unpriced rather than be charged wholly at either rate.
    const actual = foldAnalyticsSessionUsage(
      read([
        usageEvent({ inputTokens: 4, outputTokens: 1, model: 'claude-opus-5' }),
        usageEvent({ inputTokens: 6, outputTokens: 2, model: 'claude-sonnet-5' }),
      ]),
      [
        { modelId: 'claude-opus-5', aliases: ['claude-opus-5-preview'] },
        { modelId: 'claude-sonnet-5', aliases: [] },
      ],
    );

    should(actual).containDeep({ kind: 'usage', usage: { pricingModel: null, inputTokens: 10 } });
  });

  it('should sum Codex reasoning tokens and leave Claude output unreclassified', () => {
    // Codex names a reasoning subset of its output total, so the figure is carried for pricing to
    // subtract. Claude states none, and inventing one from its output would hand pricing a second
    // rate to apply to tokens the provider already billed as output.
    // Arrange / Act
    const codex = foldAnalyticsSessionUsage(
      read(
        [
          usageEvent({ inputTokens: 20, outputTokens: 5, reasoningTokens: 2, model: 'gpt-5.6-codex' }, 'codex'),
          usageEvent({ inputTokens: 30, outputTokens: 9, reasoningTokens: 4, model: 'gpt-5.6-codex' }, 'codex'),
        ],
        { harness: 'codex' },
      ),
    );
    // The same figure on a Claude read, which no Claude parser produces: even then it is not folded.
    const claude = foldAnalyticsSessionUsage(
      read([usageEvent({ inputTokens: 20, outputTokens: 5, reasoningTokens: 2, model: 'claude-opus-5' })]),
    );

    // Assert
    should(codex).containDeep({ kind: 'usage', usage: { outputTokens: 14, reasoningTokens: 6 } });
    should(claude).containDeep({ kind: 'usage', usage: { outputTokens: 5, reasoningTokens: null } });
  });

  it('should distinguish a stated zero of reasoning from a transcript that names none', () => {
    // A harness that reported `0` has said this turn did no reasoning. One that reported nothing has
    // said nothing, and folding that to zero would put a claim on the board nobody made.
    const stated = foldAnalyticsSessionUsage(
      read([usageEvent({ inputTokens: 4, outputTokens: 1, reasoningTokens: 0 }, 'codex')], { harness: 'codex' }),
    );
    const silent = foldAnalyticsSessionUsage(
      read([usageEvent({ inputTokens: 4, outputTokens: 1 }, 'codex')], { harness: 'codex' }),
    );

    should(stated).containDeep({ kind: 'usage', usage: { reasoningTokens: 0 } });
    should(silent).containDeep({ kind: 'usage', usage: { reasoningTokens: null } });
  });

  it('should mark mixed present and missing Codex reasoning evidence as incomplete', () => {
    // One reported subset cannot stand in for the whole session. Keep the ordinary token totals so
    // the usage remains visible, but make the separate reasoning total unknown and pricing refuse it.
    const actual = foldAnalyticsSessionUsage(
      read(
        [
          usageEvent({ inputTokens: 4, outputTokens: 2, reasoningTokens: 1 }, 'codex'),
          usageEvent({ inputTokens: 6, outputTokens: 3 }, 'codex'),
        ],
        { harness: 'codex' },
      ),
    );

    should(actual).containDeep({
      kind: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: null, reasoningTokensIncomplete: true },
    });
  });

  it('should refuse a reasoning figure whose accounting it cannot state', () => {
    should(
      foldAnalyticsSessionUsage(
        read([usageEvent({ inputTokens: 4, outputTokens: 1, reasoningTokens: -1 }, 'codex')], { harness: 'codex' }),
      ),
    ).deepEqual({ kind: 'refused', reason: 'ambiguous_token_accounting' });
  });

  it('should claim no pricing model when no record names one', () => {
    const actual = foldAnalyticsSessionUsage(read([usageEvent({ inputTokens: 4, outputTokens: 1 })]));

    should(actual).containDeep({ kind: 'usage', usage: { pricingModel: null } });
  });

  it('should withhold a cache-write split that does not account for the whole write', () => {
    // A partial split priced as if it were complete would charge the remainder at nothing. Reporting
    // it as absent makes the pricing step refuse rather than undercharge.
    const actual = foldAnalyticsSessionUsage(
      read([
        usageEvent({
          inputTokens: 10,
          outputTokens: 1,
          cacheCreationInputTokens: 6,
          cacheWrite5mInputTokens: 2,
          cacheWrite1hInputTokens: 1,
          model: 'claude-opus-5',
        }),
      ]),
    );

    should(actual).containDeep({
      kind: 'usage',
      usage: { cacheWriteInputTokens: 6, cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: null },
    });
  });

  it('should refuse rather than report a total it cannot prove complete', () => {
    // Every one of these is a session that spent an UNKNOWN amount. None of them is a free session,
    // so none may fold to zero tokens.
    should(foldAnalyticsSessionUsage({ kind: 'unresolved' })).deepEqual({
      kind: 'refused',
      reason: 'transcript_unresolved',
    });
    should(foldAnalyticsSessionUsage({ kind: 'unreadable' })).deepEqual({
      kind: 'refused',
      reason: 'transcript_unreadable',
    });
    should(
      foldAnalyticsSessionUsage(read([usageEvent({ inputTokens: 4, outputTokens: 1 })], { issues: ['invalid-json'] })),
    ).deepEqual({ kind: 'refused', reason: 'transcript_damaged' });
    should(
      foldAnalyticsSessionUsage(
        read([usageEvent({ inputTokens: 4, outputTokens: 1 })], { issues: ['source-truncated'] }),
      ),
    ).deepEqual({ kind: 'refused', reason: 'transcript_damaged' });
    should(
      foldAnalyticsSessionUsage(read([usageEvent({ inputTokens: 4, outputTokens: 1 })], { pendingBytes: 12 })),
    ).deepEqual({ kind: 'refused', reason: 'transcript_incomplete' });
    should(foldAnalyticsSessionUsage(read([messageEvent()]))).deepEqual({
      kind: 'refused',
      reason: 'no_usage_evidence',
    });
  });

  it('should tolerate issues about records it did inspect', () => {
    // An unsupported or partially modelled record still PARSED, so the parser can state that it
    // carried no usage figure. Refusing on those would make the feature answer nothing in practice.
    const actual = foldAnalyticsSessionUsage(
      read([usageEvent({ inputTokens: 4, outputTokens: 1, model: 'claude-opus-5' })], {
        issues: ['unsupported-record', 'invalid-tool-input', 'invalid-record'],
      }),
    );

    should(actual).containDeep({ kind: 'usage', usage: { inputTokens: 4 } });
  });

  it('should refuse a token figure whose accounting it cannot state', () => {
    // A fractional or negative count is a record this daemon does not understand.
    should(foldAnalyticsSessionUsage(read([usageEvent({ inputTokens: 1.5, outputTokens: 1 })]))).deepEqual({
      kind: 'refused',
      reason: 'ambiguous_token_accounting',
    });
    should(foldAnalyticsSessionUsage(read([usageEvent({ inputTokens: -1, outputTokens: 1 })]))).deepEqual({
      kind: 'refused',
      reason: 'ambiguous_token_accounting',
    });
    // Codex gives no basis for saying whether a cache WRITE sits inside its prompt total or beside
    // it, and the two readings differ by the write itself.
    should(
      foldAnalyticsSessionUsage(
        read([usageEvent({ inputTokens: 10, outputTokens: 1, cacheCreationInputTokens: 3 }, 'codex')], {
          harness: 'codex',
        }),
      ),
    ).deepEqual({ kind: 'refused', reason: 'ambiguous_token_accounting' });
    // A total that has left the safe-integer range is no longer arithmetic anyone can check.
    should(
      foldAnalyticsSessionUsage(
        read([
          usageEvent({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }),
          usageEvent({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }),
        ]),
      ),
    ).deepEqual({ kind: 'refused', reason: 'ambiguous_token_accounting' });
  });

  it('should keep the last turn context when a later turn does not restate it', () => {
    const actual = foldAnalyticsSessionUsage(
      read(
        [
          settingsEvent('gpt-5.6-codex', 'codex'),
          usageEvent({ inputTokens: 4, outputTokens: 1 }, 'codex'),
          { harness: 'codex', role: 'system', kind: 'settings', settings: { reasoningEffort: 'high' } },
          usageEvent({ inputTokens: 6, outputTokens: 2 }, 'codex'),
        ],
        { harness: 'codex' },
      ),
    );

    should(actual).containDeep({ kind: 'usage', usage: { pricingModel: 'gpt-5.6-codex', inputTokens: 10 } });
  });
});
