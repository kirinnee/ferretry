import { describe, expect, test } from 'bun:test';
import type {
  AuthorizedOutcome,
  CredentialPlacement,
  OutboundHttpRequest,
  SecretName,
} from '@ferretry/core-vault/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import {
  DEFAULT_VOICE_CONFIG,
  type ReplyVoiceConfig,
  REPLY_AUDIO_SAMPLES,
  REPLY_DOWNLINK_UNIT_BYTES,
  type StreamSnapshot,
  UNIT_SAMPLES,
  decodeReplyDownlinkUnit,
  encodeSpeakFrame,
  encodeUplinkUnit,
} from '../../../contract/index.ts';
import {
  ElevenLabsReplyVoice,
  ElevenLabsSpeechError,
  type SpendPort,
  pcm16Samples,
} from '../../../daemon/lib/reply/elevenlabs.ts';
import { routeReplyVoice } from '../../../daemon/lib/reply/router.ts';
import { VoiceStream } from '../../../daemon/lib/stream/session.ts';

const VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const KEY_NAME = 'ELEVENLABS_API_KEY';

/** 16 kHz PCM16 little endian of the given sample values. */
const pcm = (...values: number[]): string => {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) view.setInt16(index * 2, value, true);
  return Buffer.from(bytes).toString('base64');
};
const answer = (audio: string): AuthorizedOutcome => ({
  kind: 'completion',
  payload: { audio_base64: audio, alignment: { characters: ['h'], character_start_times_seconds: [0] } },
});

interface Sent {
  readonly name: string;
  readonly hosts: readonly string[];
  readonly request: OutboundHttpRequest;
  readonly placement: CredentialPlacement | undefined;
}

class MemorySpend implements SpendPort {
  record: { day: string; chars: number } | undefined;
  async read() {
    return this.record;
  }
  async write(record: { day: string; chars: number }) {
    this.record = record;
  }
}

function build(
  options: {
    outcome?: (request: OutboundHttpRequest) => AuthorizedOutcome | Promise<AuthorizedOutcome>;
    keys?: readonly string[];
    listFails?: boolean;
    config?: Partial<ReplyVoiceConfig['elevenlabs']>;
    day?: () => string;
  } = {},
) {
  const sent: Sent[] = [];
  const logged: string[] = [];
  const spend = new MemorySpend();
  const config = { ...DEFAULT_VOICE_CONFIG.replyVoice, provider: 'elevenlabs' as const };
  const settings: ReplyVoiceConfig = {
    ...config,
    elevenlabs: { ...config.elevenlabs, voiceId: VOICE, ...options.config },
  };
  const voice = new ElevenLabsReplyVoice({
    authorizer: {
      send: async (name, hosts, request, placement) => {
        sent.push({ name, hosts, request, placement });
        return await (options.outcome?.(request) ?? answer(pcm(0, 16384, -16384, -32768)));
      },
    },
    secrets: {
      list: async () => {
        if (options.listFails) throw new Error('the store is unreadable');
        return (options.keys ?? [KEY_NAME]).map(name => ({
          name: name as SecretName,
          updatedAt: '2026-11-24T00:00:00.000Z' as never,
        }));
      },
    },
    spend,
    settings: () => settings,
    today: options.day ?? (() => '2026-11-24'),
    monotonicMs: (() => {
      let at = 0;
      return () => (at += 40);
    })(),
    log: { info: message => void logged.push(message) },
  });
  return { voice, sent, spend, logged };
}

const failure = async (voice: ElevenLabsReplyVoice, text = 'Hello there.'): Promise<ElevenLabsSpeechError> => {
  try {
    await voice.speak(text);
  } catch (error) {
    if (error instanceof ElevenLabsSpeechError) return error;
    throw error;
  }
  throw new Error('the line was spoken');
};

describe('ElevenLabs as the reply voice: one JSON call through the Vault’s holder', () => {
  test('a line is ONE POST to /with-timestamps asking for 16 kHz PCM, the key named (never held) with the xi-api-key placement', async () => {
    const { voice, sent } = build();
    const spoken = await voice.speak('Hello there.');
    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call?.name).toBe(KEY_NAME);
    expect(call?.hosts).toEqual(['api.elevenlabs.io']);
    expect(call?.placement).toEqual({ header: 'xi-api-key' });
    expect(call?.request.method).toBe('POST');
    expect(call?.request.url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=pcm_16000`,
    );
    expect(JSON.parse(call?.request.body ?? '')).toEqual({ text: 'Hello there.', model_id: 'eleven_flash_v2_5' });
    // The request carries no credential of its own: the holder places it.
    expect(JSON.stringify(call?.request)).not.toMatch(/xi-api-key|authorization|bearer/iu);
    // Decoded to the stream's own format: samples in [-1, 1].
    expect(Array.from(spoken.samples)).toEqual([0, 0.5, -0.5, -1]);
    expect(spoken.speakMs).toBeGreaterThan(0);
  });

  test('a voice id is put in the path only as a plain id, and the chosen model is the one sent', async () => {
    const { voice, sent } = build({ config: { model: 'eleven_multilingual_v2' } });
    await voice.speak('Hi.');
    expect(JSON.parse(sent[0]?.request.body ?? '').model_id).toBe('eleven_multilingual_v2');
    expect(sent[0]?.request.url).not.toContain('..');
  });

  test('PCM decoding: whole samples only', () => {
    expect(pcm16Samples(new Uint8Array(0))).toBeUndefined();
    expect(pcm16Samples(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(Array.from(pcm16Samples(new Uint8Array([0xff, 0x7f])) ?? [])).toEqual([32767 / 32768]);
  });

  test('a reply that is not JSON audio (the holder’s `unreadable`: raw audio, or an echoed key) makes no sound and says why, without the text', async () => {
    const { voice, logged } = build({ outcome: () => ({ kind: 'unreadable' }) });
    const error = await failure(voice, 'A secret sentence.');
    expect(error.code).toBe('unavailable');
    expect(error.message).not.toContain('secret sentence');
    expect(logged).toEqual(['voice.reply.elevenlabs.failed']);
  });

  test.each([
    [{ kind: 'completion', payload: {} }, 'malformed'],
    [{ kind: 'completion', payload: { audio_base64: '!!!not base64!!!' } }, 'malformed'],
    [{ kind: 'completion', payload: { audio_base64: Buffer.from([1, 2, 3]).toString('base64') } }, 'malformed'],
    [{ kind: 'secret_missing' }, 'not_set'],
    [{ kind: 'vault_damaged' }, 'vault_damaged'],
    [{ kind: 'status', status: 401 }, 'rejected'],
    [{ kind: 'status', status: 429 }, 'rate_limited'],
    [{ kind: 'status', status: 500 }, 'unavailable'],
    [{ kind: 'timeout' }, 'unavailable'],
    [{ kind: 'unreachable' }, 'unavailable'],
    [{ kind: 'oversized' }, 'unavailable'],
    [{ kind: 'refused' }, 'unavailable'],
  ] as const)('%j is a line not spoken, coded %s', async (outcome, code) => {
    const { voice } = build({ outcome: () => outcome as AuthorizedOutcome });
    expect((await failure(voice)).code).toBe(code);
  });
});

describe('the daily character cap', () => {
  test('characters are counted BEFORE the call, and a line that would pass the cap is not sent at all', async () => {
    const { voice, sent, spend } = build({ config: { dailyChars: 20 } });
    await voice.speak('Hello there.');
    expect(spend.record).toEqual({ day: '2026-11-24', chars: 12 });
    expect(await voice.usage()).toEqual({ day: '2026-11-24', usedChars: 12, dailyChars: 20 });
    expect((await failure(voice, 'Hello again, friend.')).code).toBe('cap');
    expect(sent).toHaveLength(1);
    expect(spend.record?.chars).toBe(12);
  });

  test('a call that definitely billed nothing (401, 429, any 4xx, no key) gives its characters back; one that may have billed keeps them', async () => {
    for (const [outcome, kept] of [
      [{ kind: 'status', status: 401 }, 0],
      [{ kind: 'status', status: 429 }, 0],
      [{ kind: 'status', status: 422 }, 0],
      [{ kind: 'secret_missing' }, 0],
      [{ kind: 'status', status: 503 }, 12],
      [{ kind: 'timeout' }, 12],
      [{ kind: 'unreachable' }, 12],
      [{ kind: 'unreadable' }, 12],
    ] as const) {
      const { voice, spend } = build({ outcome: () => outcome as AuthorizedOutcome });
      await failure(voice);
      expect(spend.record?.chars).toBe(kept);
    }
  });

  test('a new machine day starts from zero, and yesterday’s count is not today’s', async () => {
    let day = '2026-11-24';
    const { voice, spend } = build({ config: { dailyChars: 12 }, day: () => day });
    await voice.speak('Hello there.');
    expect((await failure(voice)).code).toBe('cap');
    day = '2026-11-25';
    await voice.speak('Hello there.');
    expect(spend.record).toEqual({ day: '2026-11-25', chars: 12 });
  });

  test('two lines asked together cannot both pass the same cap: they are made one after the other', async () => {
    const { voice, sent } = build({ config: { dailyChars: 12 } });
    const results = await Promise.allSettled([voice.speak('Hello there.'), voice.speak('Hello there.')]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(sent).toHaveLength(1);
  });

  test('characters are counted as characters, not UTF-16 units', async () => {
    const { voice, spend } = build();
    await voice.speak('Ça va 🙂');
    expect(spend.record?.chars).toBe(7);
  });
});

describe('ready, and the voices', () => {
  test('it can speak only with a key in the store AND a chosen voice; the key is looked up by name, never opened', async () => {
    expect(await build().voice.view()).toEqual({ state: 'ready' });
    expect(await build({ keys: [] }).voice.view()).toEqual({ state: 'absent' });
    expect(await build({ keys: ['GROQ_API_KEY'] }).voice.view()).toEqual({ state: 'absent' });
    expect(await build({ config: { voiceId: undefined } }).voice.view()).toEqual({ state: 'absent' });
    await expect(build({ keys: [] }).voice.warm()).rejects.toThrow('not set up');
  });

  test('the status says what is set and what is spent, and carries no text', async () => {
    const { voice } = build({ keys: [] });
    expect(await voice.status()).toEqual({
      usage: { day: '2026-11-24', usedChars: 0, dailyChars: 20_000 },
      keySet: false,
      voiceId: VOICE,
      model: 'eleven_flash_v2_5',
    });
  });

  test('the voices are one GET of the account’s list, kept only as id, name and kind; a row with an unusable id is left out', async () => {
    const { voice, sent } = build({
      outcome: () => ({
        kind: 'completion',
        payload: {
          voices: [
            { voice_id: VOICE, name: ' George ', category: 'premade', labels: { accent: 'british' }, preview_url: 'x' },
            { voice_id: '../../v1/user', name: 'Evil', category: 'cloned' },
            { voice_id: 'a'.repeat(20), name: 'Mine', category: null },
          ],
          has_more: false,
        },
      }),
    });
    const listed = await voice.voices();
    expect(listed).toEqual({
      voices: [
        { id: VOICE, name: 'George', category: 'premade' },
        { id: 'a'.repeat(20), name: 'Mine' },
      ],
    });
    expect(sent[0]?.request.method).toBe('GET');
    expect(sent[0]?.request.url).toStartWith('https://api.elevenlabs.io/v2/voices?');
    expect(sent[0]?.placement).toEqual({ header: 'xi-api-key' });
    expect(sent[0]?.request.body).toBeUndefined();
  });

  test('a secret store that cannot be read says the key is not set, and the voice is not ready', async () => {
    const { voice } = build({ listFails: true });
    expect(await voice.ready()).toBe(false);
    expect((await voice.status()).keySet).toBe(false);
  });

  test.each([
    [{ kind: 'secret_missing' }, 'not_set'],
    [{ kind: 'status', status: 401 }, 'rejected'],
    [{ kind: 'status', status: 429 }, 'rate_limited'],
    [{ kind: 'timeout' }, 'unavailable'],
    [{ kind: 'completion', payload: { nonsense: true } }, 'unavailable'],
  ] as const)('a failed list %j says %s with a fixed sentence and no voices', async (outcome, code) => {
    const { voice } = build({ outcome: () => outcome as AuthorizedOutcome });
    const listed = await voice.voices();
    expect(listed.voices).toEqual([]);
    expect(listed.failure?.code).toBe(code);
    expect(listed.failure?.sentence.length).toBeGreaterThan(10);
  });
});

describe('choosing the voice', () => {
  test('the choice in voice.yaml is read at each use, so a change is heard from the next line', async () => {
    let provider: 'kokoro' | 'elevenlabs' = 'kokoro';
    const calls: string[] = [];
    const speaker = (name: string) => ({
      view: async () => ({ state: 'ready' as const }),
      warm: async () => void calls.push(`${name}:warm`),
      speak: async (text: string) => {
        calls.push(`${name}:${text}`);
        return { samples: new Float32Array(1), speakMs: 1 };
      },
    });
    const routed = routeReplyVoice({
      provider: () => provider,
      kokoro: speaker('kokoro'),
      elevenlabs: speaker('elevenlabs'),
    });
    await routed.warm();
    await routed.speak('one');
    provider = 'elevenlabs';
    await routed.warm();
    await routed.speak('two');
    expect(calls).toEqual(['kokoro:warm', 'kokoro:one', 'elevenlabs:warm', 'elevenlabs:two']);
  });
});

const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

/** A real voice stream over the real ElevenLabs voice (fake holder): what a person hears and what the device is told. */
async function stream(options: Parameters<typeof build>[0]) {
  const world = build(options);
  const clock = fixedClock();
  const frames: Uint8Array[] = [];
  const downstream: SocketDownstream = {
    send: frame => {
      frames.push(frame as Uint8Array);
      return (frame as Uint8Array).byteLength;
    },
    close: () => undefined,
    bufferedBytes: () => 0,
  };
  let counter = 0;
  const live = new VoiceStream({
    engine: { detectSpeech: async () => [], transcribe: async () => ({ text: '', decodeMs: 0, realTimeFactor: 0 }) },
    reply: routeReplyVoice({
      provider: () => 'elevenlabs',
      kokoro: {
        view: async () => ({ state: 'absent' }),
        warm: async () => undefined,
        speak: async () => Promise.reject(new Error('Kokoro was used')),
      },
      elevenlabs: world.voice,
    }),
    clock,
    downstream,
    streamId: 's1',
    nonce: () => (counter++).toString(16).padStart(16, '0'),
    send: undefined,
    mayChat: () => true,
    resolveFerret: async reference => reference,
    recordSent: () => undefined,
    claimFerret: () => () => undefined,
    onEnd: () => undefined,
    log: { info: () => undefined },
  });
  await live.open();
  live.fromClient(JSON.stringify({ t: 'start', v: 1, purpose: 'test', reply: 'machine' }));
  const units = (): { snapshot: StreamSnapshot; pcm: Int16Array }[] =>
    frames.filter(frame => frame.byteLength === REPLY_DOWNLINK_UNIT_BYTES).map(frame => decodeReplyDownlinkUnit(frame));
  let echo: string | undefined;
  return {
    ...world,
    units,
    speak: (id: number, text: string) => live.fromClient(encodeSpeakFrame({ t: 'speak', id, text })),
    async run(ms: number) {
      for (let at = 0; at < ms; at += 40) {
        await clock.advance(40);
        const latest = units().at(-1);
        if (latest !== undefined) echo = latest.snapshot.nonce;
        live.fromClient(encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo }));
        if (at % 200 === 160) await settle();
      }
      await settle();
    },
  };
}

describe('through the voice stream', () => {
  test('a ready ElevenLabs voice is announced ready, and a line comes down as its own sound, ending with last', async () => {
    // 3 200 samples of 0.5: exactly one 200 ms slot.
    const level = pcm(...Array(REPLY_AUDIO_SAMPLES).fill(16384));
    const r = await stream({ outcome: () => answer(level) });
    await r.run(400);
    expect(r.units().at(-1)?.snapshot.reply).toBe('ready');
    r.speak(7, 'Let me check.');
    await r.run(1_000);
    const audio = r.units().filter(unit => unit.snapshot.audio !== undefined);
    expect(audio.map(unit => unit.snapshot.audio?.id)).toEqual([7]);
    expect(audio[0]?.snapshot.audio?.last).toBe(true);
    expect(audio[0]?.pcm[0]).toBe(16384);
    expect(r.sent).toHaveLength(1);
    expect(JSON.parse(r.sent[0]?.request.body ?? '').text).toBe('Let me check.');
  });

  test('with no key the stream says the voice is absent, so the device’s own voice reads, and nothing is sent', async () => {
    const r = await stream({ keys: [] });
    await r.run(400);
    expect(r.units().at(-1)?.snapshot.reply).toBe('absent');
    r.speak(1, 'Let me check.');
    await r.run(600);
    expect(r.sent).toHaveLength(0);
    const failed = r.units().find(unit => unit.snapshot.audio?.id === 1);
    expect(failed?.snapshot.audio?.failed).toBe('reply_voice_absent');
  });

  test('a line past the daily cap is told to the device as failed, so the device reads it, and ElevenLabs is never asked', async () => {
    const r = await stream({ config: { dailyChars: 5 } });
    await r.run(400);
    r.speak(2, 'Let me check the failing test.');
    await r.run(800);
    expect(r.sent).toHaveLength(0);
    const failed = r.units().find(unit => unit.snapshot.audio?.id === 2);
    expect(failed?.snapshot.audio).toMatchObject({ failed: 'reply_voice_failed', last: true });
  });
});
