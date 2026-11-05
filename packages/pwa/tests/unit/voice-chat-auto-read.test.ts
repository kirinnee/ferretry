import { describe, expect, test } from 'bun:test';
import {
  armOnSend,
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
    ...input,
  });
/** The daemon's clock for a short, readable scenario. */
const at = (ms: number): number => T + ms;

describe('observeTurn: a turn we saw end', () => {
  test("working arms the watch with the daemon's own start time", () => {
    const step = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 });
    expect(step.watch.armed).toEqual({ startedAt: T - 5000, after: T - 5000, floor: null });
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
  test('a send with nothing seen compares with the send time; the stale your-turn is ignored, the real one reads', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    expect(armed.armed).toEqual({ startedAt: T, after: T, floor: null });
    expect(look(armed, { turn: 'your-turn', turnAt: T - 8000 }).fire).toBeNull();
    expect(look(armed, { turn: 'your-turn', turnAt: T + 6000 }).fire).toEqual({ startedAt: T, outcome: 'your-turn' });
  });

  test("seeing working re-bases the start on the daemon's clock", () => {
    const armed = armOnSend(IDLE_WATCH, T);
    const working = look(armed, { turn: 'working', turnAt: T - 30_000 });
    expect(working.watch.armed).toEqual({ startedAt: T - 30_000, after: T - 30_000, floor: null });
  });

  test('a non-finite time arms with none', () => {
    expect(armOnSend(IDLE_WATCH, Number.NaN).armed).toEqual({ startedAt: null, after: null, floor: null });
  });

  test('with no usable turn time on the reply, it fires once settled', () => {
    expect(look(armOnSend(IDLE_WATCH, T), { turn: 'your-turn', turnAt: null }).fire?.outcome).toBe('your-turn');
  });

  test('REGRESSION (round 1, #2): a newer send drops the pending reading of the older turn', () => {
    // working@1000 → your-turn@2000 waiting out its settle time → the person sends at 3000.
    const working = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000) }).watch;
    const pending = look(working, { turn: 'your-turn', turnAt: at(2000), quietMs: 100 });
    expect(pending.recheckInMs).not.toBeNull();
    const resent = armOnSend(pending.watch, at(3000));
    // The stale completion@2000, long since settled, is not the reply to the new send.
    expect(look(resent, { turn: 'your-turn', turnAt: at(2000), quietMs: 9000 }).fire).toBeNull();
    // Nor does a replayed snapshot of the old working@1000 move the new turn's start.
    expect(look(resent, { turn: 'working', turnAt: at(1000) }).watch.armed).toEqual(resent.armed);
    // The new turn does.
    const next = look(resent, { turn: 'working', turnAt: at(3500) }).watch;
    expect(look(next, { turn: 'your-turn', turnAt: at(4000) }).fire).toEqual({
      startedAt: at(3500),
      outcome: 'your-turn',
    });
  });

  test('a fast reply that arrives before anything else was looked at is still the reply to the send', () => {
    const seen = look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(2000) }).watch;
    const armed = armOnSend(seen, at(3000));
    expect(armed.armed).toEqual({ startedAt: at(3000), after: at(2000), floor: at(2000) });
    // The daemon's clock runs behind the browser's: its next your-turn is dated 2500, before the send time.
    expect(look(armed, { turn: 'your-turn', turnAt: at(2500) }).fire).toEqual({
      startedAt: at(3000),
      outcome: 'your-turn',
    });
    expect(look(armed, { turn: 'your-turn', turnAt: at(2000) }).fire).toBeNull();
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
    expect(armOnSend(fired, at(1500)).armed).toEqual({ startedAt: at(1500), after: at(2000), floor: at(2000) });
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
    expect(armed.armed).toEqual({ startedAt: null, after: null, floor: null });
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

  test('a send still arms an old daemon, and reads with no new-record proof', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    expect(look(armed, { turn: 'working', legacy: true }).watch.armed).toEqual(armed.armed);
    expect(look(armed, { turn: 'your-turn', legacy: true, quietMs: LEGACY_QUIET_MS }).fire?.outcome).toBe('your-turn');
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
    expect(armed.armed).toEqual({ startedAt: null, after: null, floor: null });
  });
});
