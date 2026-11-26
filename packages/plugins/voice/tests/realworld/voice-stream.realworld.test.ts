// Realworld: downloads the real 700 MB speech models (public files, hash-checked) and speaks a real clip through the stream.
import type { SpeechThread } from '../../daemon/lib/engine/ports.ts';
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import { bunWorkers } from '../../../../core/kernel/host/adapters/process.ts';
import { UNIT_SAMPLES, decodeDownlinkUnit, encodeUplinkUnit, type StreamSnapshot } from '../../contract/index.ts';
import { startSpeechThread } from '../../daemon/adapters/worker-speech-thread.ts';
import { SpeechEngine } from '../../daemon/lib/engine/engine.ts';
import { VoiceStream } from '../../daemon/lib/stream/session.ts';
import { DiskFiles, nativeFor, nativeHost } from './disk-files.ts';

/**
 * The red/green proof of the voice stream with the REAL engine: a real clip is streamed in real time, in 40 ms units, the
 * way a phone sends it, and the machine's own Parakeet and Silero turn it into words. Nothing is faked but the phone
 * (this test) and the ferret (a function that records what it was sent).
 *
 * It downloads the pinned model files from Hugging Face and jsDelivr into memory (about 700 MB, public, SHA-256 checked),
 * so it runs only when asked: `FY_VOICE_STREAM_REAL=1`.
 */
const ASKED = process.env.FY_VOICE_STREAM_REAL === '1';
const CLIP = join(import.meta.dir, 'dev/speed-bench/clip-5s.wav');

function pcmOf(wav: Uint8Array): Int16Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const at = Buffer.from(wav).indexOf('data') + 8;
  return Int16Array.from({ length: (wav.byteLength - at) >> 1 }, (_, index) => view.getInt16(at + index * 2, true));
}

const realClock = {
  nowMs: () => performance.now(),
  every: (interval: number, fn: () => void) => {
    const timer = setInterval(fn, interval);
    return () => clearInterval(timer);
  },
  after: (delay: number, fn: () => void) => {
    const timer = setTimeout(fn, delay);
    return () => clearTimeout(timer);
  },
};

describe.skipIf(!ASKED)('the voice stream with the real speech engine', () => {
  test('a real clip streamed in real time: live words, then the final words, then ONE send at the pause', async () => {
    const engine = new SpeechEngine({
      http: { request: async url => await fetch(url, { redirect: 'manual' }) },
      files: new DiskFiles(process.env.FY_VOICE_ENGINE_DIR ?? '/tmp/claude-1000/vc-native-bench/real/speech'),
      native: nativeFor(process.env.FY_STT_ENGINE),
      clock: { after: (delay, fn) => realClock.after(delay as number, fn) },
      machine: () => 'this box',
      start: kind =>
        kind === 'native'
          ? (nativeHost('speech') as SpeechThread)
          : startSpeechThread(bunWorkers(), { after: (delay, fn) => realClock.after(delay as number, fn) }),
      availableMemory: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
    });
    try {
      await engine.install();
      await engine.settled();
      expect((await engine.view()).state).toBe('ready');

      const frames: { at: number; snapshot: StreamSnapshot }[] = [];
      const sent: { at: number; message: string; sendId: string }[] = [];
      const claimed = new Set<string>();
      const downstream: SocketDownstream = {
        send: frame => {
          frames.push({ at: performance.now(), snapshot: decodeDownlinkUnit(frame as Uint8Array) });
          return (frame as Uint8Array).byteLength;
        },
        close: () => undefined,
        bufferedBytes: () => 0,
      };
      const stream = new VoiceStream({
        engine,
        clock: realClock as never,
        downstream,
        streamId: 'real',
        nonce: () =>
          Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join(''),
        send: async (_ferret, message, sendId) => {
          sent.push({ at: performance.now(), message, sendId });
          return { ok: true };
        },
        mayChat: () => true,
        resolveFerret: async reference => reference,
        recordSent: () => undefined,
        claimFerret: () => () => undefined,
        entry: {
          enter: ferret => !claimed.has(ferret) && !!claimed.add(ferret),
          leave: ferret => void claimed.delete(ferret),
        },
        onEnd: () => undefined,
        log: { info: () => undefined },
      });
      await stream.open();
      stream.fromClient(
        JSON.stringify({ t: 'start', v: 1, purpose: 'chat', ferretId: 'real-ferret', session: 'vm-real-session' }),
      );

      const clip = pcmOf(new Uint8Array(await readFile(CLIP)));
      const lead = 2 * 16_000;
      const tail = 4 * 16_000;
      const total = lead + clip.length + tail;
      const begun = performance.now();
      let speechEndedAt = 0;
      for (let at = 0; at < total; at += UNIT_SAMPLES) {
        const pcm = new Int16Array(UNIT_SAMPLES);
        for (let index = 0; index < UNIT_SAMPLES; index += 1) pcm[index] = clip[at - lead + index] ?? 0;
        if (at - lead + UNIT_SAMPLES >= clip.length && speechEndedAt === 0) speechEndedAt = performance.now();
        const echo = frames.at(-1)?.snapshot.nonce;
        stream.fromClient(
          encodeUplinkUnit({
            pcm: at < lead || at - lead >= clip.length ? new Int16Array(UNIT_SAMPLES) : pcm,
            control: 'none',
            echo,
          }),
        );
        const due = begun + ((at + UNIT_SAMPLES) / 16_000) * 1000;
        await Bun.sleep(Math.max(0, due - performance.now()));
      }
      await Bun.sleep(3_000);

      const interim = frames.filter(item => item.snapshot.words !== undefined && !item.snapshot.words.final);
      const final = frames.find(item => item.snapshot.words?.final === true);
      console.log('first interim words after speech began (ms)', Math.round((interim[0]?.at ?? 0) - begun - 2_000));
      console.log('speech ended → final words (ms)', Math.round((final?.at ?? 0) - speechEndedAt));
      // Two different sends reach the ferret: the entry message (once, as voice mode begins) and the utterance. Each is
      // asserted on its own, and the utterance is timed by its own id so the entry can never be mistaken for it.
      const entry = sent.filter(item => item.message.startsWith('(voice mode on)'));
      const utterance = sent.filter(item => item.sendId === 'real:1');
      console.log('speech ended → utterance sent (ms)', Math.round((utterance[0]?.at ?? 0) - speechEndedAt));
      console.log(
        'sent',
        sent.map(item => ({ sendId: item.sendId, message: item.message })),
      );
      expect(interim.length).toBeGreaterThan(0);
      expect(entry).toHaveLength(1);
      expect(entry[0]?.sendId).toBe('voice-on:vm-real-session');
      expect(entry[0]?.at ?? Number.POSITIVE_INFINITY).toBeLessThan(utterance[0]?.at ?? 0);
      expect(utterance).toHaveLength(1);
      expect(sent).toHaveLength(2);
      expect((utterance[0]?.message ?? '').toLowerCase().replace(/[^a-z ]/gu, '')).toBe(
        'voice please fix the login redirect and run the tests again',
      );
      expect(frames.at(-1)?.snapshot.last).toMatchObject({ turn: 1, outcome: 'sent' });
      for (const item of frames) expect(item.snapshot.error).toBeUndefined();
    } finally {
      await engine.unload();
    }
  }, 900_000);
});
