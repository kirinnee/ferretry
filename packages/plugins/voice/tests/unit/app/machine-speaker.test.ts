import { describe, expect, test } from 'bun:test';
import type { ReplyState } from '../../../contract/index.ts';
import { createReadAloud } from '../../../app/lib/voice-chat/read-aloud.ts';
import type { SpeakerEvent, SpeakerPort, SpeakRequest } from '../../../app/lib/voice-chat/ports.ts';
import { createMachineSpeaker } from '../../../app/lib/voice-mode/machine-speaker.ts';

function rig(options: { state?: ReplyState | undefined; stream?: boolean; remaining?: number } = {}) {
  const sent: string[] = [];
  let hushes = 0;
  let interrupts = 0;
  let ids = 0;
  let remaining = options.remaining ?? 0;
  let tick: (() => void) | undefined;
  const active: boolean[] = [];
  const speaker = createMachineSpeaker({
    stream: () =>
      options.stream === false
        ? undefined
        : {
            speak: text => {
              sent.push(text);
              return [{ id: ids++, text }];
            },
            hush: () => {
              hushes += 1;
            },
            interrupt: () => {
              hushes += 1;
              interrupts += 1;
            },
          },
    replyState: () => ('state' in options ? options.state : 'ready'),
    player: { remainingMs: () => remaining },
    onActive: on => void active.push(on),
    every: fn => {
      tick = fn;
      return () => {
        tick = undefined;
      };
    },
  });
  const events: SpeakerEvent[] = [];
  const request = (segments: string[]): SpeakRequest => ({ segments, rate: 1, voice: null, language: 'en-US' });
  return {
    speaker,
    sent,
    events,
    active,
    request,
    hushes: () => hushes,
    /** Of those, the ones that carry where the person's ears were (the person stopped it). */
    interrupts: () => interrupts,
    ticking: () => tick !== undefined,
    tick: () => tick?.(),
    setRemaining: (ms: number) => {
      remaining = ms;
    },
    start: (segments: string[]) => speaker.speak(request(segments), event => void events.push(event)),
  };
}

describe('the machine speaker', () => {
  test('sends each caption to the machine in order, reports each as its sound starts, and ends once it has been heard', () => {
    const r = rig();
    r.start(['Let me check.', 'It passes.']);
    expect(r.sent).toEqual(['Let me check.', 'It passes.']);
    expect(r.active).toEqual([true]);
    r.speaker.onSpeech({ id: 0, event: 'started' });
    r.speaker.onSpeech({ id: 0, event: 'finished' });
    r.speaker.onSpeech({ id: 1, event: 'started' });
    r.speaker.onSpeech({ id: 1, event: 'finished' });
    r.setRemaining(900);
    expect(r.ticking()).toBe(true);
    r.tick();
    expect(r.events).toEqual([
      { type: 'segment', index: 0 },
      { type: 'segment', index: 1 },
    ]);
    r.setRemaining(0);
    r.tick();
    expect(r.events.at(-1)).toEqual({ type: 'end' });
    expect(r.active).toEqual([true, false]);
    expect(r.hushes()).toBe(0);
    expect(r.ticking()).toBe(false);
  });

  test('stop silences it: the machine is hushed, the reading hears "stopped", and nothing more is said', () => {
    const r = rig();
    r.start(['One.', 'Two.']);
    r.speaker.onSpeech({ id: 0, event: 'started' });
    r.speaker.stop();
    expect(r.hushes()).toBe(1);
    expect(r.events.at(-1)).toEqual({ type: 'stopped' });
    expect(r.active).toEqual([true, false]);
    // A late event of the stopped reading is ignored.
    r.speaker.onSpeech({ id: 1, event: 'started' });
    r.speaker.onSpeech({ id: 1, event: 'failed', code: 'x' });
    expect(r.events).toEqual([{ type: 'segment', index: 0 }, { type: 'stopped' }]);
    // Stopping with nothing playing does nothing.
    r.speaker.stop();
    expect(r.hushes()).toBe(1);
  });

  test('no stream, or a machine without the reply voice, is "unavailable" at once and sends nothing', () => {
    const none = rig({ stream: false });
    none.start(['Hello.']);
    expect(none.events).toEqual([{ type: 'error', reason: 'unavailable' }]);
    expect(none.active).toEqual([]);
    const absent = rig({ state: 'absent' });
    absent.start(['Hello.']);
    expect(absent.sent).toEqual([]);
    expect(absent.events).toEqual([{ type: 'error', reason: 'unavailable' }]);
  });

  test('a reply voice that is still loading takes the line (it waits for the voice rather than switching voices)', () => {
    const loading = rig({ state: 'loading' });
    loading.start(['Hello.']);
    expect(loading.sent).toEqual(['Hello.']);
    const unknown = rig({ state: undefined });
    unknown.start(['Hello.']);
    expect(unknown.sent).toEqual(['Hello.']);
  });

  test('a line that failed before any sound is "unavailable" (the device reads it); after sound it is "failed" (never read twice)', () => {
    const early = rig();
    early.start(['One.', 'Two.']);
    early.speaker.onSpeech({ id: 0, event: 'failed', code: 'reply_failed' });
    expect(early.events).toEqual([{ type: 'error', reason: 'unavailable' }]);
    expect(early.hushes()).toBe(1);
    expect(early.active).toEqual([true, false]);

    const late = rig();
    late.start(['One.', 'Two.']);
    late.speaker.onSpeech({ id: 0, event: 'started' });
    late.speaker.onSpeech({ id: 0, event: 'finished' });
    late.speaker.onSpeech({ id: 1, event: 'failed', code: 'reply_failed' });
    expect(late.events.at(-1)).toEqual({ type: 'error', reason: 'failed' });
    expect(late.hushes()).toBe(1);
  });

  test('V3: the person’s stop says where their ears were; a reading replaced, or failed, is only flushed', () => {
    const stopped = rig();
    stopped.start(['One.']);
    stopped.speaker.onSpeech({ id: 0, event: 'started' });
    stopped.speaker.stop();
    expect([stopped.hushes(), stopped.interrupts()]).toEqual([1, 1]);
    const replaced = rig();
    replaced.start(['First.']);
    replaced.speaker.onSpeech({ id: 0, event: 'started' });
    replaced.speaker.speak(replaced.request(['Second.']), event => void replaced.events.push(event));
    expect([replaced.hushes(), replaced.interrupts()]).toEqual([1, 0]);
    const failed = rig();
    failed.start(['One.']);
    failed.speaker.onSpeech({ id: 0, event: 'started' });
    failed.speaker.onSpeech({ id: 0, event: 'failed', code: 'x' });
    expect([failed.hushes(), failed.interrupts()]).toEqual([1, 0]);
  });

  test('a new reading replaces the one before it, which is hushed', () => {
    const r = rig();
    r.start(['First.']);
    r.speaker.onSpeech({ id: 0, event: 'started' });
    r.speaker.speak(r.request(['Second.']), event => void r.events.push(event));
    expect(r.hushes()).toBe(1);
    expect(r.events).toContainEqual({ type: 'stopped' });
    expect(r.sent).toEqual(['First.', 'Second.']);
    r.speaker.onSpeech({ id: 1, event: 'started' });
    expect(r.events.at(-1)).toEqual({ type: 'segment', index: 0 });
  });
});

/** The device's own voice: records what it is asked to say. */
function device(): SpeakerPort & { said: SpeakRequest[]; stops: number } {
  const port = {
    said: [] as SpeakRequest[],
    stops: 0,
    supported: true,
    voices: () => [{ id: 'd', name: 'Device', lang: 'en-US', local: true, isDefault: true }],
    unlock: () => undefined,
    speak(request: SpeakRequest) {
      port.said.push(request);
    },
    stop() {
      port.stops += 1;
    },
  };
  return port;
}

describe('the read-aloud controller with the machine voice attached', () => {
  const reply = '<voice>Let me check.</voice>\n\nSome detail the screen shows.';

  test('a reading goes to the machine, with no device voice needed, and says the text stays on the machine', () => {
    const port = device();
    const none: SpeakerPort = { ...port, voices: () => [] };
    const controller = createReadAloud({ speaker: none });
    expect(controller.supported).toBe(true);
    const r = rig();
    controller.attach(r.speaker);
    controller.read('k', reply);
    expect(r.sent).toEqual(['Let me check.']);
    expect(controller.getState().status).toBe('reading');
    expect(controller.getState().voiceNote).toBeNull();
    r.speaker.onSpeech({ id: 0, event: 'started' });
    r.speaker.onSpeech({ id: 0, event: 'finished' });
    r.tick();
    expect(controller.getState().status).toBe('finished');
  });

  test('a machine without the reply voice hands the same words to the device voice', () => {
    const port = device();
    const controller = createReadAloud({ speaker: port });
    const r = rig({ state: 'absent' });
    controller.attach(r.speaker);
    controller.read('k', reply);
    expect(r.sent).toEqual([]);
    expect(port.said).toHaveLength(1);
    expect(port.said[0]?.segments).toEqual(['Let me check.']);
    expect(controller.getState().status).toBe('reading');
  });

  test('a machine voice that fails on the first line falls back once, and stop then silences the device voice', () => {
    const port = device();
    const controller = createReadAloud({ speaker: port });
    const r = rig();
    controller.attach(r.speaker);
    controller.read('k', reply);
    r.speaker.onSpeech({ id: 0, event: 'failed', code: 'reply_failed' });
    expect(port.said).toHaveLength(1);
    controller.stop();
    expect(port.stops).toBeGreaterThan(0);
    expect(controller.getState().status).toBe('stopped');
  });

  test('failing after it was heard is "failed", and the device does not read it again', () => {
    const port = device();
    const controller = createReadAloud({ speaker: port });
    const r = rig();
    controller.attach(r.speaker);
    controller.read('k', reply);
    r.speaker.onSpeech({ id: 0, event: 'started' });
    r.speaker.onSpeech({ id: 0, event: 'failed', code: 'reply_failed' });
    expect(port.said).toEqual([]);
    expect(controller.getState().status).toBe('failed');
  });

  test('stop (the person’s, or barge-in) hushes the machine', () => {
    const controller = createReadAloud({ speaker: device() });
    const r = rig();
    controller.attach(r.speaker);
    controller.read('k', reply);
    r.speaker.onSpeech({ id: 0, event: 'started' });
    controller.stop();
    expect(r.hushes()).toBe(1);
    expect(controller.getState().status).toBe('stopped');
  });

  test('detaching (voice mode ended) stops the reading, and the device voice is the reader again', () => {
    const port = device();
    const controller = createReadAloud({ speaker: port });
    const r = rig();
    controller.attach(r.speaker);
    controller.read('k', reply);
    controller.attach(null);
    expect(r.hushes()).toBe(1);
    expect(controller.getState().status).toBe('stopped');
    controller.read('k2', reply);
    expect(port.said).toHaveLength(1);
  });

  test('with no device voice and no machine voice attached nothing changes: the reading is unavailable', () => {
    const controller = createReadAloud({ speaker: { ...device(), voices: () => [] } });
    controller.read('k', reply);
    expect(controller.getState().status).toBe('unavailable');
  });

  test('a machine that cannot begin, with no device voice either, is unavailable and says so', () => {
    const controller = createReadAloud({ speaker: { ...device(), voices: () => [] } });
    const r = rig({ state: 'absent' });
    controller.attach(r.speaker);
    controller.read('k', reply);
    expect(controller.getState().status).toBe('unavailable');
  });
});

describe('the machine speaker on its own clock', () => {
  test('has no device voices to offer, nothing to unlock, and ends a finished reading on a real timer', async () => {
    const events: SpeakerEvent[] = [];
    const speaker = createMachineSpeaker({
      stream: () => ({ speak: text => [{ id: 0, text }], hush: () => undefined, interrupt: () => undefined }),
      replyState: () => 'ready',
      player: { remainingMs: () => 0 },
    });
    expect(speaker.voices()).toEqual([]);
    expect(speaker.unlock()).toBeUndefined();
    speaker.speak({ segments: ['Hello.'], rate: 1, voice: null, language: 'en-US' }, event => void events.push(event));
    speaker.onSpeech({ id: 0, event: 'started' });
    speaker.onSpeech({ id: 0, event: 'finished' });
    await Bun.sleep(250);
    expect(events.at(-1)).toEqual({ type: 'end' });
  });
});

describe('the machine speaker when the stream has ended', () => {
  test('a stream that takes no line (it is over) is "unavailable", so the device reads it', () => {
    const events: SpeakerEvent[] = [];
    const active: boolean[] = [];
    const speaker = createMachineSpeaker({
      stream: () => ({ speak: () => [], hush: () => undefined, interrupt: () => undefined }),
      replyState: () => 'ready',
      player: { remainingMs: () => 0 },
      onActive: on => void active.push(on),
    });
    speaker.speak({ segments: ['Hello.'], rate: 1, voice: null, language: 'en-US' }, event => void events.push(event));
    expect(events).toEqual([{ type: 'error', reason: 'unavailable' }]);
    expect(active).toEqual([]);
  });
});
