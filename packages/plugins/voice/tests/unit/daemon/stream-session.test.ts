import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@ferretry/kernel/testing';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import {
  STREAM_CLOSES,
  type StreamSnapshot,
  UNIT_SAMPLES,
  WordsAssembler,
  decodeDownlinkUnit,
  encodeUplinkUnit,
  type StreamControl,
  type VoiceSpan,
} from '../../../contract/index.ts';
import { VoiceEngineError } from '../../../contract/index.ts';
import { spansFromProbabilities, VAD_CHUNK } from '../../../daemon/lib/engine/spans.ts';
import { StreamRegistry } from '../../../daemon/lib/stream/registry.ts';
import { SampleBuffer } from '../../../daemon/lib/stream/samples.ts';
import { VoiceStream, type StreamParts } from '../../../daemon/lib/stream/session.ts';

/** A voice is any audio louder than this; the fake VAD runs the REAL span rules over per-chunk loudness. */
const LOUD = 6_000;
const WORDS = ['please', 'check', 'the', 'build', 'and', 'tell', 'me', 'what', 'failed', 'today'];

/** Silero's job, done by loudness: the same hysteresis and minimum lengths decide what a span is. */
const fakeSpans = (samples: Float32Array): readonly VoiceSpan[] => {
  const probabilities: number[] = [];
  for (let at = 0; at + VAD_CHUNK <= samples.length; at += VAD_CHUNK) {
    let peak = 0;
    for (let index = at; index < at + VAD_CHUNK; index += 1) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    probabilities.push(peak * 32768 >= LOUD ? 0.9 : 0.05);
  }
  return spansFromProbabilities(probabilities, samples.length);
};

interface Rig {
  readonly clock: ReturnType<typeof fixedClock>;
  readonly frames: Uint8Array[];
  readonly closes: { code: number; reason: string }[];
  readonly sent: { ferretId: string; message: string; sendId: string }[];
  /** The ferret ids a send was audited for. */
  readonly audited: string[];
  readonly transcribed: number[];
  readonly stream: VoiceStream;
  snapshot(): StreamSnapshot;
  /** Every snapshot sent so far, oldest first. */
  snapshots(): StreamSnapshot[];
  /** The phone: one 40 ms unit per call, echoing the newest nonce it has seen unless it is `dead`. */
  talk(ms: number, options?: { loud?: boolean; control?: StreamControl; dead?: boolean }): Promise<void>;
  start(record: object): void;
  ended: number;
}

const settle = async (): Promise<void> => {
  for (let round = 0; round < 6; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

async function rig(
  overrides: {
    send?: StreamParts['send'];
    engine?: Partial<StreamParts['engine']>;
    claimFerret?: StreamParts['claimFerret'];
    mayChat?: StreamParts['mayChat'];
    resolveFerret?: StreamParts['resolveFerret'];
    registry?: StreamRegistry;
    buffered?: number;
  } = {},
): Promise<Rig> {
  const clock = fixedClock();
  const frames: Uint8Array[] = [];
  const closes: { code: number; reason: string }[] = [];
  const sent: Rig['sent'] = [];
  const audited: string[] = [];
  const transcribed: number[] = [];
  let counter = 0;
  const downstream: SocketDownstream = {
    send(frame) {
      frames.push(frame as Uint8Array);
      return (frame as Uint8Array).byteLength;
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    bufferedBytes: () => overrides.buffered ?? 0,
  };
  const registry = overrides.registry ?? new StreamRegistry();
  let ended = 0;
  const stream = new VoiceStream({
    engine: {
      detectSpeech: async samples => fakeSpans(samples),
      transcribe: async samples => {
        transcribed.push(samples.length);
        const seconds = samples.length / 16_000;
        return {
          text: WORDS.slice(0, Math.max(1, Math.min(WORDS.length, Math.floor(seconds * 2)))).join(' '),
          decodeMs: 10,
          realTimeFactor: 0.1,
        };
      },
      ...overrides.engine,
    },
    clock,
    downstream,
    streamId: 'abc123',
    nonce: () => `${(counter++).toString(16).padStart(16, '0')}`.replace(/^0{16}$/u, '0000000000000001'),
    send:
      'send' in overrides
        ? overrides.send
        : async (ferretId, message, sendId) => {
            sent.push({ ferretId, message, sendId });
            return { ok: true };
          },
    mayChat: overrides.mayChat ?? (() => true),
    resolveFerret: overrides.resolveFerret ?? (async reference => reference),
    recordSent: ferretId => void audited.push(ferretId),
    claimFerret: overrides.claimFerret ?? (ferret => registry.claimFerret(ferret)),
    onEnd: () => {
      ended += 1;
    },
    log: { info: () => undefined },
  });
  await stream.open();
  const snapshots = (): StreamSnapshot[] => frames.map(decodeDownlinkUnit);
  let echo: string | undefined;
  const view: Rig = {
    clock,
    frames,
    closes,
    sent,
    audited,
    transcribed,
    stream,
    snapshot: () => snapshots().at(-1) as StreamSnapshot,
    snapshots,
    start: record => stream.fromClient(JSON.stringify(record)),
    async talk(ms, options = {}) {
      for (let at = 0; at < ms; at += 40) {
        await clock.advance(40);
        const latest = frames.at(-1);
        if (latest !== undefined && options.dead !== true) echo = decodeDownlinkUnit(latest).nonce;
        const pcm = new Int16Array(UNIT_SAMPLES);
        if (options.loud === true)
          for (let index = 0; index < UNIT_SAMPLES; index += 1) pcm[index] = index % 2 === 0 ? 12_000 : -12_000;
        stream.fromClient(encodeUplinkUnit({ pcm, control: options.control ?? 'none', echo }));
        if (at % 200 === 160) await settle();
      }
      await settle();
    },
    get ended() {
      return ended;
    },
  };
  return view;
}

const chat = { t: 'start', v: 1, purpose: 'chat', ferretId: 'fer-1' } as const;
const test_ = { t: 'start', v: 1, purpose: 'test' } as const;

describe('the voice stream: what the machine hears and shows', () => {
  test('Talk to test: live words appear while you speak, the final words follow the pause, and nothing is sent', async () => {
    const r = await rig();
    r.start(test_);
    await r.talk(2_000); // lead-in silence, and the models load
    expect(r.snapshot().state).toBe('listening');
    await r.talk(3_000, { loud: true });
    const interim = r.snapshots().filter(snapshot => snapshot.words !== undefined && !snapshot.words.final);
    expect(interim.length).toBeGreaterThan(0);
    expect(r.snapshot().state).toBe('hearing');
    await r.talk(2_500); // past the 1.5 s pause
    const final = r.snapshots().filter(snapshot => snapshot.words?.final === true);
    expect(final.length).toBeGreaterThan(0);
    expect(r.snapshot().last).toMatchObject({ turn: 1, outcome: 'heard' });
    expect(r.sent).toEqual([]);
    expect(r.snapshot().state).toBe('listening');
  });

  test('a pause shorter than the style is not the end of the turn', async () => {
    const r = await rig();
    r.start(test_);
    await r.talk(1_500);
    await r.talk(1_000, { loud: true });
    await r.talk(800); // under 1.5 s
    await r.talk(1_000, { loud: true });
    expect(r.snapshot().turn).toBe(1);
    expect(r.snapshot().last).toBeUndefined();
    await r.talk(2_500);
    expect(r.snapshot().last).toMatchObject({ turn: 1, outcome: 'heard' });
  });

  test('silence alone makes no turn, and a muted phone is not listened to', async () => {
    const r = await rig();
    r.start(test_);
    await r.talk(4_000);
    expect(r.snapshot()).toMatchObject({ state: 'listening', turn: 0 });
    await r.talk(40, { control: 'muted' });
    await r.talk(3_000, { loud: true, control: 'muted' });
    expect(r.snapshot().state).toBe('muted');
    expect(r.snapshot().turn).toBe(0);
    await r.talk(240, { control: 'unmuted' });
    expect(r.snapshot().state).toBe('listening');
  });

  test('a long transcript arrives in fragments over several units and reassembles', async () => {
    const long = Array.from({ length: 400 }, (_, index) => `word${index} é 😀`).join(' ');
    const r = await rig({
      engine: { transcribe: async () => ({ text: long, decodeMs: 1, realTimeFactor: 0 }) },
    });
    r.start(test_);
    await r.talk(1_500);
    await r.talk(2_000, { loud: true });
    await r.talk(4_000);
    const assembler = new WordsAssembler();
    let whole: string | undefined;
    const finals = r.snapshots().filter(snapshot => snapshot.words?.final === true);
    expect(finals.length).toBeGreaterThan(3);
    for (const snapshot of finals) {
      const done = assembler.accept(snapshot.words as NonNullable<typeof snapshot.words>);
      if (done !== undefined) whole = done.text;
    }
    expect(whole).toBe(long);
    for (const frame of r.frames) expect(frame.byteLength).toBe(1024);
  });
});

describe('the voice stream: when it sends, and when it must not', () => {
  const speakThenPause = async (r: Rig, phone: { dead?: boolean } = {}): Promise<void> => {
    await r.talk(1_500);
    await r.talk(2_500, { loud: true });
    await r.talk(3_000, phone);
  };

  test('voice mode sends the finished turn once, at the pause, as "(voice) …" with a stable id', async () => {
    const r = await rig();
    r.start(chat);
    await speakThenPause(r);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ ferretId: 'fer-1', sendId: 'abc123:1' });
    expect(r.sent[0]?.message).toStartWith('(voice) please check');
    expect(r.snapshot().last).toEqual({ turn: 1, outcome: 'sent', sendId: 'abc123:1' });
    await r.talk(2_000);
    expect(r.sent).toHaveLength(1);
  });

  test('a second turn is a second message with its own id', async () => {
    const r = await rig();
    r.start(chat);
    await speakThenPause(r);
    await r.talk(2_500, { loud: true });
    await r.talk(3_000);
    expect(r.sent.map(item => item.sendId)).toEqual(['abc123:1', 'abc123:2']);
  });

  test('RED→GREEN: a phone that stopped answering at the pause cancels the turn and nothing is sent', async () => {
    const r = await rig();
    r.start(chat);
    // Units still arrive for a moment after a phone dies, and they carry the OLD nonce: only an echo of a nonce issued
    // after the pause proves the phone is alive.
    await speakThenPause(r, { dead: true });
    expect(r.sent).toEqual([]);
    expect(r.snapshot().last).toMatchObject({ turn: 1, outcome: 'cancelled', code: 'phone_silent' });
  });

  test('a phone that goes quiet altogether is closed, and nothing is sent', async () => {
    const r = await rig();
    r.start(chat);
    await r.talk(1_500);
    await r.talk(2_000, { loud: true });
    await r.clock.advance(6_000);
    await settle();
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.silentPhone);
    expect(r.sent).toEqual([]);
    expect(r.ended).toBe(1);
  });

  test('a send the mailbox refused is reported, not repeated', async () => {
    let calls = 0;
    const r = await rig({
      send: async () => {
        calls += 1;
        return { ok: false, code: 'send_refused' };
      },
    });
    r.start(chat);
    await speakThenPause(r);
    expect(calls).toBe(1);
    expect(r.snapshot().last).toMatchObject({ turn: 1, outcome: 'failed', code: 'send_refused' });
  });

  test('an acknowledgement that never came (the send threw) is not retried by the stream', async () => {
    let calls = 0;
    const r = await rig({
      send: async () => {
        calls += 1;
        throw new Error('the socket closed under the send');
      },
    });
    r.start(chat);
    await speakThenPause(r);
    await r.talk(3_000);
    expect(calls).toBe(1);
    expect(r.snapshot().last).toMatchObject({ outcome: 'failed', code: 'send_refused' });
  });

  test('a turn with no words (noise the model could not read) sends nothing', async () => {
    const r = await rig({ engine: { transcribe: async () => ({ text: '  ', decodeMs: 1, realTimeFactor: 0 }) } });
    r.start(chat);
    await speakThenPause(r);
    expect(r.sent).toEqual([]);
    expect(r.snapshot().last).toMatchObject({ outcome: 'dropped', code: 'no_words' });
  });

  test('"End" from the phone closes the stream and releases the ferret for the next one', async () => {
    const registry = new StreamRegistry();
    const first = await rig({ registry });
    first.start(chat);
    await first.talk(400);
    const second = await rig({ registry });
    second.start(chat);
    await second.talk(200);
    expect(second.snapshot().error).toMatchObject({ code: 'voice_busy' });
    expect(second.closes.at(-1)).toEqual(STREAM_CLOSES.busy);
    await first.talk(40, { control: 'end' });
    expect(first.closes.at(-1)).toEqual(STREAM_CLOSES.ended);
    const third = await rig({ registry });
    third.start(chat);
    await third.talk(1_500);
    expect(third.snapshot().error).toBeUndefined();
  });

  test('with Conversation off, voice mode is refused out loud instead of listening to no purpose', async () => {
    const r = await rig({ send: undefined });
    r.start(chat);
    expect(r.snapshot().error).toMatchObject({ code: 'voice_unavailable' });
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.failed);
  });
});

describe('the voice stream: an engine that cannot keep up fails out loud', () => {
  test('a decode that never answers (interim or final) fails the turn as engine_timeout, and the next turn starts clean', async () => {
    let first = true;
    const r = await rig({
      engine: {
        transcribe: async samples =>
          first
            ? await new Promise(() => {
                first = false;
              })
            : { text: `again ${samples.length}`, decodeMs: 1, realTimeFactor: 0 },
      },
    });
    r.start(test_);
    await r.talk(1_500);
    await r.talk(2_500, { loud: true });
    await r.talk(7_000); // the interim decode hangs; five seconds later the turn is lost, out loud
    expect(r.snapshot().last).toMatchObject({ outcome: 'failed', code: 'engine_timeout' });
    await r.talk(1_200);
    await r.talk(2_500, { loud: true });
    await r.talk(3_000);
    expect(r.snapshot().last).toMatchObject({ outcome: 'heard' });
  });

  test('three lost turns in a row end the stream and say the machine is overloaded', async () => {
    const r = await rig({
      engine: {
        transcribe: async () => {
          throw new VoiceEngineError('load_failed', 'x');
        },
      },
    });
    r.start(test_);
    for (let turn = 0; turn < 5 && r.closes.length === 0; turn += 1) {
      await r.talk(1_500);
      await r.talk(2_500, { loud: true });
      await r.talk(3_000);
    }
    expect(
      r
        .snapshots()
        .some(snapshot => snapshot.error?.code === 'engine_failed' || snapshot.error?.code === 'engine_overloaded'),
    ).toBe(true);
    expect(r.closes.length).toBe(1);
  });

  test('not enough memory to load speech is said as such, and ends the stream', async () => {
    const r = await rig({
      engine: {
        detectSpeech: async () => {
          throw new VoiceEngineError('no_memory', 'x');
        },
      },
    });
    r.start(test_);
    await settle();
    expect(r.snapshot().error).toMatchObject({ code: 'voice_no_memory' });
    expect(r.closes).toHaveLength(1);
  });

  test('a load that was superseded (the engine unloaded while this waited) is asked again once', async () => {
    let calls = 0;
    const r = await rig({
      engine: {
        detectSpeech: async samples => {
          calls += 1;
          if (calls === 1) throw new VoiceEngineError('not_ready', 'Speech was stopped while it was loading.');
          return fakeSpans(samples);
        },
      },
    });
    r.start(test_);
    await r.talk(1_000);
    expect(r.snapshot().state).toBe('listening');
    expect(r.closes).toEqual([]);
  });
});

describe('the voice stream: malformed is fatal', () => {
  test('audio before the start record, a bad start, and a second start each close with a protocol error', async () => {
    const before = await rig();
    before.stream.fromClient(encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo: undefined }));
    expect(before.closes.at(-1)).toEqual(STREAM_CLOSES.protocol);

    const bad = await rig();
    bad.start({ t: 'start', v: 1, purpose: 'chat' }); // no ferret
    expect(bad.closes.at(-1)).toEqual(STREAM_CLOSES.protocol);

    const twice = await rig();
    twice.start(test_);
    twice.start(test_);
    expect(twice.closes.at(-1)).toEqual(STREAM_CLOSES.protocol);
  });

  test('a unit with a control the stream does not define closes with a protocol error', async () => {
    const r = await rig();
    r.start(test_);
    const unit = encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo: undefined });
    unit[1280] = 9;
    r.stream.fromClient(unit);
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.protocol);
  });

  test('audio that arrives much faster than real time is closed', async () => {
    const r = await rig();
    r.start(test_);
    const unit = encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo: undefined });
    for (let index = 0; index < 400; index += 1) r.stream.fromClient(unit);
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.tooFast);
  });

  test('a stream that never says what it is for is closed after five seconds', async () => {
    const r = await rig();
    await r.clock.advance(5_400);
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.protocol);
  });

  test('units may arrive in any chunking: half a unit, then three', async () => {
    const r = await rig();
    r.start(test_);
    const unit = encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES).fill(7), control: 'none', echo: undefined });
    const joined = new Uint8Array(unit.byteLength * 3);
    for (let index = 0; index < 3; index += 1) joined.set(unit, index * unit.byteLength);
    r.stream.fromClient(joined.slice(0, 700));
    r.stream.fromClient(joined.slice(700));
    expect(r.closes).toEqual([]);
  });
});

describe('the voice stream: edges', () => {
  test('a start record that is not JSON closes with a protocol error', async () => {
    const r = await rig();
    r.stream.fromClient('{nope');
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.protocol);
  });

  test('a unit may arrive as an ArrayBuffer as well as a view', async () => {
    const r = await rig();
    r.start(test_);
    const unit = encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES).fill(5), control: 'none', echo: undefined });
    r.stream.fromClient(unit.buffer.slice(unit.byteOffset, unit.byteOffset + unit.byteLength) as ArrayBuffer);
    expect(r.closes).toEqual([]);
  });

  test("a failure that is not the wire's (a defect) is not hidden as a protocol error", async () => {
    const r = await rig({
      mayChat: () => {
        throw new Error('the grant check broke');
      },
    });
    expect(() => r.start(chat)).toThrow('the grant check broke');
    expect(r.closes).toEqual([]);
  });

  test('an engine failure of an unknown kind ends the stream as engine_failed', async () => {
    const r = await rig({
      engine: {
        transcribe: async () => {
          throw new Error('the worker died');
        },
      },
    });
    r.start(test_);
    await r.talk(1_500);
    await r.talk(2_500, { loud: true });
    await r.talk(3_000);
    expect(r.snapshots().some(snapshot => snapshot.error?.code === 'engine_failed')).toBe(true);
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.failed);
  });

  test('a socket the browser stopped reading ends the stream instead of growing', async () => {
    const r = await rig({ buffered: 1_000_000 });
    r.start(test_);
    await r.clock.advance(400);
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.overloaded);
  });

  test('three turns lost to a hung engine in a row end the stream as engine_overloaded', async () => {
    const r = await rig({ engine: { transcribe: () => new Promise(() => undefined) } });
    r.start(test_);
    for (let turn = 0; turn < 3; turn += 1) {
      await r.talk(1_500);
      await r.talk(2_500, { loud: true });
      await r.talk(7_000);
    }
    expect(r.snapshots().some(snapshot => snapshot.error?.code === 'engine_overloaded')).toBe(true);
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.overloaded);
  });
});

describe('the sample buffer', () => {
  test('holds more than its first ten seconds, hands back slices, and forgets from the front', () => {
    const buffer = new SampleBuffer();
    for (let second = 0; second < 12; second += 1) buffer.append(new Int16Array(16_000).fill(16_384));
    expect(buffer.length).toBe(12 * 16_000);
    expect(buffer.slice(0, 2)[0]).toBe(0.5);
    expect(buffer.slice(5, 7)).toHaveLength(2);
    expect(buffer.dropBefore(16_000)).toBe(16_000);
    expect(buffer.length).toBe(11 * 16_000);
  });
});

/** The final decode answers when the test says so: the moment between "the pause was heard" and "the words are known". */
const gatedFinal = () => {
  let hold = false;
  let release: () => void = () => undefined;
  return {
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      release();
    },
    transcribe: async (samples: Float32Array) => {
      if (hold) await new Promise<void>(resolve => (release = resolve));
      return { text: samples.length > 0 ? 'please check the build' : '', decodeMs: 1, realTimeFactor: 0 };
    },
  };
};

const turn = async (r: Rig): Promise<void> => {
  await r.talk(1_500);
  await r.talk(2_500, { loud: true });
  await r.talk(3_000);
};

describe('the voice stream: voice chat needs the fleet permission as well (review 2481, blocking 1)', () => {
  test('RED→GREEN: a chat start without fleet.use is refused in a plain sentence, and nothing is sent or audited', async () => {
    const r = await rig({ mayChat: () => false });
    r.start(chat);
    expect(r.snapshot().error).toMatchObject({ code: 'fleet_not_granted' });
    expect(r.snapshot().error?.message).toContain('fleet');
    expect(r.closes.at(-1)).toEqual(STREAM_CLOSES.forbidden);
    await turn(r);
    expect(r.sent).toEqual([]);
    expect(r.audited).toEqual([]);
  });

  test('Talk to test needs only voice.use: it still works without fleet.use', async () => {
    const r = await rig({ mayChat: () => false });
    r.start(test_);
    await turn(r);
    expect(r.snapshot().last).toMatchObject({ turn: 1, outcome: 'heard' });
    expect(r.closes).toEqual([]);
  });

  test('RED→GREEN: a grant narrowed mid-stream refuses the NEXT turn; the one before it was sent and audited once', async () => {
    let granted = true;
    const r = await rig({ mayChat: () => granted });
    r.start(chat);
    await turn(r);
    expect(r.sent).toHaveLength(1);
    expect(r.audited).toEqual(['fer-1']);
    granted = false;
    await r.talk(2_500, { loud: true });
    await r.talk(3_000);
    expect(r.sent).toHaveLength(1);
    expect(r.audited).toEqual(['fer-1']);
    expect(r.snapshot().last).toMatchObject({ turn: 2, outcome: 'failed', code: 'fleet_not_granted' });
  });

  test('a send the mailbox refused leaves no audit record', async () => {
    const r = await rig({ send: async () => ({ ok: false, code: 'send_refused' }) });
    r.start(chat);
    await turn(r);
    expect(r.audited).toEqual([]);
  });
});

describe('the voice stream: a phone that is gone, or an End, during the final decode must not send (review 2481, c)', () => {
  test('RED→GREEN: End pressed while the final words are being decoded sends nothing', async () => {
    const gate = gatedFinal();
    const r = await rig({ engine: { transcribe: gate.transcribe } });
    r.start(chat);
    await r.talk(1_500);
    await r.talk(2_500, { loud: true });
    gate.hold();
    await r.talk(2_000); // the pause is heard; the final decode now waits
    await r.talk(1_000); // the phone still answers every unit while it waits
    await r.talk(40, { control: 'end' });
    gate.release();
    await settle();
    await r.talk(40);
    expect(r.sent).toEqual([]);
    expect(r.audited).toEqual([]);
  });

  test('RED→GREEN: a phone that answered during the decode but died before it ended is not proof; nothing is sent', async () => {
    const gate = gatedFinal();
    const r = await rig({ engine: { transcribe: gate.transcribe } });
    r.start(chat);
    await r.talk(1_500);
    await r.talk(2_500, { loud: true });
    gate.hold();
    await r.talk(3_000); // the pause is heard; still answering every unit while the decode waits
    gate.release();
    await settle();
    await r.talk(3_000, { dead: true });
    expect(r.sent).toEqual([]);
    expect(r.snapshot().last).toMatchObject({ outcome: 'cancelled', code: 'phone_silent' });
  });
});

describe('the voice stream: bounded memory and empty words (review 2481, d and b)', () => {
  test('RED→GREEN: audio piling up behind a stuck engine call is capped, not kept without bound', async () => {
    let calls = 0;
    const r = await rig({
      engine: {
        detectSpeech: async samples => {
          calls += 1;
          return calls === 1 ? [] : await new Promise<readonly VoiceSpan[]>(() => fakeSpans(samples));
        },
      },
    });
    r.start(test_);
    for (let at = 0; at < 140_000; at += 200) await r.talk(200, { loud: true });
    const held = (r.stream as unknown as { samples: SampleBuffer }).samples.length;
    expect(held).toBeLessThanOrEqual((120 + 5) * 16_000);
    expect(held).toBeGreaterThan(100 * 16_000);
  }, 60_000);

  test('RED→GREEN: a decode that is only punctuation is no words, and nothing is sent', async () => {
    const r = await rig({ engine: { transcribe: async () => ({ text: ' . ', decodeMs: 1, realTimeFactor: 0 }) } });
    r.start(chat);
    await turn(r);
    expect(r.sent).toEqual([]);
    expect(r.snapshot().last).toMatchObject({ outcome: 'dropped', code: 'no_words' });
  });
});

describe('the voice stream: one chat per FERRET, however it is named (review 2481, a)', () => {
  const names = async (reference: string): Promise<string | undefined> =>
    reference === 'joslin' || reference === 'fer-1' ? 'fer-1' : undefined;

  test('RED→GREEN: a callsign and the id are the same ferret: the second stream is voice_busy', async () => {
    const registry = new StreamRegistry();
    const first = await rig({ registry, resolveFerret: names });
    first.start({ ...chat, ferretId: 'fer-1' });
    await first.talk(400);
    const second = await rig({ registry, resolveFerret: names });
    second.start({ ...chat, ferretId: 'joslin' });
    await second.talk(200);
    expect(second.snapshot().error).toMatchObject({ code: 'voice_busy' });
    expect(second.closes.at(-1)).toEqual(STREAM_CLOSES.busy);
  });

  test('the message goes to the resolved id, and that id is what is audited', async () => {
    const r = await rig({ resolveFerret: names });
    r.start({ ...chat, ferretId: 'joslin' });
    await turn(r);
    expect(r.sent[0]).toMatchObject({ ferretId: 'fer-1' });
    expect(r.audited).toEqual(['fer-1']);
  });

  test('a name no single ferret goes by is refused out loud', async () => {
    const r = await rig({ resolveFerret: names });
    r.start({ ...chat, ferretId: 'nobody' });
    await settle();
    expect(r.snapshot().error).toMatchObject({ code: 'ferret_unknown' });
    expect(r.closes).toHaveLength(1);
  });

  test('a resolver that fails is a name no single ferret goes by', async () => {
    const r = await rig({
      resolveFerret: async () => {
        throw new Error('ferrets are not answering');
      },
    });
    r.start(chat);
    await settle();
    expect(r.snapshot().error).toMatchObject({ code: 'ferret_unknown' });
  });

  test('a stream that ended while the name was being resolved does not keep the ferret', async () => {
    const registry = new StreamRegistry();
    let answer: (id: string) => void = () => undefined;
    const slow = await rig({
      registry,
      resolveFerret: () => new Promise<string>(resolve => (answer = resolve)),
    });
    slow.start(chat);
    slow.stream.close();
    answer('fer-1');
    await settle();
    expect(registry.claimFerret('fer-1')).toBeDefined();
  });
});

describe('the voice stream: the final decode starts in the pause, not at its end (voice latency)', () => {
  test('RED→GREEN: the turn is decoded 0.3 s after the last word, and the send at the pause reuses that decode', async () => {
    const r = await rig();
    r.start(chat);
    await r.talk(1_500);
    await r.talk(2_500, { loud: true });
    await r.talk(600); // 0.6 s of silence: well before the 1.5 s pause
    const early = r.transcribed.length;
    expect(r.snapshots().some(item => item.words !== undefined && !item.words.final)).toBe(true);
    expect(r.sent).toEqual([]);
    await r.talk(3_000);
    expect(r.transcribed).toHaveLength(early); // the pause decoded nothing more
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ sendId: 'abc123:1' });
    expect(r.snapshot().last).toEqual({ turn: 1, outcome: 'sent', sendId: 'abc123:1' });
  });

  test('RED→GREEN: voice that comes back after 0.6 s outdates the early decode; the whole turn is decoded and sent once', async () => {
    const r = await rig();
    r.start(chat);
    await r.talk(1_500);
    await r.talk(1_500, { loud: true });
    await r.talk(600); // an early decode of 1.5 s of speech starts…
    await r.talk(2_500, { loud: true }); // …and the person goes on
    await r.talk(3_000);
    expect(r.sent).toHaveLength(1);
    const words = (r.sent[0]?.message ?? '').split(' ').length - 1; // "(voice)" is not a word
    expect(words).toBeGreaterThan(3); // the 1.5 s early decode says 3 words; the whole turn (4 s) says 8
  });

  test('an early decode is not proof of the phone: a phone that died at the pause still sends nothing', async () => {
    const r = await rig();
    r.start(chat);
    await r.talk(1_500);
    await r.talk(2_500, { loud: true });
    await r.talk(600);
    await r.talk(3_000, { dead: true });
    expect(r.sent).toEqual([]);
    expect(r.snapshot().last).toMatchObject({ outcome: 'cancelled', code: 'phone_silent' });
  });

  test('a turn longer than the interim limit is still decoded once, at the pause', async () => {
    const r = await rig();
    r.start(chat);
    await r.talk(1_500);
    await r.talk(7_000, { loud: true });
    const before = r.transcribed.length;
    await r.talk(3_000);
    expect(r.transcribed).toHaveLength(before + 1);
    expect(r.sent).toHaveLength(1);
  });
});
