import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock } from '@ferretry/kernel/testing';
import should from 'should';
import type { BrowserActGuard } from '../../../daemon/pages/service.ts';
import { SealedGate } from '../../../daemon/sealed/gate.ts';
import { SealedPages } from '../../../daemon/sealed/page-guards.ts';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { SurfaceControl } from '../../../daemon/tools/control.ts';
import { rootFiles } from '../../../daemon/tools/files.ts';
import { BrowserToolError, BrowserTools, type BrowserToolPorts } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import { browserKernel } from '../../support/kernel.ts';
import { workRoots } from '../../support/work-root.ts';

/** Never a real credential. The sealed copy's value: it must be in no result, error or picture an agent is handed. */
const SENTINEL = 'FAKE-SC-7f3a91';
const SOURCE = 'https://keys.example.test';
const agent: ToolCaller = { kind: 'agent', sessionId: 's1' };
const person: ToolCaller = { kind: 'person', sessionId: 's1', openedBy: { by: 'local' } };

interface Page {
  id: string;
  name: string;
  url: string;
  /** What a read of the page could show (the worker's `inputText`). */
  text: string;
  /** The host the page is on when the guard asks inside the queue; the address when not set. */
  host?: string;
  /** The hosts of the frames inside it, when the guard asks for every host (the worker's `frameHosts`). */
  frames?: readonly string[] | 'unreadable';
  /** What the page's title says, and the dialog it has open. */
  title?: string;
  dialog?: { type: 'alert'; message: string };
  openedBy: { by: 'agent'; sessionId: string };
}

/** The session's browser at the subsystem seam, every act running the guard the tools hand it. */
class Browser {
  readonly pages: Page[] = [];
  readonly acts: string[] = [];
  /** Set to make the page's text unreadable inside the queue. */
  textFails = false;
  /** Set to make every act fail the way a browser's own error does: with words from the page in it. */
  failWith: Error | undefined;

  status = async () =>
    ({
      state: 'running',
      sessionId: 's1',
      pages: this.pages.map(page => ({
        id: page.id,
        name: page.name,
        url: page.url,
        title: page.title ?? '',
        openedBy: page.openedBy,
      })),
    }) as never;

  private find(key: string): Page {
    const page = this.pages.find(each => each.id === key || each.name === key);
    if (page === undefined) throw new Error(`no page ${key}`);
    return page;
  }

  private async guarded(key: string, guard?: BrowserActGuard): Promise<Page> {
    const page = this.find(key);
    await guard?.({
      document: async () => 'loader-1',
      host: async () => page.host ?? new URL(page.url).host,
      hosts: async () =>
        page.frames === 'unreadable' ? undefined : [page.host ?? new URL(page.url).host, ...(page.frames ?? [])],
      text: async () => {
        if (this.textFails) throw new Error('too long');
        return page.text;
      },
    });
    return page;
  }

  private result(page: Page, extra: Record<string, unknown> = {}) {
    return {
      status: {},
      result: {
        url: page.url,
        title: page.title ?? '',
        pages: [],
        actedPageId: page.id,
        ...(page.dialog === undefined ? {} : { dialog: page.dialog }),
        ...extra,
      },
    } as never;
  }

  openPage = async (_session: string, name: string, options?: { url?: string }) => {
    const page: Page = {
      id: `p${String(this.pages.length + 1)}`,
      name,
      url: options?.url ?? 'about:blank',
      text: '',
      openedBy: { by: 'agent', sessionId: 's1' },
    };
    this.pages.push(page);
    return { id: page.id, url: page.url, title: '' } as never;
  };

  actOnPage = async (_session: string, key: string, action: { action: string }, guard?: BrowserActGuard) => {
    const page = await this.guarded(key, guard);
    if (this.failWith !== undefined) throw this.failWith;
    this.acts.push(action.action);
    if (action.action === 'read') return this.result(page, { text: page.text });
    if (action.action === 'screenshot') return this.result(page, { screenshotBase64: 'iVBOR' });
    return this.result(page);
  };

  scriptOnPage = async (_session: string, key: string, script: { source: string }, guard?: BrowserActGuard) => {
    const page = await this.guarded(key, guard);
    this.acts.push('script');
    return { ...(this.result(page) as object), text: `ran:${script.source}` } as never;
  };

  filesOnPage = async (_session: string, key: string, action: { action: string }, guard?: BrowserActGuard) => {
    const page = await this.guarded(key, guard);
    this.acts.push(action.action);
    return { ...(this.result(page) as object), staged: { path: '/stage/x', name: 'x.pdf', size: 3 } } as never;
  };

  lifecycleOnPage = async (_session: string, key: string, request: { op: string }, guard?: BrowserActGuard) => {
    const page = await this.guarded(key, guard);
    this.acts.push(`lifecycle-${request.op}`);
    return { reply: { text: `log of ${page.name}`, matched: true } } as never;
  };

  closePage = async () => undefined as never;
  adoptPage = async () => undefined as never;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-sealed-pages-'));
  roots.push(root);
  const work = join(root, 'work');
  await mkdir(join(work, '.fy'), { recursive: true });
  const browser = new Browser();
  const clock = fixedClock();
  // The registry masks the sealed value as the Vault's would: `[sealed:token]`.
  const kernel = browserKernel({ secrets: [] });
  const masked = {
    ...kernel.kernel,
    redaction: {
      read: async <T>(fn: (scope: never) => T): Promise<T> =>
        await fn({
          text: (text: string) => text.replaceAll(SENTINEL, '[sealed:token]'),
          cells: (grid: unknown) => grid,
          lines: (lines: string[]) => lines.map(line => line.replaceAll(SENTINEL, '[sealed:token]')),
        } as never),
    },
  } as unknown as BrowserToolPorts['kernel'];
  const sealed = new SealedPages();
  const gate = new SealedGate({ sealed, mask: async text => text.replaceAll(SENTINEL, '[sealed:token]') });
  const tools = new BrowserTools({
    browser: browser as unknown as BrowserToolPorts['browser'],
    control: new SurfaceControl(
      { publish: async () => undefined, history: async () => [] },
      { now: () => clock.nowMs() },
    ),
    kernel: masked,
    policy: { allows: async () => true },
    files: rootFiles(workRoots(work, join(work, '.fy')), nodeStagedFiles(join(root, 'upload'), clock)),
    binaryName: 'fy',
    sealed: gate,
  });
  await tools.call(agent, { tool: 'browser.open', name: 'keys', url: `${SOURCE}/new` });
  await tools.call(agent, { tool: 'browser.open', name: 'docs', url: 'https://docs.example.test/' });
  return { browser, tools, sealed, acts: browser.acts };
}

async function refused(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    should(error).be.instanceOf(BrowserToolError);
    return (error as Error).message;
  }
  throw new Error('expected the call to be refused');
}

const READERS = [
  { tool: 'browser.read', name: 'keys', mode: 'text' },
  { tool: 'browser.eval', name: 'keys', function: '() => document.body.innerText' },
  { tool: 'browser.console', name: 'keys' },
  { tool: 'browser.network', name: 'keys', action: 'list' },
  { tool: 'browser.screenshot', name: 'keys' },
  { tool: 'browser.pdf', name: 'keys' },
  { tool: 'browser.highlight', name: 'keys', selector: '#key' },
  { tool: 'browser.download', name: 'keys' },
  { tool: 'browser.wait_for', name: 'keys', text: 'hello' },
] as never as readonly Parameters<BrowserTools['call']>[1][];

describe('a page that holds a sealed value is closed to an agent for as long as the copy lives', () => {
  it('should refuse every read, script, log, picture and text wait on the origin it was copied from, saying why and until when', async () => {
    const { tools, sealed, acts } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));

    for (const call of READERS) {
      const sentence = await refused(tools.call(agent, call));
      should(sentence).containEql(`${call.tool} is refused on %browser:keys`);
      should(sentence).containEql('sealed:token');
      should(sentence).containEql('2026-11-13T12:00:00.000Z');
      should(sentence).containEql('secure_discard');
      should(sentence).not.containEql(SENTINEL);
    }
    // Refused before the browser did anything: not one act reached the page.
    should(acts).eql([]);
  });

  it('should still let an agent click, type, navigate and wait for a duration there', async () => {
    const { tools, sealed, acts } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));

    await tools.call(agent, { tool: 'browser.click', name: 'keys', selector: '#done' });
    await tools.call(agent, { tool: 'browser.navigate', name: 'keys', url: `${SOURCE}/done` });
    await tools.call(agent, { tool: 'browser.wait_for', name: 'keys', time: 10 } as never);

    should(acts).eql(['click', 'navigate']);
  });

  it('should not touch a page on another origin, but close the same origin to every ferret that shares the browser', async () => {
    const { tools, sealed } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));

    const docs = await tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' });
    // ANOTHER ferret's copy on the docs site closes the docs page to this ferret too: one profile, one clipboard.
    sealed.hold('s2', 'other', ['https://docs.example.test'], () => Date.UTC(2026, 10, 13, 12));
    const closed = await refused(tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' }));

    should(docs.summary).containEql('Read %browser:docs');
    should(closed).containEql('browser.read is refused on %browser:docs');
    // A name is that ferret's own: it is never told another's.
    should(closed).not.containEql('sealed:other');
    should(closed).containEql('another ferret sealed');
  });

  it('should begin at once and end the moment the copy does (discarded, expired)', async () => {
    const { tools, sealed } = await harness();
    const before = await tools.call(agent, { tool: 'browser.read', name: 'keys', mode: 'text' });
    let ends: number | undefined = Date.UTC(2026, 10, 13, 12);
    sealed.hold('s1', 'token', [SOURCE], () => ends);

    const during = await refused(tools.call(agent, { tool: 'browser.read', name: 'keys', mode: 'text' }));
    ends = undefined;
    const after = await tools.call(agent, { tool: 'browser.read', name: 'keys', mode: 'text' });

    should(before.summary).containEql('Read %browser:keys');
    should(during).containEql('browser.read is refused');
    should(after.summary).containEql('Read %browser:keys');
  });

  it('should follow the page by where it IS now, not by the name or the address it was opened at', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    // The page navigated away: it is on the docs site now, so it is open again…
    const keys = browser.pages[0] as Page;
    keys.host = 'docs.example.test';
    keys.url = 'https://docs.example.test/';
    const away = await tools.call(agent, { tool: 'browser.read', name: 'keys', mode: 'text' });
    // …and the docs page navigated to the source: it is closed, under its own name.
    const docs = browser.pages[1] as Page;
    docs.host = 'keys.example.test';
    docs.url = `${SOURCE}/again`;
    const back = await refused(tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' }));

    should(away.summary).containEql('Read %browser:keys');
    should(back).containEql('browser.read is refused on %browser:docs');
  });

  it('should refuse inside the page’s queue when the page moved onto the origin while the call waited', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    const docs = browser.pages[1] as Page;
    // The address the tools looked up says "docs"; by the time the act runs the page is on the source origin.
    docs.host = 'keys.example.test';

    const sentence = await refused(tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' }));

    should(sentence).containEql('browser.read is refused on %browser:docs');
    should(browser.acts).eql([]);
  });

  it('should pass a person’s own calls, whatever the page holds', async () => {
    const { tools, sealed, browser } = await harness();
    (browser.pages[0] as Page).text = `the key is ${SENTINEL}`;
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));

    const read = await tools.call(person, { tool: 'browser.read', name: 'keys', mode: 'text' });
    const shot = await tools.call(person, { tool: 'browser.screenshot', name: 'keys' });

    should(read.summary).containEql('Read %browser:keys');
    should(shot.picture?.bytes.byteLength).be.above(0);
  });

  it('should fail closed when the page’s host cannot be read inside the queue', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    // The tools' pre-check sees "docs"; inside the queue the page cannot say where it is.
    const original = browser.actOnPage;
    browser.actOnPage = async (session, key, action, guard) =>
      await original(
        session,
        key,
        action,
        guard === undefined
          ? guard
          : async page => await guard({ ...page, host: async () => undefined, hosts: async () => undefined }),
      );

    const sentence = await refused(tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' }));

    should(sentence).containEql('browser.read is refused');
  });
});

describe('a picture of a page whose text shows a live copy is withheld, wherever the page is', () => {
  it('should withhold a screenshot of a page on another origin that shows the value, naming the copy and never the value', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    (browser.pages[1] as Page).text = `Your API key: ${SENTINEL}`;

    for (const tool of ['browser.screenshot', 'browser.pdf', 'browser.highlight'] as const) {
      const sentence = await refused(
        tools.call(
          agent,
          (tool === 'browser.highlight' ? { tool, name: 'docs', selector: '#k' } : { tool, name: 'docs' }) as never,
        ),
      );
      should(sentence).containEql(`${tool} is withheld on %browser:docs`);
      should(sentence).containEql('sealed:token');
      should(sentence).not.containEql(SENTINEL);
    }
    should(browser.acts).eql([]);
  });

  it('should take a screenshot of a page that shows nothing sealed, while a copy lives', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    (browser.pages[1] as Page).text = 'Documentation';

    const shot = await tools.call(agent, { tool: 'browser.screenshot', name: 'docs' });

    should(shot.picture?.bytes.byteLength).be.above(0);
  });

  it('should withhold when a command’s copy (no page) is live and the page’s text shows it', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'cli', [], () => Date.UTC(2026, 10, 13, 12));
    (browser.pages[1] as Page).text = `token ${SENTINEL}`;
    // The registry masks by the copy's own name in this harness: use that marker.
    const sentence = await refused(tools.call(agent, { tool: 'browser.screenshot', name: 'docs' }));

    should(sentence).containEql('is withheld on %browser:docs');
  });

  it('should withhold, not guess, when the page’s text cannot be read while a copy lives', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    browser.textFails = true;

    const sentence = await refused(tools.call(agent, { tool: 'browser.screenshot', name: 'docs' }));

    should(sentence).containEql('could not read this page');
  });

  it('should take a picture freely when no copy lives, whatever the page shows, and for a person always', async () => {
    const { tools, sealed, browser } = await harness();
    (browser.pages[1] as Page).text = `Your API key: ${SENTINEL}`;
    const none = await tools.call(agent, { tool: 'browser.screenshot', name: 'docs' });
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    const byPerson = await tools.call(person, { tool: 'browser.screenshot', name: 'docs' });

    should(none.picture?.bytes.byteLength).be.above(0);
    should(byPerson.picture?.bytes.byteLength).be.above(0);
  });
});

describe('a clipboard capture that is running closes page scripts', () => {
  it('should refuse browser.eval on every page of the ferret while it runs, and allow it again after', async () => {
    const { tools, sealed } = await harness();
    const done = sealed.capturing('s1');

    const sentence = await refused(
      tools.call(agent, {
        tool: 'browser.eval',
        name: 'docs',
        function: '() => navigator.clipboard.readText()',
      } as never),
    );
    const read = await tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' });
    done();
    const after = await tools.call(agent, { tool: 'browser.eval', name: 'docs', function: '() => 1' } as never);

    should(sentence).containEql('browser.eval is refused while a clipboard capture is running in this browser');
    should(read.summary).containEql('Read %browser:docs');
    should(after.summary).containEql('Ran your script');
  });

  it('should stop every ferret’s scripts while anyone’s capture runs (one clipboard), but never a person’s', async () => {
    const { tools, sealed } = await harness();
    const done = sealed.capturing('s2');

    const byPerson = await tools.call(person, { tool: 'browser.eval', name: 'docs', function: '() => 1' } as never);
    const byOther = await refused(
      tools.call(agent, { tool: 'browser.eval', name: 'docs', function: '() => 1' } as never),
    );
    done();

    should(byPerson.summary).containEql('Ran your script');
    should(byOther).containEql('a clipboard capture is running in this browser');
  });
});

describe('a script on a page that shows a live copy is withheld, whatever its origin', () => {
  it('should withhold browser.eval (encoded, split or plain) on another origin’s page whose text shows the value', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    (browser.pages[1] as Page).text = `Your API key: ${SENTINEL}`;

    for (const source of [
      '() => document.body.innerText',
      '() => btoa(document.body.innerText)',
      '() => [...document.body.innerText].join("|")',
    ]) {
      const sentence = await refused(
        tools.call(agent, { tool: 'browser.eval', name: 'docs', function: source } as never),
      );
      should(sentence).containEql('browser.eval is withheld on %browser:docs');
      should(sentence).containEql('sealed:token');
      should(sentence).containEql('encoded or split');
      should(sentence).not.containEql(SENTINEL);
    }
    should(browser.acts).eql([]);
  });

  it('should run a script on a page that shows nothing sealed, while a copy lives', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));
    (browser.pages[1] as Page).text = 'Documentation';

    const ran = await tools.call(agent, { tool: 'browser.eval', name: 'docs', function: '() => 1' } as never);

    should(ran.summary).containEql('Ran your script');
  });
});

describe('FINDING 5: a page that holds a sealed value answers nothing of what it says through the actions that are allowed', () => {
  const HOLD_UNTIL = Date.UTC(2026, 10, 13, 12);

  it('should refuse a content-dependent selector on a closed page (click, type, hover, select, drag), and still allow structure', async () => {
    const { tools, sealed, acts } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);

    for (const selector of ['text=Copy', 'button:has-text("Copy")', '[value^="FAKE"]', '//input[@value="x"]']) {
      for (const call of [
        { tool: 'browser.click', name: 'keys', selector },
        { tool: 'browser.type', name: 'keys', selector, text: 'x' },
        { tool: 'browser.hover', name: 'keys', selector },
      ] as never as readonly Parameters<BrowserTools['call']>[1][]) {
        const sentence = await refused(tools.call(agent, call));
        should(sentence).containEql('depends on what the page says');
        should(sentence).not.containEql(SENTINEL);
      }
    }
    should(acts).eql([]);

    await tools.call(agent, { tool: 'browser.click', name: 'keys', selector: '#done' });
    await tools.call(agent, { tool: 'browser.type', name: 'keys', selector: 'input[type=text]', text: 'x' } as never);
    should(acts).eql(['click', 'type']);
  });

  it('should refuse a content-dependent selector inside the queue too, when the page moved onto the origin while the call waited', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    (browser.pages[1] as Page).host = 'keys.example.test';

    const sentence = await refused(tools.call(agent, { tool: 'browser.click', name: 'docs', selector: 'text=Save' }));

    should(sentence).containEql('depends on what the page says');
    should(browser.acts).eql([]);
  });

  it('should allow a content-dependent selector on a page no copy covers, and for a person anywhere', async () => {
    const { tools, sealed } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);

    const docs = await tools.call(agent, { tool: 'browser.click', name: 'docs', selector: 'text=Next' });
    const byPerson = await tools.call(person, { tool: 'browser.click', name: 'keys', selector: 'text=Copy' });

    should(docs.summary).containEql('Done on %browser:docs');
    should(byPerson.summary).containEql('Done on %browser:keys');
  });

  it('should withhold a dialog’s words on a closed page, whatever the page says in it', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    (browser.pages[0] as Page).dialog = { type: 'alert', message: `your key is ${SENTINEL}, btoa: ${btoa(SENTINEL)}` };

    const clicked = await tools.call(agent, { tool: 'browser.click', name: 'keys', selector: '#done' });
    const text = JSON.stringify(clicked);

    should(text).containEql('alert dialog is waiting');
    should(text).containEql('this page holds a sealed value');
    should(text).not.containEql(SENTINEL);
    should(text).not.containEql(btoa(SENTINEL));
  });

  it('should still show a dialog’s words on a page no copy covers', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    (browser.pages[1] as Page).dialog = { type: 'alert', message: 'Saved!' };

    const clicked = await tools.call(agent, { tool: 'browser.click', name: 'docs', selector: '#ok' });

    should(clicked.summary).containEql('Saved!');
  });

  it('should answer a failure on a closed page with one fixed sentence, not what the browser said about the page', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    browser.failWith = new Error(
      `strict mode violation: resolved to 2 elements: <input value="${SENTINEL}"> <input value="${btoa(SENTINEL)}">`,
    );

    const sentence = await refused(tools.call(agent, { tool: 'browser.click', name: 'keys', selector: 'input' }));

    should(sentence).containEql('does not pass on what the browser said');
    should(sentence).not.containEql(SENTINEL);
    should(sentence).not.containEql('strict mode');
    should(sentence).not.containEql(btoa(SENTINEL));
  });

  it('should keep a failure on a page no copy covers as it was, and a person’s too', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    browser.failWith = new Error('element not found');

    const docs = await tools.call(agent, { tool: 'browser.click', name: 'docs', selector: '#a' }).then(
      () => 'ok',
      (error: Error) => error.message,
    );
    const byPerson = await tools.call(person, { tool: 'browser.click', name: 'keys', selector: '#a' }).then(
      () => 'ok',
      (error: Error) => error.message,
    );

    should(docs).containEql('element not found');
    should(byPerson).containEql('element not found');
  });

  it('should list a closed page by name and origin only, in list and in tabs, and leave other pages and a person’s listing whole', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    const keys = browser.pages[0] as Page;
    keys.title = `Your key ${SENTINEL}`;
    keys.url = `${SOURCE}/new?token=${SENTINEL}#${btoa(SENTINEL)}`;
    (browser.pages[1] as Page).title = 'Documentation';

    for (const call of [
      { tool: 'browser.list' },
      { tool: 'browser.tabs', action: 'list' },
    ] as never as readonly Parameters<BrowserTools['call']>[1][]) {
      const listed = await tools.call(agent, call);
      const rows = JSON.stringify(listed.surfaces);

      should(rows).containEql('this page holds a sealed value');
      should(rows).containEql(`${SOURCE}/…`);
      should(rows).containEql('Documentation');
      should(rows).not.containEql(SENTINEL);
      should(rows).not.containEql(btoa(SENTINEL));
      should(rows).not.containEql('token=');
    }
    const byPerson = await tools.call(person, { tool: 'browser.list' });
    should(JSON.stringify(byPerson.surfaces)).containEql('/new?token=');
  });

  it('should show a page’s address as its origin after an act moved it onto a closed origin', async () => {
    const { tools, sealed } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);

    const opened = await tools.call(agent, {
      tool: 'browser.open',
      name: 'again',
      url: `${SOURCE}/new?x=${SENTINEL}`,
    } as never);

    should(opened.summary).containEql(`${SOURCE}/…`);
    should(opened.summary).not.containEql(SENTINEL);
  });
});

describe('FINDING 6: the tools close a page whose FRAME is on the protected site, and fail closed for a frame they cannot tell', () => {
  const HOLD_UNTIL = Date.UTC(2026, 10, 13, 12);

  it('should refuse a read of a page of another site that embeds a frame of the source origin', async () => {
    const { tools, sealed, browser, acts } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    (browser.pages[1] as Page).frames = ['keys.example.test'];

    const sentence = await refused(tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' }));

    should(sentence).containEql('browser.read is refused on %browser:docs');
    should(acts).eql([]);
  });

  it('should refuse when a frame of the page cannot be told, and read a page whose frames are all elsewhere', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    (browser.pages[1] as Page).frames = 'unreadable';
    const unreadable = await refused(tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' }));
    (browser.pages[1] as Page).frames = ['ads.example.test'];

    const fine = await tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' });

    should(unreadable).containEql('browser.read is refused');
    should(fine.summary).containEql('Read %browser:docs');
  });
});

describe('FINDING 7: the guard is the browser’s (every ferret that uses it), not the ferret’s', () => {
  const HOLD_UNTIL = Date.UTC(2026, 10, 13, 12);
  const other: ToolCaller = { kind: 'agent', sessionId: 's2' };

  it('should refuse the page to a SECOND ferret too, and check a picture of any page for the first ferret’s live value', async () => {
    const { tools, sealed, browser } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => HOLD_UNTIL);
    (browser.pages[1] as Page).text = `Your API key: ${SENTINEL}`;

    // The harness's pages belong to s1; the second ferret reaches the same browser through the same gate.
    const closed = await sealed.covering('s2', 'keys.example.test');
    const shown = await refused(tools.call(agent, { tool: 'browser.screenshot', name: 'docs' }));

    should(closed).have.length(1);
    should(closed[0]?.own).equal(false);
    should(shown).containEql('is withheld on %browser:docs');
    should(other.sessionId).equal('s2');
  });
});
