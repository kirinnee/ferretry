import { describe, it } from 'bun:test';
import { SessionStateSchema } from '@ferretry/protocol';
import should from 'should';
import { observedRuntimeStatePatch, projectObservedRuntime } from '../../../../src/lib/session/harness/observation.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * The model a session is actually running.
 *
 * The whole point of these cases is what the projection REFUSES to do: it never reads a configured
 * model, it never normalises the harness's string, and it never forgets an observation it once had.
 */

const AT = '2026-08-06T07:00:00.000Z';
const LATER = '2026-08-06T08:00:00.000Z';

const settings = (
  model: string | undefined,
  reasoningEffort: string | undefined,
  timestamp?: string,
): TranscriptEvent => ({
  harness: 'codex',
  role: 'system',
  kind: 'settings',
  settings: { model, reasoningEffort },
  ...(timestamp === undefined ? {} : { timestamp }),
});

const usage = (model: string | undefined, timestamp?: string): TranscriptEvent => ({
  harness: 'claude',
  role: 'system',
  kind: 'usage',
  usage: { inputTokens: 1, outputTokens: 1, ...(model === undefined ? {} : { model }) },
  ...(timestamp === undefined ? {} : { timestamp }),
});

const message = (): TranscriptEvent => ({
  harness: 'claude',
  role: 'assistant',
  kind: 'message',
  text: 'no runtime evidence in here',
  timestamp: LATER,
});

describe('the observed runtime projection', () => {
  it('should read the model off a Claude usage record', async () => {
    // Act
    const observed = projectObservedRuntime([usage('claude-opus-5', AT)]);

    // Assert
    should(observed).deepEqual({ model: 'claude-opus-5', at: AT });
  });

  it('should read the model and the level off a Codex settings record', async () => {
    // Act
    const observed = projectObservedRuntime([settings('gpt-5.6-codex', 'high', AT)]);

    // Assert
    should(observed).deepEqual({ model: 'gpt-5.6-codex', reasoningEffort: 'high', at: AT });
  });

  it('should let the newest record win per field', async () => {
    // Act
    const observed = projectObservedRuntime([
      settings('gpt-5.6-codex', 'medium', AT),
      settings('gpt-5.6-terra', undefined, LATER),
    ]);

    // Assert
    // The level survives a record that restated only the model — replacing the pair together would
    // erase a level the harness never withdrew.
    should(observed).deepEqual({ model: 'gpt-5.6-terra', reasoningEffort: 'medium', at: LATER });
  });

  it('should keep a known model when a later record states only a level', async () => {
    // Act
    const observed = projectObservedRuntime([
      settings('gpt-5.6-codex', 'medium', AT),
      settings(undefined, 'high', LATER),
    ]);

    // Assert
    should(observed).deepEqual({ model: 'gpt-5.6-codex', reasoningEffort: 'high', at: LATER });
  });

  it('should record the harness string verbatim, selector and all', async () => {
    // Normalising a `[1m]` selector here would decide handover #28 by accident, in the one place that
    // is supposed to report what was seen.
    // Act
    const observed = projectObservedRuntime([usage('claude-opus-5[1m]', AT)]);

    // Assert
    should(observed.model).equal('claude-opus-5[1m]');
  });

  it('should ignore records that carry no runtime evidence at all', async () => {
    // Act
    const observed = projectObservedRuntime([message(), usage(undefined, LATER), settings('  ', '  ', LATER)]);

    // Assert
    should(observed).deepEqual({});
  });

  it('should keep the last usable timestamp when a newer record has none', async () => {
    // Act
    const observed = projectObservedRuntime([settings('gpt-5.6-codex', 'high', AT), settings('gpt-5.6-terra', 'low')]);

    // Assert
    should(observed).deepEqual({ model: 'gpt-5.6-terra', reasoningEffort: 'low', at: AT });
  });

  it('should refuse a timestamp the session document could not hold', async () => {
    // The field is an offset-bearing instant on the wire. Writing an unparseable one would make the
    // whole session document fail to read — the observation would take the session down with it.
    // Act
    const observed = projectObservedRuntime([settings('gpt-5.6-codex', 'high', 'yesterday afternoon')]);

    // Assert
    should(observed).deepEqual({ model: 'gpt-5.6-codex', reasoningEffort: 'high' });
  });
});

describe('the observed runtime state patch', () => {
  const state = (fields: Readonly<Record<string, unknown>> = {}) =>
    SessionStateSchema.parse({ id: 's1', status: 'running', turn: 1, lastActivityAt: AT, ...fields });

  it('should write all three fields the first time a model is seen', async () => {
    // Act
    const patch = observedRuntimeStatePatch(state(), {
      model: 'gpt-5.6-codex',
      reasoningEffort: 'high',
      at: AT,
    });

    // Assert
    should(patch).deepEqual({
      observedModel: 'gpt-5.6-codex',
      observedReasoningEffort: 'high',
      observedModelAt: AT,
    });
  });

  it('should write nothing when the document already says exactly this', async () => {
    // Otherwise every read of a settled session rewrites its document.
    // Arrange
    const current = state({ observedModel: 'gpt-5.6-codex', observedReasoningEffort: 'high', observedModelAt: AT });

    // Act
    const patch = observedRuntimeStatePatch(current, { model: 'gpt-5.6-codex', reasoningEffort: 'high', at: AT });

    // Assert
    should(patch).deepEqual({});
  });

  it('should move the timestamp when the same model is confirmed again', async () => {
    // This is what lets a caller tell a fresh confirmation from the stale one it already had — and is
    // why re-selecting the model a session is already on settles instead of hanging.
    // Arrange
    const current = state({ observedModel: 'gpt-5.6-codex', observedReasoningEffort: 'high', observedModelAt: AT });

    // Act
    const patch = observedRuntimeStatePatch(current, { model: 'gpt-5.6-codex', reasoningEffort: 'high', at: LATER });

    // Assert
    should(patch).deepEqual({
      observedModel: 'gpt-5.6-codex',
      observedReasoningEffort: 'high',
      observedModelAt: LATER,
    });
  });

  it('should never clear a model the harness once reported', async () => {
    // An empty observation means the tail carried no evidence — a rotated transcript, a short tail —
    // not that the session stopped running a model.
    // Arrange
    const current = state({ observedModel: 'gpt-5.6-codex', observedReasoningEffort: 'high', observedModelAt: AT });

    // Act
    const patch = observedRuntimeStatePatch(current, {});

    // Assert
    should(patch).deepEqual({});
  });

  it('should add a level to a session that only ever had a model', async () => {
    // Arrange
    const current = state({ observedModel: 'gpt-5.6-codex', observedModelAt: AT });

    // Act
    const patch = observedRuntimeStatePatch(current, { reasoningEffort: 'high', at: LATER });

    // Assert
    should(patch).deepEqual({
      observedModel: 'gpt-5.6-codex',
      observedReasoningEffort: 'high',
      observedModelAt: LATER,
    });
  });

  it('should record a model seen with no usable timestamp beside it', async () => {
    // Act
    const patch = observedRuntimeStatePatch(state(), { model: 'claude-opus-5' });

    // Assert
    should(patch).deepEqual({ observedModel: 'claude-opus-5' });
  });

  it('should produce a patch the session document accepts', async () => {
    // Arrange
    const current = state();

    // Act
    const patch = observedRuntimeStatePatch(current, { model: 'claude-opus-5', at: AT });

    // Assert
    should(SessionStateSchema.parse({ ...current, ...patch })).match({
      observedModel: 'claude-opus-5',
      observedModelAt: AT,
    });
  });
});
