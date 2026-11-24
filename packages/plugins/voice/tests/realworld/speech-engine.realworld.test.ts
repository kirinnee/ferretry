// Realworld: loads the real 650 MB Parakeet v3 model; its speed and memory depend on the machine, not the code.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bunWorkers } from '../../../../core/kernel/host/adapters/process.ts';
import { ENGINE_FILES } from '../../daemon/lib/engine/catalog.ts';
import { SpeechEngine } from '../../daemon/lib/engine/engine.ts';
import type { EnginePathsPort, HttpPort } from '../../daemon/lib/engine/ports.ts';
import { startSpeechThread } from '../../daemon/adapters/worker-speech-thread.ts';

/**
 * The red/green proof of the machine speech worker, through the engine's own entry (install → load → decode):
 *  - RED: a server that sends a tampered file is refused by `install`, and nothing of it is kept;
 *  - GREEN: the pinned files install, the models load in the worker thread, and `clip-5s.wav` (a synthetic voice
 *    saying one sentence) decodes to that sentence. Real-time factor and memory are printed for the PR.
 *
 * Needs the real files in a folder named by FY_VOICE_ENGINE_FILES (one file per pinned role, named by role); without
 * it the test says so and skips, because a 700 MB download is not a thing a test run does by itself. A local server
 * stands in for the internet: the shipped catalog's hashes and sizes are the ones checked.
 */
const FILES = process.env.FY_VOICE_ENGINE_FILES;
const CLIP = join(import.meta.dir, 'dev/speed-bench/clip-5s.wav');
const PORT = 7481;

function samplesOf(wav: Uint8Array): Float32Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const at = Buffer.from(wav).indexOf('data') + 8;
  const count = (wav.byteLength - at) >> 1;
  return Float32Array.from({ length: count }, (_, index) => view.getInt16(at + index * 2, true) / 32768);
}

class MemoryFiles implements EnginePathsPort {
  readonly held = new Map<string, Uint8Array>();
  pathOf(file: { role: string }) {
    return `/memory/${file.role}`;
  }
  async size(file: { role: string }) {
    return this.held.get(file.role)?.byteLength;
  }
  async read(file: { role: string }) {
    const bytes = this.held.get(file.role);
    return bytes === undefined ? undefined : bytes.slice();
  }
  async write(file: { role: string }, bytes: Uint8Array) {
    this.held.set(file.role, bytes);
  }
  async remove(file: { role: string }) {
    this.held.delete(file.role);
  }
  async freeBytes() {
    return undefined;
  }
}

describe.skipIf(FILES === undefined)('the machine speech engine, with the real models', () => {
  test('refuses a tampered file, then installs, loads and decodes the clip', async () => {
    let tamper = true;
    const server = Bun.serve({
      port: PORT,
      async fetch(request) {
        const role = new URL(request.url).pathname.slice(1);
        const bytes = new Uint8Array(await readFile(join(FILES as string, role)));
        if (tamper && role === 'tokens') bytes[0] = (bytes[0] ?? 0) ^ 1;
        return new Response(bytes);
      },
    });
    const local = ENGINE_FILES.map(file => ({ ...file, url: `http://127.0.0.1:${PORT}/${file.role}` }));
    const http: HttpPort = { request: async url => await fetch(url) };
    const files = new MemoryFiles();
    const engine = new SpeechEngine({
      http,
      files,
      clock: { after: () => () => undefined },
      machine: () => 'this box',
      start: () => startSpeechThread(bunWorkers()),
      availableMemory: () => undefined,
      log: {
        info: (message, fields) => console.log(message, fields ?? ''),
        warn: (message, fields) => console.log(message, fields ?? ''),
      },
      catalog: local,
    });
    try {
      await engine.install();
      await engine.settled();
      const refused = await engine.view();
      expect(refused.state).toBe('failed');
      expect(refused.failure?.code).toBe('hash_mismatch');
      expect(files.held.has('tokens')).toBe(false);

      tamper = false;
      await engine.install();
      await engine.settled();
      const ready = await engine.view();
      expect(ready.state).toBe('ready');
      console.log('self-test', ready.selfTest);

      const samples = samplesOf(new Uint8Array(await readFile(CLIP)));
      const runs = [];
      for (let run = 0; run < 3; run += 1) runs.push(await engine.transcribe(samples));
      console.log(
        'clip-5s runs',
        runs.map(r => ({ text: r.text, decodeMs: Math.round(r.decodeMs), rtf: Number(r.realTimeFactor.toFixed(3)) })),
      );
      expect(runs[0]?.text.toLowerCase().replace(/[^a-z ]/gu, '')).toBe(
        'please fix the login redirect and run the tests again',
      );

      const spans = await engine.detectSpeech(samples);
      console.log('voice spans', spans);
      expect(spans.length).toBeGreaterThan(0);
      expect(spans[0]?.start).toBeLessThan(16_000);

      await engine.unload();
      expect((await engine.view()).loaded).toBe(false);
    } finally {
      await engine.unload();
      server.stop(true);
    }
  }, 600_000);
});
