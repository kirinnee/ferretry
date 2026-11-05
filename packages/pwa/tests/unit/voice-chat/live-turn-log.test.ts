/**
 * Proves the Live turn log: numbers only, the newest kept, the median and p90 of the stages, and the
 * sentence the bar says under Working.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { TurnNumbers } from '../../../src/lib/voice-chat/live-machine.ts';
import { LiveTurnLog, lastTurnCopy, summarizeTurns, TURN_LOG_SIZE } from '../../../src/lib/voice-chat/live-turn-log.ts';

const turn = (lastWordToSentMs: number, endToWordsMs = 300): TurnNumbers => ({
  turn: 1,
  endReason: 'pause',
  endToWordsMs,
  graceMs: 1_500,
  endToSendMs: lastWordToSentMs - 1_500,
  lastWordToSentMs,
  resumed: false,
  sendNow: false,
});

describe('LiveTurnLog', () => {
  it('keeps the newest turns only, and knows the last', () => {
    const log = new LiveTurnLog();
    should(log.last).equal(null);
    for (let ms = 1; ms <= TURN_LOG_SIZE + 5; ms += 1) log.add(turn(ms * 1_000));
    should(log.turns.length).equal(TURN_LOG_SIZE);
    should(log.turns[0]?.lastWordToSentMs).equal(6_000);
    should(log.last?.lastWordToSentMs).equal((TURN_LOG_SIZE + 5) * 1_000);
  });

  it('holds numbers and nothing else', () => {
    const log = new LiveTurnLog();
    log.add(turn(3_100));
    should(Object.keys(log.turns[0] ?? {}).sort()).deepEqual([
      'endReason',
      'endToSendMs',
      'endToWordsMs',
      'graceMs',
      'lastWordToSentMs',
      'resumed',
      'sendNow',
      'turn',
    ]);
    for (const value of Object.values(log.turns[0] ?? {}))
      should(['number', 'string', 'boolean']).containEql(typeof value);
  });
});

describe('summarizeTurns', () => {
  it('is null with no turns', () => {
    should(summarizeTurns([])).equal(null);
  });

  it('gives the median and p90 of each stage', () => {
    const turns = [3_000, 3_200, 3_400, 3_600, 5_000].map((ms, index) => turn(ms, 100 * (index + 1)));
    should(summarizeTurns(turns)).deepEqual({
      count: 5,
      lastWordToSentMs: { p50: 3_400, p90: 5_000 },
      endToWordsMs: { p50: 300, p90: 500 },
    });
  });
});

describe('lastTurnCopy', () => {
  it('says the last word to sent time in seconds', () => {
    should(lastTurnCopy(turn(3_449))).equal('Sent 3.4 s after your last word.');
  });
});
