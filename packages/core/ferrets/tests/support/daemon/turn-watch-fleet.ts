import { afterEach } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type {
  FerretId,
  FerretRecord,
  HarnessTailRecord,
  HarnessTranscriptStamp,
  HarnessTranscriptTail,
  RunnerHandle,
} from '../../../contract/index.ts';
import { FakeHarness, FakeRunner, T0 as RECORD_T0 } from '../../../contract/testing/index.ts';
import { HarnessTranscript } from '../../../daemon/adapters/session/live/harness-transcript.ts';
import { buildTurnWatch } from '../../../daemon/modules/turn-watch.ts';
import { TURN_WATCH_INTERVAL_MS } from '../../../daemon/lib/session/peers/turn.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import { memoryStorage, RecordingLog, sessionConfig } from './storage.ts';

/**
 * The inline turn watch's fixture fleet (RULING #44): fake panes over the real session store in memory, with a
 * transcript tail that costs what Claude's does. The unit file counts looks and tail parses on it; the perf file
 * holds the CPU and slice budgets, through the hooks, so no clock is read here.
 */

export const WARM_TICKS = 10;
/** When the fleet's first tick looks; each tick after it is one 2 s interval later. */
export const FLEET_NOW = '2026-11-08T10:00:00.000Z';
export const MEASURED_TICKS = 30; // one minute of 2 s ticks

/** About one 512 KB window of a Claude transcript: ~300 records of ~1.7 KB, each one parsed on every read. */
const TAIL_LINES = 300;
const RECORD_LINE_BYTES = 1_700;

/**
 * A harness whose transcript tail costs what Claude's costs: it parses every line of the window on each read and counts
 * the reads. The stamp is the file's size/mtime, which a test moves by `grow`.
 */
class TailHarness extends FakeHarness {
  reads = 0;
  readonly #sizes = new Map<FerretId, number>();
  readonly #lines: readonly string[];

  /** `openTurn`: the tail ends on the agent's reply with no turn boundary, as the fake Claude writes it. */
  constructor(openTurn = false) {
    super();
    const at = new Date(RECORD_T0).toISOString();
    // The last line (odd) is the turn boundary, or with `openTurn` the reply it would have followed.
    const boundary = (index: number) => !openTurn && index === TAIL_LINES - 1;
    this.#lines = Array.from({ length: TAIL_LINES }, (_, index) =>
      JSON.stringify({
        kind: boundary(index) ? 'turn' : index % 2 === 0 ? 'work' : 'message',
        ...(boundary(index) ? { state: 'completed' } : index % 2 === 0 ? {} : { role: 'assistant' }),
        at,
        pad: 'x'.repeat(RECORD_LINE_BYTES),
      }),
    );
  }

  grow(ferret: FerretId): void {
    this.#sizes.set(ferret, (this.#sizes.get(ferret) ?? 1_000) + 1);
  }

  override async transcriptStamp(ferret: FerretId): Promise<HarnessTranscriptStamp | undefined> {
    const size = this.#sizes.get(ferret) ?? 1_000;
    return { file: `/t/${ferret}.jsonl`, size, mtimeMs: size };
  }

  override async transcriptTail(_ferret: FerretId, limit: number): Promise<HarnessTranscriptTail> {
    this.reads += 1;
    const records = this.#lines.map(line => {
      const { pad: _pad, ...record } = JSON.parse(line) as HarnessTailRecord & { pad: string };
      return record as HarnessTailRecord;
    });
    return { kind: 'read', records: records.slice(-limit) };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The timing hooks a perf file reads its clock in: before a hand-back, after it, and as a tick begins. */
export interface FleetHooks {
  readonly yielding?: () => void;
  readonly resumed?: () => void;
  readonly ticking?: () => void;
}

/** What a test may set beyond the recorded turn: the registry state it starts on, and who hears `turnObserved`. */
export interface FleetOptions {
  /** The registry state every ferret starts on; absent: the one its recorded turn says. */
  readonly registry?: 'working' | 'idle';
  /** When the registry state was last moved (a launch); absent: the fixture's T0, long before the first look. */
  readonly stateAt?: Instant;
  /** The transcript tail ends on a reply with no turn boundary (the fake Claude's), so a prompt is an unconfirmed look. */
  readonly openTurn?: boolean;
  readonly turnObserved?: (ferret: FerretId, turn: 'working' | 'your-turn' | 'needs-input') => Promise<void>;
}

export async function fleetOf(
  turnState: 'your-turn' | 'working' | 'needs-input',
  ferrets = 30,
  hooks: FleetHooks = {},
  options: FleetOptions = {},
) {
  const { storage } = await memoryStorage({ clock: { now: () => new Date(RECORD_T0).toISOString() } });
  cleanups.push(async () => await storage.close());
  const runner = Object.assign(new FakeRunner(), { requireFerret: true });
  const harness = new TailHarness(options.openTurn);
  const transcripts = new HarnessTranscript(
    () => harness,
    () => 'claude-code',
  );
  const records = new Map<string, FerretRecord>();
  for (let index = 0; index < ferrets; index += 1) {
    const id = parseSessionId(`budget-${String(index).padStart(2, '0')}`);
    await storage.writeConfig(id, sessionConfig(id));
    await storage.writeState(id, { id, status: 'running', turn: 1, turnState });
    records.set(id, {
      format: 1,
      id: id as unknown as FerretId,
      name: id,
      role: 'lead',
      harness: 'claude-code',
      runner: 'tmux',
      folder: `/work/${id}`,
      state: options.registry ?? (turnState === 'working' ? 'working' : 'idle'),
      handle: runner.adoptable(id as unknown as FerretId),
      createdAt: RECORD_T0,
      stateAt: options.stateAt ?? RECORD_T0,
    } as FerretRecord);
  }
  let nowMs = Date.parse(FLEET_NOW);
  const { host } = buildTurnWatch({
    storage,
    tail: transcripts.tail,
    record: ferret => records.get(ferret),
    runner: () => runner,
    turnObserved: options.turnObserved ?? (async () => undefined),
    clock: { now: () => new Date(nowMs).toISOString() },
    every: () => () => undefined,
    yieldToLoop: async () => {
      hooks.yielding?.();
      await new Promise<void>(resolve => queueMicrotask(resolve));
      hooks.resumed?.();
    },
    log: new RecordingLog(),
  });
  const tick = async (frame: (handle: RunnerHandle, tick: number) => void, n: number) => {
    for (const record of records.values()) frame(record.handle as RunnerHandle, n);
    hooks.ticking?.();
    await host.turns.run();
    nowMs += TURN_WATCH_INTERVAL_MS;
  };
  return {
    runner,
    harness,
    records,
    tick,
  };
}
