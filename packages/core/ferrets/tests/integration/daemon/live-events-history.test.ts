import { describe, it } from 'bun:test';
import should from 'should';
import type {
  CompactionHistorySource,
  CompactionRecord,
  FerretRecord,
  Harness,
  HarnessTailRecord,
  Runner,
} from '../../../contract/index.ts';
import { HarnessTranscript } from '../../../daemon/adapters/session/live/harness-transcript.ts';
import { buildLiveEvents } from '../../../daemon/modules/live-events.ts';

/**
 * The live readout's compaction history, asked of whoever provides `ferrets.compaction-history` (Usage) each time it is
 * needed. Real: the stamp-keyed tail cache, the readout source and the masking wrapper. Behind fakes: the harness's
 * records, the runner's look and the hook's provider.
 *
 * WHAT IT HAS TO GET RIGHT. A running compaction's "usually ~Ns" is the provider's measured median when there is one and
 * the harness's prior (`typical`) when there is none, and a finished compaction is handed to the provider exactly once. No
 * provider, or a provider that throws, must never cost the readout its frame.
 */

const START_MS = Date.parse('2026-10-18T10:00:00.000Z');
const atMs = (offsetSeconds: number): string => new Date(START_MS + offsetSeconds * 1_000).toISOString();
const COMPACTING_PANE = '⏺ Done.\n✻ Compacting conversation… (4s · esc to interrupt)\n\n│ > ';
const IDLE_PANE = '⏺ Done.\n\n│ > ';
const ID = 's1';

const idleState = {
  id: ID,
  status: 'running',
  turn: 1,
  turnState: 'your-turn',
  turnStateAt: atMs(0),
};

interface Subject {
  readonly clock: { now: string };
  readonly sample: () => Promise<{ compaction?: Record<string, unknown> } | undefined>;
  /** What the pane paints and the harness's newest records: assign to move the scene. */
  readonly scene: { pane: string; records: readonly HarnessTailRecord[]; size: number; lookFails: boolean };
  /** What `provider` answers; assign to change who provides the hook between two samples. */
  provider: CompactionHistorySource | undefined;
  /** The poll's tick once a transcript is watched: call it to let a second go by. */
  tick: (() => void) | undefined;
  /** Follows the transcript signal (`?transcript=1`). */
  readonly watch: (onChange: (at: string) => void) => { close(): void };
}

const subject = (
  initial: CompactionHistorySource | undefined,
  state: Record<string, unknown> = idleState,
  mask: (value: string) => string = value => value,
): Subject => {
  const scene: Subject['scene'] = {
    pane: COMPACTING_PANE,
    records: [{ kind: 'usage', at: atMs(1) as never, contextTokens: 140_000 }],
    size: 1,
    lookFails: false,
  };
  const clock = { now: atMs(30) };
  const harness = {
    transcriptStamp: async () => ({ file: '/fixture/transcript.jsonl', size: scene.size, mtimeMs: scene.size }),
    transcriptTail: async () => ({ kind: 'read' as const, records: scene.records }),
  } as unknown as Harness;
  const runner = {
    look: async () => {
      if (scene.lookFails) throw new Error('the pane is gone');
      return { status: scene.pane, atPrompt: false };
    },
  } as unknown as Runner;
  const built: Subject = {
    clock,
    scene,
    provider: initial,
    tick: undefined,
    watch: onChange => transcript.watch(ID, onChange),
    sample: async () => {
      const sampled = await live.sample(ID, new AbortController().signal);
      return sampled as never;
    },
  };
  const { live, transcript } = buildLiveEvents({
    readState: async () => state,
    record: () => ({ state: 'running', handle: 'h' }) as unknown as FerretRecord,
    runner: () => runner,
    transcript: new HarnessTranscript(
      () => harness,
      () => 'claude-code' as never,
    ),
    clock: { now: () => clock.now },
    every: (_intervalMs, tick) => {
      built.tick = tick;
      return () => {};
    },
    redaction: {
      read: async (run: (scope: { text: (value: string) => string }) => unknown) => run({ text: mask }),
    } as never,
    history: () => built.provider,
  });
  return built;
};

describe('the live readout and the compaction history hook', () => {
  it("should estimate a running compaction from the provider's measured durations", async () => {
    // Arrange
    const live = subject({ durations: async () => [30_000, 50_000], record: async () => {} });

    // Act
    const sampled = await live.sample();

    // Assert
    should(sampled?.compaction).containDeep({ phase: 'running', expectedMs: 40_000, basis: 'history' });
  });

  it('should say typical when nothing provides the hook, and use a provider that arrives later', async () => {
    // Arrange
    const live = subject(undefined);

    // Act
    const before = await live.sample();
    live.provider = { durations: async () => [20_000], record: async () => {} };
    const after = await live.sample();

    // Assert — the provider is asked at the time of the sample, never captured at build.
    should(before?.compaction).containDeep({ phase: 'running', expectedMs: 60_000, basis: 'typical' });
    should(after?.compaction).containDeep({ phase: 'running', expectedMs: 20_000, basis: 'history' });
  });

  it('should mask the status verb on its way out, and drop it when nothing is left of it', async () => {
    // Arrange — a working turn whose status line paints a verb that is, or hides, a vault value.
    const working = { ...idleState, turnState: 'working' };
    const masked = subject(undefined, working, value => value.replace('Pontificating', '[secret]'));
    masked.scene.pane = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
    const empty = subject(undefined, working, () => ' ');
    empty.scene.pane = masked.scene.pane;

    // Act
    const shown = await masked.sample();
    const bare = await empty.sample();

    // Assert
    should(shown).containDeep({ verb: '[secret]…' });
    should(bare).not.have.property('verb');
  });

  it('should signal a transcript write only when the proved file moved between two polls', async () => {
    // Arrange
    const live = subject(undefined);
    const heard: string[] = [];
    const watch = live.watch(at => heard.push(at));
    await new Promise(resolve => setTimeout(resolve, 10));

    // Act
    live.tick?.();
    await new Promise(resolve => setTimeout(resolve, 10));
    const quiet = heard.length;
    live.scene.size = 2;
    live.tick?.();
    await new Promise(resolve => setTimeout(resolve, 10));
    watch.close();

    // Assert
    should(quiet).equal(0);
    should(heard).deepEqual([atMs(30)]);
  });

  it('should read no pane, and so show no compaction, when the runner cannot look', async () => {
    // Arrange
    const live = subject({ durations: async () => [30_000], record: async () => {} });
    live.scene.lookFails = true;

    // Act / Assert — the frame is still the session's, with nothing a pane would have said.
    should(await live.sample()).not.have.property('compaction');
  });

  it('should keep the frame, as typical, when the provider throws', async () => {
    // Arrange
    const live = subject({
      durations: async () => {
        throw new Error('history unreadable');
      },
      record: async () => {},
    });

    // Act / Assert
    should((await live.sample())?.compaction).containDeep({ phase: 'running', basis: 'typical' });
  });

  it('should hand a finished compaction to the provider once, and drop it without one', async () => {
    // Arrange
    const kept: CompactionRecord[] = [];
    const live = subject({ durations: async () => [], record: async entry => void kept.push(entry) });
    await live.sample();

    // Act — the pane goes quiet and the harness writes its boundary record.
    live.scene.pane = IDLE_PANE;
    live.scene.size = 2;
    live.scene.records = [
      { kind: 'usage', at: atMs(-20) as never, contextTokens: 90 },
      { kind: 'compaction', at: atMs(71) as never, trigger: 'auto' },
    ];
    live.clock.now = atMs(71);
    const done = await live.sample();
    await live.sample();

    // Assert
    should(done?.compaction).containDeep({ phase: 'done' });
    should(kept).have.length(1);
    should(kept[0]).containDeep({ harness: 'claude', tokensBefore: 140_000 });

    // And with no provider the same ending is still a frame, and nothing is kept.
    const unprovided = subject(undefined);
    await unprovided.sample();
    unprovided.provider = undefined;
    unprovided.scene.pane = IDLE_PANE;
    unprovided.scene.size = 2;
    unprovided.scene.records = live.scene.records;
    unprovided.clock.now = atMs(71);
    should((await unprovided.sample())?.compaction).containDeep({ phase: 'done' });
  });
});
