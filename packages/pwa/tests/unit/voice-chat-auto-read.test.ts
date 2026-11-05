import { describe, expect, test } from 'bun:test';
import {
  armOnSend,
  dropSend,
  IDLE_WATCH,
  observeTurn,
  stopWatching,
  TEXT_SETTLED_MS,
  type TurnWatch,
  type WatchInput,
} from '../../src/lib/voice-chat/auto-read.ts';

/** Every date here is the DAEMON's clock; the pure module has no other. */
const T = 1_000_000;
const at = (ms: number): number => T + ms;
const look = (watch: TurnWatch, input: Partial<WatchInput>) =>
  observeTurn(watch, {
    turn: 'your-turn',
    turnAt: T,
    quietMs: 10_000,
    visible: true,
    boundary: null,
    sentRow: false,
    ...input,
  });
/** A run of looks, each on the watch the last one left. */
const run = (start: TurnWatch, inputs: readonly Partial<WatchInput>[]) => {
  let step = look(start, inputs[0] ?? {});
  for (const input of inputs.slice(1)) step = look(step.watch, input);
  return step;
};

describe('observeTurn: a turn we saw end', () => {
  test("working arms the watch with the daemon's own start time", () => {
    const step = look(IDLE_WATCH, { turn: 'working', turnAt: at(-5000) });
    expect(step.watch.armed).toEqual({ kind: 'watched', startedAt: at(-5000), after: at(-5000) });
    expect(step.watch.seen).toBe(at(-5000));
    expect(step.fire).toBeNull();
  });

  test('working then your-turn, later than the start, fires once the text has settled', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: at(-5000) }).watch;
    const step = look(armed, { turn: 'your-turn', turnAt: T, quietMs: TEXT_SETTLED_MS });
    expect(step.fire).toEqual({ startedAt: at(-5000), outcome: 'your-turn' });
    expect(step.watch.armed).toBeNull();
    expect(step.watch.seen).toBe(T);
  });

  test('needs-input fires with its own outcome', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: at(-5000) }).watch;
    expect(look(armed, { turn: 'needs-input', turnAt: T }).fire?.outcome).toBe('needs-input');
  });

  test('the same state seen again is not the end of the turn', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: at(-5000) }).watch;
    const step = look(armed, { turn: 'your-turn', turnAt: at(-5000) });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual(armed.armed);
  });

  test('a working again later in the same turn (it asked, and was answered) moves the end it needs', () => {
    const step = run(IDLE_WATCH, [
      { turn: 'working', turnAt: at(0) },
      { turn: 'working', turnAt: at(4000) },
      { turn: 'your-turn', turnAt: at(3000) },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({ kind: 'watched', startedAt: at(0), after: at(4000) });
    // An older working repeated changes nothing.
    expect(look(step.watch, { turn: 'working', turnAt: at(1000) }).watch.armed).toEqual(step.watch.armed);
  });

  test('a session already at your-turn when watching begins reads nothing, and its date is the floor', () => {
    const step = look(IDLE_WATCH, { turn: 'your-turn', turnAt: T });
    expect(step.fire).toBeNull();
    expect(step.watch).toEqual({ armed: null, seen: T });
  });

  test('a working the page first sees, with no earlier state, is a turn it watched', () => {
    expect(look(IDLE_WATCH, { turn: 'working', turnAt: T }).watch.armed).not.toBeNull();
  });
});

describe('observeTurn: the watermark (replays read nothing)', () => {
  test('REGRESSION (round 3, #3): open idle at your-turn@10000, replay working@1000 → your-turn@10000, no send: silent', () => {
    const step = run(IDLE_WATCH, [
      { turn: 'your-turn', turnAt: at(10_000) },
      { turn: 'working', turnAt: at(1000) },
      { turn: 'your-turn', turnAt: at(10_000) },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toBeNull();
    expect(step.watch.seen).toBe(at(10_000));
  });

  test('a working dated exactly at the watermark is not new either', () => {
    const step = run(IDLE_WATCH, [
      { turn: 'your-turn', turnAt: at(10_000) },
      { turn: 'working', turnAt: at(10_000) },
    ]);
    expect(step.watch.armed).toBeNull();
  });

  test('a working dated after the watermark is a turn that began while the page was open', () => {
    const step = run(IDLE_WATCH, [
      { turn: 'your-turn', turnAt: at(10_000) },
      { turn: 'working', turnAt: at(11_000) },
    ]);
    expect(step.watch.armed).toEqual({ kind: 'watched', startedAt: at(11_000), after: at(11_000) });
  });

  test('consumed is consumed: the same working → your-turn pair replayed after a reading fires nothing', () => {
    const first = run(IDLE_WATCH, [
      { turn: 'your-turn', turnAt: at(0) },
      { turn: 'working', turnAt: at(1000) },
      { turn: 'your-turn', turnAt: at(9000) },
    ]);
    expect(first.fire).not.toBeNull();
    const again = run(first.watch, [
      { turn: 'working', turnAt: at(1000) },
      { turn: 'your-turn', turnAt: at(9000) },
    ]);
    expect(again.fire).toBeNull();
    expect(again.watch.armed).toBeNull();
  });

  test('an old completion that turns up with nothing being watched only raises the floor', () => {
    const step = look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(500) });
    expect(step.fire).toBeNull();
    expect(look(step.watch, { turn: 'your-turn', turnAt: at(400) }).watch.seen).toBe(at(500));
  });
});

describe("observeTurn: a send is judged against the daemon's acceptance of it", () => {
  /** The page last saw your-turn@1000 (the daemon's clock) when the person pressed send. */
  const pressed = (): TurnWatch => armOnSend(look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(1000) }).watch);
  const BOUNDARY = at(30_000);

  test('the press remembers the floor and reads nothing by itself', () => {
    const watch = pressed();
    expect(watch.armed).toEqual({ kind: 'sent', floor: at(1000), working: null });
    expect(look(watch, { turn: 'your-turn', turnAt: at(1000), boundary: BOUNDARY, sentRow: true }).fire).toBeNull();
  });

  test('the send’s own turn is read: accepted, then working after the boundary, then its end, with the person’s row', () => {
    const step = run(pressed(), [
      { turn: 'your-turn', turnAt: at(1000), boundary: null },
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(step.fire).toEqual({ startedAt: at(30_500), outcome: 'your-turn' });
    expect(step.watch.armed).toBeNull();
  });

  test('a fast turn is read even when the ledger’s word on the send arrives after the whole turn', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: null },
      { turn: 'your-turn', turnAt: at(31_000), boundary: null, sentRow: true },
      { turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(step.fire).toEqual({ startedAt: at(30_500), outcome: 'your-turn' });
  });

  test('REGRESSION (round 3, #1): a delayed prior completion@10000 with the send accepted at 30000 is not its reply', () => {
    const step = run(pressed(), [{ turn: 'your-turn', turnAt: at(10_000), boundary: BOUNDARY, sentRow: true }]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({ kind: 'sent', floor: at(1000), working: null });
    // …and it does not consume the token: the real reply is still read.
    const real = run(step.watch, [
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY, sentRow: true },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(real.fire).toEqual({ startedAt: at(30_500), outcome: 'your-turn' });
  });

  test('REGRESSION (round 3, #1): replaying the previous working@2000 does not prove the new turn', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(2000), boundary: BOUNDARY, sentRow: true },
      { turn: 'your-turn', turnAt: at(10_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({ kind: 'sent', floor: at(1000), working: at(2000) });
  });

  test('a working at or before the floor is the turn that was already running', () => {
    const watch = armOnSend(look(IDLE_WATCH, { turn: 'working', turnAt: at(25_000) }).watch);
    const step = run(watch, [
      { turn: 'working', turnAt: at(25_000), boundary: BOUNDARY, sentRow: true },
      { turn: 'your-turn', turnAt: at(32_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(step.fire).toBeNull();
    // The queued message’s own turn follows the old one’s end, and is read.
    const next = run(step.watch, [
      { turn: 'working', turnAt: at(33_000), boundary: BOUNDARY, sentRow: true },
      { turn: 'your-turn', turnAt: at(45_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(next.fire).toEqual({ startedAt: at(33_000), outcome: 'your-turn' });
  });

  test('a send pressed before anything was seen has no floor: any working counts, but the boundary still decides', () => {
    const watch = armOnSend(IDLE_WATCH);
    expect(watch.armed).toEqual({ kind: 'sent', floor: null, working: null });
    const early = run(watch, [
      { turn: 'working', turnAt: at(2000), boundary: BOUNDARY, sentRow: true },
      { turn: 'your-turn', turnAt: at(10_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(early.fire).toBeNull();
    const real = run(watch, [
      { turn: 'working', turnAt: at(31_000), boundary: BOUNDARY, sentRow: true },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(real.fire).not.toBeNull();
  });

  test('with no daemon acceptance, nothing is read — the ledger has not shown the send', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: null, sentRow: true },
      { turn: 'your-turn', turnAt: at(40_000), boundary: null, sentRow: true },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({ kind: 'sent', floor: at(1000), working: at(30_500) });
  });

  test('an unreadable acceptance date reads nothing', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: Number.NaN, sentRow: true },
      { turn: 'your-turn', turnAt: at(40_000), boundary: Number.NaN, sentRow: true },
    ]);
    expect(step.fire).toBeNull();
  });

  test('a completion not dated after the working is not its end', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY, sentRow: true },
      { turn: 'your-turn', turnAt: at(30_500), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(step.fire).toBeNull();
  });

  test('the person’s own row must be in the conversation, or it waits rather than read the wrong reply', () => {
    const waiting = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY, sentRow: false },
    ]);
    expect(waiting.fire).toBeNull();
    expect(waiting.recheckInMs).toBeNull();
    expect(
      look(waiting.watch, { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY, sentRow: true }).fire,
    ).not.toBeNull();
  });

  test('needs-input ends a send’s turn too', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY, sentRow: true },
      { turn: 'needs-input', turnAt: at(35_000), boundary: BOUNDARY, sentRow: true },
    ]);
    expect(step.fire).toEqual({ startedAt: at(30_500), outcome: 'needs-input' });
  });

  test('a newer send replaces the older token', () => {
    const second = armOnSend(run(pressed(), [{ turn: 'working', turnAt: at(2000), boundary: BOUNDARY }]).watch);
    expect(second.armed).toEqual({ kind: 'sent', floor: at(2000), working: null });
  });

  test('dropSend lets go of a send’s token and nothing else', () => {
    expect(dropSend(pressed()).armed).toBeNull();
    const watched = look(IDLE_WATCH, { turn: 'working', turnAt: T }).watch;
    expect(dropSend(watched)).toBe(watched);
    expect(dropSend(pressed()).seen).toBe(at(1000));
  });
});

describe('observeTurn: the text-settled guard, hidden tabs, and sessions that are not live', () => {
  const watched = (): TurnWatch => look(IDLE_WATCH, { turn: 'working', turnAt: at(-5000) }).watch;

  test('it waits for the text to settle and says how long', () => {
    const step = look(watched(), { turn: 'your-turn', turnAt: T, quietMs: 120 });
    expect(step.fire).toBeNull();
    expect(step.recheckInMs).toBe(TEXT_SETTLED_MS - 120);
    expect(step.watch.armed).not.toBeNull();
  });

  test('a quiet clock that runs backwards still waits the whole guard, and never less than a millisecond', () => {
    expect(look(watched(), { turn: 'your-turn', turnAt: T, quietMs: -50 }).recheckInMs).toBe(TEXT_SETTLED_MS);
    expect(look(watched(), { turn: 'your-turn', turnAt: T, quietMs: TEXT_SETTLED_MS - 0.2 }).recheckInMs).toBe(1);
  });

  test('a completion seen while the tab is hidden is consumed without a reading, for good', () => {
    const hidden = look(watched(), { turn: 'your-turn', turnAt: T, visible: false });
    expect(hidden.fire).toBeNull();
    expect(hidden.watch.armed).toBeNull();
    expect(look(hidden.watch, { turn: 'your-turn', turnAt: T, visible: true }).fire).toBeNull();
  });

  test('a session that is not live ends the watch without a reading', () => {
    const step = look(watched(), { turn: null, turnAt: T });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toBeNull();
    expect(step.watch.seen).toBe(T);
  });

  test('no usable date means nothing is watched — an old daemon is never read', () => {
    const step = look(watched(), { turn: 'working', turnAt: null });
    expect(step.watch.armed).toBeNull();
    expect(step.fire).toBeNull();
    expect(look(IDLE_WATCH, { turn: 'working', turnAt: Number.NaN }).watch).toEqual(IDLE_WATCH);
    expect(look(armOnSend(IDLE_WATCH), { turn: 'your-turn', turnAt: null }).watch.armed).toBeNull();
  });

  test('stopWatching keeps the watermark and returns the same watch when nothing was watched', () => {
    expect(stopWatching(watched())).toEqual({ armed: null, seen: at(-5000) });
    expect(stopWatching(IDLE_WATCH)).toBe(IDLE_WATCH);
  });

  test('a completion with nothing being watched is never read', () => {
    expect(look(IDLE_WATCH, { turn: 'needs-input', turnAt: T }).fire).toBeNull();
  });
});
