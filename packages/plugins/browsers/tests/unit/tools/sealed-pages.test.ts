import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock } from '@ferretry/kernel/testing';
import should from 'should';
import type { BrowserActGuard } from '../../../daemon/pages/service.ts';
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
  openedBy: { by: 'agent'; sessionId: string };
}

/** The session's browser at the subsystem seam, every act running the guard the tools hand it. */
class Browser {
  readonly pages: Page[] = [];
  readonly acts: string[] = [];
  /** Set to make the page's text unreadable inside the queue. */
  textFails = false;

  status = async () =>
    ({
      state: 'running',
      sessionId: 's1',
      pages: this.pages.map(page => ({
        id: page.id,
        name: page.name,
        url: page.url,
        title: '',
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
      text: async () => {
        if (this.textFails) throw new Error('too long');
        return page.text;
      },
    });
    return page;
  }

  private result(page: Page, extra: Record<string, unknown> = {}) {
    return { status: {}, result: { url: page.url, title: '', pages: [], actedPageId: page.id, ...extra } } as never;
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
    sealed,
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

  it('should not touch a page on another origin, and not another ferret’s page on the same one', async () => {
    const { tools, sealed } = await harness();
    sealed.hold('s1', 'token', [SOURCE], () => Date.UTC(2026, 10, 13, 12));

    const docs = await tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' });
    sealed.hold('s2', 'other', ['https://docs.example.test'], () => Date.UTC(2026, 10, 13, 12));
    const stillDocs = await tools.call(agent, { tool: 'browser.read', name: 'docs', mode: 'text' });

    should(docs.summary).containEql('Read %browser:docs');
    should(stillDocs.summary).containEql('Read %browser:docs');
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
        guard === undefined ? guard : async page => await guard({ ...page, host: async () => undefined }),
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

    should(sentence).containEql('browser.eval is refused while a clipboard capture of yours is running');
    should(read.summary).containEql('Read %browser:docs');
    should(after.summary).containEql('Ran your script');
  });

  it('should not stop another ferret’s scripts, nor a person’s', async () => {
    const { tools, sealed } = await harness();
    sealed.capturing('s2');
    const done = sealed.capturing('s1');

    const byPerson = await tools.call(person, { tool: 'browser.eval', name: 'docs', function: '() => 1' } as never);
    done();

    should(byPerson.summary).containEql('Ran your script');
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
