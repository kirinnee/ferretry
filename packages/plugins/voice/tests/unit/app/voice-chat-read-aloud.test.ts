import { describe, expect, test } from 'bun:test';
import type { SpeakerEvent, SpeakerPort, SpeakerVoice, SpeakRequest } from '../../../app/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../../app/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

const over = (synth: FakeSynth) =>
  createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });

const LOCAL: SpeakerVoice = { id: 'local', name: 'Local', lang: 'en-US', local: true, isDefault: true };

/** A speaker the test scripts by hand, to reach the corners the real adapter never produces. */
const scripted = (supported = true, voices: SpeakerVoice[] = [LOCAL]) => {
  const requests: SpeakRequest[] = [];
  const listeners: ((event: SpeakerEvent) => void)[] = [];
  let stops = 0;
  const port: SpeakerPort = {
    supported,
    voices: () => voices,
    unlock: () => undefined,
    speak: (request, onEvent) => {
      requests.push(request);
      listeners.push(onEvent);
    },
    stop: () => {
      stops += 1;
    },
  };
  return { port, requests, listeners, say: (event: SpeakerEvent) => listeners.at(-1)?.(event), stops: () => stops };
};

describe('createReadAloud', () => {
  test('reads a message: captions, current sentence, then finished', () => {
    const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
    const controller = createReadAloud({ speaker: over(synth), language: () => 'en-US' });
    const seen: string[] = [];
    controller.subscribe(() => seen.push(controller.getState().status));

    expect(controller.getState().status).toBe('idle');
    controller.read('m1', 'First one. Second one.\n\n```ts\nx\n```');
    expect(controller.getState()).toMatchObject({
      status: 'reading',
      key: 'm1',
      current: 0,
      truncated: false,
      voiceNote: null,
      segments: ['First one.', 'Second one.', "Code block, 1 line of TypeScript. It's on screen."],
    });
    expect(synth.spoken[0]?.voice).toMatchObject({ name: 'Samantha' });
    expect(synth.spoken[0]?.rate).toBe(1.1);

    synth.play();
    expect(controller.getState().current).toBe(0);
    synth.start();
    synth.finish();
    synth.start();
    expect(controller.getState().current).toBe(2);
    synth.finish();
    expect(controller.getState().status).toBe('finished');
    expect(seen.at(-1)).toBe('finished');
  });

  test('says when the voice sends text away, and nothing for a device voice', () => {
    const synth = new FakeSynth([voice('Google US English', 'en-US', { local: false })]);
    const controller = createReadAloud({ speaker: over(synth), language: () => 'en-US' });
    controller.read('m1', 'Hello.');
    expect(controller.getState().voiceNote).toBeNull();
    expect(controller.getState().status).toBe('unavailable');
  });

  test('says where the text goes when the person picked a remote voice', () => {
    const picked = voice('Google US English', 'en-US', { local: false });
    const synth = new FakeSynth([picked, voice('Samantha', 'en-US', { isDefault: true })]);
    const controller = createReadAloud({
      speaker: over(synth),
      language: () => 'en-US',
      pickedVoice: () => picked.voiceURI,
    });
    controller.read('m1', 'Hello.');
    expect(controller.getState()).toMatchObject({
      status: 'reading',
      voiceNote: 'Google US English sends text to Google to be spoken.',
    });
    expect(synth.spoken[0]?.voice).toMatchObject({ name: 'Google US English' });
  });

  test('previewVoiceNote names where the text would go BEFORE anything is read', () => {
    const picked = voice('Google US English', 'en-US', { local: false });
    const synth = new FakeSynth([picked, voice('Samantha', 'en-US', { isDefault: true })]);
    const device = createReadAloud({ speaker: over(synth), language: () => 'en-US' });
    expect(device.previewVoiceNote()).toBeNull();
    const remote = createReadAloud({
      speaker: over(synth),
      language: () => 'en-US',
      pickedVoice: () => picked.voiceURI,
    });
    expect(remote.previewVoiceNote()).toBe('Google US English sends text to Google to be spoken.');
    expect(remote.getState().status).toBe('idle');
    expect(synth.spoken).toEqual([]);
    // The voice chosen in Settings (passed at the tap) is the one named, ahead of the controller's own pick.
    expect(device.previewVoiceNote(picked.voiceURI)).toBe('Google US English sends text to Google to be spoken.');
  });

  test('previewVoiceNote is null when there is no voice, or the device cannot say', () => {
    const none = createReadAloud({ speaker: over(new FakeSynth([])), language: () => 'en-US' });
    expect(none.previewVoiceNote()).toBeNull();
    const broken = scripted();
    const throwing = createReadAloud({
      speaker: {
        ...broken.port,
        voices: () => {
          throw new Error('no voices');
        },
      },
      language: () => {
        throw new Error('no language');
      },
    });
    expect(throwing.previewVoiceNote()).toBeNull();
  });

  test('stop() stops the voice and says stopped; a second stop is a no-op', () => {
    const synth = new FakeSynth();
    const controller = createReadAloud({ speaker: over(synth) });
    controller.read('m1', 'One. Two.');
    synth.start();
    controller.stop();
    expect(controller.getState().status).toBe('stopped');
    expect(controller.getState().key).toBe('m1');
    expect(synth.queue).toEqual([]);
    const cancels = synth.cancels;
    controller.stop();
    expect(synth.cancels).toBe(cancels);
  });

  test('reading another message moves the reading there; the old one cannot change the state', () => {
    const scripts = scripted();
    const controller = createReadAloud({ speaker: scripts.port });
    controller.read('a', 'Alpha.');
    const hearA = scripts.listeners[0] as (event: SpeakerEvent) => void;
    controller.read('b', 'Beta.');
    expect(controller.getState().key).toBe('b');
    hearA({ type: 'end' });
    expect(controller.getState()).toMatchObject({ key: 'b', status: 'reading' });
    scripts.say({ type: 'end' });
    expect(controller.getState()).toMatchObject({ key: 'b', status: 'finished' });
  });

  test('a message with nothing to say is not read, and silences what was', () => {
    const scripts = scripted();
    const controller = createReadAloud({ speaker: scripts.port });
    controller.read('a', 'Alpha.');
    controller.read('b', '<div></div>');
    expect(scripts.stops()).toBe(1);
    expect(controller.getState()).toMatchObject({ status: 'idle', key: 'b', segments: [] });
    expect(scripts.requests).toHaveLength(1);
  });

  test('the speaker failing or throwing ends in failed, not an exception', () => {
    const scripts = scripted();
    const controller = createReadAloud({ speaker: scripts.port });
    controller.read('a', 'Alpha.');
    scripts.say({ type: 'error', reason: 'failed' });
    expect(controller.getState().status).toBe('failed');

    const throwing: SpeakerPort = {
      ...scripts.port,
      speak: () => {
        throw new Error('no audio device');
      },
    };
    const other = createReadAloud({ speaker: throwing });
    expect(() => other.read('a', 'Alpha.')).not.toThrow();
    expect(other.getState().status).toBe('failed');

    const badVoices: SpeakerPort = {
      ...scripts.port,
      voices: () => {
        throw new Error('voices');
      },
    };
    const third = createReadAloud({ speaker: badVoices });
    third.read('a', 'Alpha.');
    expect(third.getState().status).toBe('unavailable');
  });

  test('a long reply is capped for the rate and ends with the more-on-screen caption', () => {
    const scripts = scripted();
    const controller = createReadAloud({ speaker: scripts.port, rate: () => 1 });
    controller.read('a', 'This sentence is exactly fifty characters long ok. '.repeat(40));
    const state = controller.getState();
    expect(state.truncated).toBe(true);
    expect(state.segments.at(-1)).toBe("There's more on screen.");
    const fast = createReadAloud({ speaker: scripts.port, rate: () => 2 });
    fast.read('a', 'This sentence is exactly fifty characters long ok. '.repeat(40));
    expect(fast.getState().segments.length).toBeGreaterThan(state.segments.length);
    expect(scripts.requests.at(-1)?.rate).toBe(2);
  });

  test('the rate is clamped before it reaches the speaker', () => {
    const scripts = scripted();
    createReadAloud({ speaker: scripts.port, rate: () => 50 }).read('a', 'Hi.');
    expect(scripts.requests[0]?.rate).toBe(2);
  });

  test('an unsubscribed listener is not called again', () => {
    const scripts = scripted();
    const controller = createReadAloud({ speaker: scripts.port });
    let calls = 0;
    const off = controller.subscribe(() => {
      calls += 1;
    });
    controller.read('a', 'Hi.');
    off();
    scripts.say({ type: 'end' });
    expect(calls).toBe(1);
  });

  test('reports whether the device can speak at all', () => {
    expect(createReadAloud({ speaker: scripted(false).port }).supported).toBe(false);
    expect(createReadAloud({ speaker: scripted(true).port }).supported).toBe(true);
  });
});

describe('createReadAloud.dismiss', () => {
  test('stops the voice and forgets the message, so no other conversation can inherit it', () => {
    const scripts = scripted();
    const controller = createReadAloud({ speaker: scripts.port });
    controller.read('a1', 'Alpha. Beta.');
    const hear = scripts.listeners[0] as (event: SpeakerEvent) => void;
    controller.dismiss();
    expect(scripts.stops()).toBe(1);
    expect(controller.getState()).toMatchObject({ status: 'idle', key: null, segments: [] });
    hear({ type: 'end' });
    expect(controller.getState().status).toBe('idle');
    controller.dismiss();
    expect(controller.getState().status).toBe('idle');
  });
});

describe('createReadAloud: which voice, and what the person is told', () => {
  test('a language with no voice reads with a LOCAL one, not the remote default, and says nothing alarming', () => {
    const synth = new FakeSynth([
      voice('Google US English', 'en-US', { local: false, isDefault: true }),
      voice('Samantha', 'en-US'),
    ]);
    const controller = createReadAloud({ speaker: over(synth), language: () => 'de-DE' });
    controller.read('m1', 'Hello.');
    expect(synth.spoken[0]?.voice).toMatchObject({ name: 'Samantha', localService: true });
    expect(controller.getState().voiceNote).toBeNull();
  });

  test('with only remote voices nothing is spoken: "no on-device voice", text only (owner rule)', () => {
    const synth = new FakeSynth([voice('Google US English', 'en-US', { local: false, isDefault: true })]);
    const controller = createReadAloud({ speaker: over(synth), language: () => 'de-DE' });
    controller.read('m1', 'Hello. There.');
    expect(controller.getState()).toMatchObject({
      status: 'unavailable',
      key: 'm1',
      voiceNote: null,
      segments: ['Hello.', 'There.'],
    });
    expect(synth.spoken).toEqual([]);
  });

  test('a picked voice that is gone is ignored: the local order applies, and remote voices stay unused', () => {
    const synth = new FakeSynth([voice('Google US English', 'en-US', { local: false, isDefault: true })]);
    const controller = createReadAloud({ speaker: over(synth), language: () => 'en-US', pickedVoice: () => 'gone' });
    controller.read('m1', 'Hello.');
    expect(controller.getState().status).toBe('unavailable');
    expect(synth.spoken).toEqual([]);
  });

  test('hands the speaker the language, so a speaker that must choose can', () => {
    const scripts = scripted();
    const controller = createReadAloud({ speaker: scripts.port, language: () => 'fr-CA' });
    controller.read('m1', 'Bonjour.');
    expect(scripts.requests[0]).toMatchObject({ language: 'fr-CA', voice: LOCAL });
  });

  test('no voice at all: nothing is handed to the speaker, which is stopped, and the state says unavailable', () => {
    const scripts = scripted(true, []);
    const controller = createReadAloud({ speaker: scripts.port, language: () => 'en-US' });
    controller.read('m1', 'Hello.');
    expect(scripts.requests).toEqual([]);
    expect(scripts.stops()).toBe(1);
    expect(controller.getState()).toMatchObject({ status: 'unavailable', key: 'm1', segments: ['Hello.'], current: 0 });
    // Not reading, so Stop is not offered and a second tap tries again.
    controller.stop();
    expect(controller.getState().status).toBe('unavailable');
  });

  test('a language getter that throws falls back to English instead of throwing', () => {
    const scripts = scripted();
    const controller = createReadAloud({
      speaker: scripts.port,
      language: () => {
        throw new Error('no navigator');
      },
    });
    expect(() => controller.read('m1', 'Hello.')).not.toThrow();
    expect(scripts.requests[0]).toMatchObject({ language: 'en-US' });
  });

  test('a device that lists no voices yet says "unavailable" in words, and speaks nothing', () => {
    const synth = new FakeSynth([]);
    const controller = createReadAloud({ speaker: over(synth), language: () => 'en-US' });
    controller.read('m1', 'Hello.');
    expect(controller.getState().status).toBe('unavailable');
    expect(synth.spoken).toEqual([]);
  });

  test('the engine cancelled from outside while reading ends the reading as stopped, not "reading" forever', () => {
    const synth = new FakeSynth();
    const controller = createReadAloud({ speaker: over(synth), language: () => 'en-US' });
    controller.read('m1', 'One. Two.');
    synth.start();
    expect(controller.getState().status).toBe('reading');
    synth.cancel();
    expect(controller.getState().status).toBe('stopped');
  });
});

describe("createReadAloud: the person's voice settings for one reading", () => {
  test("voice, rate and length come with the reading and win over the controller's defaults", () => {
    const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true }), voice('Karen', 'en-AU')]);
    const controller = createReadAloud({ speaker: over(synth), language: () => 'en-US', rate: () => 1 });
    controller.read('k', 'Hello there.', { voiceId: 'uri:Karen', rate: 1.6, maxSeconds: 30 });
    expect(synth.spoken[0]?.rate).toBe(1.6);
    expect((synth.spoken[0]?.voice as { name: string } | undefined)?.name).toBe('Karen');
    controller.dismiss();
  });

  test('a shorter limit stops sooner with "There\'s more on screen."; no limit reads on', () => {
    const long = Array.from({ length: 60 }, (_, index) => `This is sentence number ${index + 1} of the reply.`).join(
      ' ',
    );
    const make = (maxSeconds: number | null) => {
      const controller = createReadAloud({ speaker: over(new FakeSynth([])), rate: () => 1 });
      controller.read('k', long, { maxSeconds });
      return controller.getState();
    };
    const thirty = make(30);
    const sixty = make(60);
    const unlimited = make(null);
    expect(thirty.truncated).toBe(true);
    expect(thirty.segments.at(-1)).toBe("There's more on screen.");
    expect(thirty.segments.length).toBeLessThan(sixty.segments.length);
    expect(unlimited.truncated).toBe(false);
    expect(unlimited.segments).toHaveLength(60);
  });

  test('absent options keep the one-minute reading it always had', () => {
    const controller = createReadAloud({ speaker: over(new FakeSynth([])), rate: () => 1 });
    controller.read('k', 'Short.');
    expect(controller.getState().truncated).toBe(false);
  });

  test('voices() lists what the speaker has, and is [] when the speaker throws', () => {
    const synth = new FakeSynth([voice('Samantha', 'en-US')]);
    expect(
      createReadAloud({ speaker: over(synth) })
        .voices()
        .map(v => v.name),
    ).toEqual(['Samantha']);
    const broken = scripted();
    broken.port.voices = () => {
      throw new Error('no voices');
    };
    expect(createReadAloud({ speaker: broken.port }).voices()).toEqual([]);
  });
});
