import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/browser/control/index.ts';
import { NodeSessionBrowserLauncher } from '../../../../src/adapters/browser/runtime/index.ts';
import {
  type BrowserAutomation,
  type BrowserInputFacts,
  type BrowserInputFieldsPort,
  BrowserSessionService,
} from '../../../../src/lib/index.ts';

/**
 * A GRANT FILL'S FIELD EMPTYING, IN A REAL CHROME (docs/input-requests.md, "Task plan fills"; invariant 19).
 *
 * The two scripts that empty a password a task-plan fill typed run inside the page, so only a real browser can show
 * they work: the `pagehide` listener the worker arms before the write (it must empty the field when the page is hidden,
 * which is what keeps the back/forward cache from holding the value), and the check before the hold ends (a field that
 * still holds anything is emptied). The real worker under Node, as a daemon runs it, through the real client. If the
 * worker or the client stops arming, or a script stops emptying, this fails.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const node = Bun.which('node');
const WORKER = join(import.meta.dir, '../../../../bin/browser-worker.ts');
const SECRET = 'correct-horse-battery-staple';

const LOGIN = `<html><head><title>Sign in</title></head><body>
<form action="/" method="get">
  <input id="user" name="login" type="text">
  <input id="pw" name="password" type="password">
  <button type="submit">Sign in</button>
</form>
</body></html>`;

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let base = '';

/** One turn of the page's own queue, with the page's automation (the input port is the driver itself). */
async function onPage<T>(work: (driver: BrowserAutomation, pageId: string) => Promise<T>): Promise<T> {
  return await browser.inputOnPage('s1', 'login', async (port: BrowserInputFieldsPort, pageId) =>
    work(port as BrowserAutomation, pageId),
  );
}

/** What the password field holds now, read from the page. */
async function passwordNow(): Promise<unknown> {
  return await onPage(async (driver, pageId) => {
    const read = await driver.evaluate(pageId, { source: '() => document.querySelector("#pw").value' });
    return JSON.parse(read.text);
  });
}

/** The password field as the browser sees it, armed and typed into as a grant fill does. */
async function armedAndTyped(): Promise<BrowserInputFacts> {
  return await onPage(async (driver, pageId) => {
    const seen = await driver.inputObserve(pageId, [{ id: 'pw', target: { kind: 'selector', selector: '#pw' } }]);
    if (!seen.ok) throw new Error(`the field was not seen: ${JSON.stringify(seen)}`);
    should(await driver.inputArm?.(pageId, seen.facts, ['pw'])).equal('armed');
    should(await driver.inputType(pageId, seen.facts, [{ field: 'pw', text: SECRET }], false)).equal('typed');
    return seen.facts;
  });
}

const jobOf = (facts: BrowserInputFacts) => ({
  navigationId: facts.navigationId,
  fields: facts.fields.map(field => ({ frameId: field.frameId, backendNodeId: field.backendNodeId })),
});

describe.if(process.platform === 'linux')('a grant fill’s field emptying, in a real Chrome', () => {
  beforeAll(async () => {
    if (chrome === null || node === null) throw new Error('this test needs a real Chrome and Node on PATH');
    root = await mkdtemp(join(tmpdir(), 'ferretry-grant-clear-'));
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request =>
        new URL(request.url).pathname === '/away'
          ? new Response('<html><body><p id="away">elsewhere</p></body></html>', {
              headers: { 'content-type': 'text/html' },
            })
          : new Response(LOGIN, { headers: { 'content-type': 'text/html' } }),
    });
    base = `http://127.0.0.1:${String(site.port)}`;
    browser = new BrowserSessionService(
      { get: async id => (id === 's1' ? {} : undefined) },
      new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        { kind: 'source', entry: WORKER },
        node,
        { FY_CHROME_BIN: chrome, PATH: process.env.PATH, HOME: process.env.HOME },
        undefined,
        { mode: async () => 'headless', platform: 'linux', transport: async () => 'pipe' },
      ),
      () => Date.now(),
    );
  }, 60_000);

  afterAll(async () => {
    await browser?.closeAll();
    site?.stop(true);
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('should empty the typed password when the page is hidden, from the listener armed before the write', async () => {
    await browser.openPage('s1', 'login', { url: `${base}/` });
    await armedAndTyped();
    should(await passwordNow()).equal(SECRET);

    // The page is hidden (what entering the back/forward cache fires): the armed listener empties the field.
    const after = await onPage(async (driver, pageId) => {
      const read = await driver.evaluate(pageId, {
        source:
          '() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); return document.querySelector("#pw").value; }',
      });
      return JSON.parse(read.text);
    });

    should(after).equal('');
    await browser.closePage('s1', 'login');
  }, 60_000);

  it('should empty a password still sitting in its field before the hold ends, whatever it holds, then say moved', async () => {
    await browser.openPage('s1', 'login', { url: `${base}/` });
    const facts = await armedAndTyped();
    // The ferret appended a character during the hold: the password is still in there.
    await onPage(async (driver, pageId) => {
      await driver.evaluate(pageId, { source: '() => { document.querySelector("#pw").value += "x"; return true; }' });
    });

    const cleared = await onPage(async (driver, pageId) => await driver.inputClear?.(pageId, jobOf(facts)));
    const again = await onPage(async (driver, pageId) => await driver.inputClear?.(pageId, jobOf(facts)));

    should(cleared).equal('cleared');
    should(await passwordNow()).equal('');
    should(again).equal('moved');
    await browser.closePage('s1', 'login');
  }, 60_000);

  it('should hold no password after the page leaves and comes back, and call the old document moved', async () => {
    await browser.openPage('s1', 'login', { url: `${base}/` });
    const facts = await armedAndTyped();

    await browser.actOnPage('s1', 'login', { action: 'navigate', url: `${base}/away` });
    await browser.actOnPage('s1', 'login', { action: 'back' });

    should(await passwordNow()).equal('');
    should(await onPage(async (driver, pageId) => await driver.inputClear?.(pageId, jobOf(facts)))).equal('moved');
    await browser.closePage('s1', 'login');
  }, 60_000);
});
