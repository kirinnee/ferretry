import { describe, expect, test } from 'bun:test';
import {
  armOnSend,
  arrivalsAfter,
  IDLE_WATCH,
  LEGACY_QUIET_MS,
  observeTurn,
  TEXT_SETTLED_MS,
  type TurnWatch,
  type WatchInput,
} from '../../src/lib/voice-chat/auto-read.ts';

const T = 1_000_000;
const look = (watch: TurnWatch, input: Partial<WatchInput>) =>
  observeTurn(watch, {
    now: T,
    turn: 'your-turn',
    turnAt: null,
    legacy: false,
    quietMs: 10_000,
    visible: true,
    fresh: 0,
    sentRow: false,
    ...input,
  });
/** The daemon's clock for a short, readable scenario. */
const at = (ms: number): number => T + ms;

describe('observeTurn: a turn we saw end', () => {
  test("working arms the watch with the daemon's own start time", () => {
    const step = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 });
    expect(step.watch.armed).toEqual({ startedAt: T - 5000, after: T - 5000, floor: null, row: true, working: true });
    expect(step.fire).toBeNull();
  });

  test('working then your-turn, later than the start, fires once the text has settled', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const step = look(armed, { turn: 'your-turn', turnAt: T, quietMs: TEXT_SETTLED_MS });
    expect(step.fire).toEqual({ startedAt: T - 5000, outcome: 'your-turn' });
    expect(step.watch.armed).toBeNull();
  });

  test('needs-input fires with its own outcome', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    expect(look(armed, { turn: 'needs-input', turnAt: T }).fire?.outcome).toBe('needs-input');
  });

  test('the same state seen again is not the end of the turn', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const step = look(armed, { turn: 'your-turn', turnAt: T - 5000 });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual(armed.armed);
  });

  test('a session already at your-turn when watching begins reads nothing', () => {
    const step = look(IDLE_WATCH, { turn: 'your-turn', turnAt: T });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toBeNull();
  });

  test('a daemon working with no usable date proves nothing', () => {
    expect(look(IDLE_WATCH, { turn: 'working', turnAt: null }).watch.armed).toBeNull();
    expect(look(IDLE_WATCH, { turn: 'working', turnAt: Number.NaN }).watch.armed).toBeNull();
  });

  test('text-settled guard: waits for 500 ms of quiet and says how long', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const early = look(armed, { turn: 'your-turn', turnAt: T, quietMs: 120 });
    expect(early.fire).toBeNull();
    expect(early.recheckInMs).toBe(380);
    expect(early.watch.armed).toEqual(armed.armed);
    expect(look(armed, { turn: 'your-turn', turnAt: T, quietMs: -50 }).recheckInMs).toBe(TEXT_SETTLED_MS);
  });

  test('a session that stops being live ends the watch without a reading', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const step = look(armed, { turn: null });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toBeNull();
  });
});

describe('armOnSend: our own send is a token taken at its initiation', () => {
  test('a send with nothing seen has no floor and no proof; nothing is compared with the browser clock', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    expect(armed.armed).toEqual({ startedAt: T, after: null, floor: null, row: false, working: false });
    // A stale your-turn is no transition; it is the old turn, and never consumes the token.
    const stale = look(armed, { turn: 'your-turn', turnAt: T - 8000 });
    expect(stale.fire).toBeNull();
    expect(stale.watch.armed).not.toBeNull();
    // With the send's own row, the next dated completion is the reply.
    expect(look(armed, { turn: 'your-turn', turnAt: T + 6000, sentRow: true }).fire).toEqual({
      startedAt: T,
      outcome: 'your-turn',
    });
  });

  test("seeing working after the floor proves the turn and re-bases the start on the daemon's clock", () => {
    const armed = armOnSend(IDLE_WATCH, T);
    const working = look(armed, { turn: 'working', turnAt: T - 30_000 });
    expect(working.watch.armed).toEqual({
      startedAt: T - 30_000,
      after: T - 30_000,
      floor: null,
      row: false,
      working: true,
    });
    expect(look(working.watch, { turn: 'your-turn', turnAt: T - 20_000 }).fire?.outcome).toBe('your-turn');
  });

  test('a non-finite time arms with none', () => {
    expect(armOnSend(IDLE_WATCH, Number.NaN).armed).toEqual({
      startedAt: null,
      after: null,
      floor: null,
      row: false,
      working: false,
    });
  });

  test('with no usable turn time on the reply, it fires once settled and proven', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    expect(look(armed, { turn: 'your-turn', turnAt: null }).fire).toBeNull();
    expect(look(armed, { turn: 'your-turn', turnAt: null, sentRow: true }).fire?.outcome).toBe('your-turn');
  });

  test('REGRESSION (round 1, #2): a newer send drops the pending reading of the older turn', () => {
    // working@1000 → your-turn@2000 waiting out its settle time → the person sends at 3000.
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const pending = look(working, { turn: 'your-turn', turnAt: at(2000), quietMs: 100 });
    expect(pending.recheckInMs).not.toBeNull();
    const resent = armOnSend(pending.watch, at(3000));
    // The stale completion@2000, long since settled, is not the reply to the new send.
    expect(look(resent, { turn: 'your-turn', turnAt: at(2000), quietMs: 9000 }).fire).toBeNull();
    // Nor does a replayed snapshot of the old working@1000 move the new turn's start or prove anything.
    expect(look(resent, { turn: 'working', turnAt: at(1000) }).watch.armed).toEqual(resent.armed);
    // The new turn does.
    const next = look(resent, { turn: 'working', turnAt: at(3500) }).watch;
    expect(look(next, { turn: 'your-turn', turnAt: at(4000) }).fire).toEqual({
      startedAt: at(3500),
      outcome: 'your-turn',
    });
  });

  test('a fast reply is the reply to the send once the send’s own row is there, even before working is seen', () => {
    const seen = look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(2000) }).watch;
    const armed = armOnSend(seen, at(3000));
    expect(armed.armed).toEqual({ startedAt: at(3000), after: at(2000), floor: at(2000), row: false, working: false });
    // The daemon's clock runs behind the browser's: its next your-turn is dated 2500, before the send time.
    expect(look(armed, { turn: 'your-turn', turnAt: at(2500), sentRow: true }).fire).toEqual({
      startedAt: at(3000),
      outcome: 'your-turn',
    });
    // The state it was already in is never a completion.
    expect(look(armed, { turn: 'your-turn', turnAt: at(2000), sentRow: true }).fire).toBeNull();
  });

  test('the send’s row, once seen, stays seen while a turn still working', () => {
    const armed = armOnSend(IDLE_WATCH, at(3000));
    // A working at or before the floor is the old turn; the row alone proves the send.
    const withRow = look(armed, { turn: 'working', turnAt: null, sentRow: true });
    expect(withRow.watch.armed).toEqual({ ...armed.armed!, row: true });
    expect(look(withRow.watch, { turn: 'your-turn', turnAt: at(4000) }).fire?.outcome).toBe('your-turn');
  });

  test('REGRESSION (round 2, #4): the previous turn’s completion arriving late, after the send, is not the reply', () => {
    // Last snapshot your-turn@1000; the previous completion@2000 arrives delayed; the send is pressed at 3000.
    const seen = look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(1000) }).watch;
    const armed = armOnSend(seen, at(3000));
    const delayed = look(armed, { turn: 'your-turn', turnAt: at(2000), quietMs: 9000 });
    expect(delayed.fire).toBeNull();
    // It did not consume the token; the floor moved up to it.
    expect(delayed.watch.armed).toEqual({ ...armed.armed!, floor: at(2000), after: at(2000) });
    // Seen again, even with the row now there, it is the state it was already in.
    expect(look(delayed.watch, { turn: 'your-turn', turnAt: at(2000), sentRow: true }).fire).toBeNull();
    // The new turn proves itself and its own completion is read.
    const next = look(delayed.watch, { turn: 'working', turnAt: at(3500) }).watch;
    expect(look(next, { turn: 'your-turn', turnAt: at(5000) }).fire?.outcome).toBe('your-turn');
  });

  test('REGRESSION (round 2, #2): pressing send reads nothing by itself, however long the session was idle', () => {
    const idle = look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(1000) }).watch;
    const armed = armOnSend(idle, at(60_000));
    const step = look(armed, { turn: 'your-turn', turnAt: at(1000), quietMs: 60_000 });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).not.toBeNull();
  });
});

describe('observeTurn: consumed is consumed', () => {
  test('REGRESSION (round 1, #5): replaying working@1000 → your-turn@2000 after reading it fires nothing', () => {
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const fired = look(working, { turn: 'your-turn', turnAt: at(2000) });
    expect(fired.fire).not.toBeNull();
    expect(fired.watch.consumed.at).toBe(at(2000));
    // A reconnect replays the same pair.
    const replayWorking = look(fired.watch, { turn: 'working', turnAt: at(1000) });
    expect(replayWorking.watch.armed).toBeNull();
    const replayDone = look(replayWorking.watch, { turn: 'your-turn', turnAt: at(2000) });
    expect(replayDone.fire).toBeNull();
    // A genuinely newer turn is still read.
    const next = look(replayDone.watch, { turn: 'working', turnAt: at(5000) }).watch;
    expect(look(next, { turn: 'your-turn', turnAt: at(6000) }).fire).not.toBeNull();
  });

  test('the watermark survives the session going quiet and not live', () => {
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const fired = look(working, { turn: 'your-turn', turnAt: at(2000) }).watch;
    const gone = look(fired, { turn: null }).watch;
    expect(gone.consumed.at).toBe(at(2000));
    expect(look(gone, { turn: 'working', turnAt: at(1000) }).watch.armed).toBeNull();
  });

  test('a send after a reading compares with the newest state it consumed', () => {
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const fired = look(working, { turn: 'your-turn', turnAt: at(2000) }).watch;
    expect(armOnSend(fired, at(1500)).armed).toEqual({
      startedAt: at(1500),
      after: at(2000),
      floor: at(2000),
      row: false,
      working: false,
    });
  });
});

describe('observeTurn: a completion seen while the tab is hidden is never read', () => {
  test('REGRESSION (round 1, #6): the turn ends hidden; coming back before the timer would fire reads nothing', () => {
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const hidden = look(working, { turn: 'your-turn', turnAt: at(2000), quietMs: 10, visible: false });
    expect(hidden.fire).toBeNull();
    expect(hidden.recheckInMs).toBeNull();
    expect(hidden.watch.armed).toBeNull();
    // Back on screen, with the text long since settled.
    const back = look(hidden.watch, { turn: 'your-turn', turnAt: at(2000), quietMs: 9000, visible: true });
    expect(back.fire).toBeNull();
  });

  test('a completion that was pending when the tab hid is dropped, not postponed', () => {
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const pending = look(working, { turn: 'your-turn', turnAt: at(2000), quietMs: 10 });
    expect(pending.recheckInMs).not.toBeNull();
    const hid = look(pending.watch, { turn: 'your-turn', turnAt: at(2000), quietMs: 10, visible: false });
    expect(hid.watch.armed).toBeNull();
    expect(look(hid.watch, { turn: 'your-turn', turnAt: at(2000), quietMs: 9000 }).fire).toBeNull();
  });

  test('a turn still working while hidden is still read if it ends in view', () => {
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const hid = look(working, { turn: 'working', turnAt: at(1000), visible: false });
    expect(hid.watch.armed).not.toBeNull();
    expect(look(hid.watch, { turn: 'your-turn', turnAt: at(2000) }).fire).not.toBeNull();
  });
});

describe('observeTurn: an old daemon with no turnState', () => {
  test('after a new record, working arms with no date; not working fires only after 3 s of quiet', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: null, legacy: true, fresh: 1 }).watch;
    expect(armed.armed).toEqual({ startedAt: null, after: null, floor: null, row: true, working: true });
    const early = look(armed, { turn: 'your-turn', legacy: true, quietMs: 1200, fresh: 1 });
    expect(early.fire).toBeNull();
    expect(early.recheckInMs).toBe(LEGACY_QUIET_MS - 1200);
    expect(look(armed, { turn: 'your-turn', legacy: true, quietMs: LEGACY_QUIET_MS, fresh: 1 }).fire).toEqual({
      startedAt: null,
      outcome: 'your-turn',
    });
  });

  test('REGRESSION (round 1, #1): an idle old daemon guessed working then your-turn on page load reads nothing', () => {
    // First pane read: working. Nothing in the conversation is new. Then the pane reads idle.
    const guessed = look(IDLE_WATCH, { turn: 'working', turnAt: null, legacy: true, fresh: 0 });
    expect(guessed.watch.armed).toBeNull();
    const idle = look(guessed.watch, { turn: 'your-turn', legacy: true, quietMs: 60_000, fresh: 0 });
    expect(idle.fire).toBeNull();
    expect(idle.watch.armed).toBeNull();
  });

  test('a send arms an old daemon, and reads only once its own row has shown AND the guess was seen working', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    const idle = { turn: 'your-turn' as const, legacy: true, quietMs: LEGACY_QUIET_MS };
    // REGRESSION (round 2, #2): pre-send idle is not a completion; nothing fires at the press.
    expect(look(armed, idle).fire).toBeNull();
    expect(look(armed, { ...idle, sentRow: true }).fire).toBeNull();
    // Working seen, but the row has not shown: still nothing.
    const working = look(armed, { turn: 'working', legacy: true });
    expect(working.watch.armed).toEqual({ ...armed.armed!, working: true });
    expect(look(working.watch, idle).fire).toBeNull();
    // Both: the quiet counts and it reads.
    const both = look(working.watch, { turn: 'working', legacy: true, sentRow: true });
    expect(look(both.watch, idle).fire?.outcome).toBe('your-turn');
    expect(look(both.watch, { ...idle, quietMs: 1000 }).recheckInMs).toBe(LEGACY_QUIET_MS - 1000);
  });

  test('a legacy completion with no proof does not move any floor', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    const step = look(armed, { turn: 'your-turn', legacy: true, turnAt: T + 5 });
    expect(step.watch.armed).toEqual(armed.armed);
  });

  test('a legacy reading uses up its records: a flicker of the pane arms nothing new', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', legacy: true, fresh: 2 }).watch;
    const fired = look(armed, { turn: 'your-turn', legacy: true, fresh: 2 });
    expect(fired.fire).not.toBeNull();
    expect(look(fired.watch, { turn: 'working', legacy: true, fresh: 2 }).watch.armed).toBeNull();
    expect(look(fired.watch, { turn: 'working', legacy: true, fresh: 3 }).watch.armed).not.toBeNull();
  });

  test('a legacy guess ignores any stray turn time', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T, legacy: true, fresh: 1 }).watch;
    expect(armed.armed).toEqual({ startedAt: null, after: null, floor: null, row: true, working: true });
  });
});

describe('arrivalsAfter: live records are those APPENDED after the ones held at open', () => {
  test('counts rows after the anchor, whatever their dates; history prepended before it counts nothing', () => {
    expect(arrivalsAfter(['a', 'b', 'c'], 'b')).toBe(1);
    expect(arrivalsAfter(['a', 'b', 'c'], 'c')).toBe(0);
    expect(arrivalsAfter(['old2', 'old1', 'a', 'b'], 'b')).toBe(0);
  });

  test('is total: no anchor, or an anchor that is gone, counts none', () => {
    expect(arrivalsAfter(['a', 'b'], undefined)).toBe(0);
    expect(arrivalsAfter(['a', 'b'], null)).toBe(0);
    expect(arrivalsAfter(['a', 'b'], 'zzz')).toBe(0);
    expect(arrivalsAfter([], 'a')).toBe(0);
  });
});
