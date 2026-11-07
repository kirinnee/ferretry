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
} from '../../../app/lib/voice-chat/auto-read.ts';

/** Every date here is the DAEMON's clock; the pure module has no other. */
const T = 1_000_000;
const at = (ms: number): number => T + ms;
const look = (watch: TurnWatch, input: Partial<WatchInput>) =>
  observeTurn(watch, {
    authoritative: true,
    turn: 'your-turn',
    turnAt: T,
    quietMs: 10_000,
    visible: true,
    boundary: null,
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
    expect(step.watch).toEqual({ armed: null, seen: T, busyAt: null });
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
    expect(watch.armed).toEqual({ kind: 'sent', floor: at(1000), working: null, inFlight: null, hiddenAt: null });
    expect(look(watch, { turn: 'your-turn', turnAt: at(1000), boundary: BOUNDARY }).fire).toBeNull();
  });

  test('the send’s own turn is read: accepted, then working after the boundary, then its end, with the person’s row', () => {
    const step = run(pressed(), [
      { turn: 'your-turn', turnAt: at(1000), boundary: null },
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY },
    ]);
    expect(step.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
    expect(step.watch.armed).toBeNull();
  });

  test('a fast turn is read even when the ledger’s word on the send arrives after the whole turn', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: null },
      { turn: 'your-turn', turnAt: at(31_000), boundary: null },
      { turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY },
    ]);
    expect(step.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
  });

  test('REGRESSION (round 3, #1): a delayed prior completion@10000 with the send accepted at 30000 is not its reply', () => {
    const step = run(pressed(), [{ turn: 'your-turn', turnAt: at(10_000), boundary: BOUNDARY }]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({ kind: 'sent', floor: at(1000), working: null, inFlight: null, hiddenAt: null });
    // …and it does not consume the token: the real reply is still read.
    const real = run(step.watch, [
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY },
    ]);
    expect(real.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
  });

  test('REGRESSION (round 3, #1): replaying the previous working@2000 does not prove the new turn', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(2000), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(10_000), boundary: BOUNDARY },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({
      kind: 'sent',
      floor: at(1000),
      working: at(2000),
      inFlight: null,
      hiddenAt: null,
    });
  });

  test('a working at or before the floor is the turn that was already running', () => {
    const watch = armOnSend(look(IDLE_WATCH, { turn: 'working', turnAt: at(25_000) }).watch);
    const step = run(watch, [
      { turn: 'working', turnAt: at(25_000), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(32_000), boundary: BOUNDARY },
    ]);
    expect(step.fire).toBeNull();
    // The queued message’s own turn follows the old one’s end, and is read.
    const next = run(step.watch, [
      { turn: 'working', turnAt: at(33_000), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(45_000), boundary: BOUNDARY },
    ]);
    expect(next.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
  });

  test('a send pressed before anything was seen has no floor: any working counts, but the boundary still decides', () => {
    const watch = armOnSend(IDLE_WATCH);
    expect(watch.armed).toEqual({ kind: 'sent', floor: null, working: null, inFlight: null, hiddenAt: null });
    const early = run(watch, [
      { turn: 'working', turnAt: at(2000), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(10_000), boundary: BOUNDARY },
    ]);
    expect(early.fire).toBeNull();
    const real = run(watch, [
      { turn: 'working', turnAt: at(31_000), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY },
    ]);
    expect(real.fire).not.toBeNull();
  });

  test('with no daemon acceptance, nothing is read — the ledger has not shown the send', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: null },
      { turn: 'your-turn', turnAt: at(40_000), boundary: null },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({
      kind: 'sent',
      floor: at(1000),
      working: at(30_500),
      inFlight: null,
      hiddenAt: null,
    });
  });

  test('an unreadable acceptance date reads nothing', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: Number.NaN },
      { turn: 'your-turn', turnAt: at(40_000), boundary: Number.NaN },
    ]);
    expect(step.fire).toBeNull();
  });

  test('a completion not dated after the working is not its end', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(30_500), boundary: BOUNDARY },
    ]);
    expect(step.fire).toBeNull();
  });

  test('R4 #4: a short turn whose working was never rendered is read once the daemon dated its end after the acceptance', () => {
    const step = run(pressed(), [{ turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY }]);
    expect(step.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
    expect(step.watch.armed).toBeNull();
  });

  test('a completion dated at the acceptance, not after it, is not the send’s', () => {
    expect(run(pressed(), [{ turn: 'your-turn', turnAt: BOUNDARY, boundary: BOUNDARY }]).fire).toBeNull();
  });

  test('R4 #1 (the other half): a send pressed while a turn was running does not take that turn’s end for its reply', () => {
    // working@25000 is running at the press; the send is accepted at 30000 and the running turn ends at 40000.
    const press = armOnSend(look(IDLE_WATCH, { turn: 'working', turnAt: at(25_000) }).watch);
    expect(press.armed).toEqual({
      kind: 'sent',
      floor: at(25_000),
      working: null,
      inFlight: at(25_000),
      hiddenAt: null,
    });
    const old = look(press, { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY });
    expect(old.fire).toBeNull();
    expect(old.watch.armed).toEqual({
      kind: 'sent',
      floor: at(25_000),
      working: null,
      inFlight: null,
      hiddenAt: null,
      passedAt: at(40_000),
    });
    expect(old.watch.busyAt).toBeNull();
    // The send’s own turn follows, whether or not its working is rendered.
    expect(look(old.watch, { turn: 'your-turn', turnAt: at(45_000), boundary: BOUNDARY }).fire).toEqual({
      startedAt: null,
      outcome: 'your-turn',
    });
    const rendered = run(old.watch, [
      { turn: 'working', turnAt: at(40_500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(45_000), boundary: BOUNDARY },
    ]);
    expect(rendered.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
  });

  test('a completion not later than the turn running at the press is not even its end', () => {
    const press = armOnSend(look(IDLE_WATCH, { turn: 'working', turnAt: at(35_000) }).watch);
    const step = look(press, { turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({
      kind: 'sent',
      floor: at(35_000),
      working: null,
      inFlight: at(35_000),
      hiddenAt: null,
    });
  });

  test('the first thing a page ever sees only sets the floor, even for a pressed send', () => {
    const step = look(armOnSend(IDLE_WATCH), { turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY });
    expect(step.fire).toBeNull();
    expect(step.watch.seen).toBe(at(31_000));
    expect(step.watch.armed).not.toBeNull();
  });

  test('needs-input ends a send’s turn too', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY },
      { turn: 'needs-input', turnAt: at(35_000), boundary: BOUNDARY },
    ]);
    expect(step.fire).toEqual({ startedAt: null, outcome: 'needs-input' });
  });

  test('a newer send replaces the older token', () => {
    const second = armOnSend(run(pressed(), [{ turn: 'working', turnAt: at(2000), boundary: BOUNDARY }]).watch);
    expect(second.armed).toEqual({ kind: 'sent', floor: at(2000), working: null, inFlight: at(2000), hiddenAt: null });
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
    expect(stopWatching(watched())).toEqual({ armed: null, seen: at(-5000), busyAt: at(-5000) });
    expect(stopWatching(IDLE_WATCH)).toBe(IDLE_WATCH);
  });

  test('a completion with nothing being watched is never read', () => {
    expect(look(IDLE_WATCH, { turn: 'needs-input', turnAt: T }).fire).toBeNull();
  });
});

describe('observeTurn: cached snapshots are not the daemon’s word (R4 #3)', () => {
  test('a cached snapshot moves nothing: no watermark, no watch, no floor', () => {
    const step = look(IDLE_WATCH, { turn: 'working', turnAt: at(1000), authoritative: false });
    expect(step.watch).toBe(IDLE_WATCH);
    expect(step.fire).toBeNull();
    const armed = armOnSend(look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(500) }).watch);
    expect(look(armed, { turn: 'working', turnAt: at(2000), authoritative: false }).watch).toBe(armed);
  });

  test('the cached working then the first live your-turn: the live snapshot only seeds the watermark', () => {
    const step = run(IDLE_WATCH, [
      { turn: 'working', turnAt: at(1000), authoritative: false },
      { turn: 'your-turn', turnAt: at(9000), authoritative: true, quietMs: 10_000 },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch).toEqual({ armed: null, seen: at(9000), busyAt: null });
  });

  test('after the first live snapshot a later working → your-turn is watched and read', () => {
    const step = run(IDLE_WATCH, [
      { turn: 'working', turnAt: at(1000), authoritative: false },
      { turn: 'your-turn', turnAt: at(9000) },
      { turn: 'working', turnAt: at(10_000) },
      { turn: 'your-turn', turnAt: at(20_000) },
    ]);
    expect(step.fire).toEqual({ startedAt: at(10_000), outcome: 'your-turn' });
  });
});

describe('observeTurn: a completion seen hidden before the send could be proven stays silent (R4 #2)', () => {
  const BOUNDARY = at(30_000);
  const pressed = (): TurnWatch => armOnSend(look(IDLE_WATCH, { turn: 'your-turn', turnAt: at(1000) }).watch);

  test('hidden completion with no acceptance yet, then visible and the acceptance shows: consumed, not read', () => {
    const step = run(pressed(), [
      { turn: 'working', turnAt: at(30_500), boundary: null },
      { turn: 'your-turn', turnAt: at(31_000), boundary: null, visible: false },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({
      kind: 'sent',
      floor: at(1000),
      working: at(30_500),
      inFlight: null,
      hiddenAt: at(31_000),
    });
    const back = look(step.watch, { turn: 'your-turn', turnAt: at(31_000), boundary: null, visible: true });
    expect(back.fire).toBeNull();
    const accepted = look(back.watch, { turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY, visible: true });
    expect(accepted.fire).toBeNull();
    expect(accepted.watch.armed).toBeNull();
    // …and it stays consumed.
    expect(look(accepted.watch, { turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY }).fire).toBeNull();
  });

  test('the same without any working rendered, and a visible look in between', () => {
    const step = run(pressed(), [
      { turn: 'your-turn', turnAt: at(31_000), boundary: null, visible: false },
      { turn: 'your-turn', turnAt: at(31_000), boundary: null },
      { turn: 'your-turn', turnAt: at(31_000), boundary: BOUNDARY },
    ]);
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toBeNull();
  });

  test('an older completion seen hidden does not stop a later real reply from being read', () => {
    const step = run(pressed(), [
      { turn: 'your-turn', turnAt: at(10_000), boundary: null, visible: false },
      { turn: 'working', turnAt: at(30_500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(40_000), boundary: BOUNDARY },
    ]);
    expect(step.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
  });

  test('a hidden look that cannot be proven yet is remembered when it is not later than the acceptance either', () => {
    const step = look(pressed(), { turn: 'your-turn', turnAt: at(10_000), boundary: BOUNDARY, visible: false });
    expect(step.fire).toBeNull();
    expect(step.watch.armed).toEqual({
      kind: 'sent',
      floor: at(1000),
      working: null,
      inFlight: null,
      hiddenAt: at(10_000),
    });
  });
});

describe('observeTurn: the old turn’s rejected end is remembered (final round)', () => {
  const BOUNDARY = at(300);
  /** working@100 is running; the person presses send; the daemon accepts it @300. */
  const pressedWhileRunning = (): TurnWatch => armOnSend(look(IDLE_WATCH, { turn: 'working', turnAt: at(100) }).watch);

  test('REGRESSION: the running turn’s end@400 is rejected, and looked at AGAIN (its last row arrives) it is still not the reply', () => {
    const first = look(pressedWhileRunning(), { turn: 'your-turn', turnAt: at(400), boundary: BOUNDARY });
    expect(first.fire).toBeNull();
    expect(first.watch.armed).toMatchObject({ kind: 'sent', inFlight: null, passedAt: at(400) });
    // The final transcript row lands: the SAME completion is evaluated again, now with nothing "in flight".
    const again = look(first.watch, { turn: 'your-turn', turnAt: at(400), boundary: BOUNDARY });
    expect(again.fire).toBeNull();
    expect(again.recheckInMs).toBeNull();
    expect(again.watch.armed).not.toBeNull();
    // …and over and over, with the token still waiting for the send’s own turn.
    expect(look(again.watch, { turn: 'your-turn', turnAt: at(400), boundary: BOUNDARY }).fire).toBeNull();
  });

  test('a NEWER completion after the rejected one is the send’s own, with or without a rendered working', () => {
    const first = look(pressedWhileRunning(), { turn: 'your-turn', turnAt: at(400), boundary: BOUNDARY });
    expect(look(first.watch, { turn: 'your-turn', turnAt: at(900), boundary: BOUNDARY }).fire).toEqual({
      startedAt: null,
      outcome: 'your-turn',
    });
    const rendered = run(first.watch, [
      { turn: 'working', turnAt: at(500), boundary: BOUNDARY },
      { turn: 'your-turn', turnAt: at(900), boundary: BOUNDARY },
    ]);
    expect(rendered.fire).toEqual({ startedAt: null, outcome: 'your-turn' });
  });

  test('a completion dated BEFORE the rejected one (a replay) is no more the reply', () => {
    const first = look(pressedWhileRunning(), { turn: 'your-turn', turnAt: at(400), boundary: BOUNDARY });
    expect(look(first.watch, { turn: 'your-turn', turnAt: at(350), boundary: BOUNDARY }).fire).toBeNull();
  });

  test('a completion that is not later than the running turn keeps it in flight and passes nothing', () => {
    const early = look(pressedWhileRunning(), { turn: 'your-turn', turnAt: at(100), boundary: null });
    expect(early.watch.armed).toMatchObject({ inFlight: at(100) });
    expect((early.watch.armed as { passedAt?: number | null }).passedAt).toBeUndefined();
  });
});
