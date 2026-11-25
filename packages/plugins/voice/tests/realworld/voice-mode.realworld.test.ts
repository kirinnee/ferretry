// Realworld: downloads the real 700 MB speech models (public files, hash-checked) and talks to them from a real browser.
import type { SpeechThread } from '../../daemon/lib/engine/ports.ts';
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { sceneBuilder } from '@ferretry/app/testing/browser';
import { bunWorkers } from '../../../../core/kernel/host/adapters/process.ts';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import { startSpeechThread } from '../../daemon/adapters/worker-speech-thread.ts';
import { SpeechEngine } from '../../daemon/lib/engine/engine.ts';
import { decodeDownlinkUnit } from '../../contract/index.ts';
import { VoiceStream } from '../../daemon/lib/stream/session.ts';
import { DiskFiles, nativeFor, nativeHost } from './disk-files.ts';

/**
 * The red/green proof of voice mode (unit 5) with the real engine and a real browser: Chrome's fake microphone plays a
 * recorded clip ("please fix the login redirect and run the tests again") into the SHIPPED `browserMic`, the page's
 * `VoiceModeSlot` carries it over a WebSocket to the daemon's real `VoiceStream` and the real Parakeet + Silero, and the
 * panel shows the words. The ferret is a recorder: it is handed what the machine would send, so the proof is when it is sent
 * after the person stops (the pause → sent time) and that it is sent ONCE (false sends: none), with the nonce proof the
 * stream needs coming back from the page. A real ferret needs a harness login and spends a subscription turn; the send
 * recorder is the same function the daemon hands the stream.
 *
 * It downloads the pinned model files (about 700 MB, public, SHA-256 checked), so it runs only when asked:
 * `FY_VOICE_MODE_REAL=1`. Set `FY_VOICE_MODE_REAL_SHOTS_DIR` to keep a picture.
 */
const ASKED = process.env.FY_VOICE_MODE_REAL === '1';
const CLIP = join(import.meta.dir, 'dev/speed-bench/clip-5s.wav');
const shotsDir = process.env.FY_VOICE_MODE_REAL_SHOTS_DIR ?? '';

function pcmOf(wav: Uint8Array): Int16Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const at = Buffer.from(wav).indexOf('data') + 8;
  return Int16Array.from({ length: (wav.byteLength - at) >> 1 }, (_, index) => view.getInt16(at + index * 2, true));
}

/** A 16 kHz mono 16-bit WAV: `lead` seconds of silence, the clip, then `tail` seconds of silence (played once, no loop). */
function wavOf(clip: Int16Array, lead: number, tail: number): Uint8Array {
  const samples = 16_000 * lead + clip.length + 16_000 * tail;
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < clip.length; index += 1)
    view.setInt16(44 + (16_000 * lead + index) * 2, clip[index] ?? 0, true);
  return out;
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

describe.skipIf(!ASKED)('voice mode in a real browser with the real speech engine', () => {
  test('a recorded clip through the real microphone path: live words in the panel, ONE send at the pause, composer back on End', async () => {
    const engine = new SpeechEngine({
      http: { request: async url => await fetch(url, { redirect: 'manual' }) },
      files: new DiskFiles(process.env.FY_VOICE_ENGINE_DIR ?? '/tmp/claude-1000/vc-native-bench/real/speech'),
      native: nativeFor(process.env.FY_STT_ENGINE),
      clock: { after: (delay, fn) => realClock.after(delay as number, fn) },
      machine: () => 'this box',
      start: kind => (kind === 'native' ? (nativeHost('speech') as SpeechThread) : startSpeechThread(bunWorkers())),
      availableMemory: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
    });
    const work = await mkdtemp(join(tmpdir(), 'ferretry-voice-mode-real-'));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await engine.install();
      await engine.settled();
      expect((await engine.view()).state).toBe('ready');

      // The page.
      const built = Bun.spawn(
        [
          process.execPath,
          sceneBuilder,
          '--out',
          join(work, 'scene'),
          '--entry',
          '../integration/app/fixtures/voice-mode-real-scene.tsx',
        ],
        { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(built.stdout).text(),
        new Response(built.stderr).text(),
        built.exited,
      ]);
      if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
      const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
      const css = await readFile(manifest.css, 'utf8');
      const js = await readFile(manifest.js, 'utf8');

      // The machine: the daemon's real stream behind a WebSocket, and a ferret that only records what it is sent.
      const sent: { at: number; message: string; sendId: string }[] = [];
      const started: unknown[] = [];
      let firstAudioAt = 0;
      const outcomes: string[] = [];
      const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>window.__bridge=location.origin</script><script type="module" src="/app.js"></script></body></html>`;
      const streams = new Map<unknown, VoiceStream>();
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request, bun) => {
          const url = new URL(request.url);
          if (url.pathname === '/stream')
            return bun.upgrade(request, { data: {} }) ? undefined : new Response('no', { status: 400 });
          return url.pathname === '/app.js'
            ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
            : new Response(page, { headers: { 'content-type': 'text/html' } });
        },
        websocket: {
          open: async ws => {
            const downstream: SocketDownstream = {
              send: frame => {
                const seen = decodeDownlinkUnit(frame as Uint8Array);
                if (seen.last !== undefined || seen.error !== undefined || seen.words?.final === true)
                  outcomes.push(
                    JSON.stringify({
                      last: seen.last,
                      error: seen.error,
                      final: seen.words?.final,
                      off: seen.words?.offset,
                      total: seen.words?.total,
                      state: seen.state,
                    }),
                  );
                ws.send(frame as Uint8Array);
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
                Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join(
                  '',
                ),
              send: async (_ferret, message, sendId) => {
                sent.push({ at: performance.now(), message, sendId });
                return { ok: true };
              },
              mayChat: () => true,
              resolveFerret: async reference => reference,
              recordSent: () => undefined,
              claimFerret: () => () => undefined,
              onEnd: () => undefined,
              log: { info: () => undefined },
            });
            streams.set(ws, stream);
            await stream.open();
          },
          message: (ws, message) => {
            const stream = streams.get(ws);
            if (typeof message === 'string') {
              started.push(JSON.parse(message));
              stream?.fromClient(message);
            } else {
              if (firstAudioAt === 0) firstAudioAt = performance.now();
              stream?.fromClient(new Uint8Array(message));
            }
          },
          close: ws => {
            streams.get(ws)?.close();
            streams.delete(ws);
          },
        },
      });

      // A real Chrome whose fake microphone plays: 1 s of silence, the clip, 5 s of silence (once).
      const clip = pcmOf(new Uint8Array(await readFile(CLIP)));
      const wav = join(work, 'mic.wav');
      await writeFile(wav, wavOf(clip, 1, 5));
      const executablePath = Bun.which('google-chrome') ?? Bun.which('chromium');
      if (executablePath === null) throw new Error('no Chrome on PATH');
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: [
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          `--use-file-for-fake-audio-capture=${wav}%noloop`,
        ],
      });
      try {
        const tab = await (await browser.newContext({ viewport: { width: 1_440, height: 900 } })).newPage();
        await tab.goto(`http://127.0.0.1:${server.port}/`);
        await tab.locator('[data-fake-composer]').waitFor({ state: 'visible' });
        await tab.getByLabel('Message').fill('half a thought');
        await tab.locator('[data-voice-mode-start]').click();
        await tab.locator('[data-voice-mode="on"]').waitFor({ state: 'visible' });
        expect(await tab.locator('[data-fake-composer]').isVisible()).toBe(false);
        const micOpened = performance.now();
        // The chat is sent once, the panel says Sent, and the words are the clip's.
        try {
          await tab.locator('[data-voice-mode-outcome]').filter({ hasText: 'Sent.' }).waitFor({ timeout: 40_000 });
        } catch (failure) {
          const seen = await tab.evaluate(() => ({
            panel: document.querySelector('[data-voice-mode]')?.textContent ?? null,
            notice: document.querySelector('[data-voice-mode-notice]')?.textContent ?? null,
            log: (globalThis as unknown as { __log: { what: string }[] }).__log.map(entry => entry.what),
          }));
          console.log(
            'the page saw',
            JSON.stringify(seen),
            'outcomes',
            JSON.stringify([...new Set(outcomes)]),
            'sent',
            JSON.stringify(sent),
            'started',
            JSON.stringify(started),
          );
          throw failure;
        }
        const doneAt = performance.now();
        if (shotsDir !== '') {
          await mkdir(shotsDir, { recursive: true });
          await tab.screenshot({ path: join(shotsDir, 'real-sent.png') });
        }
        await tab.waitForTimeout(3_000); // a false send would land here
        const log = (await tab.evaluate(() => (globalThis as unknown as { __log: unknown[] }).__log)) as {
          at: number;
          what: string;
        }[];
        const interim = log.filter(entry => entry.what.startsWith('words interim'));
        console.log('mic opened → Sent shown (ms)', Math.round(doneAt - micOpened));
        console.log('page log', JSON.stringify(log.map(entry => entry.what)));
        console.log('sent', JSON.stringify(sent.map(item => ({ sendId: item.sendId, message: item.message }))));
        console.log('start records', JSON.stringify(started));
        // The fake microphone starts with the stream: 1 s of silence, then the clip. Speech ended that long after the first unit.
        const speechEndedAt = firstAudioAt + 1_000 + (clip.length / 16_000) * 1_000;
        console.log('speech ended → sent (ms)', Math.round((sent[0]?.at ?? 0) - speechEndedAt));
        expect(started).toEqual([{ t: 'start', v: 1, purpose: 'chat', ferretId: 'real-ferret' }]);
        expect(interim.length).toBeGreaterThan(0);
        console.log('outcomes', JSON.stringify([...new Set(outcomes)]));
        // The machine's final words are firm in the panel (the greyed interim style is gone).
        expect(await tab.locator('[data-voice-mode-words]').getAttribute('data-final')).toBe('true');
        expect(sent).toHaveLength(1);
        expect(sent[0]?.sendId).toBe('real:1');
        expect((sent[0]?.message ?? '').toLowerCase().replace(/[^a-z ]/gu, '')).toBe(
          'voice please fix the login redirect and run the tests again',
        );

        await tab.locator('[data-voice-mode-end]').click();
        await tab.locator('[data-fake-composer]').waitFor({ state: 'visible' });
        expect(await tab.getByLabel('Message').inputValue()).toBe('half a thought');
        await tab.waitForTimeout(500);
        expect(sent).toHaveLength(1);
      } finally {
        await browser.close();
      }
    } finally {
      server?.stop(true);
      await engine.unload();
      await rm(work, { force: true, recursive: true });
    }
  }, 900_000);
});
