import { describe, it } from 'bun:test';
import should from 'should';
import { at } from './fixtures.ts';
import {
  decideWait,
  type IWaitIo,
  renderWaitOutcome,
  type WaitNotices,
  WaitController,
  type WaitObservation,
  type WaitState,
  waitExitCode,
} from '../../../cli/lib/wait.ts';

/**
 * The ways a wait ends, and the one way it does not. A script blocking on a helper must not carry on after a failure as
 * though the work had been done, so "the work finished", "the ferret ended", "a human is needed" and "I gave up" each
 * have their own exit code, and every case below pins one of them apart from the others.
 */

const FRESH: WaitNotices = { missingMarker: false };

const ferret = (overrides: Partial<WaitState> = {}): WaitState => ({
  state: 'working',
  finished: false,
  summary: undefined,
  needsHuman: false,
  ...overrides,
});

const observe = (overrides: Partial<WaitObservation> = {}): WaitObservation => ({
  ferret: ferret(),
  expired: false,
  ...overrides,
});

describe('decideWait without a deliverable', () => {
  it('should settle when a stopped ferret handed its result back', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ ferret: ferret({ state: 'stopped', finished: true, summary: 'all done' }) }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'settled', reason: 'completed' });
    should(waitExitCode(outcome as never)).equal(0);
  });

  it('should report a ferret that stopped without a result as an ending, not a success', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ ferret: ferret({ state: 'stopped', finished: true }) }), FRESH);

    // Assert
    should(outcome).eql({ kind: 'ended', state: 'stopped' });
    should(waitExitCode(outcome as never)).equal(1);
  });

  it('should distinguish a ferret parked on a person from one that ended', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ ferret: ferret({ state: 'idle', needsHuman: true }) }), FRESH);

    // Assert: nothing is broken, and nothing will happen either until somebody replies.
    should(outcome).eql({ kind: 'needs-attention', state: 'idle' });
    should(waitExitCode(outcome as never)).equal(3);
  });

  it('should give up when the deadline passes while the ferret is still going', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ expired: true }), FRESH);

    // Assert: 124 is what `timeout(1)` reports.
    should(outcome).eql({ kind: 'timed-out', state: 'working' });
    should(waitExitCode(outcome as never)).equal(124);
  });

  it.each(['starting', 'working', 'idle'] as const)('should keep waiting on a %s ferret', state => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ ferret: ferret({ state }) }), FRESH);

    // Assert
    should(outcome).eql({ kind: 'keep-waiting' });
  });
});

describe('decideWait with a deliverable', () => {
  const marker = (present: boolean) => ({ path: '/work/done.md', present });

  it('should settle the moment the deliverable exists, whatever the state says', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ marker: marker(true) }), FRESH);

    // Assert
    should(outcome).eql({ kind: 'settled', reason: 'marker' });
  });

  it('should keep waiting on a result with no deliverable behind it, and say so once', () => {
    // Arrange: the ferret reported, but its file has not landed (a claim, not evidence)
    const subject = observe({
      ferret: ferret({ state: 'stopped', finished: true, summary: 'done' }),
      marker: marker(false),
    });

    // Act
    const first = decideWait(subject, FRESH);
    const second = decideWait(subject, first.notices);

    // Assert
    should(first.outcome.kind).equal('keep-waiting');
    should((first.outcome as { note?: string }).note).match(/reported but \/work\/done\.md is not there yet/);
    should(second.outcome).eql({ kind: 'keep-waiting' });
  });

  it('should fail when the ferret ended and the deliverable never appeared', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ ferret: ferret({ state: 'stopped', finished: true }), marker: marker(false) }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'ended', state: 'stopped', marker: '/work/done.md' });
    should(waitExitCode(outcome as never)).equal(1);
  });

  it('should hand control back when a human is needed, since the deliverable can never appear alone', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ ferret: ferret({ state: 'idle', needsHuman: true }), marker: marker(false) }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'needs-attention', state: 'idle' });
  });

  it('should time out rather than block forever on a deliverable that never lands', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ marker: marker(false), expired: true }), FRESH);

    // Assert
    should(outcome).eql({ kind: 'timed-out', state: 'working' });
  });

  it('should keep waiting silently on an ordinary working ferret', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ marker: marker(false) }), FRESH);

    // Assert
    should(outcome).eql({ kind: 'keep-waiting' });
  });
});

describe('renderWaitOutcome', () => {
  it('should explain every ending except a settled one', () => {
    // Arrange / Act / Assert
    should(renderWaitOutcome({ kind: 'settled', reason: 'completed' })).be.undefined();
    should(renderWaitOutcome({ kind: 'ended', state: 'stopped' })).match(/ended \(stopped\) without reporting/);
    should(renderWaitOutcome({ kind: 'ended', state: 'stopped', marker: '/work/done.md' })).match(
      /is stopped and \/work\/done\.md never appeared/,
    );
    should(renderWaitOutcome({ kind: 'needs-attention', state: 'idle' })).match(/needs a human/);
    should(renderWaitOutcome({ kind: 'timed-out', state: 'working' })).match(/gave up while the ferret was still/);
    should(renderWaitOutcome({ kind: 'timed-out' })).match(/before the daemon returned a ferret state/);
    should(
      renderWaitOutcome({ kind: 'daemon-unavailable', failure: 'unresponsive', detail: 'request deadline passed' }),
    ).match(/^the daemon became unresponsive: request deadline passed/);
  });

  it('should give daemon loss its own script-visible exit', () => {
    // Arrange
    const outcome = { kind: 'daemon-unavailable', failure: 'unavailable', detail: 'connection refused' } as const;

    // Act / Assert: an ended ferret is 1 and a caller timeout is 124; daemon loss is neither.
    should(waitExitCode(outcome)).equal(69);
  });
});

// ─── the poll loop ───────────────────────────────────────────────────────────────────────────────────────────────

type Result = { id: string; state: 'starting' | 'working' | 'idle' | 'stopped'; finished: boolean; summary?: string };

function loop(results: Array<Result | Error>, options: { marker?: boolean[]; lead?: string; table?: unknown[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | undefined;
  const io: IWaitIo = {
    success: message => void out.push(message),
    error: message => void err.push(message),
    setExitCode: value => void (code = value),
  };
  let now = 0;
  const sleeps: number[] = [];
  const stops: Array<[string, string]> = [];
  const asked: string[] = [];
  const markers = [...(options.marker ?? [])];
  const controller = new WaitController(
    {
      result: async id => {
        asked.push(id);
        const next = results.length > 1 ? results.shift() : results[0];
        if (next instanceof Error) throw next;
        return next as Result;
      },
      table: async () => {
        const next = options.table?.shift();
        return (next ?? { root: { id: 'lead', name: 'lead' }, at: at('2026-11-03T12:00:00.000Z'), endedWindowMs: 0, rows: [] }) as never;
      },
      stop: async (id, reason) => void stops.push([id, reason]),
    },
    io,
    {
      nowMs: () => now,
      sleep: async ms => {
        sleeps.push(ms);
        now += ms;
      },
    },
    { exists: async () => (markers.length > 1 ? markers.shift() : markers[0]) === true, resolve: path => `/work/${path}` },
    'foo',
    options.lead,
  );
  return { controller, out, err, sleeps, stops, asked, code: () => code };
}

describe('WaitController', () => {
  it('should wait on the ladder (1 s, 2 s, 3 s) and print the result of a ferret that reported', async () => {
    // Arrange
    const run = loop([
      { id: 'c1', state: 'working', finished: false },
      { id: 'c1', state: 'working', finished: false },
      { id: 'c1', state: 'working', finished: false },
      { id: 'c1', state: 'stopped', finished: true, summary: 'the answer' },
    ]);

    // Act
    await run.controller.wait('c1', {});

    // Assert
    should(run.sleeps).eql([1_000, 2_000, 3_000]);
    should(run.out).eql(['c1 is stopped\n\nthe answer']);
    should(run.code()).equal(0);
    should(run.err).eql([]);
  });

  it('should ask on a fixed interval when one is named', async () => {
    // Arrange
    const run = loop([
      { id: 'c1', state: 'idle', finished: false },
      { id: 'c1', state: 'stopped', finished: true, summary: 'x' },
    ]);

    // Act
    await run.controller.wait('c1', { interval: 7 });

    // Assert
    should(run.sleeps).eql([7_000]);
  });

  it('should exit 1 for a ferret that stopped without a result, saying so on stderr', async () => {
    // Arrange
    const run = loop([{ id: 'c1', state: 'stopped', finished: true }]);

    // Act
    await run.controller.wait('c1', {});

    // Assert
    should(run.code()).equal(1);
    should(run.err).eql(['foo wait: the ferret ended (stopped) without reporting a result']);
  });

  it('should exit 124 once the caller’s deadline passes', async () => {
    // Arrange
    const run = loop([{ id: 'c1', state: 'working', finished: false }]);

    // Act
    await run.controller.wait('c1', { timeout: 2 });

    // Assert
    should(run.code()).equal(124);
    should(run.err[0]).match(/gave up while the ferret was still working/);
    should(run.sleeps.reduce((a, b) => a + b, 0)).equal(2_000);
  });

  it('should exit 3 when the lead’s pack table says the ferret needs a person', async () => {
    // Arrange
    const table = {
      root: { id: 'lead', name: 'lead' },
      at: at('2026-11-03T12:00:00.000Z'),
      endedWindowMs: 0,
      rows: [{ id: 'c1', name: 'c1', depth: 1, model: 'x', state: 'needs-you', ferretState: 'idle' }],
    };
    const run = loop([{ id: 'c1', state: 'idle', finished: false }], { lead: 'lead', table: [table] });

    // Act
    await run.controller.wait('c1', {});

    // Assert
    should(run.code()).equal(3);
  });

  it('should exit 69 when the daemon cannot be reached, and 124 when the deadline passed meanwhile', async () => {
    // Arrange
    const lost = loop([new Error('connection refused')]);
    const slow = loop([new Error('connection refused')]);

    // Act
    await lost.controller.wait('c1', {});
    await slow.controller.wait('c1', { timeout: 1 });

    // Assert
    should(lost.code()).equal(69);
    should(lost.err[0]).equal('foo wait: the daemon became unavailable: connection refused');
    should(slow.code()).equal(69);
  });

  it('should rethrow a refusal from the daemon, such as an unknown ferret', async () => {
    // Arrange
    const refusal = Object.assign(new Error('no ferret nope'), { status: 404, code: 'not-found' });
    const run = loop([refusal]);

    // Act
    const failure = await run.controller.wait('nope', {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).equal(refusal);
  });

  it('should settle on the deliverable and stop a ferret still running unless --keep', async () => {
    // Arrange
    const stopped = loop([{ id: 'c1', state: 'working', finished: false, summary: 'partial' }], { marker: [true] });
    const kept = loop([{ id: 'c1', state: 'working', finished: false }], { marker: [true] });

    // Act
    await stopped.controller.wait('c1', { untilMarker: 'out.md' });
    await kept.controller.wait('c1', { untilMarker: 'out.md', keep: true });

    // Assert
    should(stopped.code()).equal(0);
    should(stopped.stops).eql([['c1', 'its result was collected']]);
    should(stopped.err[0]).match(/stopped c1 now its result is collected/);
    should(kept.stops).eql([]);
  });

  it('should print JSON when asked', async () => {
    // Arrange
    const run = loop([{ id: 'c1', state: 'stopped', finished: true, summary: 'ok' }]);

    // Act
    await run.controller.wait('c1', { json: true });

    // Assert
    should(JSON.parse(run.out[0] ?? '')).eql({ id: 'c1', state: 'stopped', finished: true, result: 'ok' });
  });

  it('should refuse a timeout or interval that is not a whole positive number', async () => {
    // Arrange
    const run = loop([{ id: 'c1', state: 'working', finished: false }]);

    // Act
    const failure = await run.controller.wait('c1', { timeout: 0 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should((failure as Error).message).equal('--timeout must be a positive integer');
  });
});
