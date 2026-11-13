import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRING_SCREEN_REFUSAL } from '@ferretry/std/pairing-screen';
import should from 'should';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
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
      if (url.pathname === '/opener') return html('', '<p id="o">opener</p>');
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
  });
}, 60_000);

afterAll(async () => {
  await browser?.closeAll();
  site?.stop(true);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

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

  it('P1-2/3: should discard an async script that was running when the marker arrived, and show none of what it read', async () => {
    // Arrange — the page is plain until 1.5 s after it loads; the script is admitted at once and runs 3 s
    await call({ tool: 'browser.open', name: 'late', url: `${base}/dyn?showAt=1500` });

    // Act
    const answer = await call({
      tool: 'browser.eval',
      name: 'late',
      function:
        '() => new Promise(resolve => setTimeout(() => resolve(document.getElementById("o").textContent), 3000))',
      timeoutMs: 20_000,
    });

    // Assert
    should(answer.error).equal(PAIRING_SCREEN_REFUSAL);
    // It is refused afterwards too: the page is marked now.
    should((await call({ tool: 'browser.read', name: 'late' })).error).equal(PAIRING_SCREEN_REFUSAL);
    await call({ tool: 'browser.close', name: 'late' });
  }, 60_000);

  it('P1-3: should discard a script that ran while a code came and went (no marker left, but a code was shown)', async () => {
    // Arrange — shown at 1 s, gone at 2 s; the script runs from the start to 3.5 s
    await call({ tool: 'browser.open', name: 'blink', url: `${base}/dyn?showAt=1000&hideAt=2000` });

    // Act
    const answer = await call({
      tool: 'browser.eval',
      name: 'blink',
      function:
        '() => new Promise(resolve => setTimeout(() => resolve(document.getElementById("o").textContent), 3500))',
      timeoutMs: 20_000,
    });
    const after = await call({ tool: 'browser.read', name: 'blink' });

    // Assert
    should(answer.error).equal(PAIRING_SCREEN_REFUSAL);
    // The code is gone from the page again, so a fresh read is the page as it is now.
    should(after.text).containEql('idle');
    await call({ tool: 'browser.close', name: 'blink' });
  }, 60_000);

  it('P1-4: should refuse a page whose same-origin frame shows the code', async () => {
    // Arrange
    await call({ tool: 'browser.open', name: 'framed', url: `${base}/framed` });

    for (const request of [
      { tool: 'browser.read', name: 'framed' },
      { tool: 'browser.screenshot', name: 'framed' },
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

  it('P1-4: should refuse a script in a page that holds a window showing the code, and the window too', async () => {
    // Arrange — the page opens a same-origin popup (the pair screen) and keeps the handle
    await call({ tool: 'browser.open', name: 'opener', url: `${base}/opener` });

    // Act — the popup opens while the script runs: the group was not the one that was checked
    const opening = await call({
      tool: 'browser.eval',
      name: 'opener',
      function: '() => { window.open("/pair", "pairwin"); return new Promise(resolve => setTimeout(resolve, 1500)); }',
      timeoutMs: 20_000,
    });
    // Act — afterwards, a script that would read through the handle
    const through = await call({
      tool: 'browser.eval',
      name: 'opener',
      function: '() => window.open("", "pairwin").document.body.innerText',
    });
    const text = await call({ tool: 'browser.read', name: 'opener' });

    // Assert
    should(opening.error).equal(PAIRING_SCREEN_REFUSAL);
    should(through.error).equal(PAIRING_SCREEN_REFUSAL);
    should(text.error).equal(PAIRING_SCREEN_REFUSAL);
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

  it('should have handed an agent the fake code in no answer, no refusal and no network body', () => {
    // Arrange, Act, Assert
    should(handedOver.length).be.above(10);
    should(handedOver.filter(text => text.includes(FAKE_CODE))).eql([]);
  });
});
