import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/browser/control/index.ts';
import { NodeAgentFilesystem } from '../../../../src/adapters/agent-files/index.ts';
import { NodeSessionBrowserLauncher } from '../../../../src/adapters/browser/runtime/index.ts';
import {
  AgentFiles,
  type AgentToolCaller,
  AgentToolError,
  AgentToolService,
  BrowserSessionService,
  NO_REDACTION,
  SurfaceControl,
} from '../../../../src/lib/index.ts';
import { FakeTerminals } from '../../../unit/runtime/mounts/support.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * THE MACHINE'S AGENT BROWSER, AGAINST A REAL HEADLESS CHROME.
 *
 * Everything here is production — the launcher, the browser worker over CDP, the per-session browser
 * service and the agent tools on top of it — and Chrome is the real one the int tier already runs
 * (`google-chrome` or `chromium` on PATH). The properties are the ones only a real browser can show:
 * that two people's keystrokes land where they were aimed while both pages stream, that a takeover of
 * one tab leaves the agent working on another, and that an incognito page's cookies are its own.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const node = Bun.which('node');
const WORKER = join(import.meta.dir, '../../../../bin/browser-worker.ts');
const sessions = new Set(['s1', 's2']);

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let tools: AgentToolService;
let base = '';

const agent = (sessionId: string): AgentToolCaller => ({ kind: 'agent', sessionId });
const person: AgentToolCaller & { readonly kind: 'person' } = {
  kind: 'person',
  sessionId: 's1',
  actor: { kind: 'host' },
  openedBy: { by: 'local' },
};

/** The cookie a page's own server saw, read back out of the page's text. */
async function cookieSeenBy(sessionId: string, page: string): Promise<string> {
  await browser.actOnPage(sessionId, page, { action: 'navigate', url: `${base}/read` });
  const read = await browser.actOnPage(sessionId, page, { action: 'read', selector: '#c' });
  return 'result' in read && 'text' in read.result ? String(read.result.text) : '';
}

beforeAll(async () => {
  if (chrome === null || node === null) throw new Error('this test needs a real Chrome and Node on PATH');
  root = await mkdtemp(join(tmpdir(), 'ferretry-agent-browser-'));
  await mkdir(join(root, 'work'), { recursive: true });
  site = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      const url = new URL(request.url);
      const page = (body: string) =>
        new Response(`<html><body><input id="q"><p id="c">${body}</p></body></html>`, {
          headers: {
            'content-type': 'text/html',
            ...(url.pathname === '/set' ? { 'set-cookie': `who=${url.searchParams.get('v') ?? ''}; Path=/` } : {}),
          },
        });
      if (url.pathname === '/upload')
        return new Response(
          '<html><body><input id="f" type="file" multiple>' +
            '<button id="pick" onclick="document.getElementById(\'hidden\').click()">Choose</button>' +
            '<input id="hidden" type="file" style="display:none">' +
            '<div id="zone" style="width:200px;height:100px;background:#ccc">drop here</div><p id="r">none</p>' +
            '<script>' +
            "const show=(files)=>{document.getElementById('r').textContent=[...files].map(f=>f.name+':'+f.size).join(',')};" +
            "document.getElementById('f').onchange=e=>show(e.target.files);" +
            "document.getElementById('hidden').onchange=e=>show(e.target.files);" +
            "const z=document.getElementById('zone');" +
            "z.addEventListener('dragover',e=>e.preventDefault());" +
            "z.addEventListener('drop',e=>{e.preventDefault();show(e.dataTransfer.files)});" +
            '</script></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      if (url.pathname === '/downloads')
        return new Response(
          '<html><body><a id="dl" href="/data.csv" download>Export</a><h1>Report</h1></body></html>',
          {
            headers: { 'content-type': 'text/html' },
          },
        );
      if (url.pathname === '/data.csv')
        return new Response('a,b\n1,2\n', {
          headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="data.csv"' },
        });
      if (url.pathname === '/form')
        return new Response(
          '<html><body><label>Name <input id="n"></label>' +
            "<button onclick=\"document.getElementById('o').textContent='clicked:'+document.getElementById('n').value\">Go</button>" +
            '<p id="o">idle</p></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      if (url.pathname === '/lifecycle')
        return new Response(
          "<html><body><button id=\"ask\" onclick=\"console.log('logged-by-page');fetch('/ping?token=abc');" +
            "document.getElementById('o').textContent='answer:'+prompt('Name?')\">Ask</button>" +
            '<a id="pop" target="_blank" href="/read">popup</a><p id="o">idle</p>' +
            "<script>setTimeout(()=>document.body.append('late-text'),1500)</script></body></html>",
          { headers: { 'content-type': 'text/html' } },
        );
      if (url.pathname === '/ping')
        return new Response('pong', { headers: { 'x-api-key': 'k', 'content-type': 'text/plain' } });
      return page(url.pathname === '/set' ? 'set' : `cookie:${request.headers.get('cookie') ?? ''}`);
    },
  });
  base = `http://127.0.0.1:${String(site.port)}`;
  browser = new BrowserSessionService(
    { get: async id => (sessions.has(id) ? {} : undefined) },
    new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      { kind: 'source', entry: WORKER },
      node,
      {
        FY_CHROME_BIN: chrome,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      undefined,
      { stageDirectory: join(root, 'stage') },
    ),
    () => Date.now(),
  );
  tools = new AgentToolService({
    terminals: new FakeTerminals(['s1', 's2']),
    browser,
    control: new SurfaceControl({ publish: async () => undefined, history: async () => [] }, { now: () => Date.now() }),
    policy: { allows: async () => true },
    files: new AgentFiles({
      fs: new NodeAgentFilesystem(),
      folderOf: async () => join(root, 'work'),
      readAttachment: async () => {
        throw new Error('this test has no attachments');
      },
      uploadDirectory: join(root, 'upload'),
      token: () => crypto.randomUUID().replaceAll('-', ''),
    }),
    audit: { record: async () => undefined },
    redactor: NO_REDACTION,
    clock: { now: () => Date.now() },
    sleep: async milliseconds => await Bun.sleep(milliseconds),
  });
}, 60_000);

afterAll(async () => {
  await browser?.closeAll();
  site?.stop(true);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

/** The ref a snapshot line gives the first element whose line contains `text`. */
async function refOf(name: string, text: string): Promise<string> {
  const found = await tools.call(agent('s1'), { tool: 'browser.read', name, mode: 'snapshot', find: text });
  const ref = /\[ref=([a-z0-9]+)\]/u.exec(found.output ?? '')?.[1];
  if (ref === undefined) throw new Error(`no ref for ${text} in: ${found.output ?? ''}`);
  return ref;
}

describe('the machine agent browser, in a real Chrome', () => {
  it('should act on the refs a snapshot hands out, and refuse a ref the page no longer knows', async () => {
    // Arrange
    await tools.call(agent('s1'), { tool: 'browser.open', name: 'refs', url: `${base}/form` });

    // Act
    const snapshot = await tools.call(agent('s1'), { tool: 'browser.read', name: 'refs', mode: 'snapshot' });
    const field = await refOf('refs', 'textbox');
    const button = await refOf('refs', 'button "Go"');
    await tools.call(agent('s1'), { tool: 'browser.type', name: 'refs', ref: field, text: 'hadi' });
    await tools.call(agent('s1'), { tool: 'browser.click', name: 'refs', ref: button });
    const after = await tools.call(agent('s1'), { tool: 'browser.read', name: 'refs', selector: '#o' });
    await tools.call(agent('s1'), { tool: 'browser.navigate', name: 'refs', url: `${base}/read` });
    const stale = await tools.call(agent('s1'), { tool: 'browser.click', name: 'refs', ref: button }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Back may restore the page from Chrome's back/forward cache, clicked state and all, so it is read by
    // where the page is; a reload is what brings the form back fresh.
    const back = await tools.call(agent('s1'), { tool: 'browser.navigate', name: 'refs', history: 'back' });
    await tools.call(agent('s1'), { tool: 'browser.navigate', name: 'refs', history: 'reload' });
    const reloaded = await tools.call(agent('s1'), { tool: 'browser.read', name: 'refs', selector: '#o' });
    const shot = await tools.call(agent('s1'), { tool: 'browser.screenshot', name: 'refs', format: 'jpeg' });

    // Assert
    should(snapshot.output).match(/button "Go" \[ref=e\d+\]/u);
    should(after.output).equal('clicked:hadi');
    should(stale).be.instanceOf(AgentToolError);
    should((stale as AgentToolError).message).containEql('latest snapshot');
    should(back.summary).containEql(`(now at ${base}/form)`);
    should(reloaded.output).equal('idle');
    should(shot.screenshotFormat).equal('jpeg');
    await tools.call(agent('s1'), { tool: 'browser.close', name: 'refs' });
  }, 60_000);

  it('should land a person’s typing in their tab while the agent drives another, with both tabs streaming', async () => {
    // Arrange — the person's page (their toolbar opened it) and the agent's page, in one session.
    await browser.act('s1', { action: 'new-page', url: `${base}/read` });
    await tools.call(agent('s1'), { tool: 'browser.open', name: 'app', url: `${base}/read` });
    await browser.act('s1', { action: 'click', selector: '#q' });
    const personFrames: BrowserScreencastFrame[] = [];
    const viewer = await browser.attachViewer(
      's1',
      frame => personFrames.push(frame),
      () => undefined,
    );
    const status = await browser.status('s1');
    const personsPage = (status as { readonly activePageId: string }).activePageId;
    const agentsPage = status.pages.find(page => page.name === 'app')?.id as string;
    const agentFrames: BrowserScreencastFrame[] = [];
    // A second viewer, on the agent's page in session s2's stead, proves two streams at once.
    sessions.add('watch');
    const watchPage = await browser.openPage('watch', 'mirror', { url: `${base}/read` });
    const mirror = await browser.attachViewer(
      'watch',
      frame => agentFrames.push(frame),
      () => undefined,
    );

    // Act — at the same time: the person types a password, the agent navigates and types.
    await Promise.all([
      (async () => {
        for (const character of 'hunter2')
          await browser.dispatchHumanInput('s1', { kind: 'insertText', text: character });
      })(),
      (async () => {
        await tools.call(agent('s1'), { tool: 'browser.navigate', name: 'app', url: `${base}/read?again=1` });
        await tools.call(agent('s1'), { tool: 'browser.type', name: 'app', selector: '#q', text: 'agent work' });
      })(),
      browser.actOnPage('watch', 'mirror', { action: 'type', selector: '#q', text: 'moving' }),
    ]);
    await waitFor(
      () => personFrames.length > 0 && agentFrames.length > 0,
      'both viewers to receive a screencast frame',
    );
    const personsTree = await browser.actOnPage('s1', personsPage, { action: 'read', mode: 'a11y' });
    const agentsTree = await tools.call(agent('s1'), { tool: 'browser.read', name: 'app', mode: 'a11y' });
    viewer.detach();
    mirror.detach();

    // Assert — no cross-talk either way, the person was never moved, and both pages streamed.
    should('result' in personsTree && 'text' in personsTree.result && personsTree.result.text).match(
      /textbox: hunter2/u,
    );
    should(agentsTree.output).match(/textbox: agent work/u);
    should(agentsTree.output).not.match(/hunter2/u);
    should((await browser.status('s1')) as { readonly activePageId: string }).have.property(
      'activePageId',
      personsPage,
    );
    should(personFrames.length).be.above(0);
    should(personFrames.every(frame => frame.pageId === personsPage)).be.true();
    should(agentFrames.length).be.above(0);
    should(agentFrames.every(frame => frame.pageId === watchPage.id)).be.true();
    should(agentsPage).not.equal(personsPage);
  }, 90_000);

  it('should hold only the tab a person took over, leaving the agent working on its other tab', async () => {
    // Arrange — both of the agent's tabs are opened HERE, never borrowed from an earlier case: a case
    // that failed before it opened one must not fail this one too.
    await tools.call(agent('s1'), { tool: 'browser.open', name: 'work', url: `${base}/read` });
    await tools.call(agent('s1'), { tool: 'browser.open', name: 'login', url: `${base}/read` });
    await tools.control('s1', 'browser', { action: 'takeover', key: 'login' }, { by: 'local' }, person);

    // Act
    const held = await tools
      .call(agent('s1'), { tool: 'browser.type', name: 'login', selector: '#q', text: 'nope' })
      .catch((error: unknown) => error);
    const elsewhere = await tools.call(agent('s1'), { tool: 'browser.click', name: 'work', selector: '#q' });

    // Assert
    should(held).be.instanceOf(AgentToolError).and.have.property('code', 'taken_over');
    should(elsewhere.summary).startWith('Done on %browser:work');
  }, 60_000);

  it('should keep incognito cookies apart from the shared profile and from each other, both ways, and discard them', async () => {
    // Arrange — a cookie in the shared profile, and one in each of two incognito pages.
    await browser.openPage('s2', 'shared', { url: `${base}/set?v=shared` });
    await browser.openPage('s2', 'one', { url: `${base}/set?v=one`, incognito: true });
    await browser.openPage('s2', 'two', { incognito: true });

    // Act
    const shared = await cookieSeenBy('s2', 'shared');
    const one = await cookieSeenBy('s2', 'one');
    const two = await cookieSeenBy('s2', 'two');
    await browser.closePage('s2', 'one');
    await browser.openPage('s2', 'reopened', { incognito: true });
    const afterClose = await cookieSeenBy('s2', 'reopened');
    await browser.releaseSession('s2');
    await browser.openPage('s2', 'after-session', { incognito: true });
    const afterSession = await cookieSeenBy('s2', 'after-session');
    const sharedStill = await (async () => {
      await browser.openPage('s2', 'shared-again');
      return await cookieSeenBy('s2', 'shared-again');
    })();
    const listing = await browser.status('s2');

    // Assert — the shared profile never saw an incognito cookie; each incognito page saw only its own;
    // a closed one and a released session's are gone; the shared profile kept its own.
    should(shared).equal('cookie:who=shared');
    should(one).equal('cookie:who=one');
    should(two).equal('cookie:');
    should(afterClose).equal('cookie:');
    should(afterSession).equal('cookie:');
    should(sharedStill).equal('cookie:who=shared');
    should(listing.pages.filter(page => page.incognito === true).map(page => page.name)).deepEqual(['after-session']);
  }, 90_000);
  it('should hold a dialog for the agent, wait on the page, log the console and requests, adopt a popup and emulate a phone', async () => {
    // Arrange
    const call = async (tool: object) => await tools.call(agent('s1'), tool as never);
    await call({ tool: 'browser.open', name: 'life', url: `${base}/lifecycle` });

    // Act
    const waited = await call({ tool: 'browser.wait_for', name: 'life', text: 'late-text', timeoutMs: 10_000 });
    const button = await refOf('life', 'button "Ask"');
    const clicked = await call({ tool: 'browser.click', name: 'life', ref: button });
    const answered = await call({ tool: 'browser.dialog', name: 'life', action: 'accept', promptText: 'hadi' });
    const after = await call({ tool: 'browser.read', name: 'life', selector: '#o' });
    const consoleLog = await call({ tool: 'browser.console', name: 'life' });
    const listed = await call({ tool: 'browser.network', name: 'life', action: 'list', filter: '/ping' });
    const id = /^(r\d+)/mu.exec(listed.output ?? '')?.[1] ?? '';
    const shown = await call({ tool: 'browser.network', name: 'life', action: 'get', id });
    await call({ tool: 'browser.click', name: 'life', selector: '#pop' });
    let tabs = await call({ tool: 'browser.tabs', action: 'list' });
    await waitFor(
      async () => {
        tabs = await call({ tool: 'browser.tabs', action: 'list' });
        return (tabs.summary ?? '').includes('Popups with no name yet');
      },
      'the popup to show up in browser.tabs',
      { within: 10_000, every: 100 },
    );
    const emulated = await call({ tool: 'browser.emulate', name: 'life', viewport: { width: 390, height: 844 } });
    const reset = await call({ tool: 'browser.emulate', name: 'life', reset: true });

    // Assert
    should(waited.matched).be.true();
    should(clicked.summary).containEql('prompt dialog is waiting');
    should(answered.summary).containEql('prompt');
    should(after.output).equal('answer:hadi');
    should(consoleLog.output).containEql('logged-by-page');
    should(listed.output).containEql('/ping');
    should(shown.output).containEql('pong');
    should(shown.output?.toLowerCase()).not.containEql('x-api-key');
    should(tabs.summary).containEql('Popups with no name yet');
    should(emulated.summary).containEql('viewport 390x844');
    should(reset.summary).not.be.empty();
    await call({ tool: 'browser.close', name: 'life' });
  }, 90_000);

  it('should hand a page files through an input, a file dialog and a dropzone, and refuse a path outside the folder', async () => {
    // Arrange
    const work = join(root, 'work');
    await writeFile(join(work, 'hello.txt'), 'hello');
    await writeFile(join(root, 'outside.txt'), 'secret');
    await symlink(join(root, 'outside.txt'), join(work, 'escape.txt'));
    await tools.call(agent('s1'), { tool: 'browser.open', name: 'up', url: `${base}/upload` });
    const shown = async () =>
      (await tools.call(agent('s1'), { tool: 'browser.read', name: 'up', selector: '#r' })).output;
    const refused = async (files: string[]) =>
      await tools.call(agent('s1'), { tool: 'browser.upload', name: 'up', selector: '#f', files }).then(
        () => undefined,
        (error: unknown) => error as AgentToolError,
      );

    // Act
    await tools.call(agent('s1'), { tool: 'browser.upload', name: 'up', selector: '#f', files: ['hello.txt'] });
    const viaInput = await shown();
    await tools.call(agent('s1'), { tool: 'browser.upload', name: 'up', selector: '#pick', files: ['hello.txt'] });
    const viaDialog = await shown();
    await tools.call(agent('s1'), { tool: 'browser.read', name: 'up', selector: '#zone' });
    await tools.call(agent('s1'), {
      tool: 'browser.upload',
      name: 'up',
      selector: '#zone',
      files: ['hello.txt'],
      mode: 'drop',
    });
    const viaDrop = await shown();
    const parent = await refused(['../outside.txt']);
    const link = await refused(['escape.txt']);

    // Assert
    should(viaInput).equal('hello.txt:5');
    should(viaDialog).equal('hello.txt:5');
    should(viaDrop).equal('hello.txt:5');
    should(parent).be.instanceOf(AgentToolError);
    should(parent?.code).equal('forbidden');
    should(link?.code).equal('forbidden');
    await tools.call(agent('s1'), { tool: 'browser.close', name: 'up' });
  }, 90_000);

  it('should report a download an act started, then save it under the folder once and never over a file', async () => {
    // Arrange
    await tools.call(agent('s1'), { tool: 'browser.open', name: 'dl', url: `${base}/downloads` });

    // Act
    const clicked = await tools.call(agent('s1'), { tool: 'browser.click', name: 'dl', selector: '#dl' });
    const saved = await tools.call(agent('s1'), { tool: 'browser.download', name: 'dl' });
    const again = await tools.call(agent('s1'), { tool: 'browser.download', name: 'dl' }).then(
      () => undefined,
      (error: unknown) => error as AgentToolError,
    );
    const replaced = await tools.call(agent('s1'), { tool: 'browser.download', name: 'dl', overwrite: true });
    const target = join(root, 'work', 'downloads', 'data.csv');
    const info = await stat(target);

    // Assert
    should(clicked.summary).containEql('A download started: data.csv');
    should(saved.summary).containEql('downloads/data.csv');
    should(await readFile(target, 'utf8')).equal('a,b\n1,2\n');
    should(info.mode & 0o111).equal(0);
    should(again?.code).equal('conflict');
    should(replaced.summary).containEql('downloads/data.csv');
    await tools.call(agent('s1'), { tool: 'browser.close', name: 'dl' });
  }, 90_000);

  it('should print a page to a PDF in the folder', async () => {
    // Arrange
    await tools.call(agent('s1'), { tool: 'browser.open', name: 'print', url: `${base}/downloads` });

    // Act
    const printed = await tools.call(agent('s1'), { tool: 'browser.pdf', name: 'print', saveAs: 'out/page.pdf' });
    const bytes = await readFile(join(root, 'work', 'out', 'page.pdf'));

    // Assert
    should(printed.summary).containEql('out/page.pdf');
    should(bytes.subarray(0, 4).toString('latin1')).equal('%PDF');
    await tools.call(agent('s1'), { tool: 'browser.close', name: 'print' });
  }, 90_000);
});
