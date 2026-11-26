/**
 * VOICE MODE END TO END (F6418 part B, V5): the SHIPPED panel and live-line reader in real Chromium, talking over a WebSocket
 * to the daemon's real `VoiceStream`, with a FAKE ferret (a script of rows: a first line, progress lines between tool calls, a
 * result), a FAKE speech engine (what the person says is set by the test; pauses are found from the units' loudness) and a FAKE
 * voice of KNOWN LENGTH (every character is exactly {@link SAMPLES_PER_CHAR} samples of sound, so where a cut falls is
 * arithmetic). The audio device is a clock-driven stand-in under the real `createReplyPlayer`. No model, provider or network is
 * touched; one Chromium page, one run, real time (about 45 s).
 *
 * ONE run proves, in order:
 *
 *   1. ENTRY ONCE. Pressing Voice mode sends the ferret `(voice mode on) …` exactly once under `voice-on:<session>`, before
 *      anything the person says, and never again for the rest of the run.
 *   2. LIVE LINES PLAY AT ONCE. Each `<voice>` line reaches the machine within a few hundred ms of the ferret finishing it
 *      (while the turn is still working), and the ferret's tool rows are never held back for the sound.
 *   3. STALE PROGRESS IS DROPPED ON ARRIVAL, NEVER THE FIRST LINE OR THE RESULT. A progress line (one a tool call followed) that
 *      a newer line outdates is taken back the moment the newer line arrives, before any of it plays; the first line and the
 *      result play in full; nothing is read again at the end of the turn. Turn four pins the timing: the ferret goes quiet
 *      after the newer progress line, so only its arrival can take the older one back.
 *   4. A BARGE-IN MID-PIECE MAKES EXACTLY ONE NOTE. The person talks over a long line; the stop is a person's stop; the
 *      next `(voice)` message carries ONE `[heard up to: "…"; not heard: "…"]` note whose split is the arithmetic of where
 *      the person's ears were (exact), and agrees with the wall clock (±2 words). Nothing of the unheard rest is read again, and
 *      no second note goes alone.
 *   5. BACKGROUNDING IS A PLAIN HUSH. A reading in progress when the tab goes to the background is stopped with a hush that
 *      carries NO cut (so the ferret is told nothing and no unsolicited message is posted), and nothing speaks on return.
 *   6. THE FIRST SPOKEN WORD. Time from the ferret's first `<voice>` line reaching the chat to the first sample of it being
 *      audible, measured on the page's own clock and printed as `VOICE-E2E first spoken word …` (target vs measured).
 *   7. A LIVE LINE PLAYING WHEN THE TAB GOES TO THE BACKGROUND is stopped by the same plain hush a reading
 *      gets (no cut), once; nothing is heard or said on return, and the next message carries no heard-note.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SocketDownstream } from '@ferretry/kernel/contract';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import {
  type DropFrame,
  type HushFrame,
  type SpeakFrame,
  VOICE_ENTRY_MESSAGE,
  decodeLineFrame,
  entrySendId,
} from '../../../contract/index.ts';
import { spansFromProbabilities, VAD_CHUNK } from '../../../daemon/lib/engine/spans.ts';
import { splitForSpeech } from '../../../daemon/lib/reply/chunks.ts';
import { VoiceStream } from '../../../daemon/lib/stream/session.ts';

setDefaultTimeout(180_000);

/** One character of a line is exactly this many samples of fake sound (16 kHz mono): 62.5 ms, a person's pace. */
const SAMPLES_PER_CHAR = 1_000;
const SAMPLE_RATE = 16_000;
/** The plan's target (§8): the first spoken word within this long of the ferret's first `<voice>` line reaching the machine. */
const FIRST_WORD_TARGET_MS = 1_500;

const LINES = {
  first1: 'Looking at the build now.',
  progress1: 'Reading the build log.',
  progress2: 'Found the failing login test.',
  result1a: 'The build is green again.',
  result1b: 'I fixed the login redirect.',
  long2: 'Two tests still fail, one in login and one in logout, so I am fixing both now.',
  third: 'Skipping logout, running the login test again now.',
  first4: 'Opening the build log to look for the first failing test.',
  progressA: 'Reading the test output.',
  progressB: 'Found the broken redirect.',
  result4: 'All clear now.',
  first5: 'Rerunning every test in the login suite and then the logout suite.',
  sixth: 'Done.',
} as const;

/** The stream's own numbering of the lines the page asks to be spoken, in order (turn one's four, a result of two lines, then the rest). */
const ID = { first1: 0, progress1: 1, progress2: 2, result1a: 3, result1b: 4, long2: 5, third: 6 } as const;
/** The first line of turn one takes this long to make, so it has not begun to sound when the newer progress lines arrive. */
const SLOW_FIRST_SYNTH_MS = 900;
/** How long the ferret says nothing after its newer progress line in turn four (no tool call, no result). */
const QUIET_AFTER_PROGRESS_MS = 1_500;
const voice = (text: string): string => `<voice>${text}</voice>`;

const SAYS = [
  'please check the build',
  'what is left',
  'skip the logout one',
  'run it again please',
  'run every test now',
  'and then tell me',
] as const;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(label: string, ready: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const limit = performance.now() + ms;
  for (;;) {
    if (await ready()) return;
    if (performance.now() > limit) throw new Error(`timed out after ${ms} ms waiting for: ${label}`);
    await sleep(25);
  }
}

// ─── the machine's fakes ─────────────────────────────────────────────────────────────────────────────────────────────

const LOUD = 6_000;
/** Speech where the units are loud: Silero's decision replaced by loudness, through the real span rules. */
const fakeSpans = (samples: Float32Array) => {
  const probabilities: number[] = [];
  for (let at = 0; at + VAD_CHUNK <= samples.length; at += VAD_CHUNK) {
    let peak = 0;
    for (let index = at; index < at + VAD_CHUNK; index += 1) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    probabilities.push(peak * 32768 >= LOUD ? 0.9 : 0.05);
  }
  return spansFromProbabilities(probabilities, samples.length);
};

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

interface Sent {
  readonly at: number;
  readonly message: string;
  readonly sendId: string;
}

// ─── the page's own record, read back ─────────────────────────────────────────────────────────────────────────────────

interface PageRecord {
  readonly frames: readonly {
    at: number;
    t: 'speak' | 'drop' | 'hush';
    id?: number;
    text?: string;
    cut?: { id: number; samples: number } | null;
  }[];
  readonly played: readonly { id: number; samples: number; at: number }[];
  readonly audible: readonly { id: number; atMs: number; samples: number }[];
  readonly marks: Record<string, number>;
  readonly positions: readonly { at: number; id: number; samples: number }[];
  readonly stops: readonly number[];
}

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let css = '';
let js = '';

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-e2e-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-e2e-scene.tsx'],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the voice e2e scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  css = await readFile(manifest.css, 'utf8');
  js = await readFile(manifest.js, 'utf8');
}, 240_000);

afterAll(async () => {
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** The first free port of the test range (7480-7499). */
function serve(options: Omit<Parameters<typeof Bun.serve>[0], 'port' | 'hostname'>): ReturnType<typeof Bun.serve> {
  let last: unknown;
  for (let port = 7_480; port <= 7_499; port += 1) {
    try {
      return Bun.serve({ ...options, hostname: '127.0.0.1', port } as never);
    } catch (failure) {
      last = failure;
    }
  }
  throw new Error(`no free port in 7480-7499: ${String(last)}`);
}

/** Where the person's ears were, in whole words, if `samples` of a line's sound played (pieces are exact, inside one is a share). */
function heardWords(text: string, samples: number): { heard: string[]; unheard: string[] } {
  const heard: string[] = [];
  const unheard: string[] = [];
  let budget = samples;
  for (const piece of splitForSpeech(text)) {
    const words = piece.split(/\s+/u).filter(word => word.length > 0);
    const made = piece.length * SAMPLES_PER_CHAR;
    if (budget <= 0) unheard.push(...words);
    else if (budget >= made) {
      heard.push(...words);
      budget -= made;
    } else {
      const count = Math.floor((words.length * budget) / made);
      heard.push(...words.slice(0, count));
      unheard.push(...words.slice(count));
      budget = 0;
    }
  }
  return { heard, unheard };
}

type Win = {
  __loud?: boolean;
  __e2e: {
    agent: {
      user(text: string): void;
      tool(): void;
      say(text: string, label: string): void;
      done(label: string): void;
    };
    setHidden(hidden: boolean): void;
    now(): number;
    idle(): boolean;
  } & PageRecord;
};

describe('voice mode end to end, over a fake ferret and a fake voice of known length', () => {
  it('entry once, live lines at once, stale progress dropped, one heard-note on a barge-in, a plain hush on backgrounding, and the first spoken word', async () => {
    // The machine: the daemon's real stream behind a WebSocket.
    const sends: Sent[] = [];
    const starts: Record<string, unknown>[] = [];
    const lineFrames: { at: number; frame: SpeakFrame | HushFrame | DropFrame }[] = [];
    const made: string[] = [];
    const failed = new Set<string>();
    const claimed = new Set<string>();
    const says = { text: SAYS[0] as string };
    const scripts: Promise<void>[] = [];
    /** How many lines the page had asked the machine to speak when each message reached the ferret. */
    const speaksWhenSent = new Map<string, number>();
    const streams = new Map<unknown, VoiceStream>();
    let utterances = 0;
    let pageOf: { evaluate: <R, A>(fn: (arg: A) => R, arg: A) => Promise<R> } | undefined;

    const agentScript = async (turn: number, message: string): Promise<void> => {
      const agent = {
        user: (text: string) => pageOf?.evaluate(text => (window as unknown as Win).__e2e.agent.user(text), text),
        tool: () => pageOf?.evaluate(() => (window as unknown as Win).__e2e.agent.tool(), undefined),
        say: (markdown: string, label: string) =>
          pageOf?.evaluate(
            ([t, l]) => (window as unknown as Win).__e2e.agent.say(t as string, l as string),
            [markdown, label],
          ),
        done: (label: string) => pageOf?.evaluate(l => (window as unknown as Win).__e2e.agent.done(l), label),
      };
      await agent.user(message);
      if (turn === 1) {
        await agent.say(voice(LINES.first1), 'first1');
        await sleep(300);
        await agent.tool();
        await sleep(200);
        await agent.say(voice(LINES.progress1), 'progress1');
        await sleep(100);
        await agent.tool();
        await sleep(200);
        await agent.say(voice(LINES.progress2), 'progress2');
        await sleep(100);
        await agent.tool();
        await sleep(300);
        await agent.say(`${voice(LINES.result1a)} ${voice(LINES.result1b)}`, 'result1');
        await sleep(300);
        await agent.done('done1');
      } else if (turn === 2) {
        await agent.say(voice(LINES.long2), 'first2');
        await sleep(300);
        await agent.done('done2');
      } else if (turn === 3) {
        await agent.say(voice(LINES.third), 'first3');
        await sleep(600);
        await agent.done('done3');
      } else if (turn === 4) {
        // A long first line is still sounding while a progress line, then a newer one, arrive. After the newer one the ferret
        // goes quiet (no tool call, no result) for a while: only its ARRIVAL can take the older progress line back.
        await agent.say(voice(LINES.first4), 'first4');
        await sleep(300);
        await agent.tool();
        await sleep(200);
        await agent.say(voice(LINES.progressA), 'progressA');
        await sleep(100);
        await agent.tool();
        await sleep(200);
        await agent.say(voice(LINES.progressB), 'progressB');
        await sleep(QUIET_AFTER_PROGRESS_MS);
        await agent.say(voice(LINES.result4), 'result4');
        await sleep(300);
        await agent.done('done4');
      } else if (turn === 5) {
        // A long LIVE line, still sounding when the tab goes to the background.
        await agent.say(voice(LINES.first5), 'first5');
        await sleep(400);
        await agent.done('done5');
      } else {
        await agent.say(voice(LINES.sixth), 'first6');
        await sleep(300);
        await agent.done('done6');
      }
    };

    const server = serve({
      fetch: (request, bun) => {
        const url = new URL(request.url);
        if (url.pathname === '/stream')
          return bun.upgrade(request, { data: {} }) ? undefined : new Response('no', { status: 400 });
        if (url.pathname === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script>window.__bridge=location.origin</script><script type="module" src="/app.js"></script></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      },
      websocket: {
        open: async ws => {
          const downstream: SocketDownstream = {
            send: frame => {
              ws.send(frame as Uint8Array);
              return (frame as Uint8Array).byteLength;
            },
            close: () => undefined,
            bufferedBytes: () => 0,
          };
          const stream = new VoiceStream({
            engine: {
              detectSpeech: async samples => fakeSpans(samples),
              transcribe: async () => ({ text: says.text, decodeMs: 1, realTimeFactor: 0.1 }),
            },
            reply: {
              view: async () => ({ state: 'ready' }) as never,
              warm: async () => undefined,
              speak: async text => {
                // The first try at the third turn's line fails, as a voice that choked would: it is read again at the end of the turn.
                if (text.includes('Skipping') && !failed.has(text)) {
                  failed.add(text);
                  throw new Error('the voice choked');
                }
                if (text === LINES.first1 && !made.includes(text)) await sleep(SLOW_FIRST_SYNTH_MS);
                made.push(text);
                return { samples: new Float32Array(text.length * SAMPLES_PER_CHAR).fill(0.5), speakMs: 1 };
              },
            },
            clock: realClock as never,
            downstream,
            streamId: 'e2e',
            nonce: () =>
              Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join(
                '',
              ),
            send: async (_ferret, message, sendId) => {
              sends.push({ at: performance.now(), message, sendId });
              speaksWhenSent.set(sendId, lineFrames.filter(item => item.frame.t === 'speak').length);
              if (!message.startsWith('(voice mode on)') && !sendId.includes(':heard:')) {
                utterances += 1;
                scripts.push(agentScript(utterances, message));
              }
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
          streams.set(ws, stream);
          await stream.open();
        },
        message: (ws, message) => {
          const stream = streams.get(ws);
          if (typeof message === 'string') {
            if (message.length === 1_024) lineFrames.push({ at: performance.now(), frame: decodeLineFrame(message) });
            else starts.push(JSON.parse(message) as Record<string, unknown>);
            stream?.fromClient(message);
          } else stream?.fromClient(new Uint8Array(message));
        },
        close: ws => {
          streams.get(ws)?.close();
          streams.delete(ws);
        },
      },
    });

    const context = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
    const errors: string[] = [];
    try {
      const tab = await context.newPage();
      pageOf = tab as never;
      tab.on('pageerror', error => errors.push(error.message));
      await tab.goto(`http://127.0.0.1:${server.port}/`);
      await tab.locator('[data-fake-composer]').waitFor({ state: 'visible' });

      const record = async (): Promise<PageRecord> =>
        await tab.evaluate(() => {
          const win = (window as unknown as Win).__e2e;
          return JSON.parse(
            JSON.stringify({
              frames: win.frames,
              played: win.played,
              audible: win.audible,
              marks: win.marks,
              positions: win.positions,
              stops: win.stops,
            }),
          ) as PageRecord;
        });
      const pageNow = async (): Promise<number> => await tab.evaluate(() => (window as unknown as Win).__e2e.now());
      const loud = async (on: boolean): Promise<void> => {
        await tab.evaluate(value => {
          (window as unknown as Win).__loud = value;
        }, on);
      };
      const person = async (words: (typeof SAYS)[number], ms: number): Promise<void> => {
        says.text = words;
        await loud(true);
        await sleep(ms);
        await loud(false);
      };
      const idle = async (): Promise<boolean> => await tab.evaluate(() => (window as unknown as Win).__e2e.idle());
      const speaks = (): { at: number; frame: SpeakFrame }[] =>
        lineFrames.filter((item): item is { at: number; frame: SpeakFrame } => item.frame.t === 'speak');
      const utteranceSends = (): Sent[] =>
        sends.filter(item => !item.message.startsWith('(voice mode on)') && !item.sendId.includes(':heard:'));
      const playedSamples = (rec: PageRecord, id: number): number =>
        rec.played.filter(item => item.id === id).reduce((total, item) => total + item.samples, 0);

      // ── 1. ENTRY ONCE ──────────────────────────────────────────────────────────────────────────────────────────────
      await tab.locator('[data-voice-mode-start]').click();
      await tab.locator('[data-voice-mode="on"]').waitFor({ state: 'visible' });
      await until('the stream opened and the ferret was told', () => starts.length > 0 && sends.length > 0);
      const session = starts[0]?.session as string;
      expect(session).toMatch(/^vm-[0-9a-f-]{36}$/u);
      expect(sends).toHaveLength(1);
      expect(sends[0]?.message).toBe(VOICE_ENTRY_MESSAGE);
      expect(sends[0]?.sendId).toBe(entrySendId(session));
      // The room is heard quiet for a second first (steady noise is not a person starting to talk).
      await sleep(1_600);

      // ── 2 + 3. TURN ONE: live lines, a stale progress line dropped ─────────────────────────────────────────────
      await person(SAYS[0], 1_200);
      await until('the first utterance was sent', () => utteranceSends().length === 1);
      expect(utteranceSends()[0]?.message).toBe('(voice) please check the build');
      expect(utteranceSends()[0]?.sendId).toBe('e2e:1');
      await scripts[0];
      await until(
        'the result was heard in full',
        async () => playedSamples(await record(), ID.result1b) >= LINES.result1b.length * SAMPLES_PER_CHAR,
      );
      await until('the sound stopped', idle);
      await sleep(1_500); // a second reading of anything unsaid would start here
      const one = await record();

      // The lines, in the order the ferret finished them (the result is two lines of one message), are lines 0..4 of the stream.
      expect(speaks().map(item => item.frame.text)).toEqual([
        LINES.first1,
        LINES.progress1,
        LINES.progress2,
        LINES.result1a,
        LINES.result1b,
      ]);
      expect(speaks().map(item => item.frame.id)).toEqual(Object.values(ID).slice(0, 5));
      // Both stale progress lines were taken back before any of them was heard, each the moment a newer line arrived (the second
      // progress line, then the result): two drops, and none of their sound played.
      expect(lineFrames.filter(item => item.frame.t === 'drop').map(item => (item.frame as DropFrame).id)).toEqual([
        ID.progress1,
        ID.progress2,
      ]);
      expect(playedSamples(one, ID.progress1)).toBe(0);
      expect(playedSamples(one, ID.progress2)).toBe(0);
      // The first line (still being made when the newer ones came: it is never taken back) and both lines of the result were each
      // heard in full.
      expect(playedSamples(one, ID.first1)).toBe(LINES.first1.length * SAMPLES_PER_CHAR);
      expect(playedSamples(one, ID.result1a)).toBe(LINES.result1a.length * SAMPLES_PER_CHAR);
      expect(playedSamples(one, ID.result1b)).toBe(LINES.result1b.length * SAMPLES_PER_CHAR);
      expect(one.frames.filter(item => item.t === 'speak')).toHaveLength(5); // nothing read again at the end of the turn
      expect(one.frames.filter(item => item.t === 'hush')).toHaveLength(0);

      // Live: each line left the page within a few hundred ms of the ferret finishing it, while the turn was still working,
      // and a later line left while the first was still sounding (the ferret never waited for the sound).
      const sentAt = (label: string, id: number): number => {
        const frame = one.frames.find(item => item.t === 'speak' && item.id === id);
        return (frame?.at ?? Number.NaN) - (one.marks[label] ?? Number.NaN);
      };
      for (const [label, id] of [
        ['first1', ID.first1],
        ['progress1', ID.progress1],
        ['progress2', ID.progress2],
        ['result1', ID.result1a],
        ['result1', ID.result1b],
      ] as const)
        expect(sentAt(label, id)).toBeLessThan(500);
      const firstEnds =
        (one.audible.find(item => item.id === ID.first1)?.atMs ?? 0) +
        (LINES.first1.length * SAMPLES_PER_CHAR * 1000) / SAMPLE_RATE;
      const leftAt = (id: number): number =>
        one.frames.find(item => item.t === 'speak' && item.id === id)?.at ?? Number.POSITIVE_INFINITY;
      expect(leftAt(ID.progress2)).toBeLessThan(firstEnds);
      expect(leftAt(ID.result1a)).toBeLessThan(one.marks.done1 ?? 0);
      expect(leftAt(ID.result1b)).toBeLessThan(one.marks.done1 ?? 0);

      // ── 6. THE FIRST SPOKEN WORD (turn one) ────────────────────────────────────────────────────────────────────
      const firstWord1 =
        (one.audible.find(item => item.id === ID.first1)?.atMs ?? Number.NaN) - (one.marks.first1 ?? Number.NaN);

      // ── 4. TURN TWO: a barge-in in the middle of a piece ──────────────────────────────────────────────────────────
      await sleep(500);
      await person(SAYS[1], 1_000);
      await until('the second utterance was sent', () => utteranceSends().length === 2);
      expect(utteranceSends()[1]?.message).toBe('(voice) what is left');
      expect(utteranceSends()[1]?.sendId).toBe('e2e:2');
      await scripts[1];
      const long2Id = ID.long2;
      await until('the long line is audible', async () => (await record()).audible.some(item => item.id === long2Id));
      const two = await record();
      const audibleAt = two.audible.find(item => item.id === long2Id)?.atMs ?? Number.NaN;
      const firstWord2 = audibleAt - (two.marks.first2 ?? Number.NaN);
      // Let it play into the middle of its second piece, then talk over it (and keep talking: the next words).
      while ((await pageNow()) - audibleAt < 2_700) await sleep(25);
      says.text = SAYS[2];
      const loudAt = await pageNow();
      await loud(true);
      await until('the person stopped it', () => lineFrames.some(item => item.frame.t === 'hush'));
      await sleep(Math.max(0, 2_000 - ((await pageNow()) - loudAt)));
      await loud(false);
      await until('the third utterance was sent', () => utteranceSends().length === 3, 20_000);
      const afterCut = await record();

      const hushes = lineFrames.filter(item => item.frame.t === 'hush');
      expect(hushes).toHaveLength(1);
      const cut = (hushes[0]?.frame as HushFrame | undefined)?.cut;
      expect(cut?.id).toBe(long2Id);
      const samples = cut?.samples ?? Number.NaN;
      // Where the person's ears were agrees with the wall clock: the player's own answer, taken when it was stopped.
      const position = afterCut.positions.at(-1);
      expect(position?.id).toBe(long2Id);
      expect(Math.abs((samples / SAMPLE_RATE) * 1000 - ((position?.at ?? 0) - audibleAt))).toBeLessThan(120);
      // The stop came a barge-in's length after the person started: 300 ms of speech, not before, not long after.
      const stoppedAt = afterCut.stops.at(-1) ?? Number.NaN;
      expect(stoppedAt - loudAt).toBeGreaterThanOrEqual(250);
      expect(stoppedAt - loudAt).toBeLessThan(900);
      // Mid-piece: after the whole first piece, before the end of the second.
      const pieces = splitForSpeech(LINES.long2);
      expect(pieces).toHaveLength(3);
      const firstPiece = (pieces[0]?.length ?? 0) * SAMPLES_PER_CHAR;
      expect(samples).toBeGreaterThan(firstPiece);
      expect(samples).toBeLessThan(firstPiece + (pieces[1]?.length ?? 0) * SAMPLES_PER_CHAR);

      // The note: exactly the split the arithmetic says, carried by the person's next message; ONE note in the whole run.
      const split = heardWords(LINES.long2, samples);
      const note = `[heard up to: "${split.heard.join(' ')}"; not heard: "${split.unheard.join(' ')}"]`;
      expect(utteranceSends()[2]?.message).toBe(`${note} (voice) skip the logout one`);
      expect(utteranceSends()[2]?.sendId).toBe('e2e:3');
      // …and it agrees with the wall clock to within two words.
      const byClock = heardWords(LINES.long2, ((position?.at ?? 0) - audibleAt) * (SAMPLE_RATE / 1000));
      expect(Math.abs(byClock.heard.length - split.heard.length)).toBeLessThanOrEqual(2);
      expect(split.heard.length).toBeGreaterThan(4); // the whole first piece
      expect(split.unheard.length).toBeGreaterThan(0);
      // The rest of the line was not read again, and no second note went alone.
      expect(speaksWhenSent.get('e2e:3')).toBe(ID.long2 + 1);
      expect(sends.filter(item => item.message.includes('[heard up to'))).toHaveLength(1);
      expect(sends.filter(item => item.sendId.includes(':heard:'))).toHaveLength(0);

      // ── 5. TURN THREE: a reading under way when the tab goes to the background ─────────────────────────────────
      // The voice choked on the third turn's line the first time, so it is read at the end of the turn: a READING.
      await scripts[2];
      await until(
        'the reading is audible',
        async () => (await record()).audible.some(item => item.id > ID.third),
        20_000,
      );
      await sleep(900);
      const beforeHide = await record();
      await tab.evaluate(() => (window as unknown as Win).__e2e.setHidden(true));
      await until(
        'the hush reached the machine',
        () => lineFrames.filter(item => item.frame.t === 'hush').length === 2,
      );
      const hushedAt = lineFrames.at(-1);
      expect(lineFrames.filter(item => item.frame.t === 'hush')).toHaveLength(2);
      // A plain hush: no cut, so the ferret is told nothing and no message is posted for the owner.
      expect((hushedAt?.frame as HushFrame | undefined)?.cut).toBeUndefined();
      const hidden = await record();
      expect(hidden.frames.at(-1)).toMatchObject({ t: 'hush', cut: null });
      expect(hidden.stops.length).toBeGreaterThan(beforeHide.stops.length);
      // Nothing more is heard, and nothing more is said, hidden or back.
      const soundsAfterHush = hidden.audible.length;
      const speaksAfterHush = speaks().length;
      const sendsAfterHush = sends.length;
      await sleep(4_000); // longer than the pause a standalone note would wait
      await tab.evaluate(() => (window as unknown as Win).__e2e.setHidden(false));
      await sleep(1_500);
      const finalRecord = await record();
      expect(finalRecord.audible).toHaveLength(soundsAfterHush);
      expect(speaks()).toHaveLength(speaksAfterHush);
      expect(sends).toHaveLength(sendsAfterHush);
      expect(sends.filter(item => item.message.includes('[heard up to'))).toHaveLength(1);
      expect(sends.filter(item => item.sendId.includes(':heard:'))).toHaveLength(0);

      const lineId = (text: string): number => {
        const found = speaks().find(item => item.frame.text === text);
        if (found === undefined) throw new Error('a line the page was expected to ask for was never asked for');
        return found.frame.id;
      };

      // ── 7. TURN FOUR: a newer progress line takes an older QUEUED one back the moment it ARRIVES ───────────────────
      // The first line is long and still sounding; progress A (known to be progress: a tool call followed it) waits behind it;
      // then progress B arrives and the ferret goes quiet for 1.5 s with no tool call and no result. Only B's arrival can take A.
      await until('the sound stopped before turn four', idle);
      await sleep(1_000);
      await person(SAYS[3], 1_000);
      await until('the fourth utterance was sent', () => utteranceSends().length === 4);
      expect(utteranceSends()[3]?.message).toBe('(voice) run it again please');
      expect(utteranceSends()[3]?.sendId).toBe('e2e:4');
      await scripts[3];
      await until(
        'the result was heard in full',
        async () => playedSamples(await record(), lineId(LINES.result4)) >= LINES.result4.length * SAMPLES_PER_CHAR,
      );
      await until('the sound stopped after turn four', idle);
      const four = await record();
      const idA = lineId(LINES.progressA);
      const dropOfA = lineFrames.find(item => item.frame.t === 'drop' && (item.frame as DropFrame).id === idA);
      // A was taken back, and the drop left the page right after B reached the chat: well before the ferret's next word.
      expect(dropOfA).toBeDefined();
      const dropAfterB = four.frames.find(item => item.t === 'drop' && item.id === idA);
      expect((dropAfterB?.at ?? Number.NaN) - (four.marks.progressB ?? Number.NaN)).toBeLessThan(500);
      expect(dropAfterB?.at ?? Number.NaN).toBeLessThan(four.marks.result4 ?? 0);
      expect(playedSamples(four, idA)).toBe(0);
      // The first line, the newer progress line B (nothing newer outdated it) and the result were each heard in full; only A went.
      expect(playedSamples(four, lineId(LINES.first4))).toBe(LINES.first4.length * SAMPLES_PER_CHAR);
      expect(playedSamples(four, lineId(LINES.progressB))).toBe(LINES.progressB.length * SAMPLES_PER_CHAR);
      expect(playedSamples(four, lineId(LINES.result4))).toBe(LINES.result4.length * SAMPLES_PER_CHAR);
      expect(
        lineFrames
          .filter(item => item.frame.t === 'drop' && (item.frame as DropFrame).id >= idA)
          .map(item => (item.frame as DropFrame).id),
      ).toEqual([idA]);
      expect(lineFrames.filter(item => item.frame.t === 'hush')).toHaveLength(2); // nothing was hushed

      // ── 8. TURN FIVE: a LIVE line already playing when the tab goes to the background is hushed plainly ───────────
      await sleep(1_000);
      await person(SAYS[4], 1_000);
      await until('the fifth utterance was sent', () => utteranceSends().length === 5);
      expect(utteranceSends()[4]?.message).toBe('(voice) run every test now');
      await scripts[4];
      const id5 = lineId(LINES.first5);
      await until(
        'the live line is audible',
        async () => (await record()).audible.some(item => item.id === id5),
        20_000,
      );
      await sleep(900);
      const beforeHide5 = await record();
      const total5 = LINES.first5.length * SAMPLES_PER_CHAR;
      // It is mid-line, with its sound still ahead (the turn is already over: this is a LINE, not a reading).
      expect(playedSamples(beforeHide5, id5)).toBeGreaterThan(0);
      expect(beforeHide5.stops.length).toBe(four.stops.length);
      const speaksBefore5 = speaks().length;
      await tab.evaluate(() => (window as unknown as Win).__e2e.setHidden(true));
      await until(
        'the hush reached the machine',
        () => lineFrames.filter(item => item.frame.t === 'hush').length === 3,
      );
      // ONE hush, and a plain one (no cut): the same stop a hidden reading gets, never a person's stop.
      expect(lineFrames.filter(item => item.frame.t === 'hush')).toHaveLength(3);
      expect((lineFrames.at(-1)?.frame as HushFrame | undefined)?.cut).toBeUndefined();
      const hidden5 = await record();
      expect(hidden5.frames.at(-1)).toMatchObject({ t: 'hush', cut: null });
      expect(hidden5.stops.length).toBeGreaterThan(beforeHide5.stops.length);
      // Nothing more is heard and nothing is said again: not at once, not after a standalone note's wait, not on return.
      const soundsAfterHush5 = hidden5.audible.length;
      const sendsAfterHush5 = sends.length;
      await sleep(4_000);
      await tab.evaluate(() => (window as unknown as Win).__e2e.setHidden(false));
      await sleep(1_500);
      const back5 = await record();
      expect(back5.audible).toHaveLength(soundsAfterHush5);
      expect(back5.frames.filter(item => item.t === 'hush')).toHaveLength(3);
      expect(speaks()).toHaveLength(speaksBefore5);
      expect(sends).toHaveLength(sendsAfterHush5);
      // Only the part that was already scheduled was heard: the line was cut short by the hush.
      expect(playedSamples(back5, id5)).toBeLessThan(total5);
      expect(sends.filter(item => item.message.includes('[heard up to'))).toHaveLength(1);
      expect(sends.filter(item => item.sendId.includes(':heard:'))).toHaveLength(0);

      // ── 9. TURN SIX: the next message carries NO heard-note for it (a plain hush tells the ferret nothing) ────────
      await person(SAYS[5], 1_000);
      await until('the sixth utterance was sent', () => utteranceSends().length === 6);
      expect(utteranceSends()[5]?.message).toBe('(voice) and then tell me');
      expect(utteranceSends()[5]?.sendId).toBe('e2e:6');
      await scripts[5];
      await until('the sound stopped after turn six', idle);
      expect(sends.filter(item => item.message.includes('[heard up to'))).toHaveLength(1);

      // ── the whole run: entry exactly once, then only what the person said ──────────────────────────────────────
      await tab.locator('[data-voice-mode-end]').click();
      await tab.locator('[data-fake-composer]').waitFor({ state: 'visible' });
      await sleep(500);
      expect(sends.filter(item => item.message.startsWith('(voice mode on)'))).toHaveLength(1);
      expect(sends.map(item => item.sendId)).toEqual([
        entrySendId(session),
        'e2e:1',
        'e2e:2',
        'e2e:3',
        'e2e:4',
        'e2e:5',
        'e2e:6',
      ]);
      expect(starts).toHaveLength(1);
      expect(errors).toEqual([]);
      for (const script of scripts) await script;

      // ── 6. THE FIRST SPOKEN WORD, against the plan's target ────────────────────────────────────────────────────
      // Measured: the ferret's first `<voice>` line reaching the chat → the first sample of it audible (the page's clock; includes
      // the page's hand-off, the loopback socket, the stream's own 200 ms sound unit and the player's 150 ms scheduling lead).
      // NOT measured here: the real voice's time to make the first piece (the fake makes it at once; docs/voice.md measured 4.0 s
      // for a real line on a loaded 32-core box), so the number below is the plumbing's share of the 1.5 s target.
      console.log(
        `VOICE-E2E first spoken word: target ${FIRST_WORD_TARGET_MS} ms for the whole path (real voice included); measured with the fake voice: turn 2 ${Math.round(firstWord2)} ms (voice made at once: the plumbing alone), turn 1 ${Math.round(firstWord1)} ms (the fake voice took ${SLOW_FIRST_SYNTH_MS} ms to make it, so ${Math.round(firstWord1 - SLOW_FIRST_SYNTH_MS)} ms is the plumbing)`,
      );
      console.log(`VOICE-E2E cut at ${samples} samples; note: ${utteranceSends()[2]?.message ?? ''}`);
      expect(firstWord1 - SLOW_FIRST_SYNTH_MS).toBeGreaterThan(0);
      expect(firstWord1 - SLOW_FIRST_SYNTH_MS).toBeLessThan(FIRST_WORD_TARGET_MS);
      expect(firstWord2).toBeGreaterThan(0);
      expect(firstWord2).toBeLessThan(FIRST_WORD_TARGET_MS);
      expect(made.length).toBeGreaterThan(0);
    } catch (failure) {
      // Where the run was when it failed, so a red run explains itself (counts and states only: nothing spoken).
      const panel = await pageOf
        ?.evaluate(
          () =>
            document.querySelector('[data-voice-mode]')?.textContent ??
            document.querySelector('[data-voice-mode-notice]')?.textContent ??
            'no panel and no notice',
          undefined,
        )
        .catch(() => null);
      console.log(
        'VOICE-E2E failed; panel:',
        JSON.stringify(panel),
        'sends:',
        JSON.stringify(sends.map(item => item.sendId)),
        'line frames:',
        lineFrames.length,
        'page errors:',
        JSON.stringify(errors),
        'page:',
        JSON.stringify(
          await pageOf
            ?.evaluate(() => {
              const win = (window as unknown as Win).__e2e;
              return {
                frames: win.frames.map(item => `${item.t}${item.id ?? ''}@${Math.round(item.at)}`),
                played: win.played.map(item => `${item.id}:${item.samples}`),
                marks: win.marks,
              };
            }, undefined)
            .catch(() => null),
        ),
      );
      throw failure;
    } finally {
      await context.close();
      server.stop(true);
    }
  });
});
