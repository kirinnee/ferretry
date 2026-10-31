import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { BrowserProfileStore, XvfbDisplay } from '../../../../src/adapters/browser/control/index.ts';
import { NodeSessionBrowserLauncher } from '../../../../src/adapters/browser/runtime/index.ts';
import { BrowserSessionService } from '../../../../src/lib/index.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * BROWSER MODE "REAL WINDOW", AGAINST A REAL HEADED CHROME ON A REAL XVFB (docs/browser-mode.md).
 *
 * Everything is production — the launcher in `window` mode, the private display it draws on, the worker
 * over CDP, the browser service — and Chrome is the real one the int tier already runs. The properties are
 * the ones only a real browser can show: that a site meets an ordinary desktop Chrome (its own user agent,
 * not `HeadlessChrome`, and `navigator.webdriver` false), that the page still streams to a viewer, and that
 * a challenge interstitial is recognised. Linux only: macOS has no Xvfb, and its window is the desktop's.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const node = Bun.which('node');
const xvfb = Bun.which('Xvfb');
const WORKER = join(import.meta.dir, '../../../../bin/browser-worker.ts');

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let display: XvfbDisplay;
let base = '';

describe.if(process.platform === 'linux')('the agent browser as a real window, in a real Chrome', () => {
  beforeAll(async () => {
    if (chrome === null || node === null || xvfb === null)
      throw new Error('this test needs a real Chrome, Node and Xvfb on PATH (the dev shell has all three)');
    root = await mkdtemp(join(tmpdir(), 'ferretry-agent-window-'));
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: request => {
        const url = new URL(request.url);
        const html = (title: string, body: string) =>
          new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, {
            headers: { 'content-type': 'text/html' },
          });
        if (url.pathname === '/challenge') return html('Just a moment...', '<p>Checking your browser</p>');
        // What the page itself sees: the headers the browser sent and what its own navigator says.
        return html(
          'Who am I',
          `<p id="header">${request.headers.get('user-agent') ?? ''}</p><p id="script"></p>` +
            `<script>document.getElementById('script').textContent = navigator.userAgent + ' webdriver=' + navigator.webdriver;</script>`,
        );
      },
    });
    base = `http://127.0.0.1:${String(site.port)}`;
    display = new XvfbDisplay({ authorityDirectory: join(root, 'x11'), executable: () => xvfb ?? undefined });
    browser = new BrowserSessionService(
      { get: async id => (id === 's1' ? {} : undefined) },
      new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        { kind: 'source', entry: WORKER },
        node,
        { FY_CHROME_BIN: chrome, PATH: process.env.PATH, HOME: process.env.HOME },
        undefined,
        // Over the loopback PORT: the transport whose `navigator.webdriver` stays false. Chrome sets it for the
        // DevTools pipe (the Linux default), which agent-browser-chrome.test.ts drives in a real Chrome.
        { mode: async () => 'window', display, platform: 'linux', transport: async () => 'port' },
      ),
      () => Date.now(),
    );
  }, 60_000);

  afterAll(async () => {
    await browser?.closeAll();
    await display?.close();
    site?.stop(true);
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('should meet a site as an ordinary desktop Chrome, and still stream to the person watching', async () => {
    // Arrange
    await browser.openPage('s1', 'who', { url: `${base}/` });
    const frames: BrowserScreencastFrame[] = [];
    const viewer = await browser.attachViewer(
      's1',
      frame => frames.push(frame),
      () => undefined,
    );

    // Act
    const header = await browser.actOnPage('s1', 'who', { action: 'read', selector: '#header' });
    const script = await browser.actOnPage('s1', 'who', { action: 'read', selector: '#script' });
    await waitFor(() => frames.length > 0, 'the viewer to receive a screencast frame');
    viewer.detach();

    // Assert
    const text = (read: typeof header): string =>
      'result' in read && 'text' in read.result ? String(read.result.text) : '';
    should(text(header)).match(/Chrome\/\d+/u);
    should(text(header)).not.match(/Headless/u);
    should(text(script)).not.match(/Headless/u);
    should(text(script)).endWith('webdriver=false');
    should(frames.length).be.above(0);
  }, 90_000);

  it('should recognise a "checking your browser" interstitial on the page it is showing', async () => {
    // Act
    await browser.openPage('s1', 'shop', { url: `${base}/challenge` });
    const status = await browser.status('s1');

    // Assert
    should(status.pages.find(page => page.name === 'shop')?.challenge).deepEqual({ provider: 'cloudflare' });
    should(status.pages.find(page => page.name === 'who')?.challenge).be.undefined();
  }, 60_000);
});
