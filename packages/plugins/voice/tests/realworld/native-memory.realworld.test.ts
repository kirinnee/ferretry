// Realworld: loads the real native library and models (already installed by the other realworld tests) and counts memory.
import type { ReplyThread, SpeechThread } from '../../daemon/lib/engine/ports.ts';
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bunWorkers } from '../../../../core/kernel/host/adapters/process.ts';
import { startReplyThread, startSpeechThread } from '../../daemon/adapters/worker-speech-thread.ts';
import { SpeechEngine } from '../../daemon/lib/engine/engine.ts';
import { ReplyVoiceEngine } from '../../daemon/lib/reply/engine.ts';
import { DiskFiles, liveHosts, nativeFor, nativeHost } from './disk-files.ts';

/**
 * THE MEMORY GUARANTEE OF AN UNLOAD, with the real native engine. A worker thread that is only terminated keeps the native
 * models it loaded (Bun frees a native handle in a finalizer that runs on a later turn of the loop, and a terminated worker
 * has no later turn): each load and unload added 0.5–0.7 GB to the daemon until `unload` asked the worker to let go first.
 * This loads and unloads each engine three times and asserts the process does not grow with the count.
 *
 * It needs the installed files, so it runs only when asked: FY_NATIVE_MEMORY_REAL=1, with FY_REPLY_VOICE_DIR and
 * FY_VOICE_ENGINE_DIR naming the folders `reply-voice.realworld.test.ts` and `voice-stream.realworld.test.ts` kept.
 */
const ASKED = process.env.FY_NATIVE_MEMORY_REAL === '1';
const CLIP = join(import.meta.dir, 'dev/speed-bench/clip-5s.wav');
/**
 * The process's memory a moment after an unload. Bun runs a native handle's finalizer on the main thread's loop, a few turns
 * after the worker that held it ended, so the memory is read after a short wait and a collection (an idle unload is not
 * waited on by anyone; what matters is that it comes back and does not pile up).
 */
async function settledMb(): Promise<number> {
  for (let turn = 0; turn < 4; turn += 1) {
    Bun.gc(true);
    await Bun.sleep(300);
  }
  return Math.round(process.memoryUsage().rss / 1_048_576);
}
const quiet = (): undefined => undefined;
const clock = { after: () => () => undefined };
/** What a cycle may keep beyond the first (allocator arenas and the libraries stay mapped), where a leak was 500–700 MB each. */
const SLACK_MB = 150;

describe.skipIf(!ASKED)('the native engines give their memory back on unload', () => {
  test('the reply voice: three load/unload cycles keep the process flat', async () => {
    const native = nativeFor('native');
    expect(native.target).toBeDefined();
    const engine = new ReplyVoiceEngine({
      http: { request: async () => new Response('no', { status: 404 }) },
      files: new DiskFiles(process.env.FY_REPLY_VOICE_DIR ?? ''),
      clock,
      machine: () => 'this box',
      start: kind => (kind === 'native' ? (nativeHost('reply') as ReplyThread) : startReplyThread(bunWorkers())),
      availableMemory: () => undefined,
      log: { info: quiet, warn: quiet },
      native,
    });
    expect((await engine.view()).runtime?.kind).toBe('native');
    const after: number[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await engine.speak('I found the bug, it was a missing await.');
      await engine.unload();
      // The host is a child process: unloading ends it, and nothing of it is left behind.
      await Bun.sleep(300);
      expect(liveHosts()).toEqual([]);
      after.push(await settledMb());
    }
    console.log('reply voice: process MB after each unload', after);
    expect((after[2] ?? 0) - (after[0] ?? 0)).toBeLessThan(SLACK_MB);
  }, 300_000);

  test('the speech engine: three load/unload cycles keep the process flat', async () => {
    const native = nativeFor('native');
    const engine = new SpeechEngine({
      http: { request: async () => new Response('no', { status: 404 }) },
      files: new DiskFiles(process.env.FY_VOICE_ENGINE_DIR ?? ''),
      clock,
      machine: () => 'this box',
      start: kind => (kind === 'native' ? (nativeHost('speech') as SpeechThread) : startSpeechThread(bunWorkers())),
      availableMemory: () => undefined,
      log: { info: quiet, warn: quiet },
      native,
    });
    expect((await engine.view()).runtime?.kind).toBe('native');
    const wav = new Uint8Array(await readFile(CLIP));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const at = Buffer.from(wav).indexOf('data') + 8;
    const clip = Float32Array.from(
      { length: (wav.byteLength - at) >> 1 },
      (_, index) => view.getInt16(at + index * 2, true) / 32768,
    );
    const after: number[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect((await engine.transcribe(clip)).text.toLowerCase()).toContain('login redirect');
      await engine.unload();
      // The host is a child process: unloading ends it, and nothing of it is left behind.
      await Bun.sleep(300);
      expect(liveHosts()).toEqual([]);
      after.push(await settledMb());
    }
    console.log('speech engine: process MB after each unload', after);
    expect((after[2] ?? 0) - (after[0] ?? 0)).toBeLessThan(SLACK_MB);
  }, 300_000);
});
