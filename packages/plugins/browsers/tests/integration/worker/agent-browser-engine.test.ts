import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { BrowserScreencastFrame } from '../../../contract/index.ts';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { XvfbDisplay } from '../../../daemon/worker/control/adapters/login-runtime.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { engineFlags, engineSeed } from '../../../daemon/worker/control/engines.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';
import { launcherPorts, loginProcesses, REAL_WORKER } from '../../support/process-workers.ts';

/**
 * WHAT MUST STILL WORK ON EVERY ENGINE (B5 unit D4): the screencast the owner watches, the input the agent drives
 * (`Input.dispatch*`, through a click and typed keys) and passkeys staying off. Each engine is the real program, started by
 * the real launcher with the switches `engineFlags` gives it, in a real window on a real Xvfb. The stock Chrome always runs;
 * a patched engine runs when its program is named in `FY_ENGINE_FINGERPRINT_CHROMIUM_BIN` (the daemon fetches it on first
 * use, `task test:stealth -- --engine fingerprint-chromium` shows how), so CI never downloads one.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const xvfb = Bun.which('Xvfb');
const WORKERS = REAL_WORKER();
const PROCESSES = loginProcesses();
const STATE_KEY = '/engines/test';
const patched = process.env.FY_ENGINE_FINGERPRINT_CHROMIUM_BIN;

const PAGE = `<html><head><title>Engine</title></head><body>
<button id="go" onclick="document.getElementById('clicked').textContent='clicked'">go</button>
<p id="clicked"></p>
<input id="field" oninput="document.getElementById('typed').textContent=this.value">
<p id="typed"></p>
<p id="passkey">pending</p>
<p id="seen"></p>
<script>
  const started = performance.now();
  navigator.credentials
    .get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', timeout: 6000 } })
    .then(() => 'offered', error => error.name)
    .then(name => { document.getElementById('passkey').textContent = name + ' after ' + Math.round(performance.now() - started) + 'ms'; });
  document.getElementById('seen').textContent = JSON.stringify({ webdriver: navigator.webdriver, concurrency: navigator.hardwareConcurrency, platform: navigator.platform });
</script>
</body></html>`;

interface Engine {
  readonly name: string;
  readonly executable: string | undefined;
  readonly flags: readonly string[];
}

const ENGINES: readonly Engine[] = [
  { name: 'the machine’s Chromium', executable: chrome ?? undefined, flags: [] },
  {
    name: 'fingerprint-chromium',
    executable: patched,
    flags: engineFlags('fingerprint-chromium', engineSeed(STATE_KEY), 'linux'),
  },
];

const text = (read: { result?: { text?: unknown } } | object): string =>
  'result' in read && read.result !== undefined && 'text' in read.result ? String(read.result.text) : '';

async function waitFor(condition: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

for (const engine of ENGINES) {
  describe(`${engine.name}, in a real window`, () => {
    let root = '';
    let site: ReturnType<typeof Bun.serve>;
    let display: XvfbDisplay;
    let browser: BrowserSessionService;
    const enabled = engine.executable !== undefined && xvfb !== null;

    beforeAll(async () => {
      if (!enabled || engine.executable === undefined) return;
      root = await mkdtemp(join(tmpdir(), 'ferretry-engine-'));
      site = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
      });
      display = new XvfbDisplay({
        processes: PROCESSES,
        authorityDirectory: join(root, 'x11'),
        executable: () => xvfb ?? undefined,
      });
      const executable = engine.executable;
      browser = new BrowserSessionService(
        { get: async id => (id === 's1' ? {} : undefined) },
        new NodeSessionBrowserLauncher(
          new BrowserProfileStore(root),
          WORKERS.start,
          launcherPorts(),
          { PATH: process.env.PATH, HOME: root, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE },
          undefined,
          {
            mode: async () => 'window',
            engine: async () => ({ executable, flags: engine.flags }),
            display,
            platform: 'linux',
            transport: async () => 'port',
            listenerProver: unprovenListenerProver(),
          },
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

    it.skipIf(!enabled)(
      'should stream the screencast to the person watching',
      async () => {
        await browser.openPage('s1', 'p', { url: `http://localhost:${String(site.port)}/` });
        const frames: BrowserScreencastFrame[] = [];
        const viewer = await browser.attachViewer(
          's1',
          frame => frames.push(frame),
          () => undefined,
          'owner',
        );
        await waitFor(() => frames.length > 0, 'a screencast frame');
        viewer.detach();
        should(frames.length).be.above(0);
      },
      90_000,
    );

    it.skipIf(!enabled)(
      'should take a click and typed keys from the agent (Input.dispatch*)',
      async () => {
        await browser.actOnPage('s1', 'p', { action: 'click', selector: '#go' });
        await browser.actOnPage('s1', 'p', { action: 'type', selector: '#field', text: 'hello', slowly: true });
        should(text(await browser.actOnPage('s1', 'p', { action: 'read', selector: '#clicked' }))).equal('clicked');
        should(text(await browser.actOnPage('s1', 'p', { action: 'read', selector: '#typed' }))).equal('hello');
      },
      90_000,
    );

    it.skipIf(!enabled)(
      'should offer no passkey: a request for one fails at once instead of waiting for a dialog',
      async () => {
        const deadline = Date.now() + 15_000;
        let said = '';
        while (Date.now() < deadline) {
          said = text(await browser.actOnPage('s1', 'p', { action: 'read', selector: '#passkey' }));
          if (said !== 'pending') break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        const [name, , ms] = said.split(' ');
        should(name).equal('NotAllowedError');
        should(Number(ms?.replace('ms', ''))).be.below(3_000);
      },
      90_000,
    );
  });
}
