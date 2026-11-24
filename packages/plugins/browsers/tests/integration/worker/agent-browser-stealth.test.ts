import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { BrowserSessionLauncher } from '../../../daemon/pages/service.ts';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { XvfbDisplay } from '../../../daemon/worker/control/adapters/login-runtime.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher, type SessionBrowserModeOptions } from '../../../daemon/worker/launcher.ts';
import type { BrowserAutomation } from '../../../daemon/pages/automation.ts';
import type { BrowserInputFacts, BrowserInputFieldsPort } from '../../../daemon/target/lib/contracts.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';
import { STEALTH_CONSOLE_NOTE } from '../../../daemon/worker/main.ts';
import { launcherPorts, loginProcesses, REAL_WORKER } from '../../support/process-workers.ts';

/**
 * THE HYGIENE LAYER OF A STEALTH IDENTITY, IN A REAL HEADFUL CHROME ON A REAL XVFB (docs/browser-mode.md, "Stealth").
 * The Browser mode says HEADLESS and the identity is a stealth one, so the browser that opens must still be a real window,
 * with the zone and language its proxy exit would give, and its worker (patchright-core) must leave no `Runtime.enable`
 * trace a page can read. The control is the same real window WITHOUT the layer: it must leak, or the probe proves nothing.
 * What the stock worker does with a field (observe, then type it) is also done through the stealth worker, which reaches
 * the same Playwright internals. The real worker under Node, through the real client.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const xvfb = Bun.which('Xvfb');
const WORKERS = REAL_WORKER();

const PAGE = `<html><head><title>Who</title></head><body>
<p id="seen"></p>
<input id="code" name="otp" type="text" maxlength="6" autocomplete="one-time-code" aria-label="Verification code">
<script>
  // The DevTools tell (the rebrowser bot detector's): with the Runtime domain enabled for this page, Chrome serialises every
  // console argument, so a class's name getter is read three times for one console.debug, and only once without it.
  let nameReads = 0;
  class Probe extends Error { get name() { nameReads += 1; return 'Probe'; } }
  console.debug(new Probe('probe'));
  setTimeout(() => {
    document.getElementById('seen').textContent = JSON.stringify({
      leaked: nameReads > 1,
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }, 800);
</script>
</body></html>`;

let root = '';
let site: ReturnType<typeof Bun.serve>;
let display: XvfbDisplay;
let base = '';
const services: BrowserSessionService[] = [];

function service(modes: Partial<SessionBrowserModeOptions>): BrowserSessionService {
  if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
  const launcher: BrowserSessionLauncher = new NodeSessionBrowserLauncher(
    new BrowserProfileStore(join(root, `p${String(services.length)}`)),
    WORKERS.start,
    launcherPorts(),
    {
      FY_CHROME_BIN: chrome,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
    },
    undefined,
    {
      mode: async () => 'headless',
      display,
      platform: 'linux',
      transport: async () => 'port',
      listenerProver: unprovenListenerProver(),
      ...modes,
    },
  );
  const made = new BrowserSessionService({ get: async id => (id === 's1' ? {} : undefined) }, launcher, () =>
    Date.now(),
  );
  services.push(made);
  return made;
}

interface Seen {
  readonly leaked: boolean;
  readonly webdriver: boolean;
  readonly userAgent: string;
  readonly language: string;
  readonly languages: readonly string[];
  readonly zone: string;
}

async function seenBy(browser: BrowserSessionService): Promise<Seen> {
  await browser.openPage('s1', 'who', { url: `${base}/` });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const read = await browser.actOnPage('s1', 'who', { action: 'read', selector: '#seen' });
    const text = 'result' in read && 'text' in read.result ? String(read.result.text) : '';
    if (text.startsWith('{')) return JSON.parse(text) as Seen;
    await Bun.sleep(250);
  }
  throw new Error('the page never reported what it saw');
}

describe.if(process.platform === 'linux')('a stealth identity’s browser, in a real Chrome', () => {
  beforeAll(async () => {
    if (chrome === null || xvfb === null)
      throw new Error('this test needs a real Chrome, Node and Xvfb on PATH (the dev shell has all three)');
    root = await mkdtemp(join(tmpdir(), 'ferretry-agent-stealth-'));
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
    });
    base = `http://127.0.0.1:${String(site.port)}`;
    display = new XvfbDisplay({
      processes: loginProcesses(),
      authorityDirectory: join(root, 'x11'),
      executable: () => xvfb ?? undefined,
    });
  }, 60_000);

  afterAll(async () => {
    for (const browser of services) await browser.closeAll().catch(() => undefined);
    await display?.close();
    site?.stop(true);
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('should be a real window with the exit’s zone and language and no Runtime.enable trace, where the same window without the layer leaks', async () => {
    // Arrange — Browser mode says HEADLESS for both.
    const control = service({});
    const stealthy = service({ stealth: async () => ({ timezone: 'Europe/Berlin', locale: 'de-DE' }) });

    // Act
    const stock = await seenBy(control);
    const hidden = await seenBy(stealthy);

    // Assert — the control is a headless Chrome that leaks; the identity is a window that does not.
    should(stock.userAgent).match(/Chrome\/\d+/u);
    should(stock.leaked).be.true();
    should(hidden.leaked).be.false();
    should(hidden.userAgent).not.match(/Headless/u);
    should(hidden.webdriver).be.false();
    should(hidden.zone).equal('Europe/Berlin');
    should(hidden.language).equal('de-DE');
    should(hidden.languages).eql(['de-DE', 'de']);
    // The machine's own zone and language stay with a launch that was given none.
    should(stock.zone).not.equal('Europe/Berlin');
    // The page console cannot be captured without the domain a page detects: said first, so a silent log is not read as a quiet page.
    const read = (browser: BrowserSessionService) =>
      browser.lifecycleOnPage('s1', 'who', { op: 'console' }).then(outcome => outcome.reply.text);
    should(await read(stealthy)).containEql(STEALTH_CONSOLE_NOTE);
    should(await read(control)).not.containEql(STEALTH_CONSOLE_NOTE);
  }, 120_000);

  it('should observe a field and type into it through the stealth worker, the same internals as the stock one', async () => {
    // Arrange
    const browser = service({ stealth: async () => ({}) });
    await browser.openPage('s1', 'who', { url: `${base}/` });
    const pointers = [{ id: 'code', target: { kind: 'selector' as const, selector: '#code' } }];
    const onPage = async <T>(work: (driver: BrowserAutomation, pageId: string) => Promise<T>): Promise<T> =>
      await browser.inputOnPage('s1', 'who', async (port: BrowserInputFieldsPort, pageId) =>
        work(port as BrowserAutomation, pageId),
      );

    // Act
    const facts: BrowserInputFacts = await onPage(async (driver, pageId) => {
      const seen = await driver.inputObserve(pageId, pointers);
      if (!seen.ok) throw new Error(`the field was not seen: ${JSON.stringify(seen)}`);
      return seen.facts;
    });
    const outcome = await onPage(
      async (driver, pageId) => await driver.inputType(pageId, facts, [{ field: 'code', text: '482913' }], false),
    );
    const value = await onPage(
      async (driver, pageId) =>
        JSON.parse(
          (await driver.evaluate(pageId, { source: `() => document.querySelector('#code').value` })).text,
        ) as unknown,
    );

    // Assert
    should(facts.fields[0]?.field).containEql({ id: 'code', maxlength: '6', label: 'Verification code' });
    should(outcome).equal('typed');
    should(value).equal('482913');
  }, 120_000);
});
