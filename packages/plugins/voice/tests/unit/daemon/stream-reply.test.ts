import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@ferretry/kernel/testing';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import {
  DOWNLINK_UNIT_BYTES,
  REPLY_AUDIO_SAMPLES,
  REPLY_DOWNLINK_UNIT_BYTES,
  SPEAK_QUEUE_MAX,
  STREAM_CLOSES,
  type StreamSnapshot,
  UNIT_SAMPLES,
  VoiceEngineError,
  decodeDownlinkUnit,
  decodeReplyDownlinkUnit,
  encodeSpeakFrame,
  encodeUplinkUnit,
} from '../../../contract/index.ts';
import { VoiceStream, type StreamParts } from '../../../daemon/lib/stream/session.ts';

const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

/** 0.1 s of sound per character, at level 0.5: the length of a made line is easy to read off its text. */
const sound = (text: string): Float32Array => new Float32Array(text.length * 1_600).fill(0.5);

interface Fake {
  state: 'ready' | 'not_installed';
  warmFails: boolean;
  spoken: string[];
  /** While set, `speak` waits for it. */
  gate?: Promise<void>;
  failOn?: string;
}

async function rig(
  options: { reply?: 'fake' | 'none'; ready?: boolean; start?: object; fake?: Partial<Fake>; logged?: string[] } = {},
) {
  const clock = fixedClock();
  const frames: Uint8Array[] = [];
  const closes: { code: number; reason: string }[] = [];
  const fake: Fake = {
    state: options.ready === false ? 'not_installed' : 'ready',
    warmFails: false,
    spoken: [],
    ...options.fake,
  };
  const downstream: SocketDownstream = {
    send(frame) {
      frames.push(frame as Uint8Array);
      return (frame as Uint8Array).byteLength;
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    bufferedBytes: () => 0,
  };
  let counter = 0;
  const reply: StreamParts['reply'] =
    options.reply === 'none'
      ? undefined
      : {
          view: async () => ({ state: fake.state }) as Awaited<ReturnType<NonNullable<StreamParts['reply']>['view']>>,
          warm: async () => {
            if (fake.warmFails) throw new VoiceEngineError('no_memory', 'no memory');
          },
          speak: async text => {
            fake.spoken.push(text);
            await fake.gate;
            if (fake.failOn !== undefined && text.includes(fake.failOn)) throw new Error('speak crashed');
            return { samples: sound(text), speakMs: 100 };
          },
        };
  let ended = 0;
  const stream = new VoiceStream({
    engine: { detectSpeech: async () => [], transcribe: async () => ({ text: '', decodeMs: 0, realTimeFactor: 0 }) },
    reply,
    clock,
    downstream,
    streamId: 's1',
    nonce: () => `${(counter++).toString(16).padStart(16, '0')}`,
    send: undefined,
    mayChat: () => true,
    resolveFerret: async reference => reference,
    recordSent: () => undefined,
    claimFerret: () => () => undefined,
    onEnd: () => {
      ended += 1;
    },
    log: { info: message => void options.logged?.push(message) },
  });
  await stream.open();
  stream.fromClient(JSON.stringify(options.start ?? { t: 'start', v: 1, purpose: 'test', reply: 'machine' }));
  let echo: string | undefined;
  const units = (): { snapshot: StreamSnapshot; pcm: Int16Array }[] =>
    frames.map(frame =>
      frame.byteLength === REPLY_DOWNLINK_UNIT_BYTES
        ? decodeReplyDownlinkUnit(frame)
        : { snapshot: decodeDownlinkUnit(frame), pcm: new Int16Array(0) },
    );
  return {
    clock,
    frames,
    closes,
    stream,
    fake,
    units,
    get ended() {
      return ended;
    },
    speak: (id: number, text: string) => stream.fromClient(encodeSpeakFrame({ t: 'speak', id, text })),
    /** The phone: one 40 ms silent unit per call for `ms`, echoing the newest nonce. */
    async run(ms: number) {
      for (let at = 0; at < ms; at += 40) {
        await clock.advance(40);
        const latest = frames.at(-1);
        if (latest !== undefined) echo = (units().at(-1) as { snapshot: StreamSnapshot }).snapshot.nonce;
        stream.fromClient(encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo }));
        if (at % 200 === 160) await settle();
      }
      await settle();
    },
    audio: () => units().filter(unit => unit.snapshot.audio !== undefined),
  };
}

describe('the voice stream: the reply voice', () => {
  test('a stream that asks gets the larger unit from its very first one, and learns the voice is loading, then ready', async () => {
    const r = await rig();
    expect(r.frames[0]?.byteLength).toBe(REPLY_DOWNLINK_UNIT_BYTES);
    expect(r.units()[0]?.snapshot.reply).toBe('loading');
    await r.run(600);
    expect(r.frames.every(frame => frame.byteLength === REPLY_DOWNLINK_UNIT_BYTES)).toBe(true);
    expect(r.units().at(-1)?.snapshot.reply).toBe('ready');
    // Nothing is being said, so every audio slot is empty and no unit names a line.
    expect(r.units().every(unit => unit.pcm.length === 0 && unit.snapshot.audio === undefined)).toBe(true);
  });

  test('a stream that does not ask keeps the small unit, says nothing of a voice, and may not send a line', async () => {
    const r = await rig({ start: { t: 'start', v: 1, purpose: 'test' } });
    await r.run(400);
    expect(r.frames.every(frame => frame.byteLength === DOWNLINK_UNIT_BYTES)).toBe(true);
    expect(r.units().every(unit => unit.snapshot.reply === undefined)).toBe(true);
    r.speak(0, 'Hello.');
    expect(r.closes).toEqual([STREAM_CLOSES.protocol]);
  });

  test('nothing is sent before the start record, so no unit can be the wrong size', async () => {
    const clock = fixedClock();
    const frames: Uint8Array[] = [];
    const stream = new VoiceStream({
      engine: { detectSpeech: async () => [], transcribe: async () => ({ text: '', decodeMs: 0, realTimeFactor: 0 }) },
      clock,
      downstream: {
        send: frame => (frames.push(frame as Uint8Array), 0),
        close: () => undefined,
        bufferedBytes: () => 0,
      },
      streamId: 's',
      nonce: () => '0000000000000001',
      send: undefined,
      mayChat: () => true,
      resolveFerret: async reference => reference,
      recordSent: () => undefined,
      claimFerret: () => () => undefined,
      onEnd: () => undefined,
      log: { info: () => undefined },
    });
    await stream.open();
    await clock.advance(1_000);
    expect(frames).toHaveLength(0);
    stream.fromClient(JSON.stringify({ t: 'start', v: 1, purpose: 'test' }));
    expect(frames).toHaveLength(1);
  });

  test('a line is spoken: its sound arrives 200 ms at a time, in order, ending with last, at the level it was made', async () => {
    const r = await rig();
    await r.run(400);
    // 12 characters = 1.2 s = 19,200 samples = six slots exactly.
    r.speak(0, 'Hello there.');
    await r.run(1_800);
    const audio = r.audio();
    expect(audio.map(unit => unit.snapshot.audio?.id)).toEqual(Array(6).fill(0));
    expect(audio.map(unit => unit.pcm.length)).toEqual(Array(6).fill(REPLY_AUDIO_SAMPLES));
    expect(audio.map(unit => unit.snapshot.audio?.last)).toEqual([false, false, false, false, false, true]);
    expect(audio[0]?.pcm[0]).toBe(Math.round(0.5 * 32767));
    expect(r.fake.spoken).toEqual(['Hello there.']);
  });

  test('a long line is made in pieces, and its sound is packed so no slot but the last is part empty', async () => {
    const logged: string[] = [];
    const r = await rig({ logged });
    await r.run(400);
    // Two clauses: "I found the bug," (16 chars) and "it was a missing await in the send path." (40 chars), 0.1 s a char.
    r.speak(3, 'I found the bug, it was a missing await in the send path.');
    // 5.6 s of sound, sent at the speed it plays.
    await r.run(6_400);
    expect(r.fake.spoken).toEqual(['I found the bug,', 'it was a missing await in the send path.']);
    const audio = r.audio();
    expect(audio.every(unit => unit.snapshot.audio?.id === 3)).toBe(true);
    expect(audio.slice(0, -1).every(unit => unit.pcm.length === REPLY_AUDIO_SAMPLES)).toBe(true);
    expect(audio.at(-1)?.snapshot.audio?.last).toBe(true);
    const total = audio.reduce((sum, unit) => sum + unit.pcm.length, 0);
    expect(total).toBe((16 + 40) * 1_600);
    // The log says how long each piece took and lasted, in numbers only.
    expect(logged.filter(message => message === 'voice.stream.spoke')).toHaveLength(2);
  });

  test('two lines are spoken one after the other, and a unit never carries the end of one and the start of the next', async () => {
    const r = await rig();
    await r.run(400);
    r.speak(0, 'Short one.');
    r.speak(1, 'And another.');
    await r.run(3_000);
    const ids = r.audio().map(unit => unit.snapshot.audio?.id);
    expect(ids).toEqual([...Array(5).fill(0), ...Array(6).fill(1)].slice(0, ids.length));
    expect(new Set(ids)).toEqual(new Set([0, 1]));
    expect(ids.indexOf(1)).toBeGreaterThan(ids.lastIndexOf(0));
    expect(r.audio().filter(unit => unit.snapshot.audio?.last === true)).toHaveLength(2);
  });

  test('a line that makes no sound (no letters) ends at once without failing', async () => {
    const r = await rig();
    await r.run(400);
    r.speak(0, '...');
    await r.run(600);
    expect(r.audio().map(unit => unit.snapshot.audio)).toEqual([{ id: 0, samples: 0, last: true }]);
    expect(r.fake.spoken).toEqual([]);
  });

  test('a voice that is not installed is said once, and every line is handed back as failed so the device reads it', async () => {
    const r = await rig({ ready: false });
    await r.run(400);
    expect(r.units().at(-1)?.snapshot.reply).toBe('absent');
    r.speak(0, 'Hello there.');
    await r.run(600);
    expect(r.audio().map(unit => unit.snapshot.audio)).toEqual([
      { id: 0, samples: 0, last: true, failed: 'reply_voice_absent' },
    ]);
    expect(r.fake.spoken).toEqual([]);
  });

  test('lines sent while the voice is still loading are handed back when it turns out to be absent', async () => {
    const r = await rig({ fake: { warmFails: true } });
    r.speak(0, 'First.');
    r.speak(1, 'Second.');
    await r.run(600);
    expect(r.units().at(-1)?.snapshot.reply).toBe('absent');
    expect(r.audio().map(unit => unit.snapshot.audio)).toEqual([
      { id: 0, samples: 0, last: true, failed: 'reply_voice_absent' },
      { id: 1, samples: 0, last: true, failed: 'reply_voice_absent' },
    ]);
  });

  test('a machine with no reply voice at all says absent', async () => {
    const r = await rig({ reply: 'none' });
    expect(r.units()[0]?.snapshot.reply).toBe('absent');
    r.speak(0, 'Hello.');
    await r.run(400);
    expect(r.audio()[0]?.snapshot.audio).toMatchObject({ id: 0, failed: 'reply_voice_absent' });
  });

  test('a line the voice could not make is failed, and the lines after it are still spoken', async () => {
    const r = await rig({ fake: { failOn: 'boom' } });
    await r.run(400);
    r.speak(0, 'Fine one.');
    r.speak(1, 'A boom happened.');
    r.speak(2, 'Fine again.');
    await r.run(4_000);
    const marks = r.audio().filter(unit => unit.snapshot.audio?.last === true);
    expect(marks.map(unit => [unit.snapshot.audio?.id, unit.snapshot.audio?.failed])).toEqual([
      [0, undefined],
      [1, 'reply_voice_failed'],
      [2, undefined],
    ]);
  });

  test('more than the queue holds is refused for that line only, so the device reads it', async () => {
    let release: (() => void) | undefined;
    const r = await rig({
      fake: {
        gate: new Promise<void>(resolve => {
          release = resolve;
        }),
      },
    });
    await r.run(400);
    for (let id = 0; id < SPEAK_QUEUE_MAX + 3; id += 1) r.speak(id, `Line ${id}.`);
    await r.run(400);
    // The first line is being made (it left the queue), SPEAK_QUEUE_MAX wait behind it, and two more do not fit.
    const refused = r.audio().filter(unit => unit.snapshot.audio?.failed === 'queue_full');
    expect(refused.map(unit => unit.snapshot.audio?.id)).toEqual([SPEAK_QUEUE_MAX + 1, SPEAK_QUEUE_MAX + 2]);
    release?.();
    await r.run(2_000);
  });

  test('it makes no more sound than can wait to be sent: a full backlog pauses the next line until some has gone', async () => {
    const r = await rig();
    await r.run(400);
    // Each line is 28 s of sound. Two make 56 s, past the 30 s allowance, so the third waits for some to be sent.
    const line = `${'a'.repeat(279)}.`;
    r.speak(0, line);
    r.speak(1, line);
    r.speak(2, line);
    await r.run(1_000);
    expect(r.fake.spoken).toEqual([line, line]);
    // 56 s of sound is waiting and it plays out at real time: after 20 s there are 36 s left, still past the allowance.
    await r.run(20_000);
    expect(r.fake.spoken).toEqual([line, line]);
    // After 30 s more only 6 s is left, so the third line is made.
    await r.run(10_000);
    expect(r.fake.spoken).toEqual([line, line, line]);
    await r.run(60_000);
    expect(
      r
        .audio()
        .filter(unit => unit.snapshot.audio?.last === true)
        .map(unit => unit.snapshot.audio?.id),
    ).toEqual([0, 1, 2]);
  }, 60_000);

  test('a stream that ends while a line is being made drops it without a word, and sends nothing after the end', async () => {
    let release: (() => void) | undefined;
    const r = await rig({
      fake: {
        gate: new Promise<void>(resolve => {
          release = resolve;
        }),
      },
    });
    await r.run(400);
    r.speak(0, 'Hello there.');
    await r.run(200);
    r.stream.close();
    const sent = r.frames.length;
    release?.();
    await settle();
    expect(r.frames).toHaveLength(sent);
    expect(r.ended).toBe(1);
  });

  test('a frame of the wrong size, or not a speak frame, ends the stream as a protocol error', async () => {
    const wrong = await rig();
    wrong.stream.fromClient('{"t":"speak","id":0,"text":"hi"}');
    expect(wrong.closes).toEqual([STREAM_CLOSES.protocol]);
    const other = await rig();
    other.stream.fromClient(JSON.stringify({ t: 'start', v: 1, purpose: 'test' }).padEnd(1_024));
    expect(other.closes).toEqual([STREAM_CLOSES.protocol]);
  });

  test('a line spoken for a ferret chat travels the same way, and a refused chat still says why', async () => {
    const r = await rig({ start: { t: 'start', v: 1, purpose: 'chat', ferretId: 'fer-1', reply: 'machine' } });
    await r.run(400);
    // This rig has no send service, so a chat is refused: the refusal rides the larger unit like everything else.
    const last = r.units().at(-1)?.snapshot;
    expect(last?.error?.code).toBe('voice_unavailable');
    expect(r.frames.every(frame => frame.byteLength === REPLY_DOWNLINK_UNIT_BYTES)).toBe(true);
  });
});
