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
    fetch: request => {
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
        default:
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

/** What the agent is told after opening a page and reading it. */
async function told(name: string, url: string): Promise<string> {
  const opened = await tools.call(agent, { tool: 'browser.open', name, url });
  const read = await tools.call(agent, { tool: 'browser.read', name } as never);
  const snapshot = await browser.actOnPage(SESSION, name, { action: 'read', mode: 'text' } as never);
  const acted =
    'result' in snapshot ? snapshot.result.pages.find(page => page.id === snapshot.result.actedPageId) : undefined;
  await tools.call(agent, { tool: 'browser.close', name });
  return JSON.stringify({ opened, read, challenge: acted?.challenge });
}

describe('a sub-request challenge on a real page', () => {
  it('should tell the agent a blank page whose first-party script is challenged is a human check', async () => {
    const said = await told('blocked', `${first}/blocked`);

    should(said).containEql(NOTE);
    should(said).containEql('"challenge":{"provider":"cloudflare"}');
  }, 60_000);

  it('should say nothing of a plain 403 script that carries no challenge header', async () => {
    const said = await told('plain', `${first}/plain`);

    should(said).not.containEql(NOTE);
    should(said).not.containEql('"challenge"');
  }, 60_000);

  it('should say nothing of a page with text and one blocked third-party tracker', async () => {
    const said = await told('tracked', `${first}/tracked`);

    should(said).not.containEql(NOTE);
    should(said).not.containEql('"challenge"');
  }, 60_000);
});
