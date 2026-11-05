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
  observeTurn(watch, { now: T, turn: 'your-turn', turnAt: null, legacy: false, quietMs: 10_000, ...input });

describe('observeTurn: a turn we saw end', () => {
  test("working arms the watch with the daemon's own start time", () => {
    const step = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 });
    expect(step.watch.armed).toEqual({ startedAt: T - 5000 });
    expect(step.fire).toBeNull();
  });

  test('working then your-turn, later than the start, fires once the text has settled', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const step = look(armed, { turn: 'your-turn', turnAt: T, quietMs: TEXT_SETTLED_MS });
    expect(step.fire).toEqual({ startedAt: T - 5000, outcome: 'your-turn' });
    expect(step.watch).toBe(IDLE_WATCH);
  });

  test('needs-input fires with its own outcome', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    expect(look(armed, { turn: 'needs-input', turnAt: T }).fire?.outcome).toBe('needs-input');
  });

  test('the same state seen again is not the end of the turn', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const step = look(armed, { turn: 'your-turn', turnAt: T - 5000 });
    expect(step.fire).toBeNull();
    expect(step.watch).toBe(armed);
  });

  test('a session already at your-turn when watching begins reads nothing', () => {
    const step = look(IDLE_WATCH, { turn: 'your-turn', turnAt: T });
    expect(step.fire).toBeNull();
    expect(step.watch).toBe(IDLE_WATCH);
  });

  test('text-settled guard: waits for 500 ms of quiet and says how long', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const early = look(armed, { turn: 'your-turn', turnAt: T, quietMs: 120 });
    expect(early.fire).toBeNull();
    expect(early.recheckInMs).toBe(380);
    expect(early.watch).toBe(armed);
    expect(look(armed, { turn: 'your-turn', turnAt: T, quietMs: -50 }).recheckInMs).toBe(TEXT_SETTLED_MS);
  });

  test('a session that stops being live ends the watch without a reading', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T - 5000 }).watch;
    const step = look(armed, { turn: null });
    expect(step.fire).toBeNull();
    expect(step.watch).toBe(IDLE_WATCH);
  });
});

describe('armOnSend: our own send', () => {
  test('arms at the send time; the stale your-turn before the reply is ignored, the real one reads', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    expect(armed.armed).toEqual({ startedAt: T });
    expect(look(armed, { turn: 'your-turn', turnAt: T - 8000 }).fire).toBeNull();
    expect(look(armed, { turn: 'your-turn', turnAt: T + 6000 }).fire).toEqual({ startedAt: T, outcome: 'your-turn' });
  });

  test("seeing working re-bases the start on the daemon's clock", () => {
    const armed = armOnSend(IDLE_WATCH, T);
    const working = look(armed, { turn: 'working', turnAt: T - 30_000 });
    expect(working.watch.armed).toEqual({ startedAt: T - 30_000 });
  });

  test('an already armed watch keeps its start; a non-finite time arms with none', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    expect(armOnSend(armed, T + 99)).toBe(armed);
    expect(armOnSend(IDLE_WATCH, Number.NaN).armed).toEqual({ startedAt: null });
  });

  test('with no usable turn time on the reply, it fires once settled', () => {
    const armed = armOnSend(IDLE_WATCH, T);
    expect(look(armed, { turn: 'your-turn', turnAt: null }).fire?.outcome).toBe('your-turn');
  });
});

describe('observeTurn: an old daemon with no turnState', () => {
  test('working arms with no date; not working fires only after 3 s of quiet', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: null, legacy: true }).watch;
    expect(armed.armed).toEqual({ startedAt: null });
    const early = look(armed, { turn: 'your-turn', legacy: true, quietMs: 1200 });
    expect(early.fire).toBeNull();
    expect(early.recheckInMs).toBe(LEGACY_QUIET_MS - 1200);
    expect(look(armed, { turn: 'your-turn', legacy: true, quietMs: LEGACY_QUIET_MS }).fire).toEqual({
      startedAt: null,
      outcome: 'your-turn',
    });
  });

  test('a legacy guess ignores any stray turn time', () => {
    const armed = look(IDLE_WATCH, { turn: 'working', turnAt: T, legacy: true }).watch;
    expect(armed.armed).toEqual({ startedAt: null });
  });
});
