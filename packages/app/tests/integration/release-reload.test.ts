/**
 * ONE RELOAD GETS THE NEW RELEASE — in real Chromium, through the REAL built worker (`src/worker/service-worker.ts` →
 * `sw.verified.js`), over a site that is a signed release built and signed the way CI does (`support/browser/signed-release.ts`).
 *
 * The update path (docs/pwa-release-signing.md): a newer signed release is published over a running install, and the
 * reader reloads ONCE. Before this, that reload was answered from the installed release while the check ran behind it,
 * so only the SECOND reload showed the new app. Now a navigation finishes a BOUNDED check first
 * (`RELEASE_CHECK_DEADLINE_MS`), then answers from whatever release is installed:
 *   - N installed, N+1 published, one reload → N+1;
 *   - the site is down (offline start) → the installed release, at once;
 *   - the site answers the list slower than the deadline → the installed release within the deadline, and the check
 *     still lands behind it, so the next reload is N+1;
 *   - N+1 signed by a key the worker does not trust → N stays, the refusal is reported, nothing is weakened.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { releaseKey, sharedChromium, signedRelease, waitFor } from '../support/browser/index.ts';
import { RELEASE_CHECK_DEADLINE_MS } from '../../src/release/keeper.ts';

const page = (name: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${name}</title><p id="release">${name}</p>`;

let workDirectory = '';
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let site = new Map<string, Uint8Array>();
/** What the site does right now: down (5xx), or slow to answer the signed list. */
const knobs = { down: false, listDelayMs: 0 };
const origin = (): string => `http://127.0.0.1:${server.port}`;

let trusted: Awaited<ReturnType<typeof releaseKey>>;
let stranger: Awaited<ReturnType<typeof releaseKey>>;
let counter = 0;
const next = (): number => {
  counter += 1;
  return counter;
};

/** Publishes one release over the site: the page says which release it is. */
const publish = async (
  name: string,
  sequence: number,
  key: Awaited<ReturnType<typeof releaseKey>> = trusted,
): Promise<void> => {
  site = await signedRelease({
    directory: workDirectory,
    name: `${name}-${next()}`,
    files: new Map<string, string | Uint8Array>([['index.html', page(name)]]),
    identity: { commit: `a${String(sequence).padStart(6, '0')}`, sequence },
    key,
  });
};

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-release-reload-'));
  trusted = await releaseKey(workDirectory, 'trusted');
  stranger = await releaseKey(workDirectory, 'stranger');
  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      if (knobs.down) return new Response('down', { status: 503 });
      const { pathname } = new URL(request.url);
      const path = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (path === 'release-manifest.json' && knobs.listDelayMs > 0) await Bun.sleep(knobs.listDelayMs);
      const bytes = site.get(path);
      if (bytes === undefined) return new Response('not found', { status: 404 });
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/plain';
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': type, 'cache-control': 'no-store' },
      });
    },
  });
}, 240_000);

afterAll(async () => {
  await server?.stop(true);
  if (workDirectory !== '') await rm(workDirectory, { recursive: true, force: true });
});

/** A fresh profile with the worker installed, controlling its page, and the site's release `name` on screen. */
const install = async (): Promise<{ context: BrowserContext; tab: Page }> => {
  knobs.down = false;
  knobs.listDelayMs = 0;
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${origin()}/`);
  await tab.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.verified.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await tab.reload();
  await tab.waitForFunction(() => navigator.serviceWorker.controller !== null);
  return { context, tab };
};

const shown = async (tab: Page): Promise<string | null> => await tab.textContent('#release');

/** The outcome the worker last recorded, as the page asks for it. */
const outcome = async (tab: Page): Promise<unknown> =>
  await tab.evaluate(
    () =>
      new Promise(done => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => done((event.data as { outcome: unknown }).outcome);
        navigator.serviceWorker.controller?.postMessage({ type: 'fy-release-status' }, [channel.port2]);
      }),
  );

describe('a reload after a newer signed release was published', () => {
  test('one reload shows the new release, not two', async () => {
    await publish('release-1', 1);
    const { context, tab } = await install();
    try {
      expect(await shown(tab)).toBe('release-1');
      await publish('release-2', 2);
      await tab.reload();
      expect(await shown(tab)).toBe('release-2');
    } finally {
      await context.close();
    }
  }, 60_000);

  test('the site being down starts the installed release', async () => {
    await publish('release-1', 1);
    const { context, tab } = await install();
    try {
      knobs.down = true;
      await tab.reload();
      expect(await shown(tab)).toBe('release-1');
    } finally {
      await context.close();
    }
  }, 60_000);

  test('a list slower than the deadline is waited for no longer than the deadline, and lands behind the reload', async () => {
    await publish('release-1', 1);
    const { context, tab } = await install();
    try {
      await publish('release-2', 2);
      knobs.listDelayMs = RELEASE_CHECK_DEADLINE_MS + 2_000;
      await tab.reload();
      expect(await shown(tab)).toBe('release-1');
      // The check was not abandoned: it finishes behind the reload, and the next one is the new release.
      await waitFor(
        async () => ((await outcome(tab)) as { status?: string } | null)?.status === 'updated',
        'the late check to land',
        {
          within: 30_000,
        },
      );
      knobs.listDelayMs = 0;
      await tab.reload();
      expect(await shown(tab)).toBe('release-2');
    } finally {
      await context.close();
    }
  }, 90_000);

  test('a release signed by a key the worker does not trust is never shown, and the refusal is said', async () => {
    await publish('release-1', 1);
    const { context, tab } = await install();
    try {
      await publish('release-evil', 2, stranger);
      await tab.reload();
      expect(await shown(tab)).toBe('release-1');
      expect(await outcome(tab)).toEqual({ status: 'refused', refusal: 'unknown-key', hadRelease: true });
    } finally {
      await context.close();
    }
  }, 60_000);
});
