import { describe, expect, test } from 'bun:test';
import type { SpeakerEvent } from '../../src/lib/voice-chat/ports.ts';
import { chunkForSpeech, SPEECH_CHUNK_LIMIT } from '../../src/lib/voice-chat/speech-chunks.ts';
import { browserSpeaker, createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import {
  chooseVoice,
  clampSpeechRate,
  DEFAULT_SPEECH_RATE,
  voiceLabel,
  voiceNote,
} from '../../src/lib/voice-chat/voice-choice.ts';
import { FakeSynth, FakeUtterance, voice } from '../support/fake-speech.ts';

const speakerOver = (synth: FakeSynth | null) =>
  createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });

const record = (): { events: SpeakerEvent[]; onEvent: (event: SpeakerEvent) => void } => {
  const events: SpeakerEvent[] = [];
  return { events, onEvent: event => events.push(event) };
};

describe('chunkForSpeech', () => {
  test('a short sentence is one piece', () => {
    expect(chunkForSpeech('Hello there.')).toEqual(['Hello there.']);
    expect(chunkForSpeech('   ')).toEqual([]);
  });

  test('a long one is cut at a sentence end first, then a comma, then a space', () => {
    const sentence = (n: number): string => `${'word '.repeat(n).trim()}.`;
    const text = `${sentence(15)} ${sentence(15)} ${sentence(15)}`;
    const pieces = chunkForSpeech(text, 100);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(100);
    expect(pieces.join(' ')).toBe(text);
    expect(pieces[0]?.endsWith('.')).toBe(true);

    const commas = chunkForSpeech(`${'alpha beta, '.repeat(30)}end`, 60);
    for (const piece of commas.slice(0, -1)) expect(piece.endsWith(',')).toBe(true);
  });

  test('one endless word is cut hard, and never between a surrogate pair', () => {
    const pieces = chunkForSpeech('😀'.repeat(200), 25);
    for (const piece of pieces) expect(piece).toMatch(/^(?:😀)+$/u);
    expect(pieces.join('')).toBe('😀'.repeat(200));
    expect(chunkForSpeech('x'.repeat(500), 100).every(piece => piece.length <= 100)).toBe(true);
  });

  test('a silly limit falls back to the default instead of looping forever', () => {
    expect(chunkForSpeech('a '.repeat(500), 0).every(piece => piece.length <= SPEECH_CHUNK_LIMIT)).toBe(true);
    expect(chunkForSpeech('a '.repeat(500), Number.NaN).length).toBeGreaterThan(0);
  });
});

describe('voice choice', () => {
  const samantha = voice('Samantha', 'en-US', { isDefault: true }).voiceURI;
  const voices = [
    { id: 'g', name: 'Google US English', lang: 'en-US', local: false, isDefault: false },
    { id: 'karen', name: 'Karen', lang: 'en-AU', local: true, isDefault: false },
    { id: samantha, name: 'Samantha', lang: 'en-US', local: true, isDefault: true },
    { id: 'amelie', name: 'Amélie', lang: 'fr-CA', local: true, isDefault: false },
  ];

  test('prefers a local voice in the exact language over a remote one', () => {
    expect(chooseVoice(voices, 'en-US')?.name).toBe('Samantha');
  });

  test('falls back to a local voice in the same language, then to a remote one, then to none', () => {
    expect(chooseVoice(voices, 'en-GB')?.name).toBe('Samantha');
    expect(
      chooseVoice(
        voices.filter(v => v.local === false),
        'en-US',
      )?.name,
    ).toBe('Google US English');
    expect(chooseVoice(voices, 'de-DE')).toBeNull();
    expect(chooseVoice([], 'en-US')).toBeNull();
    expect(chooseVoice(voices, 'fr_CA')?.name).toBe('Amélie');
  });

  test('a remembered local voice wins; a remembered remote one does not beat a local one', () => {
    expect(chooseVoice(voices, 'en-US', 'karen')?.name).toBe('Karen');
    expect(chooseVoice(voices, 'en-US', 'g')?.name).toBe('Samantha');
    expect(chooseVoice(voices, 'en-US', 'gone')?.name).toBe('Samantha');
  });

  test('remote voices say so, local ones do not', () => {
    expect(voiceNote(voices[0] ?? null)).toBe('Google US English sends this text to its maker to be spoken.');
    expect(voiceNote(voices[2] ?? null)).toBeNull();
    expect(voiceNote(null)).toBeNull();
    expect(voiceLabel(voices[0] as (typeof voices)[number])).toBe('Google US English (sends text away)');
    expect(voiceLabel(voices[2] as (typeof voices)[number])).toBe('Samantha');
  });

  test('the rate is kept between 0.8 and 2.0, and defaults to 1.1', () => {
    expect(DEFAULT_SPEECH_RATE).toBe(1.1);
    expect(clampSpeechRate(0.1)).toBe(0.8);
    expect(clampSpeechRate(5)).toBe(2);
    expect(clampSpeechRate(1.3)).toBe(1.3);
    expect(clampSpeechRate(Number.NaN)).toBe(1.1);
  });
});

describe('createSpeechSynthesisSpeaker', () => {
  test('where there is no speech it says so and does nothing', () => {
    const speaker = speakerOver(null);
    const { events, onEvent } = record();
    expect(speaker.supported).toBe(false);
    expect(speaker.voices()).toEqual([]);
    speaker.unlock();
    speaker.speak({ segments: ['hi'], rate: 1 }, onEvent);
    speaker.stop();
    expect(events).toEqual([{ type: 'error', reason: 'unavailable' }]);
  });

  test('speaks one caption at a time and announces each as it starts, then ends', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    speaker.speak({ segments: ['One.', 'Two.', 'Three.'], rate: 1.3 }, onEvent);
    // Only the first is handed to the engine, and nothing is announced before it starts.
    expect(synth.spoken.map(u => u.text)).toEqual(['One.']);
    expect(events).toEqual([]);
    synth.start();
    expect(events).toEqual([{ type: 'segment', index: 0 }]);
    synth.finish();
    expect(synth.spoken.map(u => u.text)).toEqual(['One.', 'Two.']);
    synth.play(2);
    expect(events).toEqual([
      { type: 'segment', index: 0 },
      { type: 'segment', index: 1 },
      { type: 'segment', index: 2 },
      { type: 'end' },
    ]);
    expect(synth.spoken.every(u => u.rate === 1.3)).toBe(true);
  });

  test('a long caption is spoken as several utterances but announced once', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    const long = `${'This part runs on. '.repeat(40).trim()}`;
    speaker.speak({ segments: [long, 'Short.'], rate: 1 }, onEvent);
    let guard = 0;
    while (synth.queue.length > 0 && guard++ < 100) synth.play();
    expect(synth.spoken.length).toBeGreaterThan(3);
    expect(synth.spoken.every(u => u.text.length <= SPEECH_CHUNK_LIMIT)).toBe(true);
    expect(events).toEqual([{ type: 'segment', index: 0 }, { type: 'segment', index: 1 }, { type: 'end' }]);
  });

  test('uses the chosen voice and clamps the rate', () => {
    const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true }), voice('Karen', 'en-AU')]);
    const speaker = speakerOver(synth);
    const [first, second] = speaker.voices();
    expect(first).toEqual({ id: 'uri:Samantha', name: 'Samantha', lang: 'en-US', local: true, isDefault: true });
    speaker.speak({ segments: ['Hi.'], rate: 9, voice: second ?? null }, () => {});
    const utterance = synth.spoken[0] as FakeUtterance;
    expect((utterance.voice as { name: string }).name).toBe('Karen');
    expect(utterance.lang).toBe('en-AU');
    expect(utterance.rate).toBe(2);
  });

  test('a voice that has gone is simply not set', () => {
    const synth = new FakeSynth([voice('Samantha', 'en-US')]);
    const speaker = speakerOver(synth);
    speaker.speak(
      { segments: ['Hi.'], rate: 1, voice: { id: 'gone', name: 'Gone', lang: 'en-US', local: true, isDefault: false } },
      () => {},
    );
    expect((synth.spoken[0] as FakeUtterance).voice).toBeNull();
  });

  test('stop() silences at once, says stopped once, and ignores what the engine reports after', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    speaker.speak({ segments: ['One.', 'Two.'], rate: 1 }, onEvent);
    synth.start();
    speaker.stop();
    speaker.stop();
    expect(events).toEqual([{ type: 'segment', index: 0 }, { type: 'stopped' }]);
    expect(synth.queue).toEqual([]);
    // Late callbacks from the cancelled utterance change nothing.
    const first = synth.spoken[0] as FakeUtterance;
    first.onend?.();
    first.onerror?.({ error: 'canceled' });
    expect(synth.spoken).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  test('stop() with nothing playing does nothing, not even a cancel', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    speaker.stop();
    expect(synth.cancels).toBe(0);
  });

  test('a new reading replaces the one going: the first hears stopped, the second speaks', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const a = record();
    const b = record();
    speaker.speak({ segments: ['A one.', 'A two.'], rate: 1 }, a.onEvent);
    synth.start();
    speaker.speak({ segments: ['B one.'], rate: 1 }, b.onEvent);
    expect(a.events).toEqual([{ type: 'segment', index: 0 }, { type: 'stopped' }]);
    synth.play();
    expect(b.events).toEqual([{ type: 'segment', index: 0 }, { type: 'end' }]);
    expect(a.events).toHaveLength(2);
  });

  test('an engine error ends the reading as failed; interruptions are not errors', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    speaker.speak({ segments: ['One.'], rate: 1 }, onEvent);
    (synth.spoken[0] as FakeUtterance).onerror?.({ error: 'interrupted' });
    expect(events).toEqual([]);
    (synth.spoken[0] as FakeUtterance).onerror?.({ error: 'synthesis-failed' });
    expect(events).toEqual([{ type: 'error', reason: 'failed' }]);
    (synth.spoken[0] as FakeUtterance).onend?.();
    expect(events).toHaveLength(1);
  });

  test('an engine that throws on speak ends as failed instead of throwing', () => {
    const synth = new FakeSynth();
    synth.speak = () => {
      throw new Error('boom');
    };
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    expect(() => speaker.speak({ segments: ['One.'], rate: 1 }, onEvent)).not.toThrow();
    expect(events).toEqual([{ type: 'error', reason: 'failed' }]);
  });

  test('nothing to say ends straight away', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    speaker.speak({ segments: [], rate: 1 }, onEvent);
    speaker.speak({ segments: ['  '], rate: 1 }, onEvent);
    expect(events).toEqual([{ type: 'end' }, { type: 'end' }]);
  });

  test('a caption is still announced when the engine never reports a start', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    speaker.speak({ segments: ['One.'], rate: 1 }, onEvent);
    synth.finish();
    expect(events).toEqual([{ type: 'segment', index: 0 }, { type: 'end' }]);
  });

  test('unlock speaks one silent space, once, and never when speech is absent', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    speaker.unlock();
    speaker.unlock();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]?.text).toBe(' ');
    expect(synth.spoken[0]?.volume).toBe(0);
  });

  test('the real-browser factory is an unsupported speaker where there is no speechSynthesis', () => {
    expect(browserSpeaker().supported).toBe(false);
    expect(browserSpeaker().voices()).toEqual([]);
  });
});
