/**
 * Proves the turn endpointer with synthetic level frames and no clock at all — every frame carries
 * its own time, so each expectation is an exact millisecond:
 *
 *   - speech starts after 200 ms of loud time and not on a click; breaths shorter than the 250 ms
 *     hangover do not break it;
 *   - a burst under 400 ms is retracted, never a turn;
 *   - the turn ends when the quiet since the last loud frame reaches the pause — per preset and per
 *     clamped setting — and a voice that returns first withdraws the pause;
 *   - an engine hint only SHORTENS a pause the level already showed, and never while speaking;
 *   - the 120 s cap, the adaptive noise floor, a stalled stream, junk frames and a finished turn;
 *   - totality: a seeded fuzz of random frames never throws and always yields a well-formed history.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_PAUSE_MS,
  ENDPOINTER_MAX_QUIET_RMS,
  type EndpointerEvent,
  type EndpointerState,
  endpointerFeed,
  endpointerHint,
  endpointerStart,
  HANGOVER_MS,
  HINT_QUIET_MS,
  type LevelFrame,
  MAX_TURN_MS,
  PAUSE_PRESETS,
  PAUSE_RANGE_MS,
  resolvePauseMs,
} from '../../../../app/lib/voice-chat/turn-endpointer.ts';

const STEP = 20;
const LOUD = 0.1;
const QUIET = 0.001;

/** A script: `[level, milliseconds]` runs, one frame per 20 ms, the first frame at 20 ms. */
type Run = readonly [number, number];
const loud = (ms: number): Run => [LOUD, ms];
const quiet = (ms: number): Run => [QUIET, ms];

function framesOf(runs: readonly Run[], from = 0): LevelFrame[] {
  const frames: LevelFrame[] = [];
  let atMs = from;
  for (const [level, ms] of runs)
    for (let done = 0; done < ms; done += STEP) {
      atMs += STEP;
      frames.push({ atMs, rms: level });
    }
  return frames;
}

interface Played {
  readonly state: EndpointerState;
  readonly events: readonly EndpointerEvent[];
}

function play(state: EndpointerState, frames: readonly LevelFrame[]): Played {
  let current = state;
  const events: EndpointerEvent[] = [];
  for (const frame of frames) {
    const step = endpointerFeed(current, frame);
    current = step.state;
    events.push(...step.events);
  }
  return { state: current, events };
}

const run = (pause: unknown, runs: readonly Run[]): Played => play(endpointerStart(pause), framesOf(runs));
const kinds = (events: readonly EndpointerEvent[]): string[] => events.map(event => event.kind);

describe('resolvePauseMs', () => {
  const cases: readonly [string, unknown, number][] = [
    ['quick', 'quick', 900],
    ['normal', 'normal', 1_500],
    ['thinker', 'thinker', 2_500],
    ['an unknown name', 'patient', DEFAULT_PAUSE_MS],
    ['a prototype key', 'constructor', DEFAULT_PAUSE_MS],
    ['a number in range', 2_000, 2_000],
    ['a fraction', 1_234.6, 1_235],
    ['below the range', 200, 800],
    ['above the range', 60_000, 4_000],
    ['NaN', Number.NaN, DEFAULT_PAUSE_MS],
    ['Infinity', Number.POSITIVE_INFINITY, DEFAULT_PAUSE_MS],
    ['undefined', undefined, DEFAULT_PAUSE_MS],
    ['an object', {}, DEFAULT_PAUSE_MS],
  ];
  for (const [name, input, expected] of cases)
    it(`${name} → ${expected} ms`, () => {
      should(resolvePauseMs(input)).equal(expected);
    });

  it('keeps the presets inside the range and normal as the default', () => {
    for (const value of Object.values(PAUSE_PRESETS)) {
      should(value >= PAUSE_RANGE_MS.min).be.true();
      should(value <= PAUSE_RANGE_MS.max).be.true();
    }
    should(DEFAULT_PAUSE_MS).equal(PAUSE_PRESETS.normal);
    should(endpointerStart().pauseMs).equal(1_500);
  });
});

describe('speech start', () => {
  const cases: readonly [string, readonly Run[], readonly EndpointerEvent[]][] = [
    [
      '200 ms of loud time starts speech on the 10th frame',
      [loud(200)],
      [{ kind: 'speech-start', atMs: 200, sinceMs: 0 }],
    ],
    ['180 ms is a click', [loud(180), quiet(2_000)], []],
    ['a click then silence never speaks', [quiet(100), loud(100), quiet(2_000)], []],
    [
      'a loud run that starts later says when it began',
      [quiet(100), loud(300)],
      [{ kind: 'speech-start', atMs: 300, sinceMs: 100 }],
    ],
    ['two clicks a hangover apart are not one speech', [loud(100), quiet(260), loud(100), quiet(260)], []],
    [
      'a breath under the hangover does not restart the run',
      [loud(100), quiet(240), loud(100)],
      [{ kind: 'speech-start', atMs: 440, sinceMs: 0 }],
    ],
  ];
  for (const [name, runs, expected] of cases)
    it(name, () => {
      should(run('normal', runs).events).eql(expected);
    });
});

describe('a burst too short to be a turn', () => {
  it('is retracted once the quiet passes the hangover, and never ends a turn', () => {
    const { events, state } = run('normal', [loud(300), quiet(3_000)]);
    should(events).eql([
      { kind: 'speech-start', atMs: 200, sinceMs: 0 },
      { kind: 'speech-cancel', atMs: 300 + 260 },
    ]);
    should(state.phase).equal('listening');
  });

  it('listens again afterwards and a real turn still works', () => {
    const { events } = run('normal', [loud(300), quiet(500), loud(1_000), quiet(1_500)]);
    should(kinds(events)).eql(['speech-start', 'speech-cancel', 'speech-start', 'pause', 'turn-end']);
  });

  it('exactly 400 ms of loud time is enough', () => {
    should(kinds(run('normal', [loud(400), quiet(1_500)]).events)).eql(['speech-start', 'pause', 'turn-end']);
    should(kinds(run('normal', [loud(380), quiet(1_500)]).events)).eql(['speech-start', 'speech-cancel']);
  });

  it('counts loud time across breaths', () => {
    // 200 + 200 loud with a short breath between: 400 ms in total.
    should(kinds(run('normal', [loud(200), quiet(100), loud(200), quiet(1_500)]).events)).eql([
      'speech-start',
      'pause',
      'turn-end',
    ]);
  });
});

describe('the pause that ends a turn', () => {
  const cases: readonly [string, unknown, number][] = [
    ['quick', 'quick', 900],
    ['normal', 'normal', 1_500],
    ['thinker', 'thinker', 2_500],
    ['the shortest setting', 800, 800],
    ['the longest setting', 4_000, 4_000],
    ['a custom length', 1_100, 1_100],
    ['too short clamps up', 100, 800],
    ['too long clamps down', 99_999, 4_000],
    ['nonsense is normal', 'soon', 1_500],
  ];
  for (const [name, pause, pauseMs] of cases)
    it(`${name}: the turn ends ${pauseMs} ms after the last loud frame`, () => {
      const { events, state } = run(pause, [loud(1_000), quiet(pauseMs + 1_000)]);
      should(events).eql([
        { kind: 'speech-start', atMs: 200, sinceMs: 0 },
        { kind: 'pause', atMs: 1_000 + 260, sinceMs: 1_000 },
        { kind: 'turn-end', atMs: 1_000 + pauseMs, speechEndedAtMs: 1_000, reason: 'pause' },
      ]);
      should(state.phase).equal('ended');
    });

  it('one frame short of the pause is not the end', () => {
    const { events } = run('normal', [loud(1_000), quiet(1_480)]);
    should(kinds(events)).eql(['speech-start', 'pause']);
  });

  it('reports the pause once per quiet stretch', () => {
    const { events } = run('thinker', [loud(1_000), quiet(2_000)]);
    should(kinds(events)).eql(['speech-start', 'pause']);
  });

  it('a hangover-length dip inside speech says nothing at all', () => {
    const { events } = run('normal', [
      loud(1_000),
      quiet(HANGOVER_MS - STEP),
      loud(1_000),
      quiet(HANGOVER_MS - STEP),
      loud(200),
    ]);
    should(kinds(events)).eql(['speech-start']);
  });

  it('the voice returning first withdraws the pause, and the pause starts over', () => {
    const { events } = run('normal', [loud(1_000), quiet(1_000), loud(500), quiet(1_500)]);
    should(events).eql([
      { kind: 'speech-start', atMs: 200, sinceMs: 0 },
      { kind: 'pause', atMs: 1_260, sinceMs: 1_000 },
      { kind: 'resume', atMs: 2_020 },
      { kind: 'pause', atMs: 2_500 + 260, sinceMs: 2_500 },
      { kind: 'turn-end', atMs: 2_500 + 1_500, speechEndedAtMs: 2_500, reason: 'pause' },
    ]);
  });

  it('a resume right after the pause was said (a 1.4 s thinking pause) never ends the turn', () => {
    const { events, state } = run('normal', [loud(1_000), quiet(1_480), loud(1_000)]);
    should(kinds(events)).eql(['speech-start', 'pause', 'resume']);
    should(state.phase).equal('speaking');
  });

  it('a finished turn ignores every further frame', () => {
    const done = run('normal', [loud(1_000), quiet(1_500)]).state;
    should(done.phase).equal('ended');
    const more = play(done, framesOf([loud(1_000), quiet(3_000)], 2_500));
    should(more.events).eql([]);
    should(more.state).equal(done);
    should(endpointerHint(done).events).eql([]);
  });
});

describe('engine hints only shorten a pause', () => {
  const speech = (quietMs: number): Played => run('normal', [loud(1_000), quiet(quietMs)]);

  it('ends the turn at 600 ms of quiet instead of 1.5 s', () => {
    const afterBreath = speech(300);
    const hinted = endpointerHint(afterBreath.state);
    should(hinted.events).eql([]);
    const rest = play(hinted.state, framesOf([quiet(1_000)], 1_300));
    should(rest.events).eql([
      { kind: 'turn-end', atMs: 1_000 + HINT_QUIET_MS, speechEndedAtMs: 1_000, reason: 'engine-hint' },
    ]);
  });

  it('ends at once when the quiet is already long enough', () => {
    const waiting = speech(1_000);
    const step = endpointerHint(waiting.state);
    should(step.events).eql([{ kind: 'turn-end', atMs: 2_000, speechEndedAtMs: 1_000, reason: 'engine-hint' }]);
    should(step.state.phase).equal('ended');
  });

  it('a hint before the pause is said waits for 600 ms of quiet', () => {
    const early = endpointerHint(speech(100).state);
    should(early.events).eql([]);
    const rest = play(early.state, framesOf([quiet(900)], 1_100));
    should(rest.events.map(e => [e.kind, e.atMs])).eql([
      ['pause', 1_260],
      ['turn-end', 1_600],
    ]);
  });

  it('never ends a turn while the level says the person is speaking', () => {
    const speaking = run('normal', [loud(1_000)]);
    const step = endpointerHint(speaking.state);
    should(step.events).eql([]);
    should(step.state).equal(speaking.state);
    // …and the hint is not remembered into the next quiet stretch.
    const rest = play(step.state, framesOf([quiet(1_400)], 1_000));
    should(kinds(rest.events)).eql(['pause']);
  });

  it('a hint is forgotten when the voice comes back', () => {
    const hinted = endpointerHint(speech(300).state);
    const resumed = play(hinted.state, framesOf([loud(500), quiet(1_400)], 1_300));
    should(kinds(resumed.events)).eql(['resume', 'pause']);
    should(resumed.state.phase).equal('speaking');
  });

  it('never starts a turn and never ends a burst that is too short', () => {
    should(endpointerHint(endpointerStart()).events).eql([]);
    const burst = run('normal', [loud(300), quiet(100)]);
    const step = endpointerHint(burst.state);
    should(step.events).eql([]);
    should(kinds(play(step.state, framesOf([quiet(1_000)], 400)).events)).eql(['speech-cancel']);
  });

  it('a second hint changes nothing', () => {
    const once = endpointerHint(speech(300).state);
    should(endpointerHint(once.state).state).equal(once.state);
  });

  it('is always a shortening: every allowed pause is longer than the hint floor', () => {
    should(HINT_QUIET_MS < PAUSE_RANGE_MS.min).be.true();
    const { events } = run(800, [loud(1_000), quiet(1_000)]);
    should(events.at(-1)).eql({ kind: 'turn-end', atMs: 1_800, speechEndedAtMs: 1_000, reason: 'pause' });
  });
});

describe('the longest turn', () => {
  it('ends at 120 s however loud it still is', () => {
    const { events, state } = run('normal', [loud(MAX_TURN_MS + 5_000)]);
    should(events).eql([
      { kind: 'speech-start', atMs: 200, sinceMs: 0 },
      { kind: 'turn-end', atMs: MAX_TURN_MS, speechEndedAtMs: MAX_TURN_MS, reason: 'max-turn' },
    ]);
    should(state.phase).equal('ended');
  });

  it('is counted from when speech began, not from when listening began', () => {
    const { events } = run('thinker', [quiet(5_000), loud(MAX_TURN_MS + 5_000)]);
    should(events.at(-1)).eql({
      kind: 'turn-end',
      atMs: 5_000 + MAX_TURN_MS,
      speechEndedAtMs: 5_000 + MAX_TURN_MS,
      reason: 'max-turn',
    });
  });

  it('a long turn with ordinary pauses is cut at the cap, mid-pause if need be', () => {
    const chunks: Run[] = [];
    for (let at = 0; at < MAX_TURN_MS; at += 5_000) chunks.push(loud(4_000), quiet(1_000));
    const { events } = run('thinker', chunks);
    const last = events.at(-1) as EndpointerEvent;
    should(last.kind).equal('turn-end');
    should((last as { reason: string }).reason).equal('max-turn');
    should(last.atMs).equal(MAX_TURN_MS);
  });
});

describe('the longest turn never sends under the minimum', () => {
  it('200 ms of speech then one loud frame at the cap is retracted, not sent', () => {
    const early = framesOf([loud(200)]);
    const { events, state } = play(endpointerStart(), [...early, { atMs: MAX_TURN_MS + 20, rms: LOUD }]);
    should(events.some(e => e.kind === 'turn-end')).be.false();
    should(kinds(events)).eql(['speech-start', 'speech-cancel']);
    should(state.phase).not.equal('ended');
  });

  it('an under-minimum run reaching the cap without a stall is cancelled, never ended', () => {
    // Defensive: build the state a run would be in if the stall rule were not there.
    const early = play(endpointerStart(), framesOf([loud(220)])).state;
    should(early.voicedMs).equal(220);
    const aged: EndpointerState = { ...early, lastAtMs: MAX_TURN_MS - 20 };
    const step = endpointerFeed(aged, { atMs: MAX_TURN_MS, rms: LOUD });
    should(step.events.some(e => e.kind === 'turn-end')).be.false();
    should(step.events.map(e => e.kind)).eql(['speech-cancel']);
    should(step.state.phase).equal('listening');
    should(step.state.voicedMs).equal(0);
  });

  it('sparse loud frames across stalls never add up to a turn', () => {
    const frames: LevelFrame[] = [];
    for (let index = 1; index <= 30; index += 1) frames.push({ atMs: index * 1_000, rms: LOUD });
    const { events, state } = play(endpointerStart(), frames);
    should(events).eql([]);
    should(state.voicedMs).equal(STEP);
    should(state.phase).equal('listening');
  });

  it('a stall cancels a started but unconfirmed run, and a later loud frame cannot confirm it', () => {
    const frames = [...framesOf([loud(220)]), { atMs: 220 + 5_000, rms: LOUD }, { atMs: 220 + 10_000, rms: LOUD }];
    const { events } = play(endpointerStart(), frames);
    should(kinds(events)).eql(['speech-start', 'speech-cancel']);
  });

  it('a stall does not cancel a confirmed turn', () => {
    const frames = [...framesOf([loud(500)]), { atMs: 500 + 5_000, rms: LOUD }];
    const { events, state } = play(endpointerStart(), frames);
    should(kinds(events)).eql(['speech-start']);
    should(state.phase).equal('speaking');
  });
});

describe('the adaptive noise floor', () => {
  const steady = (level: number, ms: number, from = 0): LevelFrame[] => framesOf([[level, ms]], from);

  it('a steady hum above the fixed minimum is not speech', () => {
    // 0.006 is over the 0.004 floor of an empty room, but the hum IS the floor here.
    const { events } = play(endpointerStart(), steady(0.006, 30_000));
    should(events).eql([]);
  });

  it('speech over a hum starts a turn, and the hum alone ends it', () => {
    const frames = [...steady(0.006, 5_000), ...steady(0.08, 1_000, 5_000), ...steady(0.006, 2_000, 6_000)];
    const { events } = play(endpointerStart(), frames);
    should(kinds(events)).eql(['speech-start', 'pause', 'turn-end']);
    should((events.at(-1) as { atMs: number }).atMs).equal(7_500);
  });

  it('a fan with a ripple under the threshold does not break the pause', () => {
    const ripple: Run[] = [];
    for (let at = 0; at < 3_000; at += 40) ripple.push([0.008, 20], [0.011, 20]);
    const { events } = run('normal', [[0.006, 3_000], loud(1_000), ...ripple]);
    should(kinds(events)).eql(['speech-start', 'pause', 'turn-end']);
  });

  it('noise louder than the highest threshold reads as speech: the turn can only reach the cap', () => {
    const { events } = play(endpointerStart(), steady(0.03, MAX_TURN_MS + 1_000));
    should(events.map(e => e.kind)).eql(['speech-start', 'turn-end']);
    should((events.at(-1) as { reason: string }).reason).equal('max-turn');
  });

  it('forgets a floor older than ten seconds', () => {
    // Loud room for 15 s, then it goes quiet: the floor falls back and a soft voice is heard again.
    const frames = [...steady(0.012, 15_000), ...steady(0.0005, 12_000, 15_000), ...steady(0.03, 1_000, 27_000)];
    should(kinds(play(endpointerStart(), frames).events)).eql(['speech-start']);
  });
});

describe('only measured audio counts as loud time', () => {
  it('two loud frames 500 ms apart are 40 ms of loud time, not 520', () => {
    const frames: LevelFrame[] = [{ atMs: 20, rms: LOUD }, { atMs: 520, rms: LOUD }, ...framesOf([quiet(2_000)], 540)];
    const { events, state } = play(endpointerStart(), frames);
    should(state.voicedMs).equal(0);
    should(kinds(events)).eql([]);
    should(state.phase).equal('listening');
  });

  it('a loud frame one frame after a 480 ms hole is credited one frame', () => {
    const early = play(endpointerStart(), [{ atMs: 20, rms: LOUD }]).state;
    const step = endpointerFeed(early, { atMs: 500, rms: LOUD });
    should(step.state.voicedMs).equal(STEP);
    should(step.state.runStartMs).equal(480);
  });

  it('a jittery frame is credited no more than one frame', () => {
    const confirmed = play(endpointerStart(), framesOf([loud(500)])).state;
    const step = endpointerFeed(confirmed, { atMs: 500 + 90, rms: LOUD });
    should(step.state.voicedMs).equal(500 + STEP);
  });

  it('invalid frames through 380 ms then a loud frame at 400 ms are 40 ms of loud time', () => {
    const junk: LevelFrame[] = Array.from({ length: 18 }, (_, index) => ({ atMs: 40 + index * 20, rms: Number.NaN }));
    const { events, state } = play(endpointerStart(), [{ atMs: 20, rms: LOUD }, ...junk, { atMs: 400, rms: LOUD }]);
    should(state.voicedMs).equal(STEP);
    should(state.runStartMs).equal(380);
    should(events).eql([]);
  });

  it('a hole longer than a breath cancels a started, unconfirmed run', () => {
    const frames = [...framesOf([loud(220)]), { atMs: 220 + 300, rms: LOUD }];
    const { events, state } = play(endpointerStart(), frames);
    should(kinds(events)).eql(['speech-start', 'speech-cancel']);
    should(state.voicedMs).equal(STEP);
    should(state.phase).equal('listening');
  });

  it('a hole of exactly one hangover does not break a run, and a confirmed turn is never broken', () => {
    const { state } = play(endpointerStart(), [...framesOf([loud(100)]), { atMs: 100 + HANGOVER_MS, rms: LOUD }]);
    should(state.voicedMs).equal(100 + STEP);
    const confirmed = play(endpointerStart(), [...framesOf([loud(500)]), { atMs: 500 + 400, rms: LOUD }]);
    should(confirmed.state.voicedMs).equal(500 + STEP);
    should(kinds(confirmed.events)).eql(['speech-start']);
  });

  it('a hole inside a quiet part of an unconfirmed run over the hangover forgets it', () => {
    const { state } = play(endpointerStart(), [
      { atMs: 20, rms: LOUD },
      { atMs: 400, rms: QUIET },
    ]);
    should(state.runStartMs).equal(null);
    should(state.voicedMs).equal(0);
  });
});

describe('soft speech is never learned as the room', () => {
  const steady = (level: number, ms: number, from = 0): LevelFrame[] => framesOf([[level, ms]], from);

  it('5 s of a quiet room then 15 s of uninterrupted soft speech is one unbroken turn', () => {
    const frames = [...steady(0.001, 5_000), ...steady(0.025, 15_000, 5_000)];
    const { events, state } = play(endpointerStart(), frames);
    should(kinds(events)).eql(['speech-start']);
    should(state.phase).equal('speaking');
    should(state.pauseSaid).be.false();
  });

  it('and it ends 1.5 s after the soft speech really stops', () => {
    const frames = [...steady(0.001, 5_000), ...steady(0.025, 15_000, 5_000), ...steady(0.001, 2_000, 20_000)];
    const { events } = play(endpointerStart(), frames);
    should(kinds(events)).eql(['speech-start', 'pause', 'turn-end']);
    should((events.at(-1) as { atMs: number; speechEndedAtMs: number }).atMs).equal(21_500);
    should((events.at(-1) as { speechEndedAtMs: number }).speechEndedAtMs).equal(20_000);
  });

  it('quiet frames between words are still learned while speaking', () => {
    const frames = [...steady(0.001, 2_000), ...steady(0.025, 1_000, 2_000), ...steady(0.003, 100, 3_000)];
    const { state } = play(endpointerStart(), frames);
    should(state.levels.at(-1)).equal(0.003);
    should(state.levels.filter(level => level === 0.025).length).be.below(11);
  });
});

describe('a stalled stream', () => {
  it('cannot end a turn: quiet is counted afresh from after the gap', () => {
    const before = framesOf([loud(1_000), quiet(1_000)]);
    const after = framesOf([quiet(1_000)], 2_000 + 5_000);
    const { events } = play(endpointerStart(), [...before, ...after]);
    // 1.0 s of quiet before the gap, 5 s of nothing, then 1.0 s of quiet again: no turn-end at the gap.
    should(kinds(events)).eql(['speech-start', 'pause']);
    should(events.every(e => e.kind !== 'turn-end')).be.true();
  });

  it('still ends the turn once 1.5 s of quiet has really been heard after the gap', () => {
    const before = framesOf([loud(1_000)]);
    const after = framesOf([quiet(2_000)], 1_000 + 5_000);
    const { events } = play(endpointerStart(), [...before, ...after]);
    const end = events.find(e => e.kind === 'turn-end') as { atMs: number };
    should(end.atMs).equal(6_000 + 1_500);
  });

  it('a gap inside speech just adds one frame of loud time', () => {
    const { events } = play(endpointerStart(), [
      { atMs: 20, rms: LOUD },
      { atMs: 5_000, rms: LOUD },
      { atMs: 10_000, rms: LOUD },
    ]);
    should(events).eql([]);
  });
});

describe('frames that make no sense', () => {
  const state = run('normal', [loud(300)]).state;
  const junk: readonly [string, LevelFrame][] = [
    ['NaN time', { atMs: Number.NaN, rms: LOUD }],
    ['infinite time', { atMs: Number.POSITIVE_INFINITY, rms: LOUD }],
    ['NaN level', { atMs: 400, rms: Number.NaN }],
    ['infinite level', { atMs: 400, rms: Number.POSITIVE_INFINITY }],
    ['negative level', { atMs: 400, rms: -1 }],
    ['the same instant twice', { atMs: 300, rms: LOUD }],
    ['an older frame', { atMs: 100, rms: QUIET }],
  ];
  for (const [name, frame] of junk)
    it(`${name} changes nothing`, () => {
      const step = endpointerFeed(state, frame);
      should(step.state).equal(state);
      should(step.events).eql([]);
    });

  it('does not mutate the state it is given', () => {
    const before = structuredClone(state);
    endpointerFeed(state, { atMs: 320, rms: QUIET });
    endpointerHint(state);
    should(state).eql(before);
  });

  it('gives the same answer for the same state and frame', () => {
    const frame = { atMs: 320, rms: QUIET };
    should(endpointerFeed(state, frame)).eql(endpointerFeed(state, frame));
  });
});

describe('totality', () => {
  /** A small seeded generator so a failure names its seed. */
  const random = (seed: number): (() => number) => {
    let value = seed;
    return () => {
      value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
      return value / 2 ** 32;
    };
  };
  const levels = [0, 0.0005, 0.003, 0.006, 0.012, 0.03, 0.1, 0.5, 1, Number.NaN, -1, Number.POSITIVE_INFINITY];

  for (let seed = 1; seed <= 25; seed += 1)
    it(`seed ${seed}: never throws and the history is well formed`, () => {
      const next = random(seed);
      let state = endpointerStart(next() < 0.5 ? 'quick' : next() * 5_000);
      let atMs = 0;
      const history: EndpointerEvent[] = [];
      for (let index = 0; index < 3_000; index += 1) {
        atMs += next() < 0.01 ? Math.floor(next() * 3_000) : next() < 0.05 ? 0 : 20;
        const rms = levels[Math.floor(next() * levels.length)] as number;
        const stepped = next() < 0.02 ? endpointerHint(state) : endpointerFeed(state, { atMs, rms });
        state = stepped.state;
        history.push(...stepped.events);
      }
      let speaking = false;
      let ended = false;
      let paused = false;
      for (const event of history) {
        should(ended).be.false();
        if (event.kind === 'speech-start') {
          should(speaking).be.false();
          speaking = true;
        } else if (event.kind === 'speech-cancel') {
          should(speaking).be.true();
          speaking = false;
          paused = false;
        } else if (event.kind === 'pause') {
          should(speaking && !paused).be.true();
          paused = true;
        } else if (event.kind === 'resume') {
          should(speaking && paused).be.true();
          paused = false;
        } else {
          should(speaking).be.true();
          ended = true;
        }
      }
      should(Number.isFinite(state.pauseMs)).be.true();
      should(state.levels.length <= 500).be.true();
    });
});

describe('endpointerStart options', () => {
  const steady = (level: number, ms: number, from = 0): LevelFrame[] => framesOf([[level, ms]], from);

  it('starts with no history and the default ceiling', () => {
    const state = endpointerStart();
    should(state.levels).eql([]);
    should(state.maxQuietRms).equal(ENDPOINTER_MAX_QUIET_RMS);
  });

  it('seeds the noise floor from levels heard before, so a new turn does not start blind', () => {
    const seeded = endpointerStart('normal', { floorLevels: new Array<number>(100).fill(0.0005) });
    // A hum that arrives after a quiet room is louder than the remembered floor allows: speech.
    should(kinds(play(seeded, steady(0.01, 400)).events)).eql(['speech-start']);
    // With no memory the hum IS the floor from its first frame, and nothing starts.
    should(play(endpointerStart(), steady(0.01, 400)).events).eql([]);
  });

  it('drops junk seed levels and keeps only what the floor window holds', () => {
    const seeds = [Number.NaN, -1, Number.POSITIVE_INFINITY, ...new Array<number>(900).fill(0.002)];
    should(endpointerStart('normal', { floorLevels: seeds }).levels.length).equal(500);
    should(endpointerStart('normal', { floorLevels: [Number.NaN, -3] }).levels).eql([]);
  });

  it('takes a lower ceiling for the harness to sweep, and ignores a nonsense one', () => {
    const low = endpointerStart('normal', { maxQuietRms: 0.015 });
    should(low.maxQuietRms).equal(0.015);
    should(kinds(play(low, steady(0.02, 400)).events)).eql(['speech-start']);
    should(play(endpointerStart(), steady(0.02, 400)).events).eql([]);
    for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      should(endpointerStart('normal', { maxQuietRms: nonsense }).maxQuietRms).equal(ENDPOINTER_MAX_QUIET_RMS);
  });
});
