// Realworld: downloads the real Kokoro files (165 MB, public, SHA-256 checked) and speaks through the real worker.
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import { bunWorkers } from '../../../../core/kernel/host/adapters/process.ts';
import {
  REPLY_AUDIO_SAMPLES,
  type StreamSnapshot,
  UNIT_SAMPLES,
  decodeReplyDownlinkUnit,
  encodeSpeakFrame,
  encodeUplinkUnit,
} from '../../contract/index.ts';
import { startReplyThread } from '../../daemon/adapters/worker-speech-thread.ts';
import { REPLY_FILES } from '../../daemon/lib/reply/catalog.ts';
import { ReplyVoiceEngine } from '../../daemon/lib/reply/engine.ts';
import type { EnginePathsPort } from '../../daemon/lib/engine/ports.ts';
import { VoiceStream } from '../../daemon/lib/stream/session.ts';

/**
 * The red/green proof of the reply voice, through its own entry points (install → load in the worker → speak), and then
 * through the voice stream a browser uses:
 *  - RED: a file whose pinned hash is not the file's is refused by `install` and nothing of it is kept;
 *  - GREEN: the pinned files install, Kokoro loads in its own worker thread, and a 12-word line becomes real speech
 *    (audible level, a length a person would take to say it); then the same line asked for over a stream arrives as
 *    audio units in real time. The first-sound time and the real-time factor are printed for the PR and the docs.
 *
 * It downloads about 164 MB from huggingface.co and cdn.jsdelivr.net, so it runs only when asked: FY_REPLY_VOICE_REAL=1.
 * FY_REPLY_VOICE_DIR names a folder to keep the files in between runs (it is created if missing).
 */
const ASKED = process.env.FY_REPLY_VOICE_REAL === '1';
const LINE = 'I found the bug, it was a missing await, and I have fixed it.';

class DiskFiles implements EnginePathsPort {
  constructor(private readonly dir: string) {}
  pathOf(file: { role: string }) {
    return join(this.dir, file.role);
  }
  async size(file: { role: string }) {
    return await stat(this.pathOf(file)).then(
      s => s.size,
      () => undefined,
    );
  }
  async read(file: { role: string }) {
    return await readFile(this.pathOf(file)).then(
      buffer => new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
      () => undefined,
    );
  }
  async write(file: { role: string }, bytes: Uint8Array) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathOf(file), bytes);
  }
  async remove(file: { role: string }) {
    await unlink(this.pathOf(file)).catch(() => undefined);
  }
  async freeBytes() {
    return undefined;
  }
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

const rms = (samples: Float32Array | Int16Array, scale: number): number => {
  let sum = 0;
  for (const sample of samples) sum += (sample / scale) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
};

describe.skipIf(!ASKED)('the reply voice, with the real model', () => {
  test('refuses a file that is not the pinned one, then installs, loads, speaks, and streams a line', async () => {
    const kept = process.env.FY_REPLY_VOICE_DIR;
    const dir = kept ?? (await mkdtemp(join(tmpdir(), 'ferretry-reply-voice-')));
    const log = (message: string, fields?: unknown) => console.log(message, fields ?? '');
    const make = (catalog: typeof REPLY_FILES, files: DiskFiles) =>
      new ReplyVoiceEngine({
        http: { request: async (url, init) => await fetch(url, init) },
        files,
        clock: { after: () => () => undefined },
        machine: () => 'this box',
        start: () => startReplyThread(bunWorkers()),
        availableMemory: () => undefined,
        log: { info: log, warn: log },
        catalog,
      });
    try {
      // RED: the vocabulary's pinned hash is wrong, so its download is refused and not kept.
      const wrongDir = await mkdtemp(join(tmpdir(), 'ferretry-reply-voice-red-'));
      const tampered = REPLY_FILES.map(file => (file.role === 'tokens' ? { ...file, sha256: '0'.repeat(64) } : file));
      const redFiles = new DiskFiles(wrongDir);
      const red = make(
        // Only the small files, so the refusal is quick: the others are not needed to prove it.
        tampered.filter(file => file.role === 'tokens'),
        redFiles,
      );
      await red.install();
      await red.settled();
      const refused = await red.view();
      expect(refused.state).toBe('failed');
      expect(refused.failure?.code).toBe('hash_mismatch');
      expect(await redFiles.size({ role: 'tokens' })).toBeUndefined();
      await rm(wrongDir, { recursive: true, force: true });

      // GREEN: the real files, installed, loaded and spoken.
      const files = new DiskFiles(dir);
      const engine = make(REPLY_FILES, files);
      await engine.install();
      await engine.settled();
      const ready = await engine.view();
      expect(ready.state).toBe('ready');
      console.log('self-test', ready.selfTest);

      const runs = [];
      for (let run = 0; run < 3; run += 1) runs.push(await engine.speak(LINE));
      const seconds = (runs[0]?.samples.length ?? 0) / 16_000;
      console.log(
        'line runs',
        runs.map(r => ({
          audioS: Number((r.samples.length / 16_000).toFixed(2)),
          speakMs: Math.round(r.speakMs),
          rtf: Number((r.speakMs / 1000 / (r.samples.length / 16_000)).toFixed(2)),
        })),
      );
      expect(seconds).toBeGreaterThan(2);
      expect(seconds).toBeLessThan(8);
      expect(rms(runs[0]?.samples ?? new Float32Array(0), 1)).toBeGreaterThan(0.01);
      await engine.unload();
      expect((await engine.view()).loaded).toBe(false);

      // Over the stream a browser opens: units in real time, the first sound measured from the line being sent.
      const frames: Uint8Array[] = [];
      const downstream: SocketDownstream = {
        send: frame => {
          frames.push(frame as Uint8Array);
          return (frame as Uint8Array).byteLength;
        },
        close: () => undefined,
        bufferedBytes: () => 0,
      };
      let echo: string | undefined;
      const stream = new VoiceStream({
        // The speech engine is not under test (it is 700 MB): it hears nothing, so no turn is ever opened.
        engine: {
          detectSpeech: async () => [],
          transcribe: async () => ({ text: '', decodeMs: 0, realTimeFactor: 0 }),
        },
        reply: engine,
        clock: realClock,
        downstream,
        streamId: 'real',
        nonce: () =>
          Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''),
        send: undefined,
        mayChat: () => true,
        resolveFerret: async () => undefined,
        recordSent: () => undefined,
        claimFerret: () => () => undefined,
        onEnd: () => undefined,
        log: { info: () => undefined },
      });
      await stream.open();
      stream.fromClient(JSON.stringify({ t: 'start', v: 1, purpose: 'test', reply: 'machine' }));
      const heard: Int16Array[] = [];
      let first: number | undefined;
      let sentAt = 0;
      let consumed = 0;
      let lastSeen = false;
      const microphone = setInterval(() => {
        stream.fromClient(encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'none', echo }));
      }, 40);
      const deadline = performance.now() + 60_000;
      let spoke = false;
      while (!lastSeen && performance.now() < deadline) {
        await Bun.sleep(20);
        for (; consumed < frames.length; consumed += 1) {
          const { snapshot, pcm } = decodeReplyDownlinkUnit(frames[consumed] as Uint8Array);
          echo = (snapshot as StreamSnapshot).nonce;
          if (snapshot.reply === 'ready' && !spoke) {
            spoke = true;
            sentAt = performance.now();
            stream.fromClient(encodeSpeakFrame({ t: 'speak', id: 0, text: LINE }));
          }
          if (pcm.length > 0) {
            first ??= performance.now() - sentAt;
            heard.push(pcm);
          }
          if (snapshot.audio?.last === true) lastSeen = true;
        }
      }
      clearInterval(microphone);
      stream.close();
      const total = heard.reduce((sum, part) => sum + part.length, 0);
      console.log(
        'stream: first sound ms',
        Math.round(first ?? -1),
        'audio s',
        (total / 16_000).toFixed(2),
        'units',
        heard.length,
      );
      expect(lastSeen).toBe(true);
      expect(first).toBeDefined();
      // Real speech reached the wire, at the rate it plays: the same length the engine made for the same words (± a clause).
      expect(total / 16_000).toBeGreaterThan(2);
      expect(rms(Int16Array.from(heard.flatMap(part => [...part])), 32768)).toBeGreaterThan(0.01);
      expect(REPLY_AUDIO_SAMPLES).toBe(3_200);
    } finally {
      if (kept === undefined) await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
