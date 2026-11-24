import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { SealedGate } from '../../../daemon/sealed/gate.ts';
import { SealedPages } from '../../../daemon/sealed/page-guards.ts';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { SurfaceControl } from '../../../daemon/tools/control.ts';
import { rootFiles } from '../../../daemon/tools/files.ts';
import { BrowserTools } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { browserKernel } from '../../support/kernel.ts';
import { quietProtection } from '../../support/no-pairing-screen.ts';
import { launcherPorts, REAL_WORKER } from '../../support/process-workers.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';
import { workRoots } from '../../support/work-root.ts';

/**
 * A BLANK PAGE BEHIND A SUB-REQUEST CHALLENGE IS A HUMAN CHECK, IN A REAL HEADLESS CHROME.
 *
 * A site lets the document load but answers its scripts and stylesheets with 403 + `cf-mitigated: challenge`, so the
 * page is blank. Local fixture pages only (a local server; no real site is loaded). The agent's browser tool answer
 * must carry the same human-check note a top-level challenge gets; an ordinary 403 script, or a page with text and
 * one blocked third-party tracker, must not.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const WORKERS = REAL_WORKER();
const SESSION = 's1';
const agent: ToolCaller = { kind: 'agent', sessionId: SESSION };
const NOTE = 'human check';

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let tools: BrowserTools;
let first = '';
let other = '';

const CHALLENGE = { 'content-type': 'text/javascript', 'cf-mitigated': 'challenge' };

beforeAll(async () => {
  if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
  root = await mkdtemp(join(tmpdir(), 'ferretry-subresource-challenge-'));
  await mkdir(join(root, 'work', '.fy'), { recursive: true });
  site = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch: async request => {
      const { pathname } = new URL(request.url);
      const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
      switch (pathname) {
        // A blank document whose own script and stylesheet are challenged: the Navia shape.
        case '/blocked':
          return html(
            '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
          );
        case '/app.js':
        case '/app.css':
          return new Response('', { status: 403, headers: CHALLENGE });
        // A blank document whose script is refused the ordinary way: no header.
        case '/plain':
          return html('<html><body><div id="root"></div><script src="/plain.js"></script></body></html>');
        case '/plain.js':
          return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/javascript' } });
        // A page with text and one challenged third-party tracker (another host: the same server by another name).
        case '/tracked':
          return html(
            `<html><body><h1>Order history</h1><p>You have no orders yet, and nothing here is hidden.</p><script src="${other}/tracker.js"></script></body></html>`,
          );
        case '/tracker.js':
          return new Response('', { status: 403, headers: CHALLENGE });
        // A page with text and a flood of challenged trackers, then (answered last) one challenged first-party script.
        case '/flood': {
          const trackers = Array.from(
            { length: 20 },
            (_, each) => `<script src="${other}/t${String(each)}.js"></script>`,
          );
          return html(
            `<html><body><h1>Order history</h1><p>You have no orders yet, and nothing here is hidden.</p>${trackers.join('')}<script src="/late.js"></script></body></html>`,
          );
        }
        case '/late.js':
          await Bun.sleep(600);
          return new Response('', { status: 403, headers: CHALLENGE });
        // A link target that commits nothing: the browser stays on the page it was on.
        case '/nothing':
          return new Response(null, { status: 204 });
        case '/text':
          return html(
            '<html><body><h1>Order history</h1><p>You have no orders yet, and nothing is hidden.</p></body></html>',
          );
        default:
          if (/^\/t\d+\.js$/.test(pathname)) return new Response('', { status: 403, headers: CHALLENGE });
          return new Response('not found', { status: 404 });
      }
    },
  });
  first = `http://127.0.0.1:${String(site.port)}`;
  other = `http://localhost:${String(site.port)}`;
  browser = new BrowserSessionService(
    { get: async id => (id === SESSION ? {} : undefined) },
    new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      WORKERS.start,
      launcherPorts(),
      { FY_CHROME_BIN: chrome, PATH: process.env.PATH, HOME: process.env.HOME },
      undefined,
      { stageDirectory: join(root, 'stage'), listenerProver: unprovenListenerProver() },
    ),
    () => Date.now(),
  );
  const sealed = new SealedPages();
  const control = new SurfaceControl(
    { publish: async () => undefined, history: async () => [] },
    { now: () => Date.now() },
  );
  tools = new BrowserTools({
    browser,
    control,
    kernel: browserKernel().kernel as never,
    policy: { allows: async () => true },
    files: rootFiles(
      workRoots(join(root, 'work'), join(root, 'work', '.fy')),
      nodeStagedFiles(join(root, 'upload'), { now: () => Date.now() } as never),
    ),
    binaryName: 'fy',
    sealed: new SealedGate({ sealed, mask: async text => text }),
    protection: quietProtection(),
  });
}, 90_000);

afterAll(async () => {
  await browser?.closeAll();
  site?.stop(true);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

interface Told {
  /** The `browser.open` answer's words. */
  readonly opened: string;
  /** The `browser.read` answer's words. */
  readonly read: string;
  /** The page's own challenge hint, as the view sees it. */
  readonly challenge: unknown;
}

/** The words of one tool answer. */
const wordsOf = (answer: { readonly summary: string }): string => answer.summary;

/** The challenge hint the view sees on a page. */
async function hintOf(name: string): Promise<unknown> {
  const snapshot = await browser.actOnPage(SESSION, name, { action: 'read', mode: 'text' } as never);
  return 'result' in snapshot
    ? snapshot.result.pages.find(page => page.id === snapshot.result.actedPageId)?.challenge
    : undefined;
}

/** What the agent is told after opening a page and after reading it, each on its own. */
async function told(name: string, url: string): Promise<Told> {
  const opened = wordsOf(await tools.call(agent, { tool: 'browser.open', name, url }));
  const read = wordsOf(await tools.call(agent, { tool: 'browser.read', name } as never));
  const challenge = await hintOf(name);
  await tools.call(agent, { tool: 'browser.close', name });
  return { opened, read, challenge };
}

describe('a sub-request challenge on a real page', () => {
  it('should tell the agent, on open and on read alike, that a blank page with a challenged first-party script is a human check', async () => {
    const said = await told('blocked', `${first}/blocked`);

    should(said.opened).containEql(NOTE);
    should(said.read).containEql(NOTE);
    should(said.challenge).deepEqual({ provider: 'cloudflare' });
  }, 60_000);

  it('should say nothing of a plain 403 script that carries no challenge header', async () => {
    const said = await told('plain', `${first}/plain`);

    should(said.opened).not.containEql(NOTE);
    should(said.read).not.containEql(NOTE);
    should(said.challenge).be.undefined();
  }, 60_000);

  it('should say nothing of a page with text and one blocked third-party tracker', async () => {
    const said = await told('tracked', `${first}/tracked`);

    should(said.opened).not.containEql(NOTE);
    should(said.read).not.containEql(NOTE);
    should(said.challenge).be.undefined();
  }, 60_000);

  it('should still see a first-party challenge that comes after more challenged trackers than the record holds', async () => {
    const said = await told('flood', `${first}/flood`);

    should(said.read).containEql(NOTE);
    should(said.challenge).deepEqual({ provider: 'cloudflare' });
  }, 60_000);

  it('should keep the current page’s evidence through a navigation that commits nothing, and drop it when one commits', async () => {
    await tools.call(agent, { tool: 'browser.open', name: 'stay', url: `${first}/blocked` });

    // Chrome aborts a navigation that answers 204, so the tool reports a failure and the page stays where it was.
    await tools
      .call(agent, { tool: 'browser.navigate', name: 'stay', url: `${first}/nothing` } as never)
      .catch(() => undefined);
    const stayed = await hintOf('stay');
    await tools.call(agent, { tool: 'browser.navigate', name: 'stay', url: `${first}/text` } as never);
    const moved = await hintOf('stay');
    await tools.call(agent, { tool: 'browser.close', name: 'stay' });

    should(stayed).deepEqual({ provider: 'cloudflare' });
    should(moved).be.undefined();
  }, 60_000);
});
