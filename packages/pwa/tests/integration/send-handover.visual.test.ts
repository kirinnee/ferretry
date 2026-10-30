/**
 * ONE BUBBLE PER MESSAGE, AT EVERY FRAME, in a real browser (owner: "the double text box (right after
 * sending) still exists").
 *
 * Right after a send the reader's message showed TWICE: the send ledger's pending bubble under the
 * conversation, and the transcript's own user row once the agent had the message — until the daemon's
 * confirmation caught up and the pending one vanished, which also made the transcript jump. The scene
 * (`tests/integration/fixtures/send-handover-scene.tsx`) is the real `Transcript` over the real
 * `placeLedgerRows`, fed a fake daemon whose transcript and ledger change on a timeline, and it counts
 * the reader-side bubbles that show each message after every DOM mutation and on every animation frame.
 *
 * The matrix is every way the message can travel (typed directly, a turn file, a queued file, two
 * sends the harness joined into one), both harnesses' ways of writing it down, both arrival orders and
 * both together, at a local and a relayed pace. Each run must see exactly one bubble per message the
 * whole way through, and — except for a joined pair, which genuinely becomes a different message — the
 * SAME element, so the hand-over is in place.
 *
 * Set `FY_HANDOVER_SHOTS_DIR` to keep each stage at a phone and a desktop, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { gate } from './support/overlap.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_HANDOVER_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-send-handover-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/send-handover-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the send hand-over scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Probe {
  readonly stage: string;
  readonly stages: readonly string[];
  readonly checks: number;
  readonly frames: number;
  readonly violations: readonly { readonly stage: string; readonly marker: string }[];
  readonly done: boolean;
}

const newContext = async (phone: boolean, mode: 'light' | 'dark'): Promise<BrowserContext> =>
  await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    deviceScaleFactor: phone ? 2 : 1,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });

const open = async (context: BrowserContext, query: string): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  // Loopback only: the scene must never reach a daemon, a font host or anything else.
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?${query}`);
  await tab.waitForSelector('.fy-transcript-content');
  return tab;
};

const probeOf = async (tab: Page): Promise<Probe> =>
  await tab.evaluate(() => (window as unknown as { __handover: Probe }).__handover);

/** Plays one timeline to the end and answers what the probe saw. */
const play = async (query: string): Promise<Probe> => {
  const context = await newContext(false, 'light');
  try {
    const tab = await open(context, query);
    await tab.waitForFunction(() => (window as unknown as { __handover: Probe }).__handover.done, undefined, {
      timeout: 15_000,
    });
    return await probeOf(tab);
  } finally {
    await context.close();
  }
};

const PATHS = ['direct', 'turn-file', 'queued-file', 'merged'] as const;
const HARNESSES = ['claude', 'codex'] as const;
const ORDERS = ['transcript-first', 'ledger-first', 'together'] as const;
/** A local carrier answers within a frame or two; a relayed one is a poll behind. */
const PACES = [
  { name: 'local', land: 120, gap: 40, read: 30 },
  { name: 'relayed', land: 300, gap: 1_200, read: 700 },
] as const;

/**
 * A timeline is real time and a run spends nearly all of it waiting for the scene's own timers, so the runs
 * overlap instead of queueing: every path and harness starts with the file, `CONCURRENT_RUNS` timelines at a
 * time, each in its own context so no run sees another's page. A test then reads its own runs' probes.
 */
const CONCURRENT_RUNS = 12;
const inTurn = gate(CONCURRENT_RUNS);
const playInTurn = async (query: string): Promise<Probe> => await inTurn(async () => await play(query));

interface Run {
  readonly order: string;
  readonly pace: string;
  readonly probe: Probe;
}
const runsOf = new Map<string, Promise<PromiseSettledResult<Run>[]>>();
const startRuns = (): void => {
  for (const path of PATHS)
    for (const harness of HARNESSES)
      runsOf.set(
        `${path}/${harness}`,
        Promise.allSettled(
          ORDERS.flatMap(order =>
            PACES.map(async (pace): Promise<Run> => {
              const query = `path=${path}&harness=${harness}&order=${order}&land=${pace.land}&gap=${pace.gap}&read=${pace.read}`;
              return { order, pace: pace.name, probe: await playInTurn(query) };
            }),
          ),
        ),
      );
};

describe('a sent message hands over to its transcript row in place', () => {
  beforeAll(startRuns);
  for (const path of PATHS)
    for (const harness of HARNESSES)
      it(`${path} · ${harness}: one bubble, one element, at every frame in every order and pace`, async () => {
        for (const result of await (runsOf.get(`${path}/${harness}`) as Promise<PromiseSettledResult<Run>[]>)) {
          if (result.status === 'rejected') throw result.reason;
          const { order, pace, probe } = result.value;
          // The run really went through every stage and was really watched while it did.
          expect(probe.stages.at(-1)).toBe('replied');
          expect(probe.frames).toBeGreaterThan(10);
          expect({ order, pace, violations: probe.violations }).toEqual({ order, pace, violations: [] });
        }
      }, 120_000);
});

describe('the hand-over, captured', () => {
  it.if(shotsDir !== '')(
    'keeps every stage at a phone and a desktop, light and dark',
    async () => {
      for (const path of ['direct', 'turn-file'] as const)
        for (const phone of [false, true])
          for (const mode of ['light', 'dark'] as const) {
            const context = await newContext(phone, mode);
            try {
              const tab = await open(context, `path=${path}&pause=1&read=0&theme=studio-${mode}`);
              for (const [index, stage] of ['sent', 'landed', 'delivered', 'replied'].entries()) {
                await tab.evaluate(
                  step => (window as unknown as { __handover: { goto: (n: number) => void } }).__handover.goto(step),
                  index,
                );
                await tab.waitForSelector(`[data-stage="${stage}"]`);
                await tab.waitForTimeout(120);
                await tab.screenshot({
                  path: join(shotsDir, `handover-${path}-${index}-${stage}-${phone ? 'phone' : 'desktop'}-${mode}.png`),
                });
              }
            } finally {
              await context.close();
            }
          }
      // A send still on its way after the settle time shows its way out, inside the same bubble.
      for (const stuck of ['open', 'typed'] as const)
        for (const phone of [false, true])
          for (const mode of ['light', 'dark'] as const) {
            const context = await newContext(phone, mode);
            try {
              const tab = await open(context, `path=direct&pause=1&stuck=${stuck}&theme=studio-${mode}`);
              await tab.waitForSelector('[data-ledger-more]');
              await tab.screenshot({
                path: join(shotsDir, `handover-stuck-${stuck}-${phone ? 'phone' : 'desktop'}-${mode}.png`),
              });
            } finally {
              await context.close();
            }
          }
    },
    120_000,
  );
});
