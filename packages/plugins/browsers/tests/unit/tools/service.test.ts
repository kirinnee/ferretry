import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock } from '@ferretry/kernel/testing';
import should from 'should';
import { pageTarget } from '../../../daemon/pages/acts.ts';
import type { BrowserActGuard } from '../../../daemon/pages/service.ts';
import type { BrowserInputEvent } from '../../../daemon/pages/wire/browser.ts';
import { heldViewerHost } from '../../../daemon/stream/held-host.ts';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { SurfaceControl } from '../../../daemon/tools/control.ts';
import { rootFiles } from '../../../daemon/tools/files.ts';
import { ApiError, type CallContext } from '@ferretry/kernel/contract';
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
  scriptOnPage = async () => {
    throw new Error('not exercised');
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

async function harness(options: { readonly allows?: boolean } = {}) {
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
    policy: { allows: async () => options.allows ?? true },
    files: rootFiles(workRoots(work, join(work, '.fy')), nodeStagedFiles(join(root, 'upload'), clock)),
    binaryName: 'fy',
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
