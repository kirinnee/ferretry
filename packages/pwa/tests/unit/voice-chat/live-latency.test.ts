/**
 * THE LAST-WORD-TO-SENT LATENCY OF THE REAL LOOP, computed — not measured with a microphone.
 *
 * The machine, the runner and the endpointer here are the real ones; the engine is a fake whose
 * `endTurn` takes as long as the numbers `docs/voice.md` measured for each real engine on the box that
 * wrote it ("After early finish"), clean-up is a fixed assumed delay, and the clock is virtual. So the
 * table below is what the LOOP adds on top of those measured engine times (the pause, the settle rule,
 * the countdown), and it is labelled "computed" wherever it is quoted. No audio and no words.
 */

import { describe, expect, it } from 'bun:test';
import { LiveRunner } from '../../../src/lib/voice-chat/live-runner.ts';
import type { TurnNumbers } from '../../../src/lib/voice-chat/live-machine.ts';
import { fakeLive } from '../../support/live-ports.ts';

/** Engine decode left after the pause is confirmed, from `docs/voice.md` › Measured, on this machine. */
const ENGINES = [
  { name: 'Parakeet 110M', afterPauseMs: 0 },
  { name: 'Parakeet 0.6B (early finish)', afterPauseMs: 220 },
  { name: 'Vosk small', afterPauseMs: 50 },
  { name: 'Whisper base.en (early finish)', afterPauseMs: 1_790 },
  { name: 'Parakeet 0.6B (no early finish)', afterPauseMs: 1_760 },
] as const;

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
};

/** Time passing the way it does for a person: a frame at a time, with the answers of the engine landing in between. */
const pass = async (fake: ReturnType<typeof fakeLive>, rms: number, ms: number): Promise<void> => {
  for (let spent = 0; spent < ms; spent += 20) {
    fake.hear(rms, 20);
    await flush();
  }
};

const turnWith = async (decodeMs: number, graceMs: number): Promise<TurnNumbers> => {
  const fake = fakeLive();
  const numbers: TurnNumbers[] = [];
  const runner = new LiveRunner(fake.ports, { canSend: true, graceMs, onTurn: turn => numbers.push(turn) });
  runner.start();
  await flush();
  fake.decodeMs.current = decodeMs;
  await pass(fake, 0.1, 600);
  await pass(fake, 0.001, 1_500 + Math.max(graceMs, decodeMs + 500) + 600);
  runner.dispose();
  const [sent] = numbers;
  if (sent === undefined) throw new Error('the turn was never sent');
  return sent;
};

describe('Live loop latency (computed over the engines measured in docs/voice.md)', () => {
  for (const engine of ENGINES) {
    it(`${engine.name}: last word to sent stays within the pause, the countdown and the decode left`, async () => {
      const turn = await turnWith(engine.afterPauseMs, 1_500);
      // The pause (1.5 s) + the larger of the countdown and decode+settle, with a frame of slack.
      const floor = 1_500 + Math.max(1_500, engine.afterPauseMs + 500);
      expect(turn.lastWordToSentMs).toBeGreaterThanOrEqual(floor - 40);
      expect(turn.lastWordToSentMs).toBeLessThanOrEqual(floor + 200);
    });
  }

  it('Send now and a zero countdown cut the wait to the pause plus the decode', async () => {
    const turn = await turnWith(220, 0);
    expect(turn.lastWordToSentMs).toBeLessThanOrEqual(1_500 + 220 + 200);
  });
});
