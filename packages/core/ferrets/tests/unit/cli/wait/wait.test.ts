import { describe, expect, test } from 'bun:test';
import type { FerretSummary, FyEvent } from '../../../../contract/index.ts';
import { WaitController, type WaitPorts } from '../../../../cli/lib/wait/controller.ts';
import { decideWait, renderWaitOutcome } from '../../../../cli/lib/wait/decide.ts';
import { sessionView } from '../session/session-fixtures.ts';

/** Today's `fy wait` (reads/wait.ts, reads/controller.ts) over Ferrets' four states. */

const fresh = { missingMarker: false, declaredWait: false, idle: false };
const at = (overrides: Partial<FerretSummary>) => sessionView({ id: 'lead', ...overrides });
const decide = (
  ferret: FerretSummary,
  extra: { marker?: { path: string; present: boolean }; expired?: boolean } = {},
) =>
  decideWait(
    { ferret, expired: extra.expired ?? false, ...(extra.marker === undefined ? {} : { marker: extra.marker }) },
    fresh,
  ).outcome;
const FINISHED = '2026-11-06T09:00:00.000Z' as FerretSummary['finishedAt'];

describe('what a poll decides', () => {
  test('V-wait a ferret that said done settles; one stopped without saying it ended', () => {
    expect(decide(at({ state: 'stopped', finishedAt: FINISHED }))).toEqual({ kind: 'settled', reason: 'completed' });
    expect(decide(at({ state: 'stopped' }))).toEqual({ kind: 'ended', state: 'stopped' });
  });

  test('V-wait a working ferret keeps the wait going, and so does an idle one between turns (C-38)', () => {
    expect(decide(at({ state: 'working' })).kind).toBe('keep-waiting');
    expect(decide(at({ state: 'starting' })).kind).toBe('keep-waiting');
    expect(decide(at({ state: 'idle' })).kind).toBe('keep-waiting');
    // With a deliverable named, an idle ferret does not end the wait either: the file or the deadline does.
    expect(decide(at({ state: 'idle' }), { marker: { path: 'out.md', present: false } }).kind).toBe('keep-waiting');
    expect(decide(at({ state: 'idle' }), { expired: true })).toEqual({ kind: 'timed-out', state: 'idle' });
  });

  test('V-wait an idle ferret says once that it is between turns, then keeps quiet (C-38)', () => {
    const idle = at({ state: 'idle' });
    const first = decideWait({ ferret: idle, expired: false }, fresh);
    expect(first.outcome).toMatchObject({ kind: 'keep-waiting', note: expect.stringContaining('idle between turns') });
    expect(decideWait({ ferret: idle, expired: false }, first.notices).outcome).toEqual({ kind: 'keep-waiting' });
  });

  test('V-wait a declared wait is not stuck: the daemon wakes the ferret, and the note is said once', () => {
    const parked = at({ state: 'idle', waiting: { since: '2026-11-06T09:00:00.000Z', condition: 'CI' } } as never);
    const first = decideWait({ ferret: parked, expired: false }, fresh);
    expect(first.outcome).toMatchObject({ kind: 'keep-waiting', note: expect.stringContaining('on CI') });
    const second = decideWait({ ferret: parked, expired: false }, first.notices);
    expect(second.outcome).toEqual({ kind: 'keep-waiting' });
  });

  test('V-wait the caller’s deadline times a running ferret out', () => {
    expect(decide(at({ state: 'working' }), { expired: true })).toEqual({ kind: 'timed-out', state: 'working' });
  });

  test('V-wait a named deliverable is the ground truth over a claim of done', () => {
    const done = at({ state: 'stopped', finishedAt: FINISHED });
    expect(decide(done, { marker: { path: 'out.md', present: true } })).toEqual({ kind: 'settled', reason: 'marker' });
    expect(decide(done, { marker: { path: 'out.md', present: false } }).kind).toBe('keep-waiting');
    expect(decide(done, { marker: { path: 'out.md', present: false }, expired: true }).kind).toBe('timed-out');
    expect(decide(at({ state: 'stopped' }), { marker: { path: 'out.md', present: false } })).toEqual({
      kind: 'ended',
      state: 'stopped',
      marker: 'out.md',
    });
  });
});

/** A journal event as the daemon serves it. */
const journal = (sequence: number, type: string, data: unknown = {}): FyEvent => ({
  sequence,
  time: '2026-11-06T09:00:00.000Z' as FyEvent['time'],
  sessionId: 'lead',
  type,
  source: 'journal',
  data,
});

/** `events`: what the journal holds at each read, in order (the last one repeats); a read is `after` its cursor. */
function world(
  script: readonly (FerretSummary | Error)[],
  present = false,
  events: readonly (readonly FyEvent[])[] = [],
) {
  let time = 0;
  const asked: number[] = [];
  const slept: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  let index = 0;
  let reads = 0;
  const cursors: number[] = [];
  const ports: WaitPorts = {
    events: async (_reference, after) => {
      cursors.push(after);
      const held = events[Math.min(reads, events.length - 1)] ?? [];
      reads += 1;
      return held.filter(event => event.sequence > after);
    },
    get: async () => {
      asked.push(time);
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next as FerretSummary;
    },
    markerExists: async () => present,
    startDeadline: () => ({ signal: new AbortController().signal, cancel: () => undefined }),
    nowMs: () => time,
    sleep: async ms => {
      slept.push(ms);
      time += ms;
    },
    transport: error => ((error as { lost?: boolean }).lost === true ? 'unavailable' : undefined),
  };
  const controller = new WaitController(
    ports,
    { success: t => out.push(t), error: t => err.push(t), setExitCode: c => (code = c) },
    'fy',
  );
  return { controller, ports, slept, out, err, cursors, code: () => code };
}

describe('the wait loop', () => {
  test('V-wait finishing exits 0 and prints the state; the sleeps start soon and slow to every 5 s', async () => {
    const w = world([
      at({ state: 'working' }),
      at({ state: 'working' }),
      at({ state: 'working' }),
      at({ state: 'working' }),
      at({ state: 'working' }),
      at({ state: 'stopped', finishedAt: FINISHED }),
    ]);
    await w.controller.wait('lead', {});
    expect(w.code()).toBe(0);
    expect(w.slept).toEqual([1_000, 2_000, 3_000, 5_000, 5_000]);
    expect(w.out).toEqual(['lead is stopped']);
  });

  test('V-wait a ferret that moved starts the ladder again', async () => {
    const w = world([
      at({ state: 'working' }),
      at({ state: 'working' }),
      at({ state: 'working', stateAt: '2026-11-06T09:05:00.000Z' as never }),
      at({ state: 'stopped', finishedAt: FINISHED }),
    ]);
    await w.controller.wait('lead', {});
    expect(w.slept).toEqual([1_000, 2_000, 1_000]);
  });

  test('V-wait exit codes: ended 1, timeout 124, daemon lost 69; an idle ferret is never an exit (C-38)', async () => {
    const ended = world([at({ state: 'stopped' })]);
    await ended.controller.wait('lead', {});
    expect(ended.code()).toBe(1);
    expect(ended.err.join()).toContain('without saying it was done');
    const idle = world([at({ state: 'idle' }), at({ state: 'idle' }), at({ state: 'stopped', finishedAt: FINISHED })]);
    await idle.controller.wait('lead', {});
    expect(idle.code()).toBe(0);
    expect(idle.err.join()).toContain('idle between turns');
    const slow = world([at({ state: 'working' })]);
    await slow.controller.wait('lead', { timeout: 3, interval: 1 });
    expect(slow.code()).toBe(124);
    expect(slow.slept).toEqual([1_000, 1_000, 1_000]);
    const lost = world([at({ state: 'working' }), Object.assign(new Error('refused'), { lost: true })]);
    await lost.controller.wait('lead', {});
    expect(lost.code()).toBe(69);
    expect(lost.err.join()).toContain('the daemon became unavailable');
  });

  test('V-wait an answer that is not a lost daemon is the caller’s to see, not an exit code', async () => {
    const w = world([new Error('no such ferret')]);
    await expect(w.controller.wait('nobody', {})).rejects.toThrow('no such ferret');
  });

  test('V-wait --json prints the summary on one line; a zero or fractional --timeout is refused', async () => {
    const w = world([at({ state: 'stopped', finishedAt: FINISHED })]);
    await w.controller.wait('lead', { json: true });
    expect(JSON.parse(w.out[0] as string)).toMatchObject({ id: 'lead', state: 'stopped' });
    await expect(world([]).controller.wait('lead', { timeout: 0 })).rejects.toThrow(
      '--timeout must be a positive integer',
    );
    await expect(world([]).controller.wait('lead', { interval: 1.5 })).rejects.toThrow(
      '--interval must be a positive integer',
    );
  });
});

describe('a ferret that asks for a person ends the wait (G13 review)', () => {
  const ASK = journal(7, 'interaction.help', { reason: 'which database?' });

  test('V-wait an idle ferret keeps the wait going, then a signal help ends it with exit 3 and the question', async () => {
    const w = world(
      [at({ state: 'idle' }), at({ state: 'idle' }), at({ state: 'idle' }), at({ state: 'idle' })],
      false,
      // The baseline read, a quiet poll, then the ferret asks (an interactive ferret stays idle: only the journal says so).
      [[journal(1, 'session.started')], [journal(1, 'session.started')], [journal(1, 'session.started'), ASK]],
    );
    await w.controller.wait('lead', {});
    expect(w.code()).toBe(3);
    expect(w.err.join('\n')).toContain('asking for a person: which database?');
    expect(w.slept).toHaveLength(2);
    // Each read continues from the last sequence it saw.
    expect(w.cursors).toEqual([0, 1, 1]);
  });

  test('V-wait a request already in the journal when the wait began was seen by whoever began it', async () => {
    const w = world(
      [at({ state: 'idle' }), at({ state: 'idle' }), at({ state: 'stopped', finishedAt: FINISHED })],
      false,
      [[ASK]],
    );
    await w.controller.wait('lead', {});
    expect(w.code()).toBe(0);
  });

  test('V-wait a request ends a wait that names a deliverable too, and an ended ferret still ends it as ended', async () => {
    const asked = world([at({ state: 'working' }), at({ state: 'working' })], false, [[], [ASK]]);
    await asked.controller.wait('lead', { untilMarker: 'out.md' });
    expect(asked.code()).toBe(3);
    const died = world([at({ state: 'working' }), at({ state: 'stopped' })], false, [[], [ASK]]);
    await died.controller.wait('lead', {});
    expect(died.code()).toBe(1);
  });

  test('V-wait a journal that cannot be read leaves the wait as it was', async () => {
    const w = world([at({ state: 'idle' }), at({ state: 'stopped', finishedAt: FINISHED })]);
    w.ports.events = async () => {
      throw new Error('no journal');
    };
    await w.controller.wait('lead', {});
    expect(w.code()).toBe(0);
  });
});

describe('the deadline bounds a read in flight', () => {
  test('V-wait --timeout ends 124 at the deadline when the daemon never answers the read, and the read was handed the deadline signal', async () => {
    const deadline = new AbortController();
    let cancelled = false;
    let handed: AbortSignal | undefined;
    let code = 0;
    const err: string[] = [];
    const ports: WaitPorts = {
      events: async () => [],
      // A hung daemon: the read settles only when its signal aborts, as the client's read does.
      get: async (_reference, signal) => {
        handed = signal;
        queueMicrotask(() => deadline.abort());
        return await new Promise<FerretSummary>((_resolve, reject) =>
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('abandoned'), { name: 'AbortError' })),
          ),
        );
      },
      markerExists: async () => false,
      startDeadline: () => ({ signal: deadline.signal, cancel: () => (cancelled = true) }),
      nowMs: () => 0,
      sleep: async () => undefined,
      transport: () => 'unresponsive',
    };
    const controller = new WaitController(
      ports,
      { success: () => undefined, error: t => err.push(t), setExitCode: c => (code = c) },
      'fy',
    );
    await controller.wait('lead', { timeout: 5 });
    expect(handed).toBe(deadline.signal);
    expect(code).toBe(124);
    expect(cancelled).toBe(true);
  });
});

describe('how an ended wait is explained', () => {
  test('a ferret that ended without its named deliverable says the deliverable never appeared', () => {
    expect(renderWaitOutcome({ kind: 'ended', state: 'stopped', marker: 'out.md' })).toBe(
      'the ferret is stopped and out.md never appeared',
    );
  });
});
