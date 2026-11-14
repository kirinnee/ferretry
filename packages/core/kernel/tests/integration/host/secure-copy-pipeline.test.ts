/**
 * THE SECURE-COPY PIPELINE ON REAL PROCESSES (secure-clip-1 fix1 P2-7, narrowed and isolated in fix2 R1).
 *
 * What is production: the Accounts half (the copy service, the `secure_*` tools), the Vault half (the sealed command child on
 * a real process with the sealed environment, the input bridge, the secret store, the masking registry and the kernel's
 * redaction it binds), and the Browsers half (the tools and the page target, over a REAL headless Chrome and the production
 * launcher). Stood in: the terminal (a recording adapter, so the typed text can be read back), the agenda and the audit sink
 * (the kernel's fakes).
 *
 * ISOLATION (`secure-copy-isolation.ts`, self-checked by `secure-copy-isolation.test.ts`): every child the Browsers half
 * starts has HOME, every XDG_* directory and TMPDIR under the test's own temporary home, whatever environment the launcher
 * handed it; every Chrome gets a proxy switch to a loopback tripwire and a resolver that knows only loopback, and the
 * Browsers half's fetch port refuses a non-loopback host. The first test below asserts that on the processes it launched.
 *
 * WHAT IT ASSERTS, and no more. The one secret-shaped string is the fake sentinel. It is searched for in: every tool answer
 * and every owner route answer this file received (the text the tools return, as the test host serialised it, NOT the MCP
 * server's own wire serializer), the gate's audit records, the host's logs and published events, and the state files the
 * halves wrote. The value was typed into: the terminal adapter and the page's field, as the page's own script reported it.
 * For the secret store it asserts the name exists and was audited; it does NOT read the stored value back (no getter exists, and
 * none is added), so it does not prove the store holds THIS sentinel. It does not read agent transcript files, and its
 * navigation case navigates BEFORE the capture and tests a stale reference, not navigation during the read.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { BrowsersApi } from '../../../../../plugins/browsers/contract/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import {
  ChildEnvironmentPort,
  type InputTargetAdapter,
  type InputTargetFacts,
  VaultPort,
  type VaultApi,
} from '../../../../vault/contract/index.ts';
import type { ChildEnvironmentOpener, FerretId, Redaction } from '../../../contract/index.ts';
import { bunSpawn, effectivePermissions, globalFetch, restrictSpawn, systemClock } from '../../../host/index.ts';
import {
  BOUND_NAMES,
  homeEnvironment,
  isolatedSpawn,
  type Launch,
  loopbackFetch,
  writeFontConfiguration,
} from './secure-copy-isolation.ts';
import { implementDaemon, perNeeder, providedFor } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { ferret, type TestHost, testHost } from '../../../testing/index.ts';

/** The REAL half of a plugin, as the generated registry loads it. */
const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

/** A value no real credential looks like. */
const SENTINEL = 'FAKE-SC-7f3a91';
const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');

const FERRET = 'F1';
/** A second ferret, on the same machine and so on the same browser (secure-clip-2 fix1, finding 7). */
const OTHER = 'F2';
let calling = FERRET as FerretId;

/**
 * Every form an agent could be handed the sentinel in, or could ask a page to give it in: the sweep searches for each.
 * Raw, base64 (padded and not), hex, reversed, the characters joined by a bar, URI-encoded, and split in two halves.
 */
function forms(value: string): readonly string[] {
  const b64 = Buffer.from(value).toString('base64');
  return [
    value,
    b64,
    b64.replace(/=+$/u, ''),
    Buffer.from(value).toString('hex'),
    [...value].reverse().join(''),
    [...value].join('|'),
    encodeURIComponent(value),
    value.slice(0, Math.floor(value.length / 2)) + value.slice(Math.floor(value.length / 2)),
  ];
}

let root = '';
/** The one home every child the Browsers half starts is bound to, and the tripwire every Chrome's traffic is sent to. */
let home = '';
let tripwire: ReturnType<typeof Bun.serve>;
const tripped: string[] = [];
const launches: Launch[] = [];
/** The process environment this file replaced, put back after it. */
const replaced = new Map<string, string | undefined>();
let site: ReturnType<typeof Bun.serve>;
let base = '';
let host: TestHost;
let gate: FakeGate;
/** What the page's own server was told the field held: the proof the value really was typed. */
const typedIntoPage: string[] = [];
/** What the recording terminal was asked to type. */
const typedIntoTerminal: string[] = [];
/**
 * A seam inside the REAL Browsers half, for the one window a real Chrome cannot position by timing: Accounts' takeover
 * check (`copy.takenOver`) answers, and `afterCheck` runs before the answer reaches the Vault. While `suppressReport` is on, the
 * takeover is not told to the Vault, so the test can land it from inside a check without waiting on the lock that check holds.
 */
const seam = {
  afterCheck: undefined as undefined | ((answered: number) => Promise<void>),
  answered: 0,
  suppressReport: false,
};

/** Every answer an agent or a route gave in this file, as text: the sentinel is searched for in all of them. */
const said: string[] = [];

const TERMINAL_FACTS: InputTargetFacts = {
  kind: 'terminal',
  paneProof: { paneId: '%1', pid: 10 },
  foreground: { pid: 11, pgid: 11, comm: 'vercel', argv: 'vercel env add TOKEN' },
  echo: 'off',
  cursorRow: 0,
  promptLine: '? Value of TOKEN?',
  promptLineDigest: 'b'.repeat(64),
  program: 'vercel',
  canonical: true,
  recognisedConsumer: true,
};

/** A terminal that records what it was told to type, in place of tmux: the typed text can be compared, nothing else can. */
const fakeTerminal: InputTargetAdapter = {
  masking: 'screen',
  observe: async () => ({ ok: true, facts: TERMINAL_FACTS, names: ['dev'] }),
  type: async (_ferret: unknown, _target: unknown, values: readonly { readonly text: string }[]) => {
    for (const value of values) typedIntoTerminal.push(value.text);
    return 'typed';
  },
} as unknown as InputTargetAdapter;

const PAGES: Readonly<Record<string, string>> = {
  '/source': `<html><body><h1>Token created</h1><p id="token">${SENTINEL}</p><p id="empty"></p><p id="other">no secret here</p></body></html>`,
  '/dest': `<html><body><label>API token <input id="dest" type="password" oninput="fetch('/seen?v='+encodeURIComponent(this.value))"></label></body></html>`,
  '/other': '<html><body><p id="token">moved on</p></body></html>',
  // A page whose Copy button puts the value on the clipboard: the agent presses it by selector and captures the CLIPBOARD
  // (secure-clip-2 fix2, item 8). The value is on the page too, as such a page shows a key once.
  '/clip': `<html><body><p id="k">${SENTINEL}</p><button id="copy" onclick="navigator.clipboard.writeText(document.getElementById('k').textContent)">Copy</button></body></html>`,
  '/slow': '<html><body><p>slow page</p></body></html>',
  // Pages that say the value on a channel other than their visible text (secure-clip-2 fix1, finding 5): a title, a dialog, and
  // two inputs whose value is it (so a click on "input" is a strict-mode error that quotes both).
  '/titled': `<html><head><title>key ${SENTINEL}</title></head><body><p id="t">${SENTINEL}</p><button id="go" onclick="alert('your key is ' + document.getElementById('t').textContent)">Go</button><input id="a" value="${SENTINEL}"><input id="b" value="${SENTINEL}"></body></html>`,
};

/** The tool call as a ferret makes it; the answer is kept for the sentinel sweep. */
async function tool(name: string, input: Record<string, unknown>) {
  calling = FERRET as FerretId;
  const answer = await host.tool(name, input, { as: ferret(FERRET) });
  said.push(JSON.stringify(answer));
  return answer;
}

const ownerCall = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const answer = await host.request(method, path, body === undefined ? {} : { body });
  said.push(answer.body);
  return answer;
};

/** The owner reads the card, then allows exactly what it names: the body carries no value. */
async function allow(requestId: string) {
  const listed = await ownerCall('GET', `/v1/ferrets/${FERRET}/input-requests`);
  const request = listed
    .json<{ requests: { id: string; observedDigest?: string }[] }>()
    .requests.find(each => each.id === requestId);
  if (request?.observedDigest === undefined) throw new Error('the card has no observed digest yet');
  return await ownerCall('POST', `/v1/ferrets/${FERRET}/input-requests/${requestId}/deliver`, {
    deliveryId: crypto.randomUUID(),
    observedDigest: request.observedDigest,
    sealed: true,
    submit: false,
  });
}

const requestOf = (answer: { text?: string; data?: unknown }): string => {
  const id = (answer.data as { request?: string } | undefined)?.request;
  if (id === undefined) throw new Error(`no request in ${JSON.stringify(answer)}`);
  return id;
};

/** Everything the daemon wrote or said that is not an answer to a caller: audit, events, logs, every state file. */
async function trace(): Promise<string> {
  const files: [string, string][] = [];
  for (const id of ['vault', 'accounts', 'browsers'])
    for (const entry of host.state(id).files.entries()) files.push([id, JSON.stringify(entry)]);
  return JSON.stringify([gate.audits, host.logs, host.published, files]);
}

beforeAll(async () => {
  if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
  root = await mkdtemp(join(tmpdir(), 'ferretry-secure-copy-pipeline-'));
  await mkdir(join(root, 'work'), { recursive: true });
  // Everything the production Browsers launcher reads from the process environment (`processHost`) is the temporary home's,
  // BEFORE the half is built: HOME, the XDG directories, the profile's FY_HOME and the Chrome binary.
  home = join(root, 'home');
  const bound = { ...homeEnvironment(home), FY_HOME: join(home, '.ferretry'), FY_CHROME_BIN: chrome };
  for (const path of [...Object.values(homeEnvironment(home)), bound.FY_HOME]) await mkdir(path, { recursive: true });
  // Chrome lays text out only with a font, and a moved HOME can lose the profile's fonts: the home gets its own fonts.conf.
  Object.assign(bound, { FONTCONFIG_FILE: await writeFontConfiguration(home) });
  for (const [name, value] of Object.entries(bound)) {
    replaced.set(name, process.env[name]);
    process.env[name] = value;
  }
  // The tripwire is Chrome's only way out: a refused-by-design proxy on an ephemeral loopback port that records what it was asked.
  tripwire = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      tripped.push(new URL(request.url).host);
      return new Response('blocked by the test', { status: 403 });
    },
  });
  // The fake command a ferret would run: it prints the sentinel, a program of its own making (a path, never a rule match).
  await writeFile(join(root, 'work', 'fake-token'), `#!/bin/sh\necho ${SENTINEL}\n`);
  await chmod(join(root, 'work', 'fake-token'), 0o755);
  // A program that happens to be called `git`, prints its environment on stderr and fails: what the agent is handed back.
  await mkdir(join(root, 'work', 'bin'), { recursive: true });
  await writeFile(join(root, 'work', 'bin', 'git'), '#!/bin/sh\nenv >&2\necho FAKE-OUT-VALUE\nexit 1\n');
  await chmod(join(root, 'work', 'bin', 'git'), 0o755);
  await writeFile(join(root, 'work', 'fake-empty'), '#!/bin/sh\nexit 0\n');
  await chmod(join(root, 'work', 'fake-empty'), 0o755);
  await writeFile(join(root, 'work', 'fake-big'), `#!/bin/sh\nhead -c 20000 /dev/zero | tr '\\0' 'x'\n`);
  await chmod(join(root, 'work', 'fake-big'), 0o755);
  await writeFile(join(root, 'work', 'fake-slow'), `#!/bin/sh\nsleep 5\necho ${SENTINEL}\n`);
  await chmod(join(root, 'work', 'fake-slow'), 0o755);
  // Every process a half starts is real. The Vault's capture child runs sealed, from this daemon's own allowlist.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root };
  let opener: ChildEnvironmentOpener | undefined;
  // The daemon's own environment holds credentials for git and gh (a proxy URL with a password, say): the host adds them to a
  // child named `git` or `gh`. A capture child must never get them, whatever its executable is called.
  const daemonOnly = {
    HTTPS_PROXY: 'http://user:FAKE-PROXY-CRED@proxy.invalid:3128',
    SSH_AUTH_SOCK: '/run/FAKE-SSH-SOCK',
  };
  const realSpawn = bunSpawn(env, () => opener, daemonOnly, env);
  site = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/seen') {
        typedIntoPage.push(url.searchParams.get('v') ?? '');
        return new Response('ok');
      }
      if (url.pathname === '/slow') await Bun.sleep(2500);
      // A page of another host that embeds the protected one in a frame (finding 6).
      if (url.pathname === '/framed')
        return new Response(
          `<html><body><p>a harmless page</p><iframe src="http://127.0.0.1:${String(site.port)}/source"></iframe></body></html>`,
          {
            headers: { 'content-type': 'text/html' },
          },
        );
      const page = PAGES[url.pathname];
      return page === undefined
        ? new Response('not found', { status: 404 })
        : new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  base = `http://127.0.0.1:${String(site.port)}`;

  let redact: Redaction | undefined;
  const vault = real('vault');
  const buildVault = vault.build as NonNullable<typeof vault.build>;
  const realVault = implementDaemon(vault.manifest, {
    build: ctx => {
      const half = buildVault({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          spawn: restrictSpawn(
            vault.manifest.id,
            effectivePermissions(vault.manifest.id, vault.manifest.permissions?.spawn ?? []),
            realSpawn,
          ),
        },
      });
      // The kernel binds the Vault's own redaction as every plugin's `kernel.redaction`; the test host does the same.
      redact = (half as { provides?: { redaction?: Redaction } }).provides?.redaction;
      return half;
    },
  });
  const browsersHalf = real('browsers');
  const buildBrowsers = browsersHalf.build as NonNullable<typeof browsersHalf.build>;
  const browsers = implementDaemon(browsersHalf.manifest, {
    build: ctx => {
      const told = (ctx.needs as unknown as { vault: VaultApi }).vault;
      const half = buildBrowsers({
        ...ctx,
        // The production launcher, on real processes and a real clock: the kernel host's own spawn, fetch and clock.
        kernel: {
          ...ctx.kernel,
          // Every child bound to the temporary home, every Chrome kept off the network, every fetch loopback-only.
          spawn: isolatedSpawn(realSpawn, { home, proxy: `http://127.0.0.1:${String(tripwire.port)}`, launches }),
          fetch: loopbackFetch(globalFetch()),
          clock: systemClock(),
        },
        needs: {
          ...ctx.needs,
          vault: {
            ...told,
            pageTakenOver: async (ferretId: FerretId, keys: readonly string[]) =>
              seam.suppressReport ? undefined : await told.pageTakenOver?.(ferretId, keys),
          },
        },
      });
      const provided = (half as { provides?: Record<string, unknown> }).provides ?? {};
      const inner = provided.browsers;
      return {
        ...half,
        provides: {
          ...provided,
          browsers: perNeeder(needer => {
            const api = providedFor(inner, needer) as BrowsersApi;
            const real = api.copy;
            if (real === undefined) return api;
            return {
              ...api,
              copy: {
                ...real,
                takenOver: async (ferretId: FerretId, key: string) => {
                  const answer = await real.takenOver(ferretId, key);
                  seam.answered += 1;
                  await seam.afterCheck?.(seam.answered);
                  return answer;
                },
              },
            };
          }),
        },
      } as never;
    },
  });
  const terminals = implementDaemon(real('terminals').manifest, {
    build: () => ({ hooks: { 'input.targets:terminal': fakeTerminal } }) as never,
  });
  gate = new FakeGate();
  const ferrets = {
    get: async (id: string) => (id === FERRET || id === OTHER ? { name: id } : undefined),
    workFolder: async () => ({ folder: join(root, 'work') }),
  };
  host = await testHost({
    plugins: [realVault, real('accounts'), browsers, terminals],
    gate: new StandInAdmission(request =>
      request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
    ),
    uses: { ferrets, agentControl: { allows: async () => true } },
    fakes: { gate, asks: new FakeAsks(), ferrets },
    redaction: { read: async fn => await (redact as Redaction).read(fn) },
  });
  opener = host.provided(ChildEnvironmentPort);
}, 120_000);

afterAll(async () => {
  await host?.stop();
  site?.stop(true);
  tripwire?.stop(true);
  for (const [name, value] of replaced) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (root !== '') await rm(root, { recursive: true, force: true });
});

const copy = (name: string, source: Record<string, unknown>) => tool('secure_copy', { name, source });
const command = (script: string, extra: Record<string, unknown> = {}) => ({
  kind: 'command',
  argv: [join(root, 'work', script)],
  ...extra,
});
const paste = (handle: string, to: Record<string, unknown>) =>
  tool('secure_paste', { handle: `sealed:${handle}`, to, prompt: 'the token' });
const mustBeRefused = (answer: { isError?: boolean; text?: string }, words?: string) => {
  should(answer.isError).equal(true);
  if (words !== undefined) should(answer.text).containEql(words);
};
const requests = async () =>
  (await ownerCall('GET', `/v1/ferrets/${FERRET}/input-requests`)).json<{
    requests: { id: string; state: string; reason?: string }[];
  }>().requests;
const takeOver = async (key: string) => {
  const taken = await host.request('POST', `/v1/ferrets/${FERRET}/surfaces/browser/control`, {
    body: { action: 'takeover', key },
  });
  should(taken.status).equal(200);
};

describe('the secure-copy pipeline, on real processes and a real Chrome', () => {
  it('should run isolated: Chrome and its worker are bound to the temporary home, and an external URL goes nowhere', async () => {
    // A loopback fixture loads (the block leaves loopback and the CDP pipe alone)…
    const local = await tool('browser_open', { name: 'iso', url: `${base}/source` });
    should(local.isError).not.equal(true);
    // …and an external address never leaves the machine: Chrome sends it to the tripwire, which records it and refuses.
    const external = await tool('browser_open', { name: 'iso-out', url: 'http://203.0.113.7/exfil' });
    should(JSON.stringify(external)).not.containEql('Token created');
    for (let waited = 0; !tripped.includes('203.0.113.7') && waited < 5_000; waited += 100) await Bun.sleep(100);
    should(tripped).containEql('203.0.113.7');
    should(tripped.filter(host => host.startsWith('127.0.0.1') || host.startsWith('localhost'))).eql([]);

    const chromes = launches.filter(launch => launch.args.some(arg => arg.startsWith('--user-data-dir=')));
    should(chromes.length).be.above(0);
    for (const chromeLaunch of chromes) {
      should(chromeLaunch.args).containEql(`--proxy-server=http://127.0.0.1:${String(tripwire.port)}`);
      should(chromeLaunch.args.join(' ')).containEql('MAP * ~NOTFOUND');
      should(chromeLaunch.env.FONTCONFIG_FILE?.startsWith(`${home}/`)).equal(true);
      const profile = chromeLaunch.args.find(arg => arg.startsWith('--user-data-dir='));
      should(profile?.slice('--user-data-dir='.length).startsWith(root)).equal(true);
    }
    // Every child the Browsers half started (Chrome and the worker alike) was bound to the temporary home.
    should(launches.length).be.above(chromes.length);
    for (const launch of launches) {
      for (const name of BOUND_NAMES) {
        const value = launch.env[name] as string;
        should(value === home || value.startsWith(`${home}/`)).equal(true);
      }
      should(launch.env.HOME).equal(home);
    }
    // The pages stay open: closing the last one stops the browser, and the cases below start from a running one.
  }, 120_000);

  it('should seal a page element and paste it into a terminal: typed once, said nowhere, masked in every read', async () => {
    const opened = await tool('browser_open', { name: 'src', url: `${base}/source` });
    should(opened.isError).not.equal(true);

    const sealed = await copy('pagetoken', { kind: 'browser', key: 'src', selector: '#token' });
    should(sealed.isError).not.equal(true);
    should(sealed.text).containEql('sealed:pagetoken').and.containEql(`${SENTINEL.length} characters`);
    const asked = await paste('pagetoken', { kind: 'terminal', name: 'dev' });
    should(asked.isError).not.equal(true);
    const delivered = await allow(requestOf(asked));

    should(delivered.status).equal(200);
    should(typedIntoTerminal).eql([SENTINEL]);
    // The page the value was read from is CLOSED to the agent while the copy lives (secure-clip-2 fix1: a read of it could show the
    // value in a form no mask knows), and the refusal says why and how to end it, without the value.
    const read = await tool('browser_read', { name: 'src', mode: 'snapshot' });
    mustBeRefused(read, 'holds sealed:pagetoken');
    should(read.text).containEql('secure_discard');
    should(JSON.stringify(read)).not.containEql(SENTINEL);
  }, 120_000);

  it('should seal a fake command’s output and paste it into a real page field, which the page itself saw once', async () => {
    const sealed = await copy('cmdtoken', command('fake-token'));
    should(sealed.isError).not.equal(true);
    should(sealed.text).containEql('sealed:cmdtoken');
    await tool('browser_open', { name: 'dest', url: `${base}/dest` });

    const asked = await paste('cmdtoken', { kind: 'browser', name: 'dest', selector: '#dest' });
    should(asked.isError).not.equal(true);
    const delivered = await allow(requestOf(asked));

    should(delivered.status).equal(200);
    // The page's own server was told the field's value by the page's own script: the value really was typed.
    for (let waited = 0; !typedIntoPage.includes(SENTINEL) && waited < 5_000; waited += 100) await Bun.sleep(100);
    should(typedIntoPage).containEql(SENTINEL);
    // …and the agent's read of that page is masked, field value included.
    const read = await tool('browser_read', { name: 'dest', mode: 'snapshot' });
    should(JSON.stringify(read)).not.containEql(SENTINEL);
  }, 120_000);

  it('should paste a sealed value into the secret store by name, writing it without ever reading it back', async () => {
    await copy('storetoken', command('fake-token'));

    const asked = await paste('storetoken', { kind: 'secret', name: 'VERCEL_TOKEN' });
    should(asked.isError).not.equal(true);
    const delivered = await allow(requestOf(asked));

    should(delivered.status).equal(200);
    should(await host.provided(VaultPort).has('VERCEL_TOKEN' as never)).equal(true);
    should(JSON.stringify(gate.audits)).containEql('VERCEL_TOKEN');
  }, 120_000);

  it('should refuse a capture that printed nothing, too much, or ran out of time, and hold no copy for any of them', async () => {
    mustBeRefused(await copy('empty', command('fake-empty')));
    mustBeRefused(await copy('big', command('fake-big')), '16');
    // The kernel clock is the test host's driven one: the timeout fires when the test moves it past the limit.
    const slow = copy('slow', command('fake-slow', { timeoutSeconds: 1 }));
    await Bun.sleep(500);
    await host.clock.advance(2_000);
    mustBeRefused(await slow);

    const listed = await tool('secure_list', {});
    const names = JSON.stringify(listed);
    for (const name of ['sealed:empty', 'sealed:big', 'sealed:slow']) should(names).not.containEql(name);
  }, 120_000);

  it('should start a capture child with the sealed environment only, even one named git: no daemon-only value reaches it', async () => {
    const failed = await copy('gitcap', { kind: 'command', argv: [join(root, 'work', 'bin', 'git')] });

    mustBeRefused(failed);
    // What the agent is told of a failed command is its stderr: the child's whole environment, if it had the overlay.
    for (const leaked of ['FAKE-PROXY-CRED', 'FAKE-SSH-SOCK', 'HTTPS_PROXY', 'SSH_AUTH_SOCK'])
      should(JSON.stringify(failed)).not.containEql(leaked);
    should(JSON.stringify(failed)).containEql('HOME=');
  }, 120_000);

  it('should refuse a page capture when the page moved on from the snapshot, or the element holds nothing', async () => {
    await tool('browser_open', { name: 'nav', url: `${base}/source` });
    const snapshot = await tool('browser_read', { name: 'nav', mode: 'snapshot', find: 'Token created' });
    const ref = /\[ref=([a-z0-9]+)\]/u.exec(JSON.stringify(snapshot))?.[1];
    await tool('browser_navigate', { name: 'nav', url: `${base}/other` });

    const stale = await copy('moved', { kind: 'browser', key: 'nav', ref: ref ?? 'e1' });
    const empty = await copy('hollow', { kind: 'browser', key: 'nav', selector: '#nothing-here' });

    mustBeRefused(stale);
    mustBeRefused(empty);
    should(JSON.stringify(await tool('secure_list', {}))).not.containEql('sealed:moved');
  }, 120_000);

  it('should refuse a paste of a copy that was discarded, in the Vault’s words, and raise no card', async () => {
    await copy('gone', command('fake-token'));
    await tool('secure_discard', { handle: 'sealed:gone' });
    const before = (await requests()).length;

    const refused = await paste('gone', { kind: 'terminal', name: 'dev' });

    mustBeRefused(refused, 'no live copy');
    should((await requests()).length).equal(before);
  }, 120_000);

  it('should end a card whose page is gone by the time the owner allows it, typing nothing', async () => {
    await copy('late', command('fake-token'));
    await tool('browser_open', { name: 'dest2', url: `${base}/dest` });
    const asked = await paste('late', { kind: 'browser', name: 'dest2', selector: '#dest' });
    const typedBefore = typedIntoPage.length;
    await tool('browser_close', { name: 'dest2' });

    const delivered = await allow(requestOf(asked));

    should(delivered.status).not.equal(200);
    should(typedIntoPage.length).equal(typedBefore);
  }, 120_000);

  it('should refuse a waiting paste the moment a person takes its page over, and type nothing', async () => {
    await copy('held', command('fake-token'));
    await tool('browser_open', { name: 'dest3', url: `${base}/dest` });
    const asked = await paste('held', { kind: 'browser', name: 'dest3', selector: '#dest' });
    const typedBefore = typedIntoPage.length;

    await takeOver('dest3');

    should(await host.provided(VaultPort).inputState(requestOf(asked) as never)).equal('refused');
    should(typedIntoPage.length).equal(typedBefore);
    // Allowing it now is refused: the card is over, and the answer says so without a value.
    const late = await ownerCall('POST', `/v1/ferrets/${FERRET}/input-requests/${requestOf(asked)}/deliver`, {
      deliveryId: crypto.randomUUID(),
      observedDigest: 'b'.repeat(64),
      sealed: true,
      submit: false,
    });
    should(late.status).not.equal(200);
    should(typedIntoPage.length).equal(typedBefore);
  }, 120_000);

  it('should refuse a paste whose takeover lands while the write waits in the page’s queue, and type nothing', async () => {
    await copy('queued', command('fake-token'));
    // On `localhost`, a host no copy covers: the agent's own page script is what keeps the queue busy, and a covered page would refuse it.
    await tool('browser_open', { name: 'dest4', url: `${base.replace('127.0.0.1', 'localhost')}/dest` });
    const asked = await paste('queued', { kind: 'browser', name: 'dest4', selector: '#dest' });
    const typedBefore = typedIntoPage.length;
    // The page's queue is busy with the agent's own act; the owner allows, so the write queues behind it.
    // A page script that takes real time keeps the queue busy WITHOUT changing the document the card was drawn from.
    const busy = tool('browser_eval', {
      name: 'dest4',
      function: '() => new Promise(resolve => setTimeout(() => resolve(1), 2500))',
    }).catch(() => undefined);
    await Bun.sleep(300);
    const delivering = allow(requestOf(asked));
    await Bun.sleep(300);

    await takeOver('dest4');
    const delivered = await delivering;
    await busy;

    should(delivered.status).not.equal(200);
    should(typedIntoPage.length).equal(typedBefore);
  }, 120_000);

  it('should refuse a paste whose takeover lands AFTER the last check and before the write, and type nothing', async () => {
    await copy('window', command('fake-token'));
    await tool('browser_open', { name: 'dest5', url: `${base}/dest` });
    const asked = await paste('window', { kind: 'browser', name: 'dest5', selector: '#dest' });
    const typedBefore = typedIntoPage.length;
    // The owner allows; the Vault's own check before opening the copy finds the page free, and THEN a person takes it
    // over: only the check inside the page's queue, right before the write, can still stop it.
    seam.answered = 0;
    seam.afterCheck = async answered => {
      if (answered !== 1) return;
      seam.suppressReport = true;
      await takeOver('dest5');
      seam.suppressReport = false;
    };

    const delivered = await allow(requestOf(asked));
    seam.afterCheck = undefined;
    await Bun.sleep(500);

    should(delivered.status).not.equal(200);
    should(typedIntoPage.length).equal(typedBefore);
    should(await host.provided(VaultPort).inputState(requestOf(asked) as never)).equal('refused');
  }, 120_000);

  describe('what a sealed value’s page still says, through every other channel (secure-clip-2 fix1)', () => {
    const route = `/v1/ferrets/${FERRET}/browser`;
    const asAgent = { as: ferret(FERRET) };
    const localhost = () => base.replace('127.0.0.1', 'localhost');

    /** Whatever an agent was told, searched for every form of the value. */
    const sweep = (answer: unknown): string[] => {
      const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
      return forms(SENTINEL).filter(form => text.includes(form));
    };

    async function tellAndSweep<T>(answer: T): Promise<T> {
      said.push(typeof answer === 'string' ? answer : JSON.stringify(answer));
      should(sweep(answer)).eql([]);
      return answer;
    }

    /** The page a person's status names as the one at `address`, made the viewed page: the route acts on that one. */
    async function view(address: string): Promise<string> {
      const status = await host.request('GET', route, {});
      const page = status.json<{ pages: { id: string; url: string }[] }>().pages.find(each => each.url === address);
      if (page === undefined) throw new Error(`no page at ${address}: ${status.body.slice(0, 600)}`);
      const viewed = await host.request('POST', route, { body: { action: 'activate-page', pageId: page.id } });
      should(viewed.status).equal(200);
      return page.id;
    }

    it('should close the browser’s HTTP action route to an agent’s credential on a covered page, and keep a person’s own', async () => {
      await copy('routetoken', { kind: 'browser', key: 'src', selector: '#token' });
      await view(`${base}/source`);

      const agent = await host.request('POST', route, { body: { action: 'read' }, ...asAgent });
      const picture = await host.request('POST', route, { body: { action: 'screenshot' }, ...asAgent });
      const person = await host.request('POST', route, { body: { action: 'read' } });

      should(agent.status).equal(403);
      should(agent.body).containEql('holds sealed:');
      should(picture.status).equal(403);
      should(JSON.stringify(picture.json())).not.containEql('screenshotBase64');
      should(person.status).equal(200);
      await tellAndSweep(agent.body);
      await tellAndSweep(picture.body);
    }, 120_000);

    it('should refuse an agent credential’s viewer stream while a sealed value lives, and let a person watch', async () => {
      const agent = await host.socket(`${route}/stream`, asAgent);
      const person = await host.socket(`${route}/stream`, {});

      should(agent.response?.status).equal(403);
      should(agent.response?.body).containEql('cannot be masked');
      should(person.response).equal(undefined);
      await person.handler?.close();
    }, 120_000);

    it('should show a covered page by its origin and a fixed title in list and tabs, never its title or address', async () => {
      await tool('browser_open', { name: 'titled', url: `${base}/titled` });

      for (const answer of [await tool('browser_list', {}), await tool('browser_tabs', { action: 'list' })]) {
        await tellAndSweep(answer);
        should(JSON.stringify(answer)).containEql('this page holds a sealed value');
      }
    }, 120_000);

    it('should withhold the words of a dialog the covered page raised, and the browser’s error about it', async () => {
      const clicked = await tool('browser_click', { name: 'titled', selector: '#go' });
      // Typing into a paragraph fails in the browser, whose own error may quote the element; the agent is told one sentence.
      const typed = await tool('browser_type', { name: 'titled', selector: '#t', text: 'x' });

      for (const answer of [clicked, typed]) await tellAndSweep(answer);
      should(JSON.stringify(clicked)).containEql('this page holds a sealed value');
      should(JSON.stringify(clicked)).not.containEql('your key is');
      // Whether Chrome refuses to type there is Chrome's; if it does, the sentence is the fixed one.
      if (typed.isError === true) should(typed.text).containEql('does not pass on what the browser said');
    }, 120_000);

    it('should refuse a selector that depends on what the page says, and still click by structure', async () => {
      const byText = await tool('browser_click', { name: 'titled', selector: 'text=Go' });
      const byAttribute = await tool('browser_click', { name: 'titled', selector: '[value^="FAKE"]' });
      const byStructure = await tool('browser_click', { name: 'titled', selector: '#go' });
      await tool('browser_dialog', { name: 'titled', action: 'accept' });

      mustBeRefused(byText, 'depends on what the page says');
      mustBeRefused(byAttribute, 'depends on what the page says');
      should(byStructure.isError).not.equal(true);
    }, 120_000);

    it('should close a page of ANOTHER host that embeds the protected site in a frame', async () => {
      await tool('browser_open', { name: 'framed', url: `${localhost()}/framed` });

      const read = await tool('browser_read', { name: 'framed', mode: 'text' });
      const picture = await tool('browser_screenshot', { name: 'framed' });

      mustBeRefused(read, 'is refused');
      mustBeRefused(picture);
      await tellAndSweep(read);
      await tellAndSweep(picture);
    }, 120_000);

    it('should refuse a SECOND ferret on the same browser too, without naming the first ferret’s copy', async () => {
      calling = OTHER as FerretId;
      const opened = await host.tool('browser_open', { name: 'mine', url: `${base}/source` }, { as: ferret(OTHER) });
      const read = await host.tool('browser_read', { name: 'mine', mode: 'text' }, { as: ferret(OTHER) });
      calling = FERRET as FerretId;
      said.push(JSON.stringify(opened), JSON.stringify(read));

      mustBeRefused(read, 'is refused');
      should(JSON.stringify(read)).containEql('other ferrets sealed');
      should(JSON.stringify(read)).not.containEql('sealed:pagetoken');
      should(sweep(read)).eql([]);
    }, 120_000);

    it('should still let an agent read a page no copy covers, so the guards are not a blanket refusal', async () => {
      await tool('browser_open', { name: 'elsewhere', url: `${localhost()}/other` });

      const read = await tool('browser_read', { name: 'elsewhere', mode: 'text' });

      should(read.isError).not.equal(true);
      should(JSON.stringify(read)).containEql('moved on');
    }, 120_000);
  });

  it('should capture a page’s CLIPBOARD, paste it into a terminal and a page field, and show it to the agent nowhere (item 8)', async () => {
    const opened = await tool('browser_open', { name: 'clipsrc', url: `${base}/clip` });
    should(opened.isError).not.equal(true);
    // Pressed by selector: reading the page first would put the value in the agent's context.
    const pressed = await tool('browser_click', { name: 'clipsrc', selector: '#copy' });
    should(pressed.isError).not.equal(true);

    const sealed = await copy('cliptoken', { kind: 'clipboard', key: 'clipsrc' });
    should(sealed.isError).not.equal(true);
    should(sealed.text).containEql('sealed:cliptoken');
    should(JSON.stringify(sealed)).not.containEql(SENTINEL);

    // …into the (recording) terminal, once.
    const typedBefore = typedIntoTerminal.length;
    const toTerminal = await paste('cliptoken', { kind: 'terminal', name: 'dev' });
    should(toTerminal.isError).not.equal(true);
    should((await allow(requestOf(toTerminal))).status).equal(200);
    should(typedIntoTerminal.slice(typedBefore)).eql([SENTINEL]);

    // …and into a real page's field, which the page's own script reported once more.
    await tool('browser_open', { name: 'clipdest', url: `${base}/dest` });
    const seenBefore = typedIntoPage.filter(each => each === SENTINEL).length;
    const toPage = await paste('cliptoken', { kind: 'browser', name: 'clipdest', selector: '#dest' });
    should(toPage.isError).not.equal(true);
    should((await allow(requestOf(toPage))).status).equal(200);
    for (
      let waited = 0;
      typedIntoPage.filter(each => each === SENTINEL).length === seenBefore && waited < 5_000;
      waited += 100
    )
      await Bun.sleep(100);
    should(typedIntoPage.filter(each => each === SENTINEL).length).equal(seenBefore + 1);

    // Every way the agent could look at either page is refused or masked, and the clipboard itself is empty and unreadable by it.
    for (const name of ['clipsrc', 'clipdest']) {
      for (const [toolName, input] of [
        ['browser_read', { name, mode: 'text' }],
        ['browser_read', { name, mode: 'snapshot' }],
        ['browser_screenshot', { name }],
        ['browser_eval', { name, function: '() => btoa(document.body.innerText)' }],
        ['browser_eval', { name, function: '() => navigator.clipboard.readText()' }],
        ['browser_console', { name }],
        ['browser_network', { name, action: 'list' }],
      ] as const) {
        const answer = await tool(toolName, input);
        mustBeRefused(answer);
        should(JSON.stringify(answer)).not.containEql(SENTINEL);
      }
    }
    for (const answer of [await tool('browser_list', {}), await tool('browser_tabs', { action: 'list' })])
      for (const form of forms(SENTINEL)) should(JSON.stringify(answer)).not.containEql(form);
    // The HTTP status and an agent's own picture of the viewed page, through the route an agent credential can reach.
    const status = await host.request('GET', `/v1/ferrets/${FERRET}/browser`, { as: ferret(FERRET) });
    said.push(status.body);
    const picture = await host.request('POST', `/v1/ferrets/${FERRET}/browser`, {
      body: { action: 'screenshot' },
      as: ferret(FERRET),
    });
    said.push(picture.body);
    should(picture.status).equal(403);
    for (const form of forms(SENTINEL)) {
      should(status.body).not.containEql(form);
      should(picture.body).not.containEql(form);
    }
  }, 180_000);

  it('should have said the sentinel nowhere: no answer, failure, audit record, event, log line or state file holds it', async () => {
    const everywhere = await trace();

    should(typedIntoTerminal).eql([SENTINEL, SENTINEL]);
    should(said.length).be.above(20);
    for (const form of forms(SENTINEL)) {
      should(said.filter(answer => answer.includes(form))).eql([]);
      should(everywhere).not.containEql(form);
    }
    should(said.filter(answer => answer.includes('FAKE-PROXY-CRED'))).eql([]);
    should(everywhere).not.containEql('FAKE-PROXY-CRED');
    // …and what the audit DID record is what the brief allows: names and counts.
    should(JSON.stringify(gate.audits)).containEql('secure_copy');
  }, 120_000);
});
