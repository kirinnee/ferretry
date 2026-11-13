import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { BrowsersApi } from '../../../contract/port.ts';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { SealedPages } from '../../../daemon/sealed/page-guards.ts';
import { secureCopyReach } from '../../../daemon/sealed/reach.ts';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { SurfaceControl } from '../../../daemon/tools/control.ts';
import { rootFiles } from '../../../daemon/tools/files.ts';
import { BrowserToolError, BrowserTools } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { browserKernel } from '../../support/kernel.ts';
import { launcherPorts, REAL_WORKER } from '../../support/process-workers.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';
import { workRoots } from '../../support/work-root.ts';

/**
 * A SEALED VALUE NEVER REACHES AN AGENT, IN A REAL HEADLESS CHROME (docs/secure-copy.md).
 *
 * Production, all the way down: the launcher, the browser worker over CDP, the per-session browser service, the agent browser
 * tools and Browsers' secure-copy reach (`BrowsersCopyApi`, as Accounts' adapters call it). A page shows a made-up value and
 * has a Copy button; the agent presses it, captures the clipboard, and moves the copy into a terminal, another page's field and
 * a named secret by handle. Then every channel an agent could read is searched for the value, in the forms it could be asked in.
 *
 * STAND-INS, said plainly. Packages meet only through contracts (`context-imports`), so Accounts' copy service cannot be
 * imported here: `Copies` below is a small stand-in that drives Browsers' reach exactly as Accounts' adapters do (`clipboardRead`
 * with its queue and seal, `sealed.hold`, `sealed.pastedInto`, `sealed.drop`) and speaks like its four tools. Accounts' real
 * service, adapters and tools are proved against the same contract in Accounts' suites. The Vault's one guarded write is done by
 * the test into a real page field, a terminal buffer and a secret map, and the masking registry is a small copy of the Vault's.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const WORKERS = REAL_WORKER();
/** A value no real credential looks like. It appears only on the page that shows it, and must reach nothing else. */
const SENTINEL = 'FAKE-SC-7f3a91';
const NORMAL = 'FAKE-NORMAL-52c0e8';
const SESSION = 's1';
const agent: ToolCaller = { kind: 'agent', sessionId: SESSION };
const person: ToolCaller = { kind: 'person', sessionId: SESSION, openedBy: { by: 'local' } };

class Clock {
  ms = Date.now();
  now(): number {
    return this.ms;
  }
}

/** The Vault's masking registry, as the copy service and the daemon's redaction use it (see `EphemeralValues`). */
class Masker {
  private readonly held: { value: string; marker: string; until: number }[] = [];
  constructor(private readonly clock: Clock) {}
  holdUntil(_session: string, value: string, marker: string, until: number): void {
    this.held.push({ value, marker, until });
  }
  holdScrollback(_session: string, value: string, marker: string): void {
    this.held.push({ value, marker, until: Number.POSITIVE_INFINITY });
  }
  retime(_session: string, marker: string, until: number): void {
    for (const entry of this.held)
      if (entry.marker === marker && entry.until !== Number.POSITIVE_INFINITY)
        entry.until = Math.min(entry.until, until);
  }
  scrub(text: string): string {
    return [...this.held]
      .filter(entry => entry.until > this.clock.now())
      .sort((a, b) => b.value.length - a.value.length)
      .reduce((out, entry) => out.replaceAll(entry.value, entry.marker), text);
  }
}

/** A terminal the Vault typed into: every way an agent reads one goes through the registry. */
class Terminal {
  private buffer = '';
  constructor(private readonly masker: Masker) {}
  type(text: string): void {
    this.buffer += `$ ${text}\n`;
  }
  read = (): string => this.masker.scrub(this.buffer);
  tail = (): string => this.masker.scrub(this.buffer.split('\n').slice(-5).join('\n'));
  logs = (): string => this.masker.scrub(this.buffer);
  snapshot = (): string => this.masker.scrub(this.buffer);
}

interface Copy {
  readonly name: string;
  readonly origin: string;
  readonly length: number;
  value?: string;
  readonly expiresAt: number;
  uses: number;
  state: 'live' | 'discarded';
}

/**
 * The stand-in for Accounts' copy service (see the note above): it holds a value, masks it, tells Browsers where it sits and
 * when it ends, and tells the agent a handle and a length.
 */
class Copies {
  private readonly held = new Map<string, Copy>();
  constructor(
    private readonly masker: Masker,
    private readonly clock: Clock,
    private readonly api: NonNullable<BrowsersApi['copy']>,
  ) {}

  async capture(name: string, key: string): Promise<ToolSaid> {
    this.held.delete(name);
    const expiresAt = this.clock.now() + 3_600_000;
    // While it is being captured it lives to its expected end; once held, to its own; discarded or expired, nothing.
    const live = (): number | undefined => {
      const copy = this.held.get(name);
      if (copy === undefined) return expiresAt;
      return copy.state === 'live' && copy.expiresAt > this.clock.now() ? copy.expiresAt : undefined;
    };
    const answer = await this.api.clipboardRead(SESSION as never, key, {
      // Inside the page's queue, before anything behind the capture runs: mask it and close the pages it sits on.
      seal: found => {
        this.masker.holdUntil(SESSION, found.value.trim(), `[sealed:${name}]`, expiresAt + 600_000);
        this.api.sealed.hold(SESSION as never, name, [found.origin, found.frameOrigin], live);
      },
    });
    if (!answer.ok) {
      const why =
        answer.reason === 'refused'
          ? answer.message
          : "The clipboard holds nothing: press the page's own Copy button first.";
      throw new Error(why);
    }
    const copy: Copy = {
      name,
      origin: answer.origin,
      length: [...answer.value.trim()].length,
      value: answer.value.trim(),
      expiresAt,
      uses: 0,
      state: 'live',
    };
    this.held.set(name, copy);
    audits.push({ event: 'agent.tool', detail: { tool: 'secure_copy', copyLength: copy.length } });
    return {
      text: `Sealed ${String(copy.length)} characters from ${copy.origin} as sealed:${name}, until ${new Date(expiresAt).toISOString()}. You cannot read it; paste it by handle. Pages on ${copy.origin} are closed to your read, eval, console, network and screenshot until the copy ends (or when you discard it); you can still click, type and navigate.`,
    };
  }

  /** The Vault's one place a value leaves: typed where the owner allowed. */
  open(name: string): string | undefined {
    const copy = this.held.get(name);
    return copy?.state === 'live' ? copy.value : undefined;
  }

  used(name: string): void {
    const copy = this.held.get(name);
    if (copy !== undefined) copy.uses += 1;
  }

  /** Where a paste went: a terminal's scrollback stays masked for the session; a page's origin stays closed. */
  async pastedInto(name: string, target: { readonly kind: 'terminal' | 'page'; readonly key: string }): Promise<void> {
    const copy = this.held.get(name);
    if (copy?.value === undefined) return;
    if (target.kind === 'terminal') this.masker.holdScrollback(SESSION, copy.value, `[sealed:${name}]`);
    else
      await this.api.sealed.pastedInto(SESSION as never, name, target.key, () =>
        copy.state === 'live' && copy.expiresAt > this.clock.now() ? copy.expiresAt : undefined,
      );
  }

  listing(): ToolSaid {
    const copies = [...this.held.values()].map(({ name, origin, length, uses, state }) => ({
      name,
      origin,
      length,
      uses,
      state,
    }));
    return {
      text: `This session holds ${String(copies.filter(copy => copy.state === 'live').length)} live copy.`,
      data: { copies },
    };
  }

  names(): readonly string[] {
    return [...this.held.keys()];
  }

  discard(name: string): ToolSaid {
    const copy = this.held.get(name);
    if (copy === undefined) throw new Error(`There is no copy named sealed:${name}.`);
    copy.state = 'discarded';
    delete copy.value;
    this.masker.retime(SESSION, `[sealed:${name}]`, this.clock.now() + 600_000);
    return { text: `sealed:${name} is discarded: its value is gone from the daemon.` };
  }
}

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let tools: BrowserTools;
let sealed: SealedPages;
let control: SurfaceControl;
let copies: Copies;
let reach: BrowsersApi['copy'];
let masker: Masker;
let terminal: Terminal;
const clock = new Clock();
const secrets = new Map<string, string>();
const audits: { event: string; detail: Record<string, unknown> }[] = [];
const events: unknown[] = [];
/** EVERYTHING an agent was handed or could read: every result, every error and every line the daemon wrote. */
const seenByAgent: string[] = [];
const logLines: string[] = [];
let A = '';
let B = '';
let C = '';

const PAGES: Record<string, string> = {
  '/keys': `<html><body><h1>New API key</h1><p id="k">${SENTINEL}</p>
<button id="copy" onclick="navigator.clipboard.writeText(document.getElementById('k').textContent)">Copy</button>
<button id="done">Done</button>
<script>console.log('keys page ready'); fetch('/ping?id=keys')</script></body></html>`,
  '/normal': `<html><body><p id="n">${NORMAL}</p>
<button id="copy" onclick="navigator.clipboard.writeText(document.getElementById('n').textContent)">Copy</button>
<input id="dest"></body></html>`,
  '/form': `<html><body><input id="dest"><p id="mirror"></p>
<script>console.log('form ready');fetch('/ping?id=form');
document.getElementById('dest').oninput=e=>{document.getElementById('mirror').textContent=e.target.value}</script></body></html>`,
  '/dash': `<html><body><h1>Dashboard</h1><p>Your key: ${SENTINEL}</p></body></html>`,
  '/probe': `<html><body><button id="go" onclick="navigator.clipboard.readText().then(t=>document.getElementById('r').textContent='read:'+t,e=>document.getElementById('r').textContent='denied:'+e.name)">Read</button><p id="r">idle</p></body></html>`,
};

/** Runs a tool the way an agent calls it and keeps everything it was told. */
async function agentCall(work: Promise<{ summary?: string; output?: string; text?: string }>) {
  try {
    const answer = await work;
    seenByAgent.push(JSON.stringify(answer));
    return answer;
  } catch (error) {
    seenByAgent.push(String((error as Error).message));
    throw error;
  }
}
const call = (input: Parameters<BrowserTools['call']>[1]) => agentCall(tools.call(agent, input));
const refused = async (input: Parameters<BrowserTools['call']>[1]): Promise<string> => {
  try {
    await call(input);
  } catch (error) {
    should(error).be.instanceOf(BrowserToolError);
    return (error as Error).message;
  }
  throw new Error(`expected ${input.tool} to be refused`);
};
/** What an agent's secure_* tool answers: a sentence, and `isError` for a refusal. Never the value. */
interface ToolSaid {
  readonly text: string;
  readonly isError?: true;
  readonly data?: unknown;
}
const secureCall = async (
  name: 'secure_copy' | 'secure_list' | 'secure_discard',
  input: {
    readonly name?: string;
    readonly source?: { readonly kind?: string; readonly key: string };
    readonly handle?: string;
  },
): Promise<ToolSaid> => {
  let result: ToolSaid;
  try {
    result =
      name === 'secure_copy'
        ? await copies.capture(input.name ?? '', input.source?.key ?? '')
        : name === 'secure_list'
          ? copies.listing()
          : copies.discard((input.handle ?? '').replace('sealed:', ''));
  } catch (error) {
    result = { text: (error as Error).message, isError: true };
  }
  seenByAgent.push(JSON.stringify(result));
  return result;
};

/** What the page REALLY shows, read underneath the tools (the test's own look: no agent is told it). */
async function rawText(name: string, selector: string): Promise<string> {
  const read = await browser.actOnPage(SESSION, name, { action: 'read', mode: 'text', selector } as never);
  return 'result' in read && 'text' in read.result ? String(read.result.text) : '';
}

beforeAll(async () => {
  if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
  root = await mkdtemp(join(tmpdir(), 'ferretry-secure-copy-chrome-'));
  await mkdir(join(root, 'work', '.fy'), { recursive: true });
  site = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch: request => {
      const url = new URL(request.url);
      if (url.pathname === '/ping') return new Response('pong', { headers: { 'content-type': 'text/plain' } });
      const body = PAGES[url.pathname];
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(body, { headers: { 'content-type': 'text/html' } });
    },
  });
  // Three origins that are one server: a page's origin is its host.
  A = `http://127.0.0.1:${String(site.port)}`;
  B = `http://localhost:${String(site.port)}`;
  C = `http://127.0.0.2:${String(site.port)}`;
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
  masker = new Masker(clock);
  terminal = new Terminal(masker);
  sealed = new SealedPages();
  control = new SurfaceControl(
    {
      publish: async (_session: string, type: string, data: unknown) => void events.push({ type, data }),
      history: async () => [],
    },
    { now: () => Date.now() },
  );
  const base = browserKernel().kernel;
  tools = new BrowserTools({
    browser,
    control,
    kernel: {
      ...base,
      // What the daemon's redaction does to every read: the registry masks the sealed value as `[sealed:<name>]`.
      redaction: {
        read: async (fn: (scope: never) => unknown) =>
          await fn({
            text: (text: string) => masker.scrub(text),
            cells: (grid: unknown) => grid,
            lines: (lines: string[]) => lines.map(line => masker.scrub(line)),
          } as never),
      },
    } as never,
    policy: { allows: async () => true },
    files: rootFiles(
      workRoots(join(root, 'work'), join(root, 'work', '.fy')),
      nodeStagedFiles(join(root, 'upload'), {
        now: () => Date.now(),
      } as never),
    ),
    binaryName: 'fy',
    sealed,
  });
  reach = secureCopyReach({ tools, pages: browser, sealed });
  copies = new Copies(masker, clock, reach as NonNullable<BrowsersApi['copy']>);
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
      original(...args);
    };
  }
}, 90_000);

afterAll(async () => {
  await browser?.closeAll();
  site?.stop(true);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

/** The Vault's one guarded write: the copy typed where the owner allowed it. */
async function pasteInto(destination: 'terminal' | 'field' | 'secret', name = 'key'): Promise<void> {
  const value = copies.open(name);
  if (value === undefined) throw new Error('the copy is gone');
  if (destination === 'terminal') {
    terminal.type(value);
    await copies.pastedInto(name, { kind: 'terminal', key: 'dev' });
  } else if (destination === 'field') {
    await browser.actOnPage(SESSION, 'form', { action: 'type', selector: '#dest', text: value } as never);
    await copies.pastedInto(name, { kind: 'page', key: 'form' });
  } else secrets.set('VERCEL_TOKEN', value);
  copies.used(name);
}

describe('a page’s Copy button and a paste work as in any Chrome', () => {
  it('should let the agent press a page’s Copy button and paste into a field of another page, which reads back the text', async () => {
    await call({ tool: 'browser.open', name: 'normal', url: `${A}/normal` });
    await call({ tool: 'browser.click', name: 'normal', selector: '#copy' });
    await call({ tool: 'browser.press', name: 'normal', keys: ['Control+V'], selector: '#dest' } as never);

    const field = await call({
      tool: 'browser.eval',
      name: 'normal',
      function: '() => document.getElementById("dest").value',
    });

    should(field.output).equal(JSON.stringify(NORMAL));
    await call({ tool: 'browser.close', name: 'normal' });
  }, 60_000);

  it('should never give an agent page the clipboard’s READ side: a page script asking for it is denied', async () => {
    await call({ tool: 'browser.open', name: 'probe', url: `${A}/probe` });
    await call({ tool: 'browser.click', name: 'probe', selector: '#go' });
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await call({ tool: 'browser.read', name: 'probe', mode: 'text', selector: '#r' });

    should(result.output).startWith('denied:');
    await call({ tool: 'browser.close', name: 'probe' });
  }, 60_000);
});

describe('page Copy → secure clipboard → terminal, another page’s field and a named secret', () => {
  it('should capture what a page put on the clipboard, telling the agent a length and an origin, never the value', async () => {
    await call({ tool: 'browser.open', name: 'keys', url: `${A}/keys` });
    await call({ tool: 'browser.open', name: 'form', url: `${B}/form` });
    await call({ tool: 'browser.open', name: 'dash', url: `${C}/dash` });
    // Pressed by selector: reading the page first would put the value in the agent's context.
    await call({ tool: 'browser.click', name: 'keys', selector: '#copy' });

    const captured = await secureCall('secure_copy', { name: 'key', source: { kind: 'clipboard', key: 'keys' } });

    should(captured.isError).not.equal(true);
    should(captured.text).containEql('Sealed 14 characters');
    should(captured.text).containEql(`from ${A}`);
    should(captured.text).containEql('sealed:key');
    should(captured.text).containEql('closed to your read, eval, console, network and screenshot');
    should(JSON.stringify(captured)).not.containEql(SENTINEL);
  }, 60_000);

  it('should have emptied the clipboard: a paste the agent presses itself carries nothing', async () => {
    await call({ tool: 'browser.press', name: 'form', keys: ['Control+V'], selector: '#dest' } as never);

    should(await rawText('form', '#mirror')).equal('');
  }, 60_000);

  it('should refuse every read, script, log and picture of the page the value was copied from, saying why and until when', async () => {
    const expected = new Date(clock.ms).getFullYear().toString();
    for (const input of [
      { tool: 'browser.read', name: 'keys', mode: 'text' },
      { tool: 'browser.read', name: 'keys', mode: 'snapshot' },
      { tool: 'browser.console', name: 'keys' },
      { tool: 'browser.network', name: 'keys', action: 'list' },
      { tool: 'browser.screenshot', name: 'keys' },
      { tool: 'browser.pdf', name: 'keys' },
      { tool: 'browser.highlight', name: 'keys', selector: '#k' },
      { tool: 'browser.download', name: 'keys' },
      { tool: 'browser.wait_for', name: 'keys', text: SENTINEL },
      // eval, as it would really be tried: encoded, split into characters, and by patching the page's clipboard writer
      { tool: 'browser.eval', name: 'keys', function: '() => document.getElementById("k").textContent' },
      { tool: 'browser.eval', name: 'keys', function: '() => btoa(document.getElementById("k").textContent)' },
      { tool: 'browser.eval', name: 'keys', function: '() => [...document.getElementById("k").textContent].join("|")' },
      {
        tool: 'browser.eval',
        name: 'keys',
        function:
          '() => { const w = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = t => { window.leak = t; return w(t); }; return 1 }',
      },
    ] as never as Parameters<BrowserTools['call']>[1][]) {
      const sentence = await refused(input);
      should(sentence).containEql(`${input.tool} is refused on %browser:keys`);
      should(sentence).containEql('sealed:key');
      should(sentence).containEql(expected);
      should(sentence).containEql('click, type and navigate');
    }
  }, 60_000);

  it('should still let the agent click and navigate there', async () => {
    const clicked = await call({ tool: 'browser.click', name: 'keys', selector: '#done' });

    should(clicked.summary).containEql('Done on %browser:keys');
  }, 60_000);

  it('should paste into a terminal, and read that terminal masked every way an agent can read one', async () => {
    await pasteInto('terminal');

    for (const read of [terminal.read(), terminal.tail(), terminal.logs(), terminal.snapshot()])
      should(read).equal('$ [sealed:key]\n');
  });

  it('should paste into another page’s field, and close that page’s origin for the life of the copy', async () => {
    await pasteInto('field');

    should(await rawText('form', '#mirror')).equal(SENTINEL);
    for (const input of [
      { tool: 'browser.read', name: 'form', mode: 'text' },
      { tool: 'browser.read', name: 'form', mode: 'snapshot' },
      { tool: 'browser.console', name: 'form' },
      { tool: 'browser.network', name: 'form', action: 'list' },
      { tool: 'browser.screenshot', name: 'form' },
      { tool: 'browser.eval', name: 'form', function: '() => btoa(document.getElementById("dest").value)' },
    ] as never as Parameters<BrowserTools['call']>[1][]) {
      const sentence = await refused(input);
      should(sentence).containEql(`${input.tool} is refused on %browser:form`);
    }
  }, 60_000);

  it('should paste into a named secret, and tell the agent nothing of it', async () => {
    await pasteInto('secret');

    should(secrets.get('VERCEL_TOKEN')).equal(SENTINEL);
    const listed = await secureCall('secure_list', {});
    should(JSON.stringify(listed)).containEql('"uses":3');
  });

  it('should withhold a picture and a script of ANOTHER origin’s page that shows the value, and read it masked', async () => {
    const shot = await refused({ tool: 'browser.screenshot', name: 'dash' });
    const pdf = await refused({ tool: 'browser.pdf', name: 'dash' });
    const encoded = await refused({
      tool: 'browser.eval',
      name: 'dash',
      function: '() => btoa(document.body.innerText)',
    });
    const text = await call({ tool: 'browser.read', name: 'dash', mode: 'text' });

    should(shot).containEql('browser.screenshot is withheld on %browser:dash');
    should(shot).containEql('sealed:key');
    should(pdf).containEql('browser.pdf is withheld');
    should(encoded).containEql('browser.eval is withheld');
    should(text.output).containEql('Your key: [sealed:key]');
  }, 60_000);

  it('should pass a person’s own calls on the same pages', async () => {
    const read = await tools.call(person, { tool: 'browser.read', name: 'keys', mode: 'text', selector: '#k' });
    const shot = await tools.call(person, { tool: 'browser.screenshot', name: 'dash' });

    // Never refused: a person's read is answered, masked like every read.
    should(read.output).equal('[sealed:key]');
    should(shot.picture?.bytes.byteLength).be.above(0);
  }, 60_000);

  it('should refuse a capture while a person holds the page, reading nothing and leaving the clipboard as it was', async () => {
    await call({ tool: 'browser.open', name: 'second', url: `${A}/keys` });
    await call({ tool: 'browser.click', name: 'second', selector: '#copy' });
    const surface = { surface: 'browser' as const, id: 'p', name: 'second' };
    const status = (await browser.status(SESSION)) as { pages: { id: string; name?: string }[] };
    const page = status.pages.find(each => each.name === 'second');
    await control.takeover(SESSION, { ...surface, id: page?.id ?? 'p' } as never, { kind: 'local' } as never);

    const refusedCapture = await secureCall('secure_copy', {
      name: 'again',
      source: { kind: 'clipboard', key: 'second' },
    });
    should(copies.names()).not.containEql('again');
    await control.handback(SESSION, { ...surface, id: page?.id ?? 'p' } as never);
    const afterwards = await secureCall('secure_copy', { name: 'again', source: { kind: 'clipboard', key: 'second' } });

    should(refusedCapture.isError).equal(true);
    should(refusedCapture.text).containEql('taken over');
    // Nothing was read, so nothing was emptied: the clipboard still held the page's value for the capture after the handback.
    should(afterwards.isError).not.equal(true);
    should(afterwards.text).containEql('Sealed 14 characters');
  }, 90_000);

  it('should open the pages when the copy ends, still masked for its ten minutes after, and keep the terminal masked for good', async () => {
    await secureCall('secure_discard', { handle: 'sealed:again' });
    // The copy expires (it lives an hour): its pages are open again, and the page's text is still masked for ten minutes.
    clock.ms += 3_600_000 + 60_000;
    const after = await call({ tool: 'browser.read', name: 'keys', mode: 'text' });
    should(after.output).containEql('[sealed:key]');
    should(after.output).not.containEql(SENTINEL);

    // Long after expiry and its ten minutes, the terminal's scrollback is still masked: it is still there to be read.
    clock.ms += 20 * 60_000;
    should(terminal.read()).equal('$ [sealed:key]\n');
    should(terminal.tail()).equal('$ [sealed:key]\n');
    should(terminal.logs()).equal('$ [sealed:key]\n');
    should(terminal.snapshot()).equal('$ [sealed:key]\n');
  }, 60_000);
});

describe('the value is in none of the places an agent could look', () => {
  it('should be absent, in every form it could be asked in, from every result, error, log line, event and audit record', () => {
    const forms = [
      SENTINEL,
      Buffer.from(SENTINEL).toString('base64'),
      btoa(SENTINEL).replaceAll('=', ''),
      [...SENTINEL].join('|'),
      [...SENTINEL].reverse().join(''),
      Buffer.from(SENTINEL).toString('hex'),
      encodeURIComponent(SENTINEL),
    ];
    const channels: Record<string, string> = {
      'tool results and errors': seenByAgent.join('\n'),
      'the terminal, read every way': [terminal.read(), terminal.tail(), terminal.logs(), terminal.snapshot()].join(
        '\n',
      ),
      'log lines': logLines.join('\n'),
      events: JSON.stringify(events),
      audit: JSON.stringify(audits),
      'the copies listing': JSON.stringify(copies.listing()),
    };
    should(seenByAgent.length).be.above(30);
    for (const [channel, text] of Object.entries(channels))
      for (const form of forms)
        should({ channel, form, found: text.includes(form) }).eql({ channel, form, found: false });
  });
});
