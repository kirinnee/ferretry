import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLiveActivitySchema } from '@ferretry/protocol';
import should from 'should';
import { type LiveActivityReads, StorageLiveActivitySource } from '../../../../src/adapters/session/live/index.ts';
import type {
  CompactionHistory,
  CompactionRecord,
  PaneState,
  SessionTranscriptTail,
  TranscriptEvent,
  TranscriptTailResult,
} from '../../../../src/lib/index.ts';

/**
 * The live readout over its ports: a real transcript FILE (so the stat-keyed cache is exercised for
 * real), with the state, pane, transcript tail and clock behind fakes.
 *
 * WHAT THIS HAS TO GET RIGHT. A readout runs twice a second per watched session, so the two ways it
 * goes wrong are cost and honesty. Cost: an idle turn must be one state read, and a quiet transcript
 * a `stat`, never a re-parse. Honesty: a turn that is not working carries no counts, a tail that
 * could not be read carries none either, and a sample whose reader has gone away is abandoned
 * rather than finished.
 */

const NOW = '2026-10-18T10:00:30.000Z';
const TURN_START = '2026-10-18T10:00:00.000Z';
const START_MS = Date.parse(TURN_START);
const CLAUDE_WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';

const cleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...cleanups].map(cleanup => cleanup()));
  cleanups.clear();
});

const atMs = (offsetSeconds: number): string => new Date(START_MS + offsetSeconds * 1_000).toISOString();

const usage = (offsetSeconds: number, messageId: string, output: number, input: number): TranscriptEvent => ({
  harness: 'claude',
  role: 'assistant',
  kind: 'usage',
  timestamp: atMs(offsetSeconds),
  messageId,
  usage: { inputTokens: input, outputTokens: output },
});

const userSaid = (offsetSeconds: number): TranscriptEvent => ({
  harness: 'claude',
  role: 'user',
  kind: 'message',
  text: 'go',
  timestamp: atMs(offsetSeconds),
});

const workingState = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  status: 'running',
  turn: 1,
  turnState: 'working',
  turnStateAt: TURN_START,
  ...extra,
});

const pane = (visible: string): PaneState => ({ alive: true, dead: false, promptReady: false, history: '', visible });

interface Script {
  /** The state document, or `'reject'` for a read that throws. */
  state: unknown;
  /** Runs when the pane is read, so a test can act mid-sample. */
  onPane?: () => void;
  pane: PaneState | undefined | 'reject';
  /** The transcript file, `undefined` for none yet, `'reject'` for a lookup that throws. */
  file: string | undefined | 'reject';
  tail: TranscriptTailResult | 'reject';
}

interface Subject {
  /** The instant the subject's clock reads; assign to move time. */
  readonly clock: { now: string };
  readonly history: CompactionRecord[];
  readonly source: StorageLiveActivitySource;
  readonly script: Script;
  readonly calls: { state: number; pane: number; file: number; tail: number };
  readonly tailLimits: number[];
  readonly signal: AbortController;
  /** Samples session `s1` with this subject's signal. */
  readonly sample: () => ReturnType<StorageLiveActivitySource['sample']>;
}

function subject(initial: Partial<Script> = {}, durations: readonly number[] = [], brokenHistory = false): Subject {
  const script: Script = {
    state: workingState(),
    pane: pane(CLAUDE_WORKING),
    file: undefined,
    tail: { kind: 'read', events: [] },
    ...initial,
  };
  const calls = { state: 0, pane: 0, file: 0, tail: 0 };
  const tailLimits: number[] = [];
  const reads: LiveActivityReads = {
    readState: async () => {
      calls.state += 1;
      if (script.state === 'reject') throw new Error('state file is locked');
      return script.state;
    },
    paneState: async () => {
      calls.pane += 1;
      script.onPane?.();
      if (script.pane === 'reject') throw new Error('tmux is gone');
      return script.pane;
    },
    transcriptFile: async () => {
      calls.file += 1;
      if (script.file === 'reject') throw new Error('lookup failed');
      return script.file;
    },
  };
  const tail: SessionTranscriptTail = {
    tail: async (_session, limit) => {
      calls.tail += 1;
      tailLimits.push(limit);
      if (script.tail === 'reject') throw new Error('transcript unreadable');
      return script.tail;
    },
  };
  const signal = new AbortController();
  const clock = { now: NOW };
  const recorded: CompactionRecord[] = [];
  const history: CompactionHistory = {
    durations: async () => {
      if (brokenHistory) throw new Error('history unreadable');
      return durations;
    },
    record: async entry => {
      if (brokenHistory) throw new Error('history unwritable');
      recorded.push(entry);
    },
  };
  const source = new StorageLiveActivitySource(reads, tail, { now: () => clock.now }, history);
  return {
    source,
    script,
    calls,
    tailLimits,
    signal,
    clock,
    history: recorded,
    sample: () => source.sample('s1', signal.signal),
  };
}

/** A real, empty transcript file the subject's stat cache can key on. */
async function transcriptFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferretry-live-'));
  cleanups.add(async () => await rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'transcript.jsonl');
  await writeFile(file, '{}\n');
  return file;
}

describe('the live readout over storage', () => {
  it('should answer nothing for a session id the layout would never produce', async () => {
    // Arrange
    const live = subject();

    // Act
    const sampled = await live.source.sample('../etc/passwd', live.signal.signal);

    // Assert — refused before any read, so a bad id cannot be turned into a path.
    should(sampled).be.undefined();
    should(live.calls.state).equal(0);
  });

  it('should answer nothing when the state cannot be read or is not a session state', async () => {
    // Arrange
    const garbage = subject({ state: 'not a document' });
    const empty = subject({ state: undefined });
    const throwing = subject({ state: 'reject' });

    // Act / Assert — a readout is a courtesy: it says nothing rather than something false.
    should(await garbage.sample()).be.undefined();
    should(await empty.sample()).be.undefined();
    should(await throwing.sample()).be.undefined();
  });

  it('should carry only the session and the clock when no turn is working, reading nothing it cannot cache', async () => {
    // Arrange
    const idle = subject({ state: workingState({ turnState: 'your-turn' }) });
    const never = subject({ state: { id: 's1', status: 'running', turn: 1 } });
    const unstamped = subject({ state: workingState({ turnStateAt: undefined }) });

    // Act
    const results = [await idle.sample(), await never.sample(), await unstamped.sample()];

    // Assert
    for (const result of results) should(result).deepEqual({ sessionId: 's1', at: NOW });
    for (const live of [idle, never, unstamped]) should(live.calls).deepEqual({ state: 1, pane: 1, file: 1, tail: 0 });
  });

  it('should read the pane and the transcript of a working turn, and prefer the larger output count', async () => {
    // Arrange — the pane says 1.2k; the transcript has 800 so far and 5.4k sent.
    const file = await transcriptFile();
    const live = subject({
      file,
      tail: {
        kind: 'read',
        events: [userSaid(-2), usage(1, 'm1', 300, 4_000), usage(4, 'm2', 500, 1_400)],
      },
    });

    // Act
    const sampled = await live.sample();

    // Assert — the pane wins as it is ahead; input can only come from the transcript.
    should(sampled).deepEqual({
      sessionId: 's1',
      at: NOW,
      turnStartedAt: TURN_START,
      verb: 'Pontificating…',
      outputTokens: 1_200,
      outputSource: 'pane',
      inputTokens: 5_400,
    });
    should(SessionLiveActivitySchema.safeParse(sampled).success).be.true();
    should(live.tailLimits).deepEqual([400]);
  });

  it('should report the transcript count when it is ahead of the pane', async () => {
    // Arrange
    const file = await transcriptFile();
    const live = subject({
      file,
      pane: pane('✽ Pontificating… (3s · ↓ 100 tokens · esc to interrupt)'),
      tail: { kind: 'read', events: [usage(1, 'm1', 900, 10)] },
    });

    // Act / Assert
    should(await live.sample()).deepEqual({
      sessionId: 's1',
      at: NOW,
      turnStartedAt: TURN_START,
      verb: 'Pontificating…',
      outputTokens: 900,
      outputSource: 'transcript',
      inputTokens: 10,
    });
  });

  it('should read the transcript alone when the pane is gone or cannot be read', async () => {
    // Arrange
    const file = await transcriptFile();
    const events: TranscriptEvent[] = [usage(1, 'm1', 70, 8)];
    const gone = subject({ file, pane: undefined, tail: { kind: 'read', events } });
    const broken = subject({ file, pane: 'reject', tail: { kind: 'read', events } });

    // Act
    const results = [await gone.sample(), await broken.sample()];

    // Assert — no verb: that comes from the pane alone.
    for (const result of results)
      should(result).deepEqual({
        sessionId: 's1',
        at: NOW,
        turnStartedAt: TURN_START,
        outputTokens: 70,
        outputSource: 'transcript',
        inputTokens: 8,
      });
  });

  it('should re-parse the transcript only when its file changed', async () => {
    // Arrange
    const file = await transcriptFile();
    const live = subject({ file, tail: { kind: 'read', events: [usage(1, 'm1', 10, 1)] } });

    // Act — two quiet samples, then the file grows, then it is touched without growing.
    await live.sample();
    await live.sample();
    const quiet = live.calls.tail;
    await appendFile(file, '{"more":true}\n');
    live.script.tail = { kind: 'read', events: [usage(1, 'm1', 10, 1), usage(2, 'm2', 20, 2)] };
    const grown = await live.sample();
    await live.sample();
    const afterGrowth = live.calls.tail;
    await utimes(file, new Date(), new Date(Date.now() + 60_000));
    await live.sample();

    // Assert — a half-second sample over a quiet turn is a `stat`, not a parse.
    should(quiet).equal(1);
    should(grown?.inputTokens).equal(3);
    should(afterGrowth).equal(2);
    should(live.calls.tail).equal(3);
  });

  it('should keep its cache across a turn boundary, because the file key is what says it changed', async () => {
    // Arrange
    const file = await transcriptFile();
    const live = subject({ file, tail: { kind: 'read', events: [usage(1, 'm1', 10, 1)] } });
    await live.sample();

    // Act — the turn ends, then another begins over the same, unchanged file.
    live.script.state = workingState({ turnState: 'your-turn' });
    await live.sample();
    live.script.state = workingState();
    await live.sample();

    // Assert — the quiet file was parsed once, not once per turn.
    should(live.calls.tail).equal(1);
  });

  it('should carry no transcript counts when it has no transcript file, or cannot stat it', async () => {
    // Arrange
    const none = subject({ file: undefined });
    const throwing = subject({ file: 'reject' });
    const missing = subject({ file: join(tmpdir(), 'ferretry-live-no-such-transcript.jsonl') });

    // Act
    const results = [await none.sample(), await throwing.sample(), await missing.sample()];

    // Assert — the pane's own reading still stands; nothing is invented for the rest.
    for (const result of results)
      should(result).deepEqual({
        sessionId: 's1',
        at: NOW,
        turnStartedAt: TURN_START,
        verb: 'Pontificating…',
        outputTokens: 1_200,
        outputSource: 'pane',
      });
    for (const live of [none, throwing, missing]) should(live.calls.tail).equal(0);
  });

  it('should carry no transcript counts when the tail was not read, and should not cache that', async () => {
    // Arrange
    const file = await transcriptFile();
    const unresolved = subject({ file, tail: { kind: 'unresolved' } });
    const throwing = subject({ file, tail: 'reject' });

    // Act
    const first = await unresolved.sample();
    await unresolved.sample();
    const second = await throwing.sample();
    unresolved.script.tail = { kind: 'read', events: [usage(1, 'm1', 5, 6)] };
    const recovered = await unresolved.sample();

    // Assert — a failed read is retried on the next sample rather than remembered as "nothing".
    for (const result of [first, second]) {
      should(result?.inputTokens).be.undefined();
      should(result?.outputSource).equal('pane');
    }
    should(unresolved.calls.tail).equal(3);
    should(recovered?.inputTokens).equal(6);
  });

  it('should say nothing of a turn whose start the tail no longer reaches', async () => {
    // Arrange — a full tail (400 events) whose oldest event is already inside the turn.
    const file = await transcriptFile();
    const events = Array.from({ length: 400 }, (_, index) => usage(1 + index * 0.01, `m${index}`, 1, 1));
    const live = subject({ file, tail: { kind: 'read', events } });

    // Act
    const sampled = await live.sample();

    // Assert — a partial sum shown as the turn's total would be a lie; the pane's number stands alone.
    should(sampled?.inputTokens).be.undefined();
    should(sampled?.outputTokens).equal(1_200);
    should(sampled?.outputSource).equal('pane');
  });

  it('should count a transcript that is short of the tail bound as complete', async () => {
    // Arrange — fewer events than asked for means the tail is the whole transcript.
    const file = await transcriptFile();
    const live = subject({ file, tail: { kind: 'read', events: [usage(1, 'm1', 5, 6)] } });

    // Act / Assert
    should((await live.sample())?.inputTokens).equal(6);
  });

  it('should abandon a sample whose reader has gone away', async () => {
    // Arrange
    const before = subject();
    const during: Subject = subject({ onPane: () => during.signal.abort(new Error('event stream closed')) });
    before.signal.abort(new Error('event stream closed'));

    // Act
    const abandonedBefore = await before.sample().catch(error => error as Error);
    const abandonedDuring = await during.sample().catch(error => error as Error);

    // Assert — the signal's own reason surfaces, so the caller can tell a close from a failure; and a
    // sample aborted before its reads began did none of them.
    should((abandonedBefore as Error).message).equal('event stream closed');
    should((abandonedDuring as Error).message).equal('event stream closed');
    should(before.calls.pane).equal(0);
    should(before.calls.file).equal(0);
  });
});

const COMPACTING_PANE = '⏺ Done.\n✻ Compacting conversation… (4s · esc to interrupt)\n\n│ > ';
const IDLE_PANE = '⏺ Done.\n\n│ > ';

const contextUsage = (
  offsetSeconds: number,
  contextTokens: number,
  harness: 'claude' | 'codex' = 'claude',
): TranscriptEvent => ({
  harness,
  role: 'assistant',
  kind: 'usage',
  timestamp: atMs(offsetSeconds),
  usage: { contextTokens },
});

const boundary = (offsetSeconds: number, harness: 'claude' | 'codex' = 'claude'): TranscriptEvent => ({
  harness,
  role: 'system',
  kind: 'compaction',
  timestamp: atMs(offsetSeconds),
  trigger: 'auto',
});

const idleState = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  workingState({ turnState: 'your-turn', ...extra });

const at30 = atMs(30);
const at71 = atMs(71);

describe('the live readout of a compaction', () => {
  it("should report a compaction the pane shows, from the context size and this daemon's own durations", async () => {
    // Arrange — no turn is working: a manual /compact begins from an idle prompt.
    const file = await transcriptFile();
    const live = subject(
      {
        file,
        state: idleState(),
        pane: pane(COMPACTING_PANE),
        tail: { kind: 'read', events: [contextUsage(1, 140_000)] },
      },
      [30_000, 50_000],
    );
    live.clock.now = at30;

    // Act
    const sampled = await live.sample();

    // Assert
    should(sampled).deepEqual({
      sessionId: 's1',
      at: at30,
      compaction: { phase: 'running', startedAt: at30, tokensBefore: 140_000, expectedMs: 40_000, basis: 'history' },
    });
    should(SessionLiveActivitySchema.safeParse(sampled).success).be.true();
  });

  it('should carry the percent and tokens written the pane reports, and none when it paints no bar', async () => {
    // Arrange
    const file = await transcriptFile();
    const sampleOf = async (frame: string) =>
      subject({
        file,
        state: idleState(),
        pane: pane(frame),
        tail: { kind: 'read', events: [contextUsage(1, 140_000)] },
      })
        .sample()
        .then(sampled => sampled?.compaction);
    const real = readFileSync(
      join(import.meta.dir, '../../../fixtures/compaction/claude-2.1.28x-compacting-progress.txt'),
      'utf8',
    );

    // Assert
    should(await sampleOf(real)).containDeep({ phase: 'running', percent: 49, tokensWritten: 37_400 });
    should(await sampleOf(COMPACTING_PANE)).not.have.property('percent');
    should(await sampleOf(COMPACTING_PANE)).not.have.property('tokensWritten');
  });

  it('should label the estimate typical for the harness when nothing has been watched yet', async () => {
    // Arrange
    const file = await transcriptFile();
    const claude = subject({
      file,
      state: idleState(),
      pane: pane(COMPACTING_PANE),
      tail: { kind: 'read', events: [contextUsage(1, 9, 'claude')] },
    });
    const codex = subject({
      file,
      state: idleState(),
      pane: pane(COMPACTING_PANE),
      tail: { kind: 'read', events: [contextUsage(1, 9, 'codex')] },
    });
    const none = subject({ state: idleState(), pane: pane(COMPACTING_PANE) });

    // Assert — an empty tail has no harness to name, and falls back to Claude's.
    should((await claude.sample())?.compaction).containDeep({ expectedMs: 60_000, basis: 'typical' });
    should((await codex.sample())?.compaction).containDeep({ expectedMs: 40_000, basis: 'typical' });
    should((await none.sample())?.compaction).containDeep({ expectedMs: 60_000, basis: 'typical' });
  });

  it('should follow a compaction from running to done, keeping its duration once', async () => {
    // Arrange
    const file = await transcriptFile();
    const live = subject({
      file,
      state: idleState({ observedModel: 'claude-synthetic' }),
      pane: pane(COMPACTING_PANE),
      tail: { kind: 'read', events: [contextUsage(-20, 150_000)] },
    });
    live.clock.now = at30;
    const running = await live.sample();

    // Act — 41s later the harness wrote its boundary and the pane went quiet.
    await appendFile(file, '{"boundary":true}\n');
    live.script.pane = pane(IDLE_PANE);
    live.script.tail = { kind: 'read', events: [contextUsage(-20, 150_000), boundary(71), contextUsage(80, 9_000)] };
    live.clock.now = at71;
    const done = await live.sample();
    await appendFile(file, '{"again":true}\n');
    const again = await live.sample();

    // Assert
    should(running?.compaction).containDeep({ phase: 'running', startedAt: at30, tokensBefore: 150_000 });
    should(done?.compaction).deepEqual({
      phase: 'done',
      trigger: 'auto',
      startedAt: at30,
      endedAt: at71,
      tokensBefore: 150_000,
      tokensAfter: 9_000,
    });
    should(again?.compaction).deepEqual(done?.compaction);
    should(live.history).deepEqual([
      { harness: 'claude', model: 'claude-synthetic', durationMs: 41_000, tokensBefore: 150_000, at: at71 },
    ]);
  });

  it('should keep a compaction running through a pane that cannot be read, and read the pane every sample while it does', async () => {
    // Arrange
    const live = subject({ state: idleState(), pane: pane(COMPACTING_PANE) });
    live.clock.now = at30;
    await live.sample();

    // Act
    live.script.pane = 'reject';
    live.clock.now = atMs(31);
    const blind = await live.sample();
    live.script.pane = pane(COMPACTING_PANE);
    live.clock.now = atMs(31.5);
    await live.sample();

    // Assert — the throttle never hides a tracked compaction's end: every sample read the pane.
    should(blind?.compaction).containDeep({ phase: 'running', startedAt: at30 });
    should(live.calls.pane).equal(3);
  });

  it('should read an idle pane at most every two seconds, repeating the last answer in between', async () => {
    // Arrange
    const live = subject({ state: idleState(), pane: pane(IDLE_PANE) });

    // Act
    await live.sample();
    live.clock.now = atMs(30.5);
    await live.sample();
    live.clock.now = atMs(31);
    await live.sample();
    const afterOneRead = live.calls.pane;
    live.clock.now = atMs(33);
    await live.sample();

    // Assert
    should(afterOneRead).equal(1);
    should(live.calls.pane).equal(2);
  });

  it('should still show a finished compaction after the pane read is skipped by the throttle', async () => {
    // Arrange — already done and recorded, then a sample inside the throttle window.
    const file = await transcriptFile();
    const live = subject({
      file,
      state: idleState(),
      pane: pane(COMPACTING_PANE),
      tail: { kind: 'read', events: [contextUsage(-20, 90)] },
    });
    live.clock.now = at30;
    await live.sample();
    await appendFile(file, '{"boundary":true}\n');
    live.script.pane = pane(IDLE_PANE);
    live.script.tail = { kind: 'read', events: [contextUsage(-20, 90), boundary(71)] };
    live.clock.now = at71;
    await live.sample();
    const reads = live.calls.pane;

    // Act
    live.clock.now = atMs(72);
    const skipped = await live.sample();

    // Assert
    should(live.calls.pane).equal(reads);
    should(skipped?.compaction).containDeep({ phase: 'done', startedAt: at30 });
  });

  it("should carry a compaction on a working turn's frame as well", async () => {
    // Arrange
    const live = subject({ pane: pane(COMPACTING_PANE) });

    // Act
    const sampled = await live.sample();

    // Assert
    should(sampled?.turnStartedAt).equal(TURN_START);
    should(sampled?.compaction).containDeep({ phase: 'running' });
  });

  it('should keep working when the history cannot be read or written', async () => {
    // Arrange
    const file = await transcriptFile();
    const live = subject(
      {
        file,
        state: idleState(),
        pane: pane(COMPACTING_PANE),
        tail: { kind: 'read', events: [contextUsage(-20, 90)] },
      },
      [],
      true,
    );
    live.clock.now = at30;
    const running = await live.sample();

    // Act
    await appendFile(file, '{"boundary":true}\n');
    live.script.pane = pane(IDLE_PANE);
    live.script.tail = { kind: 'read', events: [contextUsage(-20, 90), boundary(71)] };
    live.clock.now = at71;
    const done = await live.sample();

    // Assert — an unreadable history is an empty one: `typical`, and the end is still reported.
    should(running?.compaction).containDeep({ phase: 'running', basis: 'typical' });
    should(done?.compaction).containDeep({ phase: 'done', startedAt: at30 });
    should(live.history).have.length(0);
  });

  it('should work with no history port at all', async () => {
    // Arrange — the same journey, over a source built without a history.
    const file = await transcriptFile();
    const events: TranscriptEvent[] = [contextUsage(-20, 90), boundary(71)];
    const source = new StorageLiveActivitySource(
      {
        readState: async () => idleState(),
        paneState: async () => pane(COMPACTING_PANE),
        transcriptFile: async () => file,
      },
      { tail: async () => ({ kind: 'read', events: [events[0] as TranscriptEvent] }) },
      { now: () => at30 },
    );
    const signal = new AbortController().signal;

    // Act
    const running = await source.sample('s1', signal);

    // Assert
    should(running?.compaction).containDeep({ phase: 'running', basis: 'typical' });
  });
});
