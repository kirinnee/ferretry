/**
 * Proves Live's reader: what it picks from the conversation and when, how a reading ends (and that it ends
 * exactly once), and that it speaks through the page's ONE read-aloud controller:
 *
 *   - ONLY the last message of the turn (or every one, when chosen); a silent turn says so; a question is read;
 *   - it waits until the conversation has held still, but not for ever;
 *   - the reply of the PREVIOUS turn is never read for a turn that wrote no text (`mark`);
 *   - the cap (~60 s), the voice and the speed are the person's device settings, read at each reading;
 *   - finished / stopped / failed / no-voice each end it once; a newer reading or another one taking the voice stops it;
 *   - nothing throws, whatever the source or the speaker does.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  createLiveReader,
  MAX_WAIT_MS,
  pageVoice,
  QUIET_MS,
  type LiveReadingSource,
} from '../../../src/lib/voice-chat/live-reader.ts';
import { DEFAULT_LIVE_VOICE_SETTINGS, type LiveVoiceSettings } from '../../../src/lib/voice-chat/live-settings.ts';
import type {
  ReadEnd,
  SpeakerEvent,
  SpeakerPort,
  SpeakerVoice,
  SpeakRequest,
} from '../../../src/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../../src/lib/voice-chat/read-aloud.ts';
import type { PickerRow } from '../../../src/lib/voice-chat/reply-picker.ts';

const LOCAL: SpeakerVoice = { id: 'local', name: 'Local', lang: 'en-US', local: true, isDefault: true };

class Clock {
  now = 0;
  #timers: { at: number; run: () => void; live: boolean }[] = [];
  readonly port = {
    now: () => this.now,
    after: (ms: number, run: () => void) => {
      const entry = { at: this.now + ms, run, live: true };
      this.#timers.push(entry);
      return () => {
        entry.live = false;
      };
    },
  };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.#timers.filter(t => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      this.now = due.at;
      due.run();
    }
    this.now = target;
  }
  get pending(): number {
    return this.#timers.filter(t => t.live).length;
  }
}

const scripted = (voices: SpeakerVoice[] = [LOCAL]) => {
  const requests: SpeakRequest[] = [];
  const listeners: ((event: SpeakerEvent) => void)[] = [];
  const log: string[] = [];
  const port: SpeakerPort = {
    supported: true,
    voices: () => voices,
    unlock: () => void log.push('unlock'),
    speak: (request, onEvent) => {
      requests.push(request);
      listeners.push(onEvent);
    },
    stop: () => void log.push('stop'),
  };
  return { port, requests, log, say: (event: SpeakerEvent) => listeners.at(-1)?.(event) };
};

const row = (id: string, kind: string, text: string): PickerRow => ({ id, kind, text });
const PREVIOUS = [row('u1', 'user', 'first'), row('a1', 'assistant', 'The previous reply.')];

const setup = (
  options: {
    rows?: PickerRow[];
    settings?: Partial<LiveVoiceSettings>;
    voices?: SpeakerVoice[];
    question?: Parameters<LiveReadingSource['question']> extends [] ? ReturnType<LiveReadingSource['question']> : never;
  } = {},
) => {
  const clock = new Clock();
  const speaker = scripted(options.voices);
  const controller = createReadAloud({ speaker: speaker.port, language: () => 'en-US' });
  const world = { rows: options.rows ?? [...PREVIOUS], question: options.question ?? null };
  const settings = { ...DEFAULT_LIVE_VOICE_SETTINGS, ...options.settings };
  const source: LiveReadingSource = { rows: () => world.rows, question: () => world.question };
  const reader = createLiveReader({ controller, source, settings: () => settings, clock: clock.port });
  const ends: ReadEnd[] = [];
  const read = (what: 'reply' | 'question' = 'reply'): void => reader.read(what, end => ends.push(end));
  /** Let the conversation settle and speech begin. */
  const settle = (): void => clock.advance(QUIET_MS + 200);
  return { clock, speaker, controller, world, reader, ends, read, settle };
};

describe('createLiveReader — what it reads', () => {
  it('reads ONLY the last message of the turn, after the conversation has held still', () => {
    const s = setup();
    s.reader.mark();
    s.world.rows = [
      ...PREVIOUS,
      row('u2', 'user', 'second'),
      row('a2', 'assistant', 'Let me look at that.'),
      row('a3', 'assistant', 'All done. Two files changed.'),
    ];
    s.read();
    s.clock.advance(QUIET_MS - 100);
    should(s.speaker.requests.length).equal(0);
    s.settle();
    should(s.speaker.requests.length).equal(1);
    should(s.speaker.requests[0]?.segments.join(' ')).equal('All done. Two files changed.');
    should(s.controller.getState().key).equal('a3');
  });

  it('reads every message of the turn when the person chose that', () => {
    const s = setup({ settings: { whatToRead: 'every' } });
    s.reader.mark();
    s.world.rows = [
      ...PREVIOUS,
      row('u2', 'user', 'second'),
      row('a2', 'assistant', 'One.'),
      row('a3', 'assistant', 'Two.'),
    ];
    s.read();
    s.settle();
    should(s.speaker.requests[0]?.segments.join(' ')).equal('One. Two.');
  });

  it("a turn that wrote no text says so — it never falls back to the previous turn's reply", () => {
    const s = setup();
    s.reader.mark();
    s.world.rows = [...PREVIOUS, row('u2', 'user', 'second')];
    s.read();
    s.settle();
    should(s.speaker.requests[0]?.segments.join(' ')).equal('Done. No message.');
  });

  it('reads a question and its options, and says where the prompt is when it has nothing readable', () => {
    const s = setup({
      question: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] },
    });
    s.read('question');
    s.settle();
    should(s.speaker.requests[0]?.segments.join(' ')).containEql('Which branch?');
    should(s.speaker.requests[0]?.segments.join(' ')).containEql('main');
    const bare = setup();
    bare.read('question');
    bare.settle();
    should(bare.speaker.requests[0]?.segments.join(' ')).containEql('on screen');
  });

  it('waits while the reply is still arriving, but only up to the cap', () => {
    const s = setup();
    s.reader.mark();
    s.world.rows = [...PREVIOUS, row('u2', 'user', 'second'), row('a2', 'assistant', 'Part')];
    s.read();
    // The text keeps growing every 200 ms: never quiet for 500 ms.
    for (let spent = 0; spent < MAX_WAIT_MS - 600; spent += 200) {
      s.clock.advance(200);
      s.world.rows = [...PREVIOUS, row('u2', 'user', 'second'), row('a2', 'assistant', `Part ${'x'.repeat(spent)}`)];
    }
    should(s.speaker.requests.length).equal(0);
    s.clock.advance(900);
    should(s.speaker.requests.length).equal(1);
    should(s.ends).deepEqual([]);
  });

  it('uses the voice, speed and cap of the device settings at the moment of each reading', () => {
    const s = setup({ settings: { rate: 1.5, maxSeconds: 30 } });
    s.reader.mark();
    s.world.rows = [...PREVIOUS, row('u2', 'user', 'q'), row('a2', 'assistant', 'Hello there.')];
    s.read();
    s.settle();
    should(s.speaker.requests[0]?.rate).equal(1.5);
    should(s.speaker.requests[0]?.voice?.id).equal('local');
  });

  it('a long reply is cut at the cap and says there is more on screen; the reading still ends normally', () => {
    const s = setup({ settings: { maxSeconds: 30 } });
    s.reader.mark();
    const sentence = 'This is one sentence of a very long reply. ';
    s.world.rows = [...PREVIOUS, row('u2', 'user', 'q'), row('a2', 'assistant', sentence.repeat(200))];
    s.read();
    s.settle();
    const state = s.controller.getState();
    should(state.truncated).be.true();
    should(state.segments.at(-1)).equal("There's more on screen.");
    s.speaker.say({ type: 'end' });
    should(s.ends).deepEqual(['finished']);
  });
});

describe('createLiveReader — how a reading ends', () => {
  const reply = (s: ReturnType<typeof setup>): void => {
    s.reader.mark();
    s.world.rows = [...PREVIOUS, row('u2', 'user', 'q'), row('a2', 'assistant', 'Hello there.')];
    s.read();
    s.settle();
  };

  it('finished: once, and the controller subscription is dropped', () => {
    const s = setup();
    reply(s);
    s.speaker.say({ type: 'end' });
    s.speaker.say({ type: 'end' });
    should(s.ends).deepEqual(['finished']);
  });

  it('a speech error ends it as failed and a device with no private voice as unavailable', () => {
    const broke = setup();
    reply(broke);
    broke.speaker.say({ type: 'error', reason: 'failed' });
    should(broke.ends).deepEqual(['failed']);
    const none = setup({ voices: [{ ...LOCAL, local: false, isDefault: false }] });
    reply(none);
    should(none.ends).deepEqual(['unavailable']);
  });

  it('stop(): during the wait it ends silently and nothing is ever spoken; during speech it stops the voice', () => {
    const waiting = setup();
    waiting.reader.mark();
    waiting.world.rows = [...PREVIOUS, row('u2', 'user', 'q'), row('a2', 'assistant', 'Hi.')];
    waiting.read();
    waiting.reader.stop();
    should(waiting.ends).deepEqual(['stopped']);
    waiting.settle();
    should(waiting.speaker.requests.length).equal(0);
    should(waiting.clock.pending).equal(0);

    const talking = setup();
    reply(talking);
    talking.reader.stop();
    should(talking.ends).deepEqual(['stopped']);
    should(talking.speaker.log).containEql('stop');
    // The speaker's own late `stopped` changes nothing.
    talking.speaker.say({ type: 'stopped' });
    should(talking.ends).deepEqual(['stopped']);
  });

  it('stop() with nothing going on does nothing', () => {
    const s = setup();
    s.reader.stop();
    should(s.ends).deepEqual([]);
  });

  it('a newer reading stops the first (once) and speaks the second', () => {
    const s = setup();
    reply(s);
    const second: ReadEnd[] = [];
    s.reader.read('reply', end => second.push(end));
    should(s.ends).deepEqual(['stopped']);
    s.settle();
    should(s.speaker.requests.length).equal(2);
    s.speaker.say({ type: 'end' });
    should(second).deepEqual(['finished']);
    should(s.ends).deepEqual(['stopped']);
  });

  it('another reading taking the voice (a Read aloud button) ends this one as TAKEN: that is not the end of speech', () => {
    const s = setup();
    reply(s);
    s.controller.read('some-other-message', 'Other words.');
    should(s.ends).deepEqual(['taken']);
    // The thief keeps the voice: taking it is not a reason to stop it.
    should(s.controller.getState().status).equal('reading');
    should(s.controller.getState().key).equal('some-other-message');
  });

  it('the voice going quiet under this reading (dismissed, or another reading with nothing to say) is a plain stop', () => {
    const s = setup();
    reply(s);
    s.controller.dismiss();
    should(s.ends).deepEqual(['stopped']);
  });

  it('the page voice is busy while ANYTHING is read, tells when that changes, and silences whoever holds it', () => {
    const s = setup();
    const voice = pageVoice(s.controller);
    let told = 0;
    const unwatch = voice.watch(() => {
      told += 1;
    });
    should(voice.busy()).be.false();
    s.controller.read('some-other-message', 'Other words.');
    should(voice.busy()).be.true();
    should(told).be.above(0);
    voice.silence();
    should(voice.busy()).be.false();
    should(s.controller.getState().status).equal('stopped');
    unwatch();
    const after = told;
    s.controller.read('again', 'More words.');
    should(told).equal(after);
  });

  it('nothing to say at all ends as finished, at once', () => {
    const s = setup({ settings: {} });
    s.reader.mark();
    // A reply of only a hidden comment has nothing to say.
    s.world.rows = [...PREVIOUS, row('u2', 'user', 'q'), row('a2', 'assistant', '<!-- nothing to hear -->')];
    s.read();
    s.settle();
    should(s.speaker.requests.length).equal(0);
    should(s.ends).deepEqual(['finished']);
  });

  it('is total: a source or a speaker that throws gives a failed ending, never an exception', () => {
    const clock = new Clock();
    const broken: LiveReadingSource = {
      rows: () => {
        throw new Error('boom');
      },
      question: () => {
        throw new Error('boom');
      },
    };
    const speaker = scripted();
    const reader = createLiveReader({
      controller: createReadAloud({ speaker: speaker.port, language: () => 'en-US' }),
      source: broken,
      settings: () => DEFAULT_LIVE_VOICE_SETTINGS,
      clock: clock.port,
    });
    const ends: ReadEnd[] = [];
    reader.mark();
    reader.read('reply', end => ends.push(end));
    clock.advance(MAX_WAIT_MS + 500);
    should(ends).deepEqual(['failed']);
  });

  it('exposes the device: supported, and unlock reaches the speaker inside the tap', () => {
    const s = setup();
    should(s.reader.supported).be.true();
    s.reader.unlock();
    should(s.speaker.log).deepEqual(['unlock']);
  });
});
