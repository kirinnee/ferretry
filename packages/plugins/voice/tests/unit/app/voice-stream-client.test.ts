import { describe, expect, test } from 'bun:test';
import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import {
  DOWNLINK_UNIT_BYTES,
  STREAM_CLOSES,
  type StreamSnapshot,
  UNIT_SAMPLES,
  UPLINK_UNIT_BYTES,
  decodeUplinkUnit,
  encodeDownlinkUnit,
} from '../../../contract/index.ts';
import { resampler } from '../../../app/lib/stream/mic-source.ts';
import { type MicSource, openVoiceStream, VOICE_STREAM_ROUTE } from '../../../app/lib/stream/voice-stream.ts';

const NONCE = 'aaaaaaaaaaaaaaaa';
const unit = (patch: Partial<StreamSnapshot> = {}): Uint8Array =>
  encodeDownlinkUnit({ v: 1, state: 'listening', nonce: NONCE, turn: 0, ...patch });

function rig() {
  const sent: (string | Uint8Array)[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  let listeners!: PluginSocketListeners;
  let micOn: ((pcm: Int16Array) => void) | undefined;
  let micFails = false;
  let micStopped = 0;
  let broken = false;
  const socket: PluginSocket = {
    send: frame => {
      if (broken) throw new Error('the socket is gone');
      sent.push(frame);
    },
    close: (code, reason) =>
      void closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }),
  };
  const client = {
    socket: (route: string, _params: unknown, given: PluginSocketListeners) => {
      expect(route).toBe(VOICE_STREAM_ROUTE);
      listeners = given;
      return socket;
    },
  };
  const mic: MicSource = {
    start: async onUnit => {
      if (micFails) throw new Error('denied');
      micOn = onUnit;
    },
    stop: () => {
      micStopped += 1;
    },
  };
  const events = {
    snapshots: [] as StreamSnapshot[],
    words: [] as { turn: number; text: string; final: boolean }[],
    ended: [] as { code: number | undefined; reason: string; sentence?: string }[],
    micFailed: 0,
  };
  const handle = openVoiceStream(client, { t: 'start', v: 1, purpose: 'test' }, mic, {
    onSnapshot: snapshot => void events.snapshots.push(snapshot),
    onWords: words => void events.words.push(words),
    onEnded: ended => void events.ended.push(ended),
    onMicFailed: () => {
      events.micFailed += 1;
    },
  });
  return {
    sent,
    closes,
    events,
    handle,
    listeners: () => listeners,
    breakSend: () => {
      broken = true;
    },
    failMic: () => {
      micFails = true;
    },
    pcm: (value: number) => micOn?.(new Int16Array(UNIT_SAMPLES).fill(value)),
    micStopped: () => micStopped,
  };
}

describe('the browser end of the voice stream', () => {
  test('nothing is sent until the machine accepts; then the start record comes first and audio follows in whole units', async () => {
    const r = rig();
    expect(r.sent).toEqual([]);
    r.listeners().onOpen?.();
    await Promise.resolve();
    expect(JSON.parse(r.sent[0] as string)).toEqual({ t: 'start', v: 1, purpose: 'test' });
    r.pcm(100);
    const audio = r.sent[1] as Uint8Array;
    expect(audio.byteLength).toBe(UPLINK_UNIT_BYTES);
    expect(decodeUplinkUnit(audio).pcm[0]).toBe(100);
  });

  test('every unit echoes the newest nonce the machine has sent', async () => {
    const r = rig();
    r.listeners().onOpen?.();
    await Promise.resolve();
    r.pcm(1);
    expect(decodeUplinkUnit(r.sent[1] as Uint8Array).echo).toBeUndefined();
    r.listeners().onFrame(unit());
    r.pcm(1);
    expect(decodeUplinkUnit(r.sent[2] as Uint8Array).echo).toBe(NONCE);
    r.listeners().onFrame(unit({ nonce: 'bbbbbbbbbbbbbbbb' }));
    r.pcm(1);
    expect(decodeUplinkUnit(r.sent[3] as Uint8Array).echo).toBe('bbbbbbbbbbbbbbbb');
  });

  test('units are cut from whatever chunks arrive, and the words are rebuilt from their fragments', () => {
    const r = rig();
    const first = unit({
      state: 'hearing',
      turn: 1,
      words: { turn: 1, rev: 0, offset: 0, total: 11, text: 'hello ', final: false },
    });
    const second = unit({
      state: 'hearing',
      turn: 1,
      words: { turn: 1, rev: 0, offset: 6, total: 11, text: 'world', final: false },
    });
    const joined = new Uint8Array(DOWNLINK_UNIT_BYTES * 2);
    joined.set(first, 0);
    joined.set(second, DOWNLINK_UNIT_BYTES);
    r.listeners().onFrame(joined.slice(0, 300));
    r.listeners().onFrame(joined.slice(300));
    expect(r.events.snapshots).toHaveLength(2);
    expect(r.events.words).toEqual([{ turn: 1, text: 'hello world', final: false }]);
  });

  test('a unit that does not parse closes the stream with a protocol error', () => {
    const r = rig();
    r.listeners().onFrame(new Uint8Array(DOWNLINK_UNIT_BYTES)); // length 0
    expect(r.closes.at(-1)).toEqual({ code: STREAM_CLOSES.protocol.code, reason: STREAM_CLOSES.protocol.reason });
    expect(r.events.ended.at(-1)?.code).toBe(STREAM_CLOSES.protocol.code);
    expect(r.micStopped()).toBe(1);
  });

  test('Stop tells the machine ("end"), closes, stops the microphone, and ends once', async () => {
    const r = rig();
    r.listeners().onOpen?.();
    await Promise.resolve();
    r.handle.stop();
    r.handle.stop();
    expect(decodeUplinkUnit(r.sent.at(-1) as Uint8Array).control).toBe('end');
    expect(r.closes).toEqual([{ code: 1000, reason: STREAM_CLOSES.ended.reason }]);
    expect(r.events.ended).toHaveLength(1);
    expect(r.micStopped()).toBe(1);
  });

  test("the machine's own refusal sentence reaches the person", () => {
    const r = rig();
    r.listeners().onFrame(
      unit({
        error: {
          code: 'voice_no_memory',
          message: 'This machine does not have enough free memory to load speech right now.',
        },
      }),
    );
    r.listeners().onClose('speech failed on the machine', 1011);
    expect(r.events.ended.at(-1)).toMatchObject({ code: 1011, sentence: expect.stringContaining('free memory') });
  });

  test('a microphone that is refused ends the stream and says so', async () => {
    const r = rig();
    r.failMic();
    r.listeners().onOpen?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(r.events.micFailed).toBe(1);
    expect(r.events.ended).toHaveLength(1);
  });

  test('Stop still closes when the socket was already gone', async () => {
    const r = rig();
    r.listeners().onOpen?.();
    await Promise.resolve();
    r.breakSend();
    r.handle.stop();
    expect(r.closes).toHaveLength(1);
    expect(r.events.ended).toHaveLength(1);
  });

  test('mute rides one unit and the audio after it is plain again', async () => {
    const r = rig();
    r.listeners().onOpen?.();
    await Promise.resolve();
    r.handle.setMuted(true);
    r.pcm(0);
    r.pcm(0);
    expect(decodeUplinkUnit(r.sent[1] as Uint8Array).control).toBe('muted');
    expect(decodeUplinkUnit(r.sent[2] as Uint8Array).control).toBe('none');
  });

  test('muted time uploads zero samples, and audio returns on unmute', async () => {
    const r = rig();
    r.listeners().onOpen?.();
    await Promise.resolve();
    r.handle.setMuted(true);
    r.pcm(500);
    r.pcm(500);
    for (const index of [1, 2]) {
      const pcm = decodeUplinkUnit(r.sent[index] as Uint8Array).pcm;
      expect(pcm.every(sample => sample === 0)).toBe(true);
    }
    r.handle.setMuted(false);
    r.pcm(500);
    expect(decodeUplinkUnit(r.sent[3] as Uint8Array).pcm[0]).toBe(500);
  });
});

describe('the 16 kHz resampler', () => {
  test('a source already at 16 kHz is passed through', () => {
    const block = Float32Array.from([0.1, 0.2]);
    expect(resampler(16_000, 16_000)(block)).toBe(block);
  });

  test('48 kHz becomes a third as many samples, and a ramp stays a ramp across blocks', () => {
    const next = resampler(48_000, 16_000);
    const ramp = (from: number, count: number) =>
      Float32Array.from({ length: count }, (_, index) => (from + index) / 1000);
    const out = [...next(ramp(0, 300)), ...next(ramp(300, 300))];
    expect(out.length).toBeGreaterThanOrEqual(198);
    expect(out.length).toBeLessThanOrEqual(200);
    for (let index = 1; index < out.length; index += 1)
      expect((out[index] ?? 0) - (out[index - 1] ?? 0)).toBeCloseTo(0.003, 6);
  });
});
