import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock } from '@ferretry/kernel/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import should from 'should';
import { pageTarget } from '../../../daemon/pages/acts.ts';
import type { BrowserActGuard } from '../../../daemon/pages/service.ts';
import type { BrowserInputEvent } from '../../../contract/wire/browser.ts';
import { heldViewerHost } from '../../../daemon/stream/held-host.ts';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { agentControlPolicy } from '../../../daemon/tools/agent-control.ts';
import { SurfaceControl } from '../../../daemon/tools/control.ts';
import { rootFiles } from '../../../daemon/tools/files.ts';
import {
  ApiError,
  agentControlRefusal,
  type AgentControlKind,
  type AgentControlReader,
  type CallContext,
  type FerretId,
} from '@ferretry/kernel/contract';
import { holdSentence, PageHeld } from '../../../daemon/holds/index.ts';
import { controlRoutes, toolHandler } from '../../../daemon/tools/index.ts';
import { BrowserToolError, BrowserTools, type BrowserToolPorts } from '../../../daemon/tools/service.ts';
import { BrowserTransportError } from '../../../daemon/worker/protocol.ts';
import { callOf } from '../../support/call.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import { browserKernel } from '../../support/kernel.ts';
import { workRoots } from '../../support/work-root.ts';

const SECRET = 'hunter2';
const agent: ToolCaller = { kind: 'agent', sessionId: 's1' };
const person: ToolCaller = { kind: 'person', sessionId: 's1', openedBy: { by: 'local' } };

interface FakePage {
  id: string;
  name?: string;
  url: string;
  title: string;
  text: string;
  openedBy?: { by: 'agent'; sessionId: string } | { by: 'local' };
}

/**
 * The session's browser, faked at the subsystem seam the tools call: real pages with what they say, every act runs
 * the guard the tools hand it, and every act, upload path and input is recorded.
 */
class FakeBrowser {
  readonly pages: FakePage[] = [];
  readonly uploads: (readonly string[])[] = [];
  readonly inputs: BrowserInputEvent[] = [];
  readonly acts: string[] = [];
  /** An act the browser fails, by action: what it throws (a worker's error carries the page's own words). */
  readonly failOn = new Map<string, () => Error>();
  /** Where a page script leaves its page, and the origin of the world it ran in (`undefined`: none read). */
  scriptMoves: string | undefined;
  scriptOrigin: string | undefined;
  /** A script that ran, then failed before it could say where it ended. */
  scriptFails = false;
  /** Called inside the script's turn, after the guard ran and before the script answers. */
  duringScript: (() => void) | undefined;

  status = async (_sessionId: string) =>
    ({
      state: 'running',
      sessionId: 's1',
      pages: this.pages.map(page => ({
        id: page.id,
        url: page.url,
        title: page.title,
        ...(page.name === undefined ? {} : { name: page.name }),
        ...(page.openedBy === undefined ? {} : { openedBy: page.openedBy }),
      })),
      ...(this.pages[0] === undefined ? {} : { activePageId: this.pages[0].id, url: this.pages[0].url, title: '' }),
    }) as never;

  private acted(page: FakePage, extra: Record<string, unknown> = {}) {
    return {
      status: {},
      result: {
        url: page.url,
        title: page.title,
        pages: this.pages.map(each => ({ id: each.id, url: each.url, title: each.title })),
        activePageId: page.id,
        actedPageId: page.id,
        ...extra,
      },
    } as never;
  }

  private page(key: string): FakePage {
    const page = this.pages.find(each => each.id === key || each.name === key);
    if (page === undefined) throw new Error(`no page ${key}`);
    return page;
  }

  openPage = async (_sessionId: string, name: string, options?: { url?: string; openedBy?: FakePage['openedBy'] }) => {
    const page: FakePage = {
      id: `p${String(this.pages.length + 1)}`,
      name,
      url: options?.url ?? 'about:blank',
      title: 'New',
      text: '',
      ...(options?.openedBy === undefined ? {} : { openedBy: options.openedBy }),
    };
    this.pages.push(page);
    return { id: page.id, url: page.url, title: page.title } as never;
  };

  actOnPage = async (_sessionId: string, key: string, action: { action: string }, guard?: BrowserActGuard) => {
    await guard?.({ document: async () => ({}) } as never);
    const page = this.page(key);
    this.acts.push(action.action);
    const failure = this.failOn.get(action.action);
    if (failure !== undefined) throw failure();
    if (action.action === 'read') return this.acted(page, { text: page.text });
    if (action.action === 'screenshot')
      return this.acted(page, { screenshotBase64: Buffer.from(`pixels ${SECRET}`).toString('base64') });
    return this.acted(page);
  };

  filesOnPage = async (_sessionId: string, key: string, action: { action: string; paths?: readonly string[] }) => {
    const page = this.page(key);
    if (action.paths !== undefined) this.uploads.push(action.paths);
    return { result: { url: page.url, pages: [] } } as never;
  };

  dispatchHumanInput = async (_sessionId: string, input: BrowserInputEvent) => {
    this.inputs.push(input);
  };

  attachViewer = async () => ({ detach: () => undefined }) as never;
  scriptOnPage = async (_sessionId: string, key: string, script: { source: string }, guard?: BrowserActGuard) => {
    const page = this.page(key);
    await guard?.({ document: async () => ({}), host: async () => new URL(page.url).host } as never);
    this.duringScript?.();
    if (this.scriptFails) throw new Error('Execution context was destroyed');
    if (this.scriptMoves !== undefined) page.url = this.scriptMoves;
    return {
      ...(this.acted(page) as object),
      text: `ran:${script.source}`,
      ...(this.scriptOrigin === undefined ? {} : { scriptOrigin: this.scriptOrigin }),
    } as never;
  };
  closePage = async () => undefined as never;
  lifecycleOnPage = async () => {
    throw new Error('not exercised');
  };
  adoptPage = async () => undefined as never;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function harness(
  options: {
    readonly allows?: boolean;
    readonly policy?: (kind: string) => boolean;
    /** The owner's switches as core's AgentControlPort answers them (the real policy); `undefined` is an unbound port. */
    readonly control?: () => AgentControlReader | undefined;
    readonly vault?: FakeVault;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-browser-tools-'));
  roots.push(root);
  const work = join(root, 'work');
  await mkdir(join(work, '.fy'), { recursive: true });
  const browser = new FakeBrowser();
  const clock = fixedClock();
  const kernel = browserKernel({ secrets: [SECRET], clock });
  const tools = new BrowserTools({
    browser: browser as unknown as BrowserToolPorts['browser'],
    control: new SurfaceControl(
      { publish: async () => undefined, history: async () => [] },
      { now: () => clock.nowMs() },
    ),
    kernel: kernel.kernel,
    policy:
      options.control === undefined
        ? { allows: async (_ferret, kind) => options.policy?.(kind) ?? options.allows ?? true }
        : agentControlPolicy(options.control),
    files: rootFiles(workRoots(work, join(work, '.fy')), nodeStagedFiles(join(root, 'upload'), clock)),
    binaryName: 'fy',
    // Bound as the daemon half binds them: the Vault's sign-in lock hears scripts and page acts (I98–I100).
    ...(options.vault === undefined
      ? {}
      : {
          scriptedOrigins: {
            running: () => (options.vault as FakeVault).scriptRunning(),
            scriptedOn: (host: string | undefined) => (options.vault as FakeVault).scriptedOn(host),
          },
          pageActs: {
            acted: (sessionId: string, script: boolean) =>
              (options.vault as FakeVault).pageActed(sessionId as FerretId, script),
          },
        }),
  });
  return { root, work, browser, kernel, tools };
}

/** What a call failed with, whatever it is. */
async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

/** The person's tools route for ferret `s1` (`POST /v1/sessions/:sessionId/surfaces/browser/tools`). */
function personRoute(tools: BrowserTools, body: unknown): Promise<unknown> {
  const { call } = callOf({ method: 'POST', path: '/v1/sessions/s1/surfaces/browser/tools', body, kind: 'host' });
  const withSession = { ...call, params: new Map([['sessionId', 's1']]) } as unknown as CallContext;
  return Promise.resolve(controlRoutes(tools)['POST /v1/sessions/:sessionId/surfaces/browser/tools'](withSession));
}

async function refusal(work: Promise<unknown>): Promise<BrowserToolError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof BrowserToolError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('the browser tools — what a page says is masked (S16)', () => {
  it('S16 masks a read and the page address for an agent, and for a person alike', async () => {
    // Arrange
    const { browser, tools } = await harness();
    await tools.call(agent, { tool: 'browser.open', name: 'app', url: `https://example.test/?t=${SECRET}` });
    const page = browser.pages[0] as FakePage;
    page.text = `the password is ${SECRET}`;

    // Act
    const byAgent = await tools.call(agent, { tool: 'browser.read', name: 'app', mode: 'text' });
    const byPerson = await tools.call(person, { tool: 'browser.read', name: 'app', mode: 'text' });

    // Assert
    for (const read of [byAgent, byPerson]) {
      should(JSON.stringify(read)).not.containEql(SECRET);
      should(read.output).equal('the password is *******');
      should(read.summary).containEql('(now at https://example.test/?t=*******)');
    }
  });

  it('S16 masks the address after a write and in a listing, and never masks a screenshot', async () => {
    // Arrange
    const { browser, tools } = await harness();
    await tools.call(agent, { tool: 'browser.open', name: 'app', url: `https://example.test/${SECRET}` });
    (browser.pages[0] as FakePage).title = `Welcome ${SECRET}`;

    // Act
    const opened = await tools.call(agent, { tool: 'browser.click', name: 'app', selector: '#go' });
    const listed = await tools.call(agent, { tool: 'browser.list' });
    const shot = await tools.call(agent, { tool: 'browser.screenshot', name: 'app' });

    // Assert
    should(opened.summary).equal('Done on %browser:app (now at https://example.test/*******).');
    should(JSON.stringify(listed)).not.containEql(SECRET);
    should(listed.surfaces?.[0]?.title).equal('Welcome *******');
    should(Buffer.from(shot.picture?.bytes ?? new Uint8Array()).toString()).equal(`pixels ${SECRET}`);
  });

  it('S16 answers only "Done" after a write when the page refuses reads, so a held page tells nothing', async () => {
    // Arrange
    const { browser, kernel, tools } = await harness();
    await tools.call(agent, { tool: 'browser.open', name: 'app', url: 'https://example.test/account' });
    const target = pageTarget((browser.pages[0] as FakePage).id);
    kernel.hold(target, 'held', ['read', 'picture', 'wait', 'script', 'stream']);

    // Act
    const pressed = await tools.call(agent, { tool: 'browser.press', name: 'app', keys: ['Tab'] });
    const read = await failure(tools.call(agent, { tool: 'browser.read', name: 'app', mode: 'text' }));

    // Assert
    should(pressed.summary).equal('Done on %browser:app.');
    should(read).be.instanceOf(PageHeld);
    should((read as PageHeld).message).equal(holdSentence('held', '%browser:app', 'agent'));
    should(browser.acts).deepEqual(['press']);
  });
});

describe('the browser tools — a failure leaves masked, and a held page answers with its hold (I120)', () => {
  it('I120 a navigation whose error echoes a secret in the address answers it masked, by tool and by route', async () => {
    // Arrange
    const { browser, tools } = await harness();
    await tools.call(agent, { tool: 'browser.open', name: 'app' });
    const url = `https://login.example.test/?token=${SECRET}`;
    browser.failOn.set(
      'navigate',
      () =>
        new BrowserTransportError(
          'upstream_failed',
          `browser action failed: page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}`,
          502,
        ),
    );
    const { call } = callOf({ method: 'POST', path: '/v1/tools/browser_navigate', kind: 'agent' });

    // Act
    const byFerret = await toolHandler(tools, 'browser_navigate')(call, { name: 'app', url });
    const byPerson = (await failure(personRoute(tools, { tool: 'browser.navigate', name: 'app', url }))) as ApiError;

    // Assert
    should(byFerret).deepEqual({
      text: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://login.example.test/?token=*******',
      isError: true,
    });
    should(byPerson).be.instanceOf(ApiError);
    should(byPerson.status).equal(502);
    should(byPerson.message).equal(
      'page.goto: net::ERR_NAME_NOT_RESOLVED at https://login.example.test/?token=*******',
    );
  });

  it('I120 a read that fails on a page a hold began on answers with the hold, never the page’s error', async () => {
    // Arrange
    const { browser, kernel, tools } = await harness();
    await tools.call(agent, { tool: 'browser.open', name: 'app' });
    const target = pageTarget((browser.pages[0] as FakePage).id);
    // The owner's value lands while the read is in the page, and the page's error then carries what it shows.
    browser.failOn.set('read', () => {
      kernel.hold(target, 'held', ['read', 'picture', 'wait', 'script', 'stream']);
      return new BrowserTransportError(
        'upstream_failed',
        'browser action failed: the field now says Welcome back, ana',
        502,
      );
    });
    const { call } = callOf({ method: 'POST', path: '/v1/tools/browser_read', kind: 'agent' });

    // Act
    const byFerret = await toolHandler(tools, 'browser_read')(call, { name: 'app', mode: 'text' });
    const byPerson = (await failure(
      personRoute(tools, { tool: 'browser.read', name: 'app', mode: 'text' }),
    )) as ApiError;

    // Assert
    should(byFerret).deepEqual({ text: holdSentence('held', '%browser:app', 'agent'), isError: true });
    should(byPerson).be.instanceOf(ApiError);
    should(byPerson.status).equal(409);
    should(byPerson.message).equal(holdSentence('held', '%browser:app', 'person'));
    should(JSON.stringify([byFerret, byPerson.message])).not.containEql('ana');
  });
});

describe('the browser tools — files a page is handed (S51)', () => {
  it('S51 hands the page the daemon’s own copy of a file in the ferret’s folder, never its path', async () => {
    // Arrange
    const { browser, work, tools } = await harness();
    await writeFile(join(work, 'hello.txt'), 'hello');
    await tools.call(agent, { tool: 'browser.open', name: 'up' });

    // Act
    const given = await tools.call(agent, { tool: 'browser.upload', name: 'up', selector: '#f', files: ['hello.txt'] });

    // Assert
    const [path] = browser.uploads[0] ?? [];
    should(given.summary).startWith('Gave 1 file (5 B) to %browser:up');
    should(path).not.equal(join(work, 'hello.txt'));
    should(path?.startsWith(work)).be.false();
    should(await readFile(path ?? '', 'utf8')).equal('hello');
  });

  it('S51 refuses a path outside the folder, a link that leaves it, and the daemon’s state home', async () => {
    // Arrange
    const { root, browser, work, tools } = await harness();
    await writeFile(join(root, 'outside.txt'), 'secret');
    await symlink(join(root, 'outside.txt'), join(work, 'escape.txt'));
    await writeFile(join(work, '.fy', 'api-token'), 'fy_admin_token');
    await symlink(join(work, '.fy', 'api-token'), join(work, 'token.txt'));
    await tools.call(agent, { tool: 'browser.open', name: 'up' });
    const upload = (files: string[]) =>
      refusal(tools.call(agent, { tool: 'browser.upload', name: 'up', selector: '#f', files }));

    // Act
    const parent = await upload(['../outside.txt']);
    const link = await upload(['escape.txt']);
    const home = await upload(['.fy/api-token']);
    const token = await upload(['token.txt']);

    // Assert
    for (const refused of [parent, link, home, token]) should(refused.code).equal('forbidden');
    should(token.message).containEql('state home');
    should(browser.uploads).have.length(0);
  });

  it('S51 refuses every file tool to a ferret while "What agents may control" keeps Files off', async () => {
    // Arrange
    const { work, tools } = await harness({ allows: false });
    await writeFile(join(work, 'hello.txt'), 'hello');

    // Act
    const refused = await refusal(
      tools.call(agent, { tool: 'browser.upload', name: 'up', selector: '#f', files: ['hello.txt'] }),
    );

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.message).containEql('What agents may control');
  });
});

describe('the viewer stream’s input, through the act runner (R549)', () => {
  it('R549 dispatches one inserted text as ONE `type` act on the viewed page, never split', async () => {
    // Arrange
    const { browser, kernel, tools } = await harness();
    await tools.call(person, { tool: 'browser.open', name: 'app' });
    const host = heldViewerHost(kernel.kernel, browser as never);
    const text = 'a whole sentence, typed at once';

    // Act
    await host.dispatchHumanInput('s1', { kind: 'insertText', text });

    // Assert
    should(browser.inputs).deepEqual([{ kind: 'insertText', text }]);
    should(kernel.acts.filter(act => act.op === 'type')).have.length(1);
  });

  it('R549 refuses a person’s input on a held page before it reaches the browser', async () => {
    // Arrange
    const { browser, kernel, tools } = await harness();
    await tools.call(person, { tool: 'browser.open', name: 'app' });
    kernel.hold(pageTarget((browser.pages[0] as FakePage).id), 'held', ['type']);
    const host = heldViewerHost(kernel.kernel, browser as never);

    // Act
    const refused = await host.dispatchHumanInput('s1', { kind: 'insertText', text: 'x' }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert
    should(refused?.message).equal('This is held right now because the owner just typed a private value into it.');
    should(browser.inputs).have.length(0);
  });
});

describe('the browser tools — what a ferret did to a page, told to the Vault’s sign-in lock (I98)', () => {
  it('I98 a page script is one script act on its page, and tells the Vault it runs, where it ran and where it left the page', async () => {
    // Arrange
    const vault = new FakeVault();
    const { browser, kernel, tools } = await harness({ vault });
    await tools.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.example.test/login' });
    browser.scriptOrigin = 'https://frame.example.test';
    browser.scriptMoves = 'https://elsewhere.example.org/';
    let runningDuring = -1;
    browser.duringScript = () => {
      runningDuring = vault.scriptsRunning;
    };

    // Act
    await tools.call(agent, { tool: 'browser.eval', name: 'app', function: '() => document.title' });

    // Assert — one `script` act on the page's hold target, the machine-wide "running" closed only after it,
    // every host the script could have touched tainted, and the act filed as a script on that page.
    should(kernel.acts.filter(act => act.op === 'script').map(act => act.target)).deepEqual([
      { kind: 'page', key: 'p1' },
    ]);
    should(runningDuring).equal(1);
    should(vault.scriptsRunning).equal(0);
    should(vault.scriptedHosts).deepEqual(['accounts.example.test', 'frame.example.test', 'elsewhere.example.org']);
    should(vault.pageActs.map(act => [act.ferret, act.script, act.placed?.id])).deepEqual([
      ['s1', false, 'p1'],
      ['s1', true, 'p1'],
    ]);
  });

  it('I98 a script that ran but could not say where it ended taints every host, and its act is still placed', async () => {
    // Arrange
    const vault = new FakeVault();
    const { browser, tools } = await harness({ vault });
    await tools.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.example.test/login' });
    browser.scriptFails = true;

    // Act
    const failed = await failure(tools.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }));

    // Assert — the host it was on, then `undefined` (any host: the lock reads it as scripted everywhere).
    should(failed).be.instanceOf(Error);
    should(vault.scriptedHosts).deepEqual(['accounts.example.test', undefined]);
    should(vault.scriptsRunning).equal(0);
    should(vault.pageActs.at(-1)).match({ ferret: 's1', script: true });
    should(vault.pageActs.at(-1)?.placed?.id).equal('p1');
  });

  it('I98 a script refused by the owner’s Page scripts switch runs nothing and tells the Vault nothing', async () => {
    // Arrange — the daemon half's policy today: Browsers on, Page scripts off (fails closed).
    const vault = new FakeVault();
    const { tools: refusing } = await harness({ vault, policy: kind => kind === 'browser' });
    await refusing.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.example.test/' });
    const told = vault.pageActs.length;

    // Act
    const refused = await refusal(refusing.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }));

    // Assert
    should(refused.code).equal('forbidden');
    should(vault.pageActs.length).equal(told);
    should(vault.scriptedHosts).deepEqual([]);
  });

  it('I100 a read tells the Vault nothing; a click is told, and placed on its page with the hosts around it', async () => {
    // Arrange
    const vault = new FakeVault();
    const { tools } = await harness({ vault });
    await tools.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.example.test/login' });
    const told = vault.pageActs.length;

    // Act
    await tools.call(agent, { tool: 'browser.read', name: 'app', mode: 'text' });
    await tools.call(agent, { tool: 'browser.click', name: 'app', selector: '#next' });
    await tools.call(person, { tool: 'browser.click', name: 'app', selector: '#next' });

    // Assert — only the ferret's click; a person's act is not the ferret's steering.
    const acts = vault.pageActs.slice(told);
    should(acts).have.length(1);
    should(acts[0]?.placed).deepEqual({ id: 'p1', hosts: ['accounts.example.test'] });
  });
});

/** The owner's switches as Ferrets' reader answers them: only `on` kinds are allowed; every ask is recorded. */
function switches(...on: readonly AgentControlKind[]) {
  const asked: Array<[string, AgentControlKind]> = [];
  const reader: AgentControlReader = {
    allows: async (ferret, kind) => {
      asked.push([ferret, kind]);
      return on.includes(kind);
    },
  };
  return { asked, reader };
}

// Today's refusal: rebuild-ref packages/daemon/src/lib/agent-tools/service.ts:436-437 throws
// `AgentToolError('forbidden', controlRefusal(kind))`, the sentence at policy.ts:96-101.
const BROWSERS_OFF =
  'This machine does not let agents control browsers: "What agents may control › Browsers" is off in this machine\'s settings. Ask the person to turn it on if you need it.';
const FILES_OFF =
  'This machine does not let agents control files: "What agents may control › Files" is off in this machine\'s settings. Ask the person to turn it on if you need it.';
// Today's `pageScriptsRefusal('fy')`: rebuild-ref packages/daemon/src/lib/agent-tools/policy.ts:108-110.
const PAGE_SCRIPTS_OFF =
  'browser.eval is off on this machine: "What agents may control › Page scripts" is off, and only the owner can turn it on — in the app (Settings › this machine › What agents may control › Page scripts), with `fy machine set agent-control scripts on`, or with agentControl.pageScripts: true in machine.yaml. Turning it on waits for their confirmation, because a page script can read what a page holds, sign-ins on the shared profile included. Ask them if you need it; the other browser tools work without it.';

describe('the browser tools follow core’s AgentControlPort (What agents may control)', () => {
  it('AC1 refuses a ferret every page tool, with today’s code and sentence, while Browsers is off', async () => {
    // Arrange
    const { reader, asked } = switches('files', 'scripts');
    const { tools } = await harness({ control: () => reader });

    // Act
    const refused = await refusal(tools.call(agent, { tool: 'browser.open', name: 'app' }));
    const typing = await refusal(tools.pageFor(agent, 'app'));

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.message).equal(BROWSERS_OFF);
    should(refused.message).equal(agentControlRefusal('browser'));
    should(typing.code).equal('forbidden');
    should(typing.message).equal(BROWSERS_OFF);
    should(asked[0]).deepEqual(['s1', 'browser']);
  });

  it('AC2 allows the same call while Browsers is on', async () => {
    // Arrange
    const { reader } = switches('browser');
    const { tools } = await harness({ control: () => reader });

    // Act
    const opened = await tools.call(agent, { tool: 'browser.open', name: 'app' });

    // Assert
    should(opened.summary).be.a.String();
  });

  it('AC3 refuses a ferret when the port is unbound (fails closed)', async () => {
    // Arrange
    const { tools } = await harness({ control: () => undefined });

    // Act
    const refused = await refusal(tools.call(agent, { tool: 'browser.open', name: 'app' }));
    const script = await refusal(tools.call(person, { tool: 'browser.eval', name: 'app', function: '() => 1' }));

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.message).equal(BROWSERS_OFF);
    should(script.code).equal('forbidden');
  });

  it('AC3 refuses with today’s code and sentence when looking the port up throws (a plugin still building)', async () => {
    // Arrange — the kernel's `uses.current()` throws a TypeError until the plugin is built
    const { tools } = await harness({
      control: () => {
        throw new TypeError('uses.current() before build');
      },
    });

    // Act
    const refused = await refusal(tools.call(agent, { tool: 'browser.open', name: 'app' }));

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.message).equal(BROWSERS_OFF);
  });

  it('AC3 refuses when the reader throws or answers anything but a plain yes', async () => {
    // Arrange
    const throwing = await harness({
      control: () => ({
        allows: async () => {
          throw new Error('limits.yaml unreadable');
        },
      }),
    });
    const undetermined = await harness({ control: () => ({ allows: async () => undefined as never }) });

    // Act
    const thrown = await refusal(throwing.tools.call(agent, { tool: 'browser.open', name: 'app' }));
    const unknown = await refusal(undetermined.tools.call(agent, { tool: 'browser.open', name: 'app' }));

    // Assert
    should(thrown.message).equal(BROWSERS_OFF);
    should(unknown.message).equal(BROWSERS_OFF);
  });

  it('AC6 listing what is open follows Browsers too: refused while it is off, allowed once it is on', async () => {
    // Arrange — today's `switchOf` maps every `browser.*` tool, `browser.list` included, to the Browsers switch
    // (rebuild-ref packages/daemon/src/lib/agent-tools/service.ts:334-343): a page's title and address stay hidden.
    let on: readonly AgentControlKind[] = ['browser'];
    const { browser, tools } = await harness({
      control: () => ({ allows: async (_ferret, kind) => on.includes(kind) }),
    });
    await tools.call(agent, { tool: 'browser.open', name: 'app', url: 'https://example.test/inbox' });
    (browser.pages[0] as FakePage).title = 'Inbox';

    // Act — the owner turns Browsers off, then on again
    on = ['files', 'scripts'];
    const refused = await refusal(tools.call(agent, { tool: 'browser.list' }));
    on = ['browser'];
    const listed = await tools.call(agent, { tool: 'browser.list' });

    // Assert
    should(refused.code).equal('forbidden');
    should(refused.message).equal(BROWSERS_OFF);
    should(JSON.stringify(refused)).not.containEql('Inbox');
    should(listed.surfaces?.[0]?.title).equal('Inbox');
  });

  it('AC4 file transfer follows Files alone, and page scripts follow Page scripts alone', async () => {
    // Arrange — Browsers on, Files off, Page scripts off
    const base = switches('browser');
    const { tools, work } = await harness({ control: () => base.reader });
    await writeFile(join(work, 'hello.txt'), 'hello');
    await tools.call(agent, { tool: 'browser.open', name: 'up' });

    // Act
    const upload = await refusal(
      tools.call(agent, { tool: 'browser.upload', name: 'up', selector: '#f', files: ['hello.txt'] }),
    );
    const script = await refusal(tools.call(agent, { tool: 'browser.eval', name: 'up', function: '() => 1' }));
    const read = await tools.call(agent, { tool: 'browser.read', name: 'up', mode: 'text' });

    // Assert — each refused for its OWN switch; the page tool is untouched
    should(upload.message).equal(FILES_OFF);
    should(script.message).equal(PAGE_SCRIPTS_OFF);
    should(script.message).not.equal(upload.message);
    should(read.summary).be.a.String();
  });

  it('AC4 turning Files on lets uploads through while scripts stay off; turning Page scripts on lets eval through', async () => {
    // Arrange
    const filesOn = await harness({ control: () => switches('browser', 'files').reader });
    await writeFile(join(filesOn.work, 'hello.txt'), 'hello');
    await filesOn.tools.call(agent, { tool: 'browser.open', name: 'up' });
    const scriptsOn = await harness({ control: () => switches('browser', 'scripts').reader });
    await scriptsOn.tools.call(agent, { tool: 'browser.open', name: 'up' });

    // Act
    await filesOn.tools.call(agent, { tool: 'browser.upload', name: 'up', selector: '#f', files: ['hello.txt'] });
    const stillOff = await refusal(
      filesOn.tools.call(agent, { tool: 'browser.eval', name: 'up', function: '() => 1' }),
    );
    const evaled = await scriptsOn.tools.call(agent, { tool: 'browser.eval', name: 'up', function: '() => 1' });
    const noFiles = await refusal(
      scriptsOn.tools.call(agent, { tool: 'browser.upload', name: 'up', selector: '#f', files: ['hello.txt'] }),
    );

    // Assert
    should(filesOn.browser.uploads).have.length(1);
    should(stillOff.message).equal(PAGE_SCRIPTS_OFF);
    should(evaled.summary).be.a.String();
    should(noFiles.message).equal(FILES_OFF);
  });

  it('AC5 reads the switch fresh on every call: turning Browsers off refuses the very next act', async () => {
    // Arrange
    let on = true;
    const { tools } = await harness({ control: () => ({ allows: async (_ferret, kind) => on && kind === 'browser' }) });
    await tools.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    on = false;
    const refused = await refusal(tools.call(agent, { tool: 'browser.read', name: 'app', mode: 'text' }));

    // Assert
    should(refused.message).equal(BROWSERS_OFF);
  });
});
