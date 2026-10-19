import { describe, it } from 'bun:test';
import should from 'should';
import { observedRuntimeStatePatch, projectObservedRuntime } from '../../../../src/lib/session/harness/observation.ts';
import { ClaudeTranscriptParser } from '../../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../../src/lib/transcript/codex.ts';

/**
 * Fast mode is observed from what the harness wrote when it switched, not from what was asked.
 *
 * The records below are the ones Claude Code 2.1.281 and Codex 0.156.1 wrote in a real session
 * (fixtures/transcript/claude-fast-mode.jsonl and codex-fast-mode.jsonl), run through the real
 * parsers. The Codex fixture drops each record's `collaboration_mode` (kilobytes of instructions) and
 * rewrites the working directory; nothing else is touched.
 */

const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(`../../../fixtures/transcript/${name}`, import.meta.url)).text();

const claudeLines = async (): Promise<string[]> => (await fixture('claude-fast-mode.jsonl')).trim().split('\n');

const claude = (lines: readonly string[]) =>
  projectObservedRuntime(new ClaudeTranscriptParser().parse({ text: `${lines.join('\n')}\n` }).events);

const codex = (lines: readonly string[]) =>
  projectObservedRuntime(new CodexTranscriptParser().parse({ text: `${lines.join('\n')}\n` }).events);

/** The fixture's records, in groups of whatever the harness wrote at one timestamp. */
const upTo = (lines: readonly string[], timestamp: string): string[] =>
  lines.filter(line => (JSON.parse(line) as { timestamp: string }).timestamp <= timestamp);

describe('observing a Claude Code /fast switch at an idle prompt', () => {
  it('should read fast ON from the styled answer to `/fast on`', async () => {
    // Act
    const observed = claude(upTo(await claudeLines(), '2026-10-19T07:11:58.886Z'));

    // Assert
    should(observed).deepEqual({ fast: true, at: '2026-10-19T07:11:58.886Z' });
  });

  it('should read fast OFF from the plain answer to `/fast off`, and the latest answer wins', async () => {
    // Act
    const observed = claude(upTo(await claudeLines(), '2026-10-19T07:12:26.514Z'));

    // Assert
    should(observed).deepEqual({ fast: false, at: '2026-10-19T07:12:26.514Z' });
  });

  it('should read fast OFF off the end of a /model answer that left a model with no fast mode', async () => {
    // Act
    const observed = claude(upTo(await claudeLines(), '2026-10-19T07:12:49.119Z'));

    // Assert — the model switch states no model id (a display name only), so only fast is observed.
    should(observed).deepEqual({ fast: false, at: '2026-10-19T07:12:49.119Z' });
  });

  it('should still read fast ON when the answer also says the model was changed', async () => {
    // Act
    const observed = claude(await claudeLines());

    // Assert
    should(observed).deepEqual({ fast: true, at: '2026-10-19T07:12:59.316Z' });
  });

  it('should take no evidence from a refusal, from stderr, or from a message that merely says so', async () => {
    // Arrange
    const record = (content: string) =>
      JSON.stringify({
        type: 'user',
        uuid: 'u',
        timestamp: '2026-10-19T07:20:00.000Z',
        message: { role: 'user', content },
      });

    // Act
    const observed = claude([
      record('<local-command-stdout>Fast mode unavailable: Fast mode requires usage credits</local-command-stdout>'),
      record('<local-command-stderr>Fast mode ON</local-command-stderr>'),
      record('please turn Fast mode ON for me'),
    ]);

    // Assert
    should(observed).deepEqual({});
  });
});

describe('observing a Codex /fast switch', () => {
  it('should read fast from the service tier the thread settings name, and the toggle moves it at once', async () => {
    // Arrange
    const lines = (await fixture('codex-fast-mode.jsonl')).trim().split('\n');

    // Act
    const running = codex(lines.slice(0, 2));
    const toggled = codex(lines);

    // Assert — `priority` is the fast tier and `default` is not; the toggle writes its own record.
    should(running).deepEqual({
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      fast: true,
      at: '2026-10-19T07:07:23.593Z',
    });
    should(toggled).deepEqual({
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      fast: false,
      at: '2026-10-19T07:07:28.619Z',
    });
  });

  it('should take a tier that is neither of the two as no evidence about fast mode', async () => {
    // Arrange
    const settings = (tier: string) =>
      JSON.stringify({
        timestamp: '2026-10-19T08:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol', service_tier: tier } },
      });

    // Act
    const observed = codex([settings('ultrafast')]);

    // Assert
    should(observed).deepEqual({ model: 'gpt-5.6-sol', at: '2026-10-19T08:00:00.000Z' });
  });

  it('should read a record whose only setting is the service tier', async () => {
    // Act
    const observed = codex([
      JSON.stringify({
        timestamp: '2026-10-19T08:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } },
      }),
    ]);

    // Assert
    should(observed).deepEqual({ fast: true, at: '2026-10-19T08:00:00.000Z' });
  });
});

describe('the state patch for fast mode', () => {
  const none = {};

  it('should write the observation and move the shared timestamp', () => {
    // Act / Assert
    should(observedRuntimeStatePatch(none, { fast: true, at: '2026-10-19T08:00:00.000Z' })).deepEqual({
      observedFast: true,
      observedModelAt: '2026-10-19T08:00:00.000Z',
    });
  });

  it('should write nothing when the same fact was already recorded at the same time', () => {
    // Act / Assert
    should(
      observedRuntimeStatePatch(
        { observedFast: true, observedModelAt: '2026-10-19T08:00:00.000Z' },
        { fast: true, at: '2026-10-19T08:00:00.000Z' },
      ),
    ).deepEqual({});
  });

  it('should move the timestamp for a re-report of the same value, which is how it settles', () => {
    // Act / Assert
    should(
      observedRuntimeStatePatch(
        { observedFast: true, observedModelAt: '2026-10-19T08:00:00.000Z' },
        { fast: true, at: '2026-10-19T08:00:05.000Z' },
      ),
    ).deepEqual({ observedFast: true, observedModelAt: '2026-10-19T08:00:05.000Z' });
  });

  it('should never forget a fact the tail did not restate', () => {
    // Act / Assert
    should(
      observedRuntimeStatePatch({ observedFast: false, observedModelAt: '2026-10-19T08:00:00.000Z' }, {}),
    ).deepEqual({});
  });
});
