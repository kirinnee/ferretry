import { describe, expect, test } from 'bun:test';
import type { SpeakerEvent, SpeakerPort, SpeakRequest } from '../../src/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { FakeSynth, FakeUtterance, voice } from '../support/fake-speech.ts';

const over = (synth: FakeSynth) =>
  createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });

/** A speaker the test scripts by hand, to reach the corners the real adapter never produces. */
const scripted = (supported = true) => {
  const requests: SpeakRequest[] = [];
  const listeners: ((event: SpeakerEvent) => void)[] = [];
  let stops = 0;
  const port: SpeakerPort = {
    supported,
    voices: () => [],
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
    expect(controller.getState().voiceNote).toBe('Google US English sends this text to its maker to be spoken.');
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
    expect(third.getState().status).toBe('reading');
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
