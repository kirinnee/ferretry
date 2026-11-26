import { describe, expect, test } from 'bun:test';
import { createLiveLines } from '../../../app/lib/voice-mode/live-lines.ts';
import { createMachineSpeaker } from '../../../app/lib/voice-mode/machine-speaker.ts';
import { shareStream } from '../../../app/lib/voice-mode/shared-stream.ts';
import type { SpeechLineEvent, VoiceStreamHandle } from '../../../app/lib/stream/voice-stream.ts';

/** One stop, two owners: the panel hands the reading of a reply and the live lines the SAME stream view. */
function panel() {
  let next = 0;
  const calls = { hush: 0, interrupt: 0, speak: [] as string[] };
  const handle: Pick<VoiceStreamHandle, 'speak' | 'drop' | 'hush' | 'interrupt'> = {
    speak: text => {
      calls.speak.push(text);
      const id = next;
      next += 1;
      return [{ id, text }];
    },
    drop: () => undefined,
    hush: () => {
      calls.hush += 1;
    },
    interrupt: () => {
      calls.interrupt += 1;
    },
  };
  const stream = shareStream(() => handle as VoiceStreamHandle);
  const sound = { remaining: 0 };
  const player = { remainingMs: () => sound.remaining };
  const speaker = createMachineSpeaker({ stream, replyState: () => 'ready', player, every: () => () => undefined });
  const lines = createLiveLines({ stream, replyState: () => 'ready', player, every: () => () => undefined });
  const onSpeech = (event: SpeechLineEvent): void => {
    speaker.onSpeech(event);
    lines.onSpeech(event);
  };
  return { calls, speaker, lines, onSpeech, sound };
}

describe('one shared stop for the reading and the live lines', () => {
  test('a failed line starts the fallback reading while a second line is live; hiding the tab hushes ONCE and settles both', () => {
    const p = panel();
    const outcomes: Record<string, string> = {};
    const reading: string[] = [];
    // Line A is live; its failure starts the end-of-turn reading of it (as Auto-read does) while line B is still live.
    p.lines.say({ id: 'A', text: 'Line A.', kind: 'first' }, outcome => {
      outcomes.A = outcome;
      if (outcome === 'failed')
        p.speaker.speak({ segments: ['Line A.'] } as never, event => {
          reading.push(event.type);
        });
    });
    p.lines.say({ id: 'B', text: 'Line B.', kind: 'line' }, outcome => {
      outcomes.B = outcome;
    });
    p.onSpeech({ id: 0, event: 'failed' });
    expect(outcomes).toEqual({ A: 'failed' });
    expect(p.calls.speak).toEqual(['Line A.', 'Line B.', 'Line A.']);
    p.sound.remaining = 500;
    // The tab hides: both owners' hide handlers run.
    p.speaker.stop('automatic');
    p.lines.quiet();
    expect(p.calls.hush).toBe(1);
    expect(p.calls.interrupt).toBe(0);
    expect(reading).toEqual(['stopped']);
    expect(outcomes).toEqual({ A: 'failed', B: 'hushed' });
  });

  test('the other order hushes once too', () => {
    const p = panel();
    const outcomes: Record<string, string> = {};
    p.lines.say({ id: 'B', text: 'Line B.', kind: 'first' }, outcome => {
      outcomes.B = outcome;
    });
    p.speaker.speak({ segments: ['Reading.'] } as never, () => undefined);
    p.lines.quiet();
    p.speaker.stop('automatic');
    expect(p.calls.hush).toBe(1);
    expect(outcomes).toEqual({ B: 'hushed' });
  });

  test('a person stop is never swallowed by an earlier plain hush, and new sound can be hushed again', () => {
    const p = panel();
    p.lines.say({ id: 'B', text: 'Line B.', kind: 'first' }, () => undefined);
    p.lines.quiet();
    p.lines.say({ id: 'C', text: 'Line C.', kind: 'first' }, () => undefined);
    p.lines.hush();
    expect(p.calls.hush).toBe(1);
    expect(p.calls.interrupt).toBe(1);
    p.lines.say({ id: 'D', text: 'Line D.', kind: 'first' }, () => undefined);
    p.lines.quiet();
    expect(p.calls.hush).toBe(2);
  });
});
