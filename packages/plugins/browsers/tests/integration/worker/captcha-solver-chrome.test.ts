import { afterAll, beforeAll, describe, it, spyOn } from 'bun:test';
import type { AuditDraft } from '@ferretry/core-gate/contract';
import { OwnSecret, type OwnSecretRefusal } from '@ferretry/kernel/contract';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { AUDIT, CAPTCHA_MONTHLY_CAP_MICROS, type CaptchaSpend } from '../../../contract/index.ts';
import { CapSolver, CaptchaSolving, SpendLedger } from '../../../daemon/challenges/solver.ts';
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
 * SOLVING A TOKEN CHECK FOR THE OWNER, IN A REAL HEADLESS CHROME AGAINST A FAKE CAPSOLVER (B5 D7).
 *
 * Saved-page shapes of a Turnstile, reCAPTCHA v2 and v3 and hCaptcha widget are served from a local server (no real site
 * and no real CapSolver is called: the vendor is a second local server that answers what CapSolver's API answers). The
 * agent's own tools run with the solver wired in. What must hold: the token the fake vendor issues ends up in the widget's
 * field and its callback; a spent month and a missing key each refuse in a plain sentence and leave the page to the owner;
 * and the API key reaches the fake vendor's request BODY and no other place — not a header, an address, the page, an
 * audit record, a tool answer or any line the process printed.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const WORKERS = REAL_WORKER();
const SESSION = 's1';
const agent: ToolCaller = { kind: 'agent', sessionId: SESSION };

const KEY = 'CAP-0123456789ABCDEFSECRETKEY';
const TOKEN = '0.TOKEN-issued-by-the-fake-vendor-0123456789';
const TURNSTILE_KEY = '0x4AAAAAAAdemoSiteKeyForTurnstile';
const V2_KEY = '6LdemoSiteKeyForRecaptchaVersionTwo_abcdef123';
const V3_KEY = '6LdemoSiteKeyForRecaptchaVersionThree_abc12';
const HCAPTCHA_KEY = '10000000-ffff-ffff-ffff-000000000001';

/** Mirrors a response field's value into the page's text, so a read shows what a widget was given. */
const MIRROR = `<p id="field">empty</p><p id="got">nothing</p>
<script>
  document.addEventListener('input', event => {
    if (event.target && event.target.name) document.getElementById('field').textContent = event.target.value;
  });
  window.onDone = token => { document.getElementById('got').textContent = token; };
</script>`;

const PAGES: Readonly<Record<string, string>> = {
  // Cloudflare's wait page shape (its title) with a Turnstile box the page renders itself: the recogniser flags it.
  '/turnstile': `<html><head><title>Just a moment...</title></head><body>
    <div class="cf-turnstile" data-sitekey="${TURNSTILE_KEY}" data-action="login" data-callback="onDone"></div>${MIRROR}</body></html>`,
  // The same widget, once Cloudflare's frame has rendered: the key is in the frame's address, as in a saved page.
  '/turnstile-frame': `<html><head><title>Sign in</title></head><body><form><div id="host"></div></form>
    <iframe src="/challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x1/${TURNSTILE_KEY}/light/fbE/normal/auto/"></iframe>${MIRROR}</body></html>`,
  '/recaptcha-v2': `<html><head><title>Sign in</title></head><body>
    <div class="g-recaptcha" data-sitekey="${V2_KEY}" data-callback="onDone"></div>
    <textarea name="g-recaptcha-response"></textarea>${MIRROR}</body></html>`,
  // reCAPTCHA v3: the library loaded with `render=<key>`, its action named on the form.
  '/recaptcha-v3': `<html><head><title>Sign in</title><script src="/recaptcha/api.js?render=${V3_KEY}"></script></head><body>
    <form data-action="submit_login"></form>${MIRROR}</body></html>`,
  '/hcaptcha': `<html><head><title>Sign in</title></head><body>
    <div class="h-captcha" data-sitekey="${HCAPTCHA_KEY}" data-callback="onDone"></div>${MIRROR}</body></html>`,
  '/hcaptcha-frame': `<html><head><title>Sign in</title></head><body>
    <iframe src="/newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&sitekey=${HCAPTCHA_KEY}"></iframe>${MIRROR}</body></html>`,
  '/invisible-v2': `<html><head><title>Sign in</title><script src="/recaptcha/api.js?render=${V3_KEY}"></script></head><body>
    <iframe src="/www.google.com/recaptcha/api2/anchor?k=${V3_KEY}&size=invisible"></iframe>${MIRROR}</body></html>`,
  '/plain': '<html><head><title>Hello</title></head><body><p>No check here.</p></body></html>',
};

interface VendorCall {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly address: string;
  readonly body: { readonly clientKey?: string; readonly task?: Record<string, unknown> };
}

let root = '';
let site: ReturnType<typeof Bun.serve>;
let vendor: ReturnType<typeof Bun.serve>;
let origin = '';
let browser: BrowserSessionService;
let calls: VendorCall[] = [];
let issued: 'token' | 'nothing' = 'token';
const printed: string[] = [];
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
  root = await mkdtemp(join(tmpdir(), 'ferretry-captcha-solver-'));
  await mkdir(join(root, 'work', '.fy'), { recursive: true });
  site = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      const { pathname } = new URL(request.url);
      const page = PAGES[pathname];
      if (page !== undefined) return new Response(page, { headers: { 'content-type': 'text/html' } });
      // Library, frame and favicon requests the widgets' markup makes: answered empty and local.
      return new Response('', { headers: { 'content-type': 'text/html' } });
    },
  });
  origin = `http://127.0.0.1:${String(site.port)}`;
  // The fake CapSolver: createTask answers a task id, getTaskResult answers the token (or a task with none).
  vendor = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async request => {
      const url = new URL(request.url);
      const body = (await request.json()) as VendorCall['body'];
      calls.push({
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        address: request.url,
        body,
      });
      const answer =
        url.pathname === '/createTask'
          ? { errorId: 0, taskId: 'task-1' }
          : {
              errorId: 0,
              status: 'ready',
              solution: issued === 'token' ? { token: TOKEN, gRecaptchaResponse: TOKEN } : {},
            };
      return Response.json(answer);
    },
  });
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    spies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '));
      }),
    );
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
}, 90_000);

afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await browser?.closeAll();
  site?.stop(true);
  vendor?.stop(true);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

interface World {
  readonly solving: CaptchaSolving;
  readonly tools: BrowserTools;
  readonly audits: AuditDraft[];
  readonly failures: string[];
  readonly state: { value: CaptchaSpend | undefined };
}

/** The solver as the daemon wires it (`daemon/index.ts`), against the fake vendor and with the secret a test says. */
function world(
  options: {
    readonly stealth?: boolean;
    readonly secret?: OwnSecret | { readonly refused: OwnSecretRefusal };
    readonly spend?: CaptchaSpend;
  } = {},
): World {
  const audits: AuditDraft[] = [];
  const failures: string[] = [];
  const state: { value: CaptchaSpend | undefined } = { value: options.spend };
  const ledger = new SpendLedger(
    {
      update: async (_file: unknown, edit: (current: CaptchaSpend | undefined) => CaptchaSpend) => {
        state.value = edit(state.value);
        return { ok: true as const, value: state.value };
      },
    } as never,
    () => new Date().toISOString(),
  );
  const solving = new CaptchaSolving({
    stealth: () => options.stealth ?? true,
    solver: new CapSolver({
      fetch: async (url, init) => await fetch(url, init),
      secret: async () => options.secret ?? new OwnSecret('CAPSOLVER_API_KEY', KEY),
      ledger,
      sleep: async delay => await Bun.sleep(Math.min(delay, 10)),
      origin: `http://127.0.0.1:${String(vendor.port)}`,
      pollMilliseconds: 10,
    }),
    onPage: async (session, page, work) => await browser.inputOnPage(session, page, work),
    proxy: () => undefined,
    audit: async draft => {
      audits.push(draft);
    },
    nowMs: () => Date.now(),
    failed: message => failures.push(message),
  });
  const sealed = new SealedPages();
  const tools = new BrowserTools({
    browser,
    control: new SurfaceControl({ publish: async () => undefined, history: async () => [] }, { now: () => Date.now() }),
    kernel: browserKernel().kernel as never,
    policy: { allows: async () => true },
    files: rootFiles(
      workRoots(join(root, 'work'), join(root, 'work', '.fy')),
      nodeStagedFiles(join(root, 'upload'), { now: () => Date.now() } as never),
    ),
    binaryName: 'fy',
    sealed: new SealedGate({ sealed, mask: async text => text }),
    protection: quietProtection(),
    captcha: solving,
  });
  return { solving, tools, audits, failures, state };
}

/** What a page's own mirror shows: the response field's value, and what the widget's callback was handed. */
async function shown(name: string): Promise<{ readonly field: string; readonly got: string }> {
  const text = async (selector: string): Promise<string> => {
    const read = await browser.actOnPage(SESSION, name, { action: 'read', selector } as never);
    return 'result' in read && 'text' in read.result ? String(read.result.text).trim() : '';
  };
  return { field: await text('#field'), got: await text('#got') };
}

/** Polls the page until it shows the token (or the wait runs out), the way an agent that was told to wait would. */
async function untilField(name: string, want: string): Promise<{ readonly field: string; readonly got: string }> {
  let last = await shown(name);
  for (let attempt = 0; attempt < 60 && last.field !== want; attempt += 1) {
    await Bun.sleep(150);
    last = await shown(name);
  }
  return last;
}

async function open(name: string, path: string): Promise<void> {
  await browser.openPage(SESSION, name, { url: `${origin}${path}` });
}

const taskOf = (call: VendorCall | undefined): Record<string, unknown> => call?.body.task ?? {};

describe('solving a token check in a real browser', () => {
  it('should wait on a Turnstile the recogniser flags, then find the issued token in its field and callback', async () => {
    calls = [];
    const { tools, audits, failures } = world();

    const opened = await tools.call(agent, { tool: 'browser.open', name: 'ts', url: `${origin}/turnstile` });
    const told = opened.summary;
    const filled = await untilField('ts', TOKEN);

    should(told).containEql('The browser is solving this check now');
    should(told).not.containEql('Do not try to solve');
    should(filled).eql({ field: TOKEN, got: TOKEN });
    should(calls.map(call => call.path)).eql(['/createTask', '/getTaskResult']);
    should(taskOf(calls[0])).eql({
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: `${origin}/turnstile`,
      websiteKey: TURNSTILE_KEY,
      metadata: { action: 'login' },
    });
    await Bun.sleep(100);
    should(failures).eql([]);
    should(audits).have.length(1);
    should(audits[0]?.event).equal(AUDIT.captchaSolve);
    should(audits[0]?.detail).have.properties({
      identity: 'agent',
      siteHost: '127.0.0.1',
      kind: 'turnstile',
      vendor: 'capsolver',
      outcome: 'solved',
      estimatedCostMicros: 1200,
    });
    await tools.call(agent, { tool: 'browser.close', name: 'ts' });
  }, 90_000);

  it('should tell a solvable box by its kind and key on each shape a page can show one', async () => {
    const shapes = [
      ['/turnstile-frame', 'AntiTurnstileTaskProxyLess', TURNSTILE_KEY, 'turnstile'],
      ['/recaptcha-v2', 'ReCaptchaV2TaskProxyLess', V2_KEY, 'recaptcha-v2'],
      ['/recaptcha-v3', 'ReCaptchaV3TaskProxyLess', V3_KEY, 'recaptcha-v3'],
      ['/hcaptcha', 'HCaptchaTaskProxyLess', HCAPTCHA_KEY, 'hcaptcha'],
      ['/hcaptcha-frame', 'HCaptchaTaskProxyLess', HCAPTCHA_KEY, 'hcaptcha'],
      ['/invisible-v2', 'ReCaptchaV3TaskProxyLess', V3_KEY, 'recaptcha-v3'],
    ] as const;
    for (const [path, type, key, kind] of shapes) {
      calls = [];
      const { solving, audits } = world();
      await open('shape', path);
      should(await solving.begin(SESSION, 'shape')).eql({ kind: 'solving' });
      for (let attempt = 0; attempt < 60 && audits.length === 0; attempt += 1) await Bun.sleep(100);
      should(taskOf(calls[0]).type).equal(type);
      should(taskOf(calls[0]).websiteKey).equal(key);
      should(audits[0]?.detail).have.properties({ kind, outcome: 'solved' });
      await browser.closePage(SESSION, 'shape');
    }
    // v3 names its action; the v2 box does not; and a v2 box with a callback gets the token in field and callback.
    calls = [];
    const v3 = world();
    await open('v3', '/recaptcha-v3');
    await v3.solving.begin(SESSION, 'v3');
    for (let attempt = 0; attempt < 60 && calls.length === 0; attempt += 1) await Bun.sleep(100);
    should(taskOf(calls[0]).pageAction).equal('submit_login');
    const v2 = world();
    await open('v2', '/recaptcha-v2');
    await v2.solving.begin(SESSION, 'v2');
    should(await untilField('v2', TOKEN)).eql({ field: TOKEN, got: TOKEN });
    const hc = world();
    await open('hc', '/hcaptcha');
    await hc.solving.begin(SESSION, 'hc');
    should(await untilField('hc', TOKEN)).eql({ field: TOKEN, got: TOKEN });
    for (const name of ['v3', 'v2', 'hc']) await browser.closePage(SESSION, name);
  }, 120_000);

  it('should refuse past the monthly cap in one plain sentence, ask the vendor nothing, and leave the page to its owner', async () => {
    calls = [];
    const month = new Date().toISOString().slice(0, 7);
    const { tools, audits, state } = world({ spend: { month, micros: CAPTCHA_MONTHLY_CAP_MICROS } });

    const told = (await tools.call(agent, { tool: 'browser.open', name: 'cap', url: `${origin}/turnstile` })).summary;

    should(told).containEql('ask your owner to take the page over');
    should(told).containEql(
      'Automatic solving is not running: The captcha solver has used its $5.00 for this month; it starts again on the 1st.',
    );
    should(calls).eql([]);
    should(state.value?.micros).equal(CAPTCHA_MONTHLY_CAP_MICROS);
    should((await shown('cap')).field).equal('empty');
    should(audits.map(draft => draft.event)).eql([AUDIT.captchaCapReached]);
    await tools.call(agent, { tool: 'browser.close', name: 'cap' });
  }, 90_000);

  it('should refuse plainly with a missing key and leave the page to its owner, as before', async () => {
    calls = [];
    const { tools, audits } = world({ secret: { refused: 'not_configured' } });

    const told = (await tools.call(agent, { tool: 'browser.open', name: 'nokey', url: `${origin}/turnstile` })).summary;

    should(told).containEql('ask your owner to take the page over');
    should(told).containEql('Automatic solving is not running: The captcha solver is not set up');
    should(calls).eql([]);
    should(audits).eql([]);
    should((await shown('nokey')).field).equal('empty');
    await tools.call(agent, { tool: 'browser.close', name: 'nokey' });
  }, 90_000);

  it('should leave a check alone, with the old words and no vendor call, when stealth is not in effect', async () => {
    calls = [];
    const { tools } = world({ stealth: false });

    const told = (await tools.call(agent, { tool: 'browser.open', name: 'off', url: `${origin}/turnstile` })).summary;

    should(told).containEql('Do not try to solve or get around it');
    should(told).not.containEql('solving');
    await Bun.sleep(300);
    should(calls).eql([]);
    should((await shown('off')).field).equal('empty');
    await tools.call(agent, { tool: 'browser.close', name: 'off' });
  }, 90_000);

  it('should say a page with no box a token can answer is the owner’s, and report an answer with no token as a failed solve', async () => {
    calls = [];
    const none = world();
    await open('plain', '/plain');
    should(await none.solving.begin(SESSION, 'plain')).have.property('kind', 'not-solving');
    await browser.closePage(SESSION, 'plain');
    should(calls).eql([]);

    issued = 'nothing';
    const empty = world();
    await open('empty', '/turnstile');
    should(await empty.solving.begin(SESSION, 'empty')).eql({ kind: 'solving' });
    for (let attempt = 0; attempt < 60 && empty.audits.length === 0; attempt += 1) await Bun.sleep(100);
    issued = 'token';
    should(empty.audits[0]?.detail).have.properties({ outcome: 'failed' });
    should(empty.state.value?.micros).equal(0);
    should((await shown('empty')).field).equal('empty');
    await browser.closePage(SESSION, 'empty');
  }, 90_000);

  it('should put the key in the vendor’s request body and nowhere else, and print it on no line', async () => {
    should(calls.length).be.greaterThan(0);
    for (const call of calls) {
      should(JSON.stringify(call.headers)).not.containEql(KEY);
      should(call.address).not.containEql(KEY);
      should(call.body.clientKey).equal(KEY);
    }
    // A fresh solve, with everything the daemon says or writes in the run collected and searched.
    const { tools, audits, failures } = world();
    const answer = await tools.call(agent, { tool: 'browser.open', name: 'keys', url: `${origin}/turnstile` });
    await untilField('keys', TOKEN);
    const page = await browser.actOnPage(SESSION, 'keys', { action: 'read', mode: 'snapshot' } as never);
    await Bun.sleep(100);
    const everything = JSON.stringify({ answer, audits, failures, printed, page });
    should(everything).not.containEql(KEY);
    should(JSON.stringify({ audits, failures, printed })).not.containEql(TOKEN);
    should(JSON.stringify({ audits, failures, printed })).not.containEql(TURNSTILE_KEY);
    await tools.call(agent, { tool: 'browser.close', name: 'keys' });
  }, 90_000);
});
