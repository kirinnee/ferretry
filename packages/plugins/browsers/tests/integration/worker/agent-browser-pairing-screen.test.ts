import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveWindowLedger } from '@ferretry/std/live-window';
import { APP_EVAL_REFUSAL, PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import should from 'should';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { protectionWindows } from '../../../daemon/protection/windows.ts';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { SurfaceControl } from '../../../daemon/tools/control.ts';
import { rootFiles } from '../../../daemon/tools/files.ts';
import { BrowserTools } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import type { BrowserToolCall } from '../../../daemon/tools/wire.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { browserKernel } from '../../support/kernel.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';
import { launcherPorts, REAL_WORKER } from '../../support/process-workers.ts';
import { wallClock } from '../../support/wall-clock.ts';
import { workRoots } from '../../support/work-root.ts';

/**
 * A PAGE SHOWING A LIVE PAIRING CODE, IN A REAL HEADLESS CHROME (docs/pairing.md, "Never show it to an agent").
 *
 * Production end to end — the launcher, the browser worker over DevTools, the per-session browser service and the agent
 * tools — against fake pages that carry the app's marker and the repo's FAKE code. No real code is ever minted or
 * shown. Every string an agent was handed (each answer, each refusal) is collected, and none holds the code.
 */
const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const WORKERS = REAL_WORKER();
const FAKE_CODE = 'FAKE-PAIR-0000';
const agent: ToolCaller = { kind: 'agent', sessionId: 's1' };
const sessions = new Set(['s1']);

/** The app's own head markup while it shows a code, and the scripts that show and hide one like the app does. */
const MARKED_HEAD = `<meta name="ferretry-pairing-screen-seen" content="1"><meta name="ferretry-pairing-screen" content="shown">`;
const CODE_BODY = `<h1>Add a device</h1><p id="code">${FAKE_CODE}</p><svg width="40" height="40"><text y="20">${FAKE_CODE}</text></svg>`;
const SHOW_HIDE = `<script>
const SEEN = 'ferretry-pairing-screen-seen', MARK = 'ferretry-pairing-screen';
const q = new URLSearchParams(location.search);
function bump() {
  let seen = document.head.querySelector('meta[name=' + SEEN + ']');
  if (!seen) { seen = document.createElement('meta'); seen.name = SEEN; seen.content = '0'; document.head.append(seen); }
  seen.content = String(Number(seen.content) + 1);
}
function show() {
  bump();
  const marker = document.createElement('meta'); marker.name = MARK; marker.content = 'shown'; document.head.append(marker);
  document.getElementById('o').textContent = '${FAKE_CODE}';
}
function hide() {
  document.head.querySelector('meta[name=' + MARK + ']')?.remove();
  document.getElementById('o').textContent = 'idle';
}
if (q.get('showAt')) setTimeout(show, Number(q.get('showAt')));
if (q.get('hideAt')) setTimeout(hide, Number(q.get('hideAt')));
</script>`;

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let tools: BrowserTools;
let base = '';
/** The daemon's own record of when a pairing code was live: what a page script cannot write. */
const pairing = new LiveWindowLedger(() => Date.now());
const MINUTE = 60_000;
/** Everything an agent was handed, answer or refusal. */
const handedOver: string[] = [];

beforeAll(async () => {
  if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
  root = await mkdtemp(join(tmpdir(), 'ferretry-pairing-screen-'));
  await mkdir(join(root, 'work', '.fy'), { recursive: true });
  site = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      const url = new URL(request.url);
      const html = (head: string, body: string) =>
        new Response(`<html><head>${head}</head><body>${body}</body></html>`, {
          headers: { 'content-type': 'text/html' },
        });
      if (url.pathname === '/pair') return html(MARKED_HEAD, CODE_BODY);
      if (url.pathname === '/plain') return html('', '<p id="o">hello</p>');
      if (url.pathname === '/dyn') return html('', `<p id="o">idle</p>${SHOW_HIDE}`);
      if (url.pathname === '/framed') return html('', '<p id="o">outer</p><iframe id="f" src="/pair"></iframe>');
      // A page with a button that opens the pair screen as a popup, keeping its handle: a click is the user gesture.
      if (url.pathname === '/opener')
        return html(
          '',
          '<p id="o">opener</p><button id="open" onclick="window.open(\'/pair\', \'pairwin\')">open</button>',
        );
      // A page whose own script DELETES the marker and the sighting count: all it can write.
      if (url.pathname === '/forged')
        return html(
          MARKED_HEAD,
          `<h1>Add a device</h1><p id="code">${FAKE_CODE}</p><script>document.head.querySelectorAll('meta').forEach(meta => meta.remove())</script>`,
        );
      // A page that navigates itself away after a moment: the document that held the code is then gone.
      if (url.pathname === '/leaves')
        return html('', `<p id="o">${FAKE_CODE}</p><script>setTimeout(() => location.assign('/plain'), 600)</script>`);
      if (url.pathname === '/minted')
        return html(
          '',
          `<p id="o">closed</p><script>fetch('/v1/pair/code', { method: 'POST' }).then(r => r.text())</script>`,
        );
      if (url.pathname === '/v1/pair/code')
        return new Response(
          JSON.stringify({ code: FAKE_CODE, pairUrl: `https://x.example.test/pair#v1;code=${FAKE_CODE}` }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      return html('', '<p id="o">not found</p>');
    },
  });
  base = `http://127.0.0.1:${String(site.port)}`;
  browser = new BrowserSessionService(
    { get: async id => (sessions.has(id) ? {} : undefined) },
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
  tools = new BrowserTools({
    browser,
    control: new SurfaceControl({ publish: async () => undefined, history: async () => [] }, { now: () => Date.now() }),
    kernel: browserKernel().kernel,
    policy: { allows: async () => true },
    files: rootFiles(
      workRoots(join(root, 'work'), join(root, 'work', '.fy')),
      nodeStagedFiles(join(root, 'upload'), wallClock()),
    ),
    binaryName: 'fy',
    protection: protectionWindows({
      now: () => Date.now(),
      connections: () => ({
        advertisement: () =>
          ({
            advertisement: { kind: 'none', refusal: { reason: 'none' } },
            // The app is wherever THIS fake site is: never a hard-coded address.
            appOrigin: base,
            allowedOrigins: [base],
          }) as never,
      }),
      windows: [() => pairing],
    }),
  });
}, 60_000);

afterAll(async () => {
  await browser?.closeAll();
  site?.stop(true);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

/**
 * Closes every page of the session that is on the pair screen but was never named by the agent (a popup a script opened):
 * every window of the app's origin can reach every other, so a stray one that still shows the marker refuses its siblings.
 */
async function closeStrays(): Promise<void> {
  const status = await browser.status('s1');
  for (const page of status.pages.filter(candidate => candidate.url.endsWith('/pair')))
    await browser.act('s1', { action: 'close-page', pageId: page.id }).catch(() => undefined);
}

/** One tool call as an agent makes it: what it was handed (or refused with) is kept for the final look. */
async function call(request: BrowserToolCall): Promise<{ text?: string; picture?: unknown; error?: string }> {
  try {
    const answer = await tools.call(agent, request);
    handedOver.push(JSON.stringify({ ...answer, picture: answer.picture === undefined ? undefined : 'picture' }));
    return { text: `${answer.summary}\n${answer.output ?? ''}`, picture: answer.picture };
  } catch (error) {
    const message = (error as Error).message;
    handedOver.push(message);
    return { error: message };
  }
}

describe('the agent browser, in a real Chrome, on a page showing a live pairing code', () => {
  it('should refuse every read, picture, script, log and content wait of a marked page, and hand over no content', async () => {
    // Arrange
    await call({ tool: 'browser.open', name: 'pair', url: `${base}/pair` });
    const reads: BrowserToolCall[] = [
      { tool: 'browser.read', name: 'pair' },
      { tool: 'browser.read', name: 'pair', mode: 'snapshot' },
      { tool: 'browser.read', name: 'pair', mode: 'a11y' },
      { tool: 'browser.read', name: 'pair', selector: '#code' },
      { tool: 'browser.screenshot', name: 'pair' },
      { tool: 'browser.highlight', name: 'pair', selector: '#code' },
      { tool: 'browser.pdf', name: 'pair' },
      { tool: 'browser.eval', name: 'pair', function: '() => document.body.innerText' },
      { tool: 'browser.console', name: 'pair' },
      { tool: 'browser.network', name: 'pair', action: 'list' },
      { tool: 'browser.wait_for', name: 'pair', text: FAKE_CODE },
      { tool: 'browser.wait_for', name: 'pair', textGone: FAKE_CODE },
      { tool: 'browser.wait_for', name: 'pair', selector: '#code' },
    ];

    for (const request of reads) {
      // Act
      const answer = await call(request);

      // Assert
      should(answer.error).equal(PAIRING_SCREEN_REFUSAL);
      should(answer.picture).be.undefined();
    }

    // Act — leaving still works, and so does a wait that reads nothing of the page
    const timed = await call({ tool: 'browser.wait_for', name: 'pair', time: 100 });
    const away = await call({ tool: 'browser.navigate', name: 'pair', url: `${base}/plain` });
    const closed = await call({ tool: 'browser.close', name: 'pair' });

    // Assert
    should(timed.error).be.undefined();
    should(away.error).be.undefined();
    should(closed.error).be.undefined();
  }, 60_000);

  it('should read the same app normally once the marker is gone', async () => {
    // Arrange, Act
    await call({ tool: 'browser.open', name: 'plain', url: `${base}/plain` });
    const read = await call({ tool: 'browser.read', name: 'plain' });
    const shot = await call({ tool: 'browser.screenshot', name: 'plain' });
    const waited = await call({ tool: 'browser.wait_for', name: 'plain', text: 'hello' });
    await call({ tool: 'browser.close', name: 'plain' });

    // Assert
    should(read.text).containEql('hello');
    should(shot.picture).not.be.undefined();
    should(waited.error).be.undefined();
  }, 60_000);

  it('P1-2/3: should discard a content wait that was running when the marker arrived, and show none of what it read', async () => {
    // Arrange — the page is plain until 1.5 s after it loads; the wait is admitted at once and runs 3 s
    await call({ tool: 'browser.open', name: 'late', url: `${base}/dyn?showAt=1500` });

    // Act
    const answer = await call({ tool: 'browser.wait_for', name: 'late', text: 'never there', timeoutMs: 3_000 });

    // Assert
    should(answer.error).equal(PAIRING_SCREEN_REFUSAL);
    // It is refused afterwards too: the page is marked now.
    should((await call({ tool: 'browser.read', name: 'late' })).error).equal(PAIRING_SCREEN_REFUSAL);
    await call({ tool: 'browser.close', name: 'late' });
  }, 60_000);

  it('P1-3: should discard a content wait that ran while a code came and went (no marker left, but a code was shown)', async () => {
    // Arrange — shown at 1 s, gone at 2 s; the wait runs from the start to 3.5 s
    await call({ tool: 'browser.open', name: 'blink', url: `${base}/dyn?showAt=1000&hideAt=2000` });

    // Act
    const answer = await call({ tool: 'browser.wait_for', name: 'blink', text: 'never there', timeoutMs: 3_500 });
    // the wait can end early (it is refused the moment the code shows); let the page finish its blink
    await call({ tool: 'browser.wait_for', name: 'blink', time: 2_000 });
    const after = await call({ tool: 'browser.read', name: 'blink' });

    // Assert
    should(answer.error).equal(PAIRING_SCREEN_REFUSAL);
    // The code is gone from the page again, so a fresh read is the page as it is now.
    should(after.error).be.undefined();
    should(after.text).containEql('idle');
    await call({ tool: 'browser.close', name: 'blink' });
  }, 60_000);

  it('P1-4: should refuse a page whose same-origin frame shows the code', async () => {
    // Arrange
    await call({ tool: 'browser.open', name: 'framed', url: `${base}/framed` });

    for (const request of [
      { tool: 'browser.read', name: 'framed' },
      { tool: 'browser.screenshot', name: 'framed' },
      // a marked group: the marker is the first thing asked, so this is the pairing sentence (and the script never runs)
      {
        tool: 'browser.eval',
        name: 'framed',
        function: '() => document.getElementById("f").contentDocument.body.innerText',
      },
    ] satisfies BrowserToolCall[]) {
      // Act
      const answer = await call(request);

      // Assert
      should(answer.error).equal(PAIRING_SCREEN_REFUSAL);
    }
    await call({ tool: 'browser.close', name: 'framed' });
  }, 60_000);

  it('P1-4: should refuse a page that holds a window showing the code, a script in it, and the window too', async () => {
    // Arrange — the page's own button opens a same-origin popup (the pair screen) and keeps the handle
    await call({ tool: 'browser.open', name: 'opener', url: `${base}/opener` });

    // Act — the popup opens during the click (the click's own answer may or may not be caught by the window count: the
    // group is what the later calls are held to)
    await call({ tool: 'browser.click', name: 'opener', selector: '#open' });
    await call({ tool: 'browser.wait_for', name: 'opener', time: 500 });
    // Act — afterwards, a script that would read through the handle (a script never runs on the app), and a read
    const through = await call({
      tool: 'browser.eval',
      name: 'opener',
      function: '() => window.open("", "pairwin").document.body.innerText',
    });
    const text = await call({ tool: 'browser.read', name: 'opener' });

    // Assert
    should(through.error).equal(PAIRING_SCREEN_REFUSAL);
    should(text.error).equal(PAIRING_SCREEN_REFUSAL);
    await closeStrays();
    await call({ tool: 'browser.close', name: 'opener' });
  }, 60_000);

  it('should never show the body of the pairing mint in a network log, marked page or not', async () => {
    // Arrange — a page that has called the mint route and shows no code (the panel was closed)
    await call({ tool: 'browser.open', name: 'minted', url: `${base}/minted` });
    await call({ tool: 'browser.wait_for', name: 'minted', time: 500 });

    // Act
    const listed = await call({ tool: 'browser.network', name: 'minted', action: 'list' });
    const id = /^(r\d+)\b.*\/v1\/pair\/code/mu.exec(listed.text ?? '')?.[1];
    const got = await call({ tool: 'browser.network', name: 'minted', action: 'get', id: id ?? 'r1' });

    // Assert
    should(id).be.a.String();
    should(got.text).containEql('(body not shown: a pairing code)');
    await call({ tool: 'browser.close', name: 'minted' });
  }, 60_000);
  it('P1-1: should still refuse every read while the DAEMON says a code is live, when the page deleted its own marker', async () => {
    // Arrange — the page shows the code and its script removes the marker and the count; the daemon minted a code
    await call({ tool: 'browser.open', name: 'forged', url: `${base}/forged` });
    pairing.open('forged-1', Date.now() + 2 * MINUTE);

    for (const request of [
      { tool: 'browser.read', name: 'forged' },
      { tool: 'browser.screenshot', name: 'forged' },
      { tool: 'browser.pdf', name: 'forged' },
      { tool: 'browser.read', name: 'forged', selector: '#code' },
      { tool: 'browser.scroll', name: 'forged', text: FAKE_CODE },
      { tool: 'browser.click', name: 'forged', selector: '#code' },
    ] satisfies BrowserToolCall[]) {
      // Act
      const answer = await call(request);

      // Assert — the page says it is unmarked; the daemon's fact says otherwise
      should(answer.error).equal(PAIRING_SCREEN_REFUSAL);
      should(answer.picture).be.undefined();
    }
    // A script is never run on the app, whatever the page says of itself
    const script = await call({ tool: 'browser.eval', name: 'forged', function: '() => document.body.innerText' });
    should(script.error).equal(APP_EVAL_REFUSAL);
    pairing.close('forged-1');
    await call({ tool: 'browser.close', name: 'forged' });
  }, 60_000);

  it('P1-1: should discard a read when the page that held the code navigated away during it', async () => {
    // Arrange — nothing is live when the wait starts; the daemon mints a code 200 ms into it, and the page leaves at 600 ms
    await call({ tool: 'browser.open', name: 'leaves', url: `${base}/leaves` });
    setTimeout(() => pairing.open('leaves-1', Date.now() + 2 * MINUTE), 200);

    // Act — a wait on text is a read of the page; the document the code was minted over is gone by the time it ends
    const waited = await call({ tool: 'browser.wait_for', name: 'leaves', text: 'hello', timeoutMs: 5_000 });
    const afterwards = await call({ tool: 'browser.read', name: 'leaves' });

    // Assert — a navigation is no reason to forget the interval: the call overlapped it
    should(waited.error).equal(PAIRING_SCREEN_REFUSAL);
    should(afterwards.error).equal(PAIRING_SCREEN_REFUSAL);
    pairing.close('leaves-1');
    await call({ tool: 'browser.close', name: 'leaves' });
  }, 60_000);

  it('P1-2: should refuse a script on the app once a code was live, and still let a read answer', async () => {
    // Arrange — a plain app page is open; a code is minted and spent while it stays open
    await call({ tool: 'browser.open', name: 'life', url: `${base}/plain` });
    pairing.open('life-1', Date.now() + 2 * MINUTE);
    pairing.close('life-1');

    // Act
    const script = await call({ tool: 'browser.eval', name: 'life', function: '() => document.body.innerText' });
    const read = await call({ tool: 'browser.read', name: 'life' });

    // Assert
    should(script.error).equal(APP_EVAL_REFUSAL);
    should(read.text).containEql('hello');
    await call({ tool: 'browser.close', name: 'life' });
  }, 60_000);

  it('P1-2: should refuse a script on an app page even when no code has been live since it loaded (and run none)', async () => {
    // Arrange — the page loads after the last code was over
    await new Promise(resolve => setTimeout(resolve, 20));
    await call({ tool: 'browser.open', name: 'fresh', url: `${base}/plain` });

    // Act
    const script = await call({ tool: 'browser.eval', name: 'fresh', function: '() => document.body.innerText' });

    // Assert
    should(script.error).equal(APP_EVAL_REFUSAL);
    should(script.text).be.undefined();
    await call({ tool: 'browser.close', name: 'fresh' });
  }, 60_000);

  it('should have handed an agent the fake code in no answer, no refusal and no network body', () => {
    // Arrange, Act, Assert
    should(handedOver.length).be.above(10);
    should(handedOver.filter(text => text.includes(FAKE_CODE))).eql([]);
  });
});
