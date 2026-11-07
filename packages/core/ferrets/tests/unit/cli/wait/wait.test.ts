import { describe, expect, test } from 'bun:test';
import type { FerretSummary } from '../../../../contract/index.ts';
import { WaitController, type WaitPorts } from '../../../../cli/lib/wait/controller.ts';
import { decideWait } from '../../../../cli/lib/wait/decide.ts';
import { sessionView } from '../session/session-fixtures.ts';

/** Today's `fy wait` (reads/wait.ts, reads/controller.ts) over Ferrets' four states. */

const fresh = { missingMarker: false, declaredWait: false };
const at = (overrides: Partial<FerretSummary>) => sessionView({ id: 'lead', ...overrides });
const decide = (ferret: FerretSummary, extra: { marker?: { path: string; present: boolean }; expired?: boolean } = {}) =>
  decideWait({ ferret, expired: extra.expired ?? false, ...(extra.marker === undefined ? {} : { marker: extra.marker }) }, fresh)
    .outcome;
const FINISHED = '2026-11-06T09:00:00.000Z' as FerretSummary['finishedAt'];

describe('what a poll decides', () => {
  test('V-wait a ferret that said done settles; one stopped without saying it ended', () => {
    expect(decide(at({ state: 'stopped', finishedAt: FINISHED }))).toEqual({ kind: 'settled', reason: 'completed' });
    expect(decide(at({ state: 'stopped' }))).toEqual({ kind: 'ended', state: 'stopped' });
  });

  test('V-wait a working ferret keeps the wait going; an idle one with no declared wait needs a human', () => {
    expect(decide(at({ state: 'working' })).kind).toBe('keep-waiting');
    expect(decide(at({ state: 'starting' })).kind).toBe('keep-waiting');
    expect(decide(at({ state: 'idle' }))).toEqual({ kind: 'needs-attention', state: 'idle' });
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

function world(script: readonly (FerretSummary | Error)[], present = false) {
  let time = 0;
  const asked: number[] = [];
  const slept: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  let index = 0;
  const ports: WaitPorts = {
    get: async () => {
      asked.push(time);
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next as FerretSummary;
    },
    markerExists: async () => present,
    nowMs: () => time,
    sleep: async ms => {
      slept.push(ms);
      time += ms;
    },
    transport: error => ((error as { lost?: boolean }).lost === true ? 'unavailable' : undefined),
  };
  const controller = new WaitController(ports, { success: t => out.push(t), error: t => err.push(t), setExitCode: c => (code = c) }, 'fy');
  return { controller, slept, out, err, code: () => code };
}

describe('the wait loop', () => {
  test('V-wait finishing exits 0 and prints the state; the sleeps start soon and slow to every 5 s', async () => {
    const w = world([at({ state: 'working' }), at({ state: 'working' }), at({ state: 'working' }), at({ state: 'working' }), at({ state: 'working' }), at({ state: 'stopped', finishedAt: FINISHED })]);
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

  test('V-wait exit codes: ended 1, needs a human 3, timeout 124, daemon lost 69', async () => {
    const ended = world([at({ state: 'stopped' })]);
    await ended.controller.wait('lead', {});
    expect(ended.code()).toBe(1);
    expect(ended.err.join()).toContain('without saying it was done');
    const idle = world([at({ state: 'idle' })]);
    await idle.controller.wait('lead', {});
    expect(idle.code()).toBe(3);
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
    await expect(world([]).controller.wait('lead', { timeout: 0 })).rejects.toThrow('--timeout must be a positive integer');
    await expect(world([]).controller.wait('lead', { interval: 1.5 })).rejects.toThrow('--interval must be a positive integer');
  });
});
