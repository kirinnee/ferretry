import { describe, expect, test } from 'bun:test';
import type { SpeakerEvent } from '../../../app/lib/voice-chat/ports.ts';
import { chunkForSpeech, SPEECH_CHUNK_LIMIT } from '../../../app/lib/voice-chat/speech-chunks.ts';
import { browserSpeaker, createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import {
  chooseVoice,
  clampSpeechRate,
  DEFAULT_SPEECH_RATE,
  voiceLabel,
  voiceNote,
  voiceWhere,
} from '../../../app/lib/voice-chat/voice-choice.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

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

  test('falls back to a local voice in the same language, and NEVER to a remote one', () => {
    expect(chooseVoice(voices, 'en-GB')?.name).toBe('Samantha');
    expect(
      chooseVoice(
        voices.filter(v => v.local === false),
        'en-US',
      ),
    ).toBeNull();
    expect(chooseVoice(voices, 'fr_CA')?.name).toBe('Amélie');
  });

  test("a language nobody speaks still gets a NAMED voice: the device's own local pick, never the unset default", () => {
    // navigator.language de-DE, no German voice, and the browser's default is remote (Chrome's Google voice).
    const remoteDefault = { id: 'g', name: 'Google US English', lang: 'en-US', local: false, isDefault: true };
    const local = { id: 'karen', name: 'Karen', lang: 'en-AU', local: true, isDefault: false };
    const localDefault = { id: 'sam', name: 'Samantha', lang: 'en-US', local: true, isDefault: true };
    expect(chooseVoice([remoteDefault, local], 'de-DE')?.name).toBe('Karen');
    expect(chooseVoice([remoteDefault, local, localDefault], 'de-DE')?.name).toBe('Samantha');
    expect(chooseVoice([local, localDefault], 'de-DE')?.name).toBe('Samantha');
    expect(chooseVoice(voices, 'de-DE')?.local).toBe(true);
  });

  test('with nothing local at all, NO voice is chosen — remote voices are never picked automatically (owner rule)', () => {
    const remote = [
      { id: 'a', name: 'Remote A', lang: 'en-US', local: false, isDefault: false },
      { id: 'b', name: 'Remote B', lang: 'en-GB', local: false, isDefault: true },
    ];
    expect(chooseVoice(remote, 'de-DE')).toBeNull();
    expect(chooseVoice(remote, 'en-US')).toBeNull();
    expect(chooseVoice(remote, 'en-US', 'gone')).toBeNull();
  });

  test('a remote voice is used only when the person explicitly picked it, and it says where the text goes', () => {
    const remote = [
      { id: 'a', name: 'Remote A', lang: 'en-US', local: false, isDefault: false },
      { id: 'b', name: 'Google UK English', lang: 'en-GB', local: false, isDefault: true },
      { id: 'c', name: 'Microsoft Aria Online (Natural)', lang: 'en-US', local: false, isDefault: false },
    ];
    expect(chooseVoice(remote, 'de-DE', 'a')?.name).toBe('Remote A');
    expect(chooseVoice([...voices, ...remote], 'en-US', 'a')?.name).toBe('Remote A');
    expect(voiceNote(remote[0] ?? null)).toBe('Remote A sends text to its maker to be spoken.');
    expect(voiceNote(remote[1] ?? null)).toBe('Google UK English sends text to Google to be spoken.');
    expect(voiceLabel(remote[1] as (typeof remote)[number])).toBe('Google UK English (sends text to Google)');
    expect(voiceLabel(remote[2] as (typeof remote)[number])).toBe(
      'Microsoft Aria Online (Natural) (sends text to Microsoft)',
    );
    expect(voiceLabel(remote[0] as (typeof remote)[number])).toBe('Remote A (sends text to its maker)');
  });

  test('a device that lists no voices (yet) yields none, and the speaker will not guess', () => {
    expect(chooseVoice([], 'en-US')).toBeNull();
    expect(chooseVoice([], 'de-DE', 'anything')).toBeNull();
  });

  test('a picked voice wins, local or remote; one that is gone is ignored and the automatic order applies', () => {
    expect(chooseVoice(voices, 'en-US', 'karen')?.name).toBe('Karen');
    expect(chooseVoice(voices, 'en-US', 'g')?.name).toBe('Google US English');
    expect(chooseVoice(voices, 'en-US', 'gone')?.name).toBe('Samantha');
  });

  test('remote voices say so, local ones do not', () => {
    expect(voiceNote(voices[0] ?? null)).toBe('Google US English sends text to Google to be spoken.');
    expect(voiceNote(voices[2] ?? null)).toBeNull();
    expect(voiceNote(null)).toBeNull();
    expect(voiceLabel(voices[0] as (typeof voices)[number])).toBe('Google US English (sends text to Google)');
    expect(voiceLabel(voices[2] as (typeof voices)[number])).toBe('Samantha');
    // The picker's second line: who gets the text, apart from the name so the name is never lengthened.
    expect(voiceWhere(voices[0] as (typeof voices)[number])).toBe('Sends text to Google');
    expect(voiceWhere(voices[2] as (typeof voices)[number])).toBe('Speaks on this device');
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

  test('a voice that has gone is replaced by a local one for the language, never left unset', () => {
    const synth = new FakeSynth([voice('Samantha', 'en-US')]);
    const speaker = speakerOver(synth);
    speaker.speak(
      { segments: ['Hi.'], rate: 1, voice: { id: 'gone', name: 'Gone', lang: 'en-US', local: true, isDefault: false } },
      () => {},
    );
    expect((synth.spoken[0] as FakeUtterance).voice).toMatchObject({ name: 'Samantha' });
  });

  test('a request with no voice is given a local voice for its language', () => {
    const synth = new FakeSynth([
      voice('Google US English', 'en-US', { local: false, isDefault: true }),
      voice('Hedda', 'de-DE'),
      voice('Karen', 'en-AU'),
    ]);
    speakerOver(synth).speak({ segments: ['Hallo.'], rate: 1, language: 'de-DE' }, () => {});
    expect(synth.spoken[0]?.voice).toMatchObject({ name: 'Hedda' });
    expect(synth.spoken[0]?.lang).toBe('de-DE');
  });

  test('no matching language: a local voice is named even though the browser default is remote', () => {
    const synth = new FakeSynth([
      voice('Google US English', 'en-US', { local: false, isDefault: true }),
      voice('Karen', 'en-AU'),
    ]);
    speakerOver(synth).speak({ segments: ['Hallo.'], rate: 1, language: 'de-DE' }, () => {});
    expect(synth.spoken[0]?.voice).toMatchObject({ name: 'Karen' });
    expect(synth.spoken[0]?.voice).toMatchObject({ localService: true });
  });

  test('refuses, and speaks nothing, when no voice may be used: empty list, only remote voices, a list that throws', () => {
    const refused = (synth: FakeSynth, request: Parameters<ReturnType<typeof speakerOver>['speak']>[0]) => {
      const { events, onEvent } = record();
      speakerOver(synth).speak(request, onEvent);
      expect(synth.spoken).toEqual([]);
      return events;
    };
    // Voices load late: the very first ask can find the list empty.
    expect(refused(new FakeSynth([]), { segments: ['Hi.'], rate: 1 })).toEqual([{ type: 'error', reason: 'failed' }]);
    // Only remote voices, and the caller did not vet one: nothing is sent away behind the person's back.
    const remoteOnly = new FakeSynth([voice('Google US English', 'en-US', { local: false, isDefault: true })]);
    expect(refused(remoteOnly, { segments: ['Hi.'], rate: 1, language: 'en-US' })).toEqual([
      { type: 'error', reason: 'failed' },
    ]);
    const broken = new FakeSynth();
    broken.getVoices = () => {
      throw new Error('no list');
    };
    expect(refused(broken, { segments: ['Hi.'], rate: 1 })).toEqual([{ type: 'error', reason: 'failed' }]);
  });

  test('a remote voice the caller named (and so announced) is used', () => {
    const synth = new FakeSynth([voice('Google US English', 'en-US', { local: false, isDefault: true })]);
    const speaker = speakerOver(synth);
    speaker.speak({ segments: ['Hi.'], rate: 1, voice: speaker.voices()[0] ?? null }, () => {});
    expect(synth.spoken[0]?.voice).toMatchObject({ name: 'Google US English' });
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

  test('an engine error ends the reading as failed', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    speaker.speak({ segments: ['One.'], rate: 1 }, onEvent);
    (synth.spoken[0] as FakeUtterance).onerror?.({ error: 'synthesis-failed' });
    expect(events).toEqual([{ type: 'error', reason: 'failed' }]);
    (synth.spoken[0] as FakeUtterance).onend?.();
    expect(events).toHaveLength(1);
  });

  test.each(['interrupted', 'canceled', 'cancelled'])(
    'the live reading cancelled from outside (%s) ends as stopped, not left reading',
    error => {
      const synth = new FakeSynth();
      const speaker = speakerOver(synth);
      const { events, onEvent } = record();
      speaker.speak({ segments: ['One.', 'Two.'], rate: 1 }, onEvent);
      synth.start();
      // Another part of the page cancels the shared engine; the browser reports it on the playing utterance.
      (synth.spoken[0] as FakeUtterance).onerror?.({ error });
      expect(events).toEqual([{ type: 'segment', index: 0 }, { type: 'stopped' }]);
      // Nothing carries on afterwards: no next sentence, no second ending.
      (synth.spoken[0] as FakeUtterance).onend?.();
      expect(synth.spoken).toHaveLength(1);
      expect(events).toHaveLength(2);
    },
  );

  test('an outside synth.cancel() ends the live reading as stopped (the engine reports interrupted)', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    speaker.speak({ segments: ['One.'], rate: 1 }, onEvent);
    synth.start();
    synth.cancel();
    expect(events).toEqual([{ type: 'segment', index: 0 }, { type: 'stopped' }]);
  });

  test('a cancellation the adapter caused itself is never reported twice or against the new reading', () => {
    const synth = new FakeSynth();
    const speaker = speakerOver(synth);
    const a = record();
    const b = record();
    speaker.speak({ segments: ['A.'], rate: 1 }, a.onEvent);
    synth.start();
    // Replacing cancels the engine: the old utterance reports interrupted AFTER the new reading began.
    speaker.speak({ segments: ['B.'], rate: 1 }, b.onEvent);
    (synth.spoken[0] as FakeUtterance).onerror?.({ error: 'interrupted' });
    expect(a.events).toEqual([{ type: 'segment', index: 0 }, { type: 'stopped' }]);
    expect(b.events).toEqual([]);
    synth.play();
    expect(b.events).toEqual([{ type: 'segment', index: 0 }, { type: 'end' }]);
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

  test('an unlock the engine refuses is tried again next time', () => {
    const synth = new FakeSynth();
    let refuse = true;
    const speak = synth.speak.bind(synth);
    synth.speak = utterance => {
      if (refuse) throw new Error('not in a tap');
      speak(utterance);
    };
    const speaker = speakerOver(synth);
    expect(() => speaker.unlock()).not.toThrow();
    refuse = false;
    speaker.unlock();
    expect(synth.spoken).toHaveLength(1);
  });

  test('an engine whose cancel throws still speaks and still stops', () => {
    const synth = new FakeSynth();
    synth.cancel = () => {
      throw new Error('already quiet');
    };
    const speaker = speakerOver(synth);
    const { events, onEvent } = record();
    expect(() => speaker.speak({ segments: ['One.'], rate: 1 }, onEvent)).not.toThrow();
    expect(synth.spoken).toHaveLength(1);
    expect(() => speaker.stop()).not.toThrow();
    expect(events).toEqual([{ type: 'stopped' }]);
  });

  test('the real-browser factory is an unsupported speaker where there is no speechSynthesis', () => {
    expect(browserSpeaker().supported).toBe(false);
    expect(browserSpeaker().voices()).toEqual([]);
  });

  test('over browser globals whose voice list throws, creating the speaker still works', () => {
    const g = globalThis as Record<string, unknown>;
    const before = { synth: g.speechSynthesis, utterance: g.SpeechSynthesisUtterance };
    const synth = new FakeSynth();
    synth.getVoices = () => {
      throw new Error('not yet');
    };
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    try {
      expect(browserSpeaker().supported).toBe(true);
    } finally {
      g.speechSynthesis = before.synth;
      g.SpeechSynthesisUtterance = before.utterance;
      if (before.synth === undefined) delete g.speechSynthesis;
      if (before.utterance === undefined) delete g.SpeechSynthesisUtterance;
    }
  });

  test('over the real browser globals it speaks through them', () => {
    const g = globalThis as Record<string, unknown>;
    const before = { synth: g.speechSynthesis, utterance: g.SpeechSynthesisUtterance };
    const synth = new FakeSynth([voice('Samantha', 'en-US')]);
    g.speechSynthesis = synth;
    g.SpeechSynthesisUtterance = FakeUtterance;
    try {
      let asked = 0;
      const getVoices = synth.getVoices.bind(synth);
      synth.getVoices = () => {
        asked += 1;
        return getVoices();
      };
      const speaker = browserSpeaker();
      // Creating it already asked the browser for its voices, so the list is loaded by the time of a tap.
      expect(asked).toBe(1);
      expect(speaker.supported).toBe(true);
      expect(speaker.voices()).toHaveLength(1);
      speaker.speak({ segments: ['Hi.'], rate: 1 }, () => {});
      expect(synth.spoken.map(u => u.text)).toEqual(['Hi.']);
    } finally {
      g.speechSynthesis = before.synth;
      g.SpeechSynthesisUtterance = before.utterance;
      if (before.synth === undefined) delete g.speechSynthesis;
      if (before.utterance === undefined) delete g.SpeechSynthesisUtterance;
    }
  });
});
