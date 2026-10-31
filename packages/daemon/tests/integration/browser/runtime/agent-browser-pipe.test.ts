import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/browser/control/index.ts';
import { NodeSessionBrowserLauncher } from '../../../../src/adapters/browser/runtime/index.ts';
import { BrowserSessionService } from '../../../../src/lib/index.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * THE DEVTOOLS PIPE, AGAINST A REAL CHROME (`CdpTransport`).
 *
 * The pipe is never a default — an owner turns it on for a machine — so nothing else in this tier reaches it
 * with a real browser, and only a real one can show that Playwright drives Chrome over fds 3 and 4: the
 * launcher with the pipe named outright, the source worker under Node (as a daemon runs it), the browser
 * service, and Chrome started with `--remote-debugging-pipe` and no port at all. Linux only: it reads the
 * browser's command line from `/proc`.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const node = Bun.which('node');
const WORKER = join(import.meta.dir, '../../../../bin/browser-worker.ts');

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let base = '';

describe.if(process.platform === 'linux')('the agent browser over its DevTools pipe, in a real Chrome', () => {
  beforeAll(async () => {
    if (chrome === null || node === null) throw new Error('this test needs a real Chrome and Node on PATH');
    root = await mkdtemp(join(tmpdir(), 'ferretry-agent-pipe-'));
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response('<html><head><title>Piped</title></head><body><p id="said">over the pipe</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
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

  it('should open, read and stream a page with Chrome listening on no debugging port', async () => {
    // Arrange
    await browser.openPage('s1', 'piped', { url: `${base}/` });
    const frames: BrowserScreencastFrame[] = [];
    const viewer = await browser.attachViewer(
      's1',
      frame => frames.push(frame),
      () => undefined,
    );

    // Act
    const read = await browser.actOnPage('s1', 'piped', { action: 'read', selector: '#said' });
    await waitFor(() => frames.length > 0, 'the viewer to receive a screencast frame');
    viewer.detach();
    const record: unknown = JSON.parse(await readFile(join(root, 'browser', 'profile.lock'), 'utf8'));
    const chromePid = (record as { readonly chromePid: number }).chromePid;
    const started = (await readFile(`/proc/${String(chromePid)}/cmdline`, 'utf8')).split('\0');

    // Assert — the whole chain answered, and the Chrome it answered from has the pipe and no port.
    should('result' in read && 'text' in read.result ? String(read.result.text) : '').equal('over the pipe');
    should(frames.length).be.above(0);
    should(started).containEql('--remote-debugging-pipe');
    should(started.filter(argument => /^--remote-debugging-(?:port|address)/u.test(argument))).deepEqual([]);
  }, 90_000);
});
