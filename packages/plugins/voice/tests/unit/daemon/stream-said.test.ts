import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@ferretry/kernel/testing';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import {
  REPLY_DOWNLINK_UNIT_BYTES,
  type SpeechCut,
  UNIT_SAMPLES,
  type VoiceSpan,
  decodeDownlinkUnit,
  decodeReplyDownlinkUnit,
  encodeDropFrame,
  encodeHushFrame,
  encodeSpeakFrame,
  encodeUplinkUnit,
} from '../../../contract/index.ts';
import { spansFromProbabilities, VAD_CHUNK } from '../../../daemon/lib/engine/spans.ts';
import { splitForSpeech } from '../../../daemon/lib/reply/chunks.ts';
import { createSaid, noteText, splitHeard } from '../../../daemon/lib/stream/said.ts';
import { VoiceStream } from '../../../daemon/lib/stream/session.ts';

/**
 * V2 + V3 on the machine: what the person heard of a reply, from where their ears were when they cut it off, and the note
 * that tells the ferret. A made piece is 0.1 s of sound per character (1,600 samples), so where a cut falls inside a piece is
 * easy to read off its text.
 */
const SAMPLES_PER_CHAR = 1_600;
const sound = (text: string): Float32Array => new Float32Array(text.length * SAMPLES_PER_CHAR).fill(0.5);
const LOUD = 6_000;

const fakeSpans = (samples: Float32Array): readonly VoiceSpan[] => {
  const probabilities: number[] = [];
  for (let at = 0; at + VAD_CHUNK <= samples.length; at += VAD_CHUNK) {
    let peak = 0;
    for (let index = at; index < at + VAD_CHUNK; index += 1) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    probabilities.push(peak * 32768 >= LOUD ? 0.9 : 0.05);
  }
  return spansFromProbabilities(probabilities, samples.length);
};

const settle = async (): Promise<void> => {
  for (let round = 0; round < 8; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

interface Sent {
  readonly message: string;
  readonly sendId: string;
}

async function rig(options: { heard?: string; refuse?: number; crash?: string; hold?: Promise<void> } = {}) {
  const clock = fixedClock();
  const frames: Uint8Array[] = [];
  const sent: Sent[] = [];
  const attempts: Sent[] = [];
  const logged: string[] = [];
  let counter = 0;
  let refusals = options.refuse ?? 0;
  const downstream: SocketDownstream = {
    send(frame) {
      frames.push(frame as Uint8Array);
      return (frame as Uint8Array).byteLength;
    },
    close: () => undefined,
    bufferedBytes: () => 0,
  };
  const stream = new VoiceStream({
    engine: {
      detectSpeech: async samples => fakeSpans(samples),
      transcribe: async () => ({ text: options.heard ?? 'please check the build', decodeMs: 10, realTimeFactor: 0.1 }),
    },
    reply: {
      view: async () => ({ state: 'ready' }) as never,
      warm: async () => undefined,
      speak: async text => {
        if (options.crash !== undefined && text.includes(options.crash)) throw new Error('speak crashed');
        return { samples: sound(text), speakMs: 50 };
      },
    },
    clock,
    downstream,
    streamId: 'abc123',
    nonce: () => `${(counter++).toString(16).padStart(16, '0')}`.replace(/^0{16}$/u, '0000000000000001'),
    send: async (_ferretId, message, sendId) => {
      if (message.startsWith('(voice mode on)')) return { ok: true };
      attempts.push({ message, sendId });
      if (sendId === 'abc123:heard:1') await options.hold;
      if (refusals > 0) {
        refusals -= 1;
        return { ok: false, code: 'send_refused' };
      }
      sent.push({ message, sendId });
      return { ok: true };
    },
    mayChat: () => true,
    resolveFerret: async reference => reference,
    recordSent: () => undefined,
    claimFerret: () => () => undefined,
    onEnd: () => undefined,
    log: { info: (message, fields) => void logged.push(`${message} ${JSON.stringify(fields ?? {})}`) },
  });
  await stream.open();
  stream.fromClient(
    JSON.stringify({
      t: 'start',
      v: 1,
      purpose: 'chat',
      ferretId: 'fer-1',
      reply: 'machine',
      session: 'said-session-1',
    }),
  );
  let echo: string | undefined;
  const view = {
    sent,
    attempts,
    logged,
    frames,
    /** Every line the machine answered, by id, with how much sound it sent. */
    audio: (): Map<number, number> => {
      const total = new Map<number, number>();
      for (const frame of frames) {
        if (frame.byteLength !== REPLY_DOWNLINK_UNIT_BYTES) continue;
        const audio = decodeReplyDownlinkUnit(frame).snapshot.audio;
        if (audio !== undefined) total.set(audio.id, (total.get(audio.id) ?? 0) + audio.samples);
      }
      return total;
    },
    speak: (id: number, text: string) => stream.fromClient(encodeSpeakFrame({ t: 'speak', id, text })),
    drop: (id: number) => stream.fromClient(encodeDropFrame(id)),
    hush: (cut?: SpeechCut) => stream.fromClient(encodeHushFrame(cut)),
    /** The phone: one 40 ms unit per call, echoing the newest nonce; loud for a voice. */
    async talk(ms: number, loud = false) {
      for (let at = 0; at < ms; at += 40) {
        await clock.advance(40);
        const latest = frames.at(-1);
        if (latest !== undefined)
          echo = (
            latest.byteLength === REPLY_DOWNLINK_UNIT_BYTES
              ? decodeReplyDownlinkUnit(latest).snapshot
              : decodeDownlinkUnit(latest)
          ).nonce;
        const pcm = new Int16Array(UNIT_SAMPLES);
        if (loud) for (let index = 0; index < UNIT_SAMPLES; index += 1) pcm[index] = index % 2 === 0 ? 12_000 : -12_000;
        stream.fromClient(encodeUplinkUnit({ pcm, control: 'none', echo }));
        if (at % 200 === 160) await settle();
      }
      await settle();
    },
    /** The person says something and pauses: the turn is decoded and sent. */
    async say() {
      await view.talk(1_500, true);
      await view.talk(2_500);
    },
  };
  return view;
}

const NOTE = (heard: string, unheard: string): string => `[heard up to: ${heard}; not heard: "${unheard}"]`;

describe('V2: the words a cut falls on (pure)', () => {
  const line = (pieces: string[], made: number[]) => ({ pieces, made });

  test('every line before the cut is heard whole, the cut line up to its samples, the rest not at all', () => {
    const lines: [number, ReturnType<typeof line>][] = [
      [3, line(['One two.'], [1_000])],
      [4, line(['Three four.', 'Five six.'], [1_000, 1_000])],
      [5, line(['Seven.'], [1_000])],
    ];
    expect(splitHeard(lines, { id: 4, samples: 1_000 })).toEqual({
      heard: ['One', 'two.', 'Three', 'four.'],
      unheard: ['Five', 'six.', 'Seven.'],
    });
  });

  test('inside a piece the position is the share of its sound: 0 % hears nothing of it, the last word needs the whole piece', () => {
    const lines: [number, ReturnType<typeof line>][] = [[0, line(['a b c d e f g h'], [8_000])]];
    expect(splitHeard(lines, { id: 0, samples: 0 }).heard).toEqual([]);
    expect(splitHeard(lines, { id: 0, samples: 3_999 }).heard).toEqual(['a', 'b', 'c']);
    expect(splitHeard(lines, { id: 0, samples: 4_000 }).heard).toEqual(['a', 'b', 'c', 'd']);
    expect(splitHeard(lines, { id: 0, samples: 7_999 }).heard).toHaveLength(7);
    expect(splitHeard(lines, { id: 0, samples: 8_000 })).toEqual({
      heard: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      unheard: [],
    });
  });

  test('a piece that was never made is not heard, even in a line before the cut', () => {
    const lines: [number, ReturnType<typeof line>][] = [[0, line(['Made here.', 'Never made.'], [1_000])]];
    expect(splitHeard(lines, { id: 5, samples: 0 })).toEqual({ heard: ['Made', 'here.'], unheard: ['Never', 'made.'] });
  });

  test('the note quotes the last 12 words heard and the first 30 not heard, and says "nothing" when nothing was', () => {
    const words = (count: number, from = 0): string[] => Array.from({ length: count }, (_, at) => `w${from + at}`);
    expect(noteText([], ['a', 'b'])).toBe(NOTE('nothing', 'a b'));
    expect(noteText(['a', 'b'], ['c'])).toBe(NOTE('"a b"', 'c'));
    expect(noteText(words(12), words(30, 100))).toBe(NOTE(`"${words(12).join(' ')}"`, words(30, 100).join(' ')));
    expect(noteText(words(13), words(31, 100))).toBe(
      NOTE(`"… ${words(13).slice(1).join(' ')}"`, `${words(30, 100).join(' ')} …`).replace('…"]', '…"]'),
    );
  });

  test('a barge-in at any piece boundary never splits a long token between heard and not heard', () => {
    const url = `https://example.com/${'a'.repeat(244)}`;
    const text = `${'checking '.repeat(27)}${url} before publishing the report.`;
    const pieces = splitForSpeech(text);
    for (let cut = 0; cut <= pieces.length; cut += 1) {
      const samples = pieces.slice(0, cut).reduce((sum, piece) => sum + piece.length * 1_600, 0);
      const heard = splitHeard([[0, { pieces, made: pieces.map(piece => piece.length * 1_600) }]], { id: 0, samples });
      const inHeard = heard.heard.filter(word => word === url).length;
      const inUnheard = heard.unheard.filter(word => word === url).length;
      expect([inHeard, inUnheard].sort()).toEqual([0, 1]);
      expect([...heard.heard, ...heard.unheard].join(' ')).toBe(text);
      expect(heard.heard.some(word => word.startsWith('https://') && word !== url)).toBe(false);
      expect(heard.unheard.some(word => word.startsWith('aaaa'))).toBe(false);
    }
  });

  test('a quote mark in the words cannot break the note’s own quotes', () => {
    expect(noteText(['say', '"hi"'], ['"bye"'])).toBe(NOTE(`"say 'hi'"`, "'bye'"));
  });

  test('fully heard: no note; a second cut before the ferret was told adds what was not heard and keeps the newer place', () => {
    const said = createSaid();
    said.line(0, 'Hello there.');
    said.made(0, 1_000);
    expect(said.cut({ id: 0, samples: 1_000 })).toBe(false);
    expect(said.note()).toBeUndefined();
    said.line(1, 'One two three four.');
    said.made(1, 4_000);
    expect(said.cut({ id: 1, samples: 2_000 })).toBe(true);
    expect(said.note()?.text).toBe(NOTE('"One two"', 'three four.'));
    said.line(2, 'Five six.');
    said.made(2, 1_000);
    expect(said.cut({ id: 2, samples: 0 })).toBe(true);
    expect(said.note()).toMatchObject({ n: 2, text: NOTE('"One two"', 'three four. Five six.') });
    const taken = said.alone();
    expect(taken?.note?.n).toBe(2);
    expect(said.note()).toBeUndefined();
    said.delivered(taken ?? { upTo: 0 });
    expect(said.note()).toBeUndefined();
  });

  test('a note taken by one send cannot be taken by another; a refusal gives it back, joined with any newer cut', () => {
    const said = createSaid();
    said.line(0, 'One two three four.');
    said.made(0, 4_000);
    said.cut({ id: 0, samples: 2_000 });
    const first = said.carry();
    expect(first.note?.n).toBe(1);
    expect(said.alone()).toBeUndefined();
    expect(said.carry().note).toBeUndefined();
    said.line(1, 'Five six.');
    said.made(1, 1_000);
    said.cut({ id: 1, samples: 0 });
    said.failed(first);
    expect(said.note()).toMatchObject({ n: 2, text: NOTE('"One two"', 'three four. Five six.') });
  });

  test('an acknowledgement forgets only the lines that were there when its message left', () => {
    const said = createSaid();
    said.line(0, 'Old reply.');
    said.made(0, 1_000);
    const sending = said.carry();
    said.line(1, 'Next reply now.');
    said.made(1, 3_000);
    said.delivered(sending);
    expect(said.cut({ id: 1, samples: 1_000 })).toBe(true);
    expect(said.note()?.text).toBe(NOTE('"Next"', 'reply now.'));
  });

  test('a line that was taken back is not counted', () => {
    const said = createSaid();
    said.line(0, 'Kept line.');
    said.made(0, 1_000);
    said.line(1, 'Dropped line.');
    said.skip(1);
    expect(said.cut({ id: 0, samples: 500 })).toBe(true);
    expect(said.note()?.text).toBe(NOTE('"Kept"', 'line.'));
  });
});

describe('V3: telling the ferret what was heard (on the stream)', () => {
  test('talking over a line: the next (voice) message starts with what was heard and what was not, one send id per message', async () => {
    const r = await rig();
    await r.talk(600);
    r.speak(0, 'Checking the build now. It takes a while.');
    await r.talk(600);
    // Piece one is 23 characters, piece two 17: the person heard all of the first and more than half of the second.
    r.hush({ id: 0, samples: 23 * SAMPLES_PER_CHAR + 9 * SAMPLES_PER_CHAR });
    await r.say();
    expect(r.sent).toEqual([
      {
        message: `${NOTE('"Checking the build now. It takes"', 'a while.')} (voice) please check the build`,
        sendId: 'abc123:1',
      },
    ]);
    // The note is spent: the next message is plain.
    await r.say();
    expect(r.sent.at(-1)?.message).toBe('(voice) please check the build');
  });

  test('cut before any sound was heard: "nothing", and every word is not heard', async () => {
    const r = await rig();
    await r.talk(600);
    r.speak(0, 'Hold on.');
    r.hush({ id: 0, samples: 0 });
    await r.say();
    expect(r.sent[0]?.message).toBe(`${NOTE('nothing', 'Hold on.')} (voice) please check the build`);
  });

  test('a reply heard to its end is not a cut-off: no note', async () => {
    const r = await rig();
    await r.talk(600);
    r.speak(0, 'All done.');
    await r.talk(600);
    r.hush({ id: 0, samples: 9 * SAMPLES_PER_CHAR });
    await r.say();
    expect(r.sent.map(each => each.message)).toEqual(['(voice) please check the build']);
  });

  test('a hush with no position is only a reading being replaced: the ferret is told nothing', async () => {
    const r = await rig();
    await r.talk(600);
    r.speak(0, 'Replaced soon.');
    await r.talk(600);
    r.hush();
    await r.say();
    expect(r.sent.map(each => each.message)).toEqual(['(voice) please check the build']);
  });

  test('a line taken back, or one the machine could not speak, is not told as unheard', async () => {
    const r = await rig({ crash: 'Broken' });
    await r.talk(600);
    r.speak(0, 'First part.');
    r.speak(1, 'Broken line.');
    r.speak(2, 'Last part.');
    r.drop(2);
    await r.talk(800);
    r.hush({ id: 0, samples: 6 * SAMPLES_PER_CHAR });
    await r.say();
    expect(r.sent[0]?.message).toBe(`${NOTE('"First"', 'part.')} (voice) please check the build`);
  });

  test('a cut with nothing said after it goes alone, once, under its own id, when the pause has passed', async () => {
    const r = await rig();
    await r.talk(600);
    r.speak(0, 'Almost there now.');
    await r.talk(400);
    r.hush({ id: 0, samples: 6 * SAMPLES_PER_CHAR });
    await r.talk(1_000);
    expect(r.sent).toEqual([]);
    await r.talk(1_500);
    expect(r.sent).toEqual([{ message: NOTE('"Almost"', 'there now.'), sendId: 'abc123:heard:1' }]);
    await r.talk(6_000);
    expect(r.sent).toHaveLength(1);
  });

  test('talking over it but with no words (a cough): the note goes alone, as soon as the turn is known to be empty', async () => {
    const r = await rig({ heard: '.' });
    await r.talk(600);
    r.speak(0, 'Almost there now.');
    await r.talk(400);
    r.hush({ id: 0, samples: 6 * SAMPLES_PER_CHAR });
    await r.say();
    expect(r.sent).toEqual([{ message: NOTE('"Almost"', 'there now.'), sendId: 'abc123:heard:1' }]);
  });

  test('a refused send keeps the note for the next message, and it is told once', async () => {
    const r = await rig({ refuse: 2 });
    await r.talk(600);
    r.speak(0, 'Almost there now.');
    await r.talk(400);
    r.hush({ id: 0, samples: 6 * SAMPLES_PER_CHAR });
    await r.say(); // the message is refused, and so is the note sent alone after it
    expect(r.sent).toEqual([]);
    await r.say();
    expect(r.sent.map(each => each.message)).toEqual([
      `${NOTE('"Almost"', 'there now.')} (voice) please check the build`,
    ]);
    await r.talk(6_000);
    expect(r.sent).toHaveLength(1);
  });

  test('the words never reach a log, only counts', async () => {
    const r = await rig();
    await r.talk(600);
    r.speak(0, 'Secret plans follow.');
    await r.talk(600);
    r.hush({ id: 0, samples: 7 * SAMPLES_PER_CHAR });
    await r.say();
    expect(r.logged.join('\n')).not.toMatch(/secret|plans|follow|heard up to/iu);
  });

  test('the wire: a bare hush still parses, and a position is carried in the same fixed-size frame', () => {
    expect(encodeHushFrame()).toHaveLength(1_024);
    expect(encodeHushFrame({ id: 3, samples: 9_600 })).toHaveLength(1_024);
    expect(JSON.parse(encodeHushFrame({ id: 3, samples: 9_600 }))).toEqual({
      t: 'hush',
      cut: { id: 3, samples: 9_600 },
    });
    expect(JSON.parse(encodeHushFrame())).toEqual({ t: 'hush' });
  });

  test('a standalone note still in flight cannot also prefix the next utterance', async () => {
    const hold = Promise.withResolvers<void>();
    const r = await rig({ hold: hold.promise });
    await r.talk(600);
    r.speak(0, 'Almost there now.');
    await r.talk(400);
    r.hush({ id: 0, samples: 6 * SAMPLES_PER_CHAR });
    await r.talk(1_700);
    expect(r.attempts.map(each => each.sendId)).toEqual(['abc123:heard:1']);
    try {
      await r.say();
    } finally {
      hold.resolve();
    }
    await r.talk(300);
    expect(r.sent.filter(each => each.message.startsWith('[heard up to:'))).toHaveLength(1);
    // The note went once, alone; the utterance is plain (it was sent while the note was held, so it lands first).
    expect(r.sent.map(each => each.message)).toEqual([
      '(voice) please check the build',
      NOTE('"Almost"', 'there now.'),
    ]);
  });

  test('a refused standalone note is sent again under the same id without another utterance', async () => {
    const r = await rig({ refuse: 1 });
    await r.talk(600);
    r.speak(0, 'Almost there now.');
    await r.talk(400);
    r.hush({ id: 0, samples: 6 * SAMPLES_PER_CHAR });
    await r.talk(8_000);
    expect(r.attempts.map(each => each.sendId)).toEqual(['abc123:heard:1', 'abc123:heard:1']);
    expect(r.sent).toEqual([{ message: NOTE('"Almost"', 'there now.'), sendId: 'abc123:heard:1' }]);
  });

  test("a late acknowledgement of a standalone note does not clear the next reply's lines", async () => {
    const hold = Promise.withResolvers<void>();
    const r = await rig({ hold: hold.promise });
    await r.talk(600);
    r.speak(0, 'Almost there now.');
    await r.talk(400);
    r.hush({ id: 0, samples: 6 * SAMPLES_PER_CHAR });
    await r.talk(1_700);
    expect(r.attempts.map(each => each.sendId)).toEqual(['abc123:heard:1']);
    r.speak(1, 'Something else followed.');
    await r.talk(400);
    hold.resolve();
    await r.talk(1_000);
    r.hush({ id: 1, samples: 10 * SAMPLES_PER_CHAR });
    await r.talk(2_000);
    expect(r.sent).toEqual([
      { message: NOTE('"Almost"', 'there now.'), sendId: 'abc123:heard:1' },
      { message: NOTE('"Something"', 'else followed.'), sendId: 'abc123:heard:2' },
    ]);
  });

  test('a drop the device sent after sound already left the machine still means that line was never heard', async () => {
    const r = await rig();
    await r.talk(600);
    const stale = 'Stale progress you never heard.';
    r.speak(0, stale);
    await r.talk(400);
    // Some of its sound is on the way, and has not reached the device: the device takes the line back and discards it.
    expect(r.audio().get(0)).toBeGreaterThan(0);
    expect(r.audio().get(0)).toBeLessThan(stale.length * SAMPLES_PER_CHAR);
    r.drop(0);
    r.speak(1, 'Current line keeps going.');
    await r.talk(4_500);
    r.hush({ id: 1, samples: 7 * SAMPLES_PER_CHAR });
    await r.say();
    expect(r.sent).toEqual([
      { message: `${NOTE('"Current"', 'line keeps going.')} (voice) please check the build`, sendId: 'abc123:1' },
    ]);
  });
});
