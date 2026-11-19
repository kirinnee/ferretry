import { afterEach, describe, expect, it } from 'bun:test';
import { interact, mount, must, settleUntil } from '@ferretry/app/testing';
import { PullFilesView } from '../../../app/features/diff/index.ts';
import type { PullsClient } from '../../../app/features/diff/use-pull-files.ts';
import type { PullFilesAnswer } from '../../../contract/index.ts';

const REPO = { provider: 'github', owner: 'octo', name: 'widgets' } as const;
const P = '11111111-1111-4111-8111-111111111111';
const ROUTE = 'GET /v1/pulls/:project/:repo/:number/files';

const PATCH = '@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail';
const answer = (over: Partial<PullFilesAnswer> = {}): PullFilesAnswer => ({
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: PATCH,
      url: 'https://github.com/octo/widgets/blob/x/src/a.ts',
    },
    {
      path: 'img/logo.png',
      status: 'added',
      additions: 0,
      deletions: 0,
      url: 'https://github.com/octo/widgets/blob/x/img/logo.png',
    },
    { path: 'docs/new.md', status: 'renamed', previousPath: 'docs/old.md', additions: 0, deletions: 0 },
  ],
  truncated: false,
  unreadable: 0,
  fromCache: false,
  ...over,
});

interface Sent {
  readonly route: string;
  readonly params?: Readonly<Record<string, string>>;
}
const client = (reply: unknown, sent: Sent[] = []): PullsClient => ({
  call: (async (route: string, init?: { params?: Record<string, string> }) => {
    sent.push({ route, ...(init?.params === undefined ? {} : { params: init.params }) });
    if (reply instanceof Error) throw reply;
    return reply;
  }) as PullsClient['call'],
});

const viewport = (width: number): void => {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(
    {
      width,
      height: 900,
    },
  );
};

const view = (c: PullsClient) => <PullFilesView client={c} number={7} project={P} repo={REPO} />;
const ready = async (container: HTMLElement): Promise<void> =>
  await settleUntil(
    () =>
      container.querySelector('[data-pulls-files]') !== null &&
      container.querySelector('[data-pulls-files="ready"]') !== null,
    'the files',
    interact,
  );

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // no DOM yet
  }
});

describe('PullFilesView', () => {
  it('asks for this PR’s files with the repository as one owner~name segment', async () => {
    const sent: Sent[] = [];
    const { container, unmount } = await mount(view(client(answer(), sent)));
    await ready(container);
    expect(sent).toEqual([{ route: ROUTE, params: { project: P, repo: 'octo~widgets', number: '7' } }]);
    await unmount();
  });

  it('phone: one unified column, with old and new line numbers, no tree until asked', async () => {
    viewport(390);
    const { container, unmount } = await mount(view(client(answer())));
    await ready(container);
    expect(container.querySelector('[data-diff-view="split"]')).toBeNull();
    const unified = must(container.querySelector('[data-diff-view="unified"]'), 'unified view');
    expect([...unified.querySelectorAll('[data-diff-line]')].map(l => l.getAttribute('data-diff-line'))).toEqual([
      'context',
      'del',
      'add',
      'context',
    ]);
    expect(container.querySelector('[data-file-tree]')).toBeNull();
    const button = must(
      [...container.querySelectorAll('button')].find(b => b.textContent === 'File list'),
      'file list button',
    );
    await interact(() => button.click());
    expect(container.querySelector('[data-file-tree]')).not.toBeNull();
    await unmount();
  });

  it('wide: split by default with the tree beside it, and a switch to unified', async () => {
    viewport(1280);
    const { container, unmount } = await mount(view(client(answer())));
    await ready(container);
    expect(container.querySelector('[data-diff-view="split"]')).not.toBeNull();
    expect(container.querySelector('[data-file-tree]')).not.toBeNull();
    const toggle = must(
      [...container.querySelectorAll('button')].find(b => b.textContent === 'Unified view'),
      'unified toggle',
    );
    await interact(() => toggle.click());
    expect(container.querySelector('[data-diff-view="split"]')).toBeNull();
    expect(container.querySelector('[data-diff-view="unified"]')).not.toBeNull();
    await unmount();
  });

  it('a file with no patch says so and links to GitHub; a rename with no change says so', async () => {
    viewport(1280);
    const { container, unmount } = await mount(view(client(answer())));
    await ready(container);
    const logo = must(container.querySelector('[data-diff-file="img/logo.png"]'), 'logo card');
    expect(logo.textContent).toContain('No text changes to show');
    const link = must(logo.querySelector('a'), 'the GitHub link');
    expect(link.getAttribute('href')).toBe('https://github.com/octo/widgets/blob/x/img/logo.png');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const renamed = must(container.querySelector('[data-diff-file="docs/new.md"]'), 'renamed card');
    expect(renamed.textContent).toContain('docs/old.md → docs/new.md');
    expect(renamed.textContent).toContain('Renamed with no changes to its content.');
    await unmount();
  });

  it('a large file with additions but no patch reads "too large or binary"', async () => {
    const files = [{ path: 'big.json', status: 'modified' as const, additions: 9000, deletions: 1 }];
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    expect(container.textContent).toContain('Too large or binary to show here.');
    await unmount();
  });

  it('filters the tree to the files that match', async () => {
    viewport(1280);
    const { container, unmount } = await mount(view(client(answer())));
    await ready(container);
    const input = must(container.querySelector<HTMLInputElement>('input[type="search"]'), 'filter');
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'logo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const rows = [...container.querySelectorAll('[data-tree-file]')].map(n => n.getAttribute('data-tree-file'));
    expect(rows).toEqual(['img/logo.png']);
    await unmount();
  });

  it('ticking Viewed collapses the file, counts it, and survives a reload of the page on this device', async () => {
    viewport(1280);
    const first = await mount(view(client(answer())));
    await ready(first.container);
    const card = must(first.container.querySelector('[data-diff-file="src/a.ts"]'), 'a.ts card');
    const box = must(card.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'viewed box');
    await interact(() => box.click());
    expect(first.container.querySelector('[data-diff-file="src/a.ts"]')?.getAttribute('data-viewed')).toBe('true');
    expect(first.container.querySelector('[data-diff-file="src/a.ts"] [data-diff-body]')).toBeNull();
    expect(first.container.textContent).toContain('1 of 3 viewed');
    await first.unmount();

    const second = await mount(view(client(answer())));
    await ready(second.container);
    expect(second.container.querySelector('[data-diff-file="src/a.ts"]')?.getAttribute('data-viewed')).toBe('true');
    // A file whose diff changed since is unviewed again.
    await second.unmount();
    const changed = answer();
    changed.files = [{ ...changed.files[0]!, patch: '@@ -1 +1 @@\n-x\n+y' }];
    const third = await mount(view(client(changed)));
    await ready(third.container);
    expect(third.container.querySelector('[data-diff-file="src/a.ts"]')?.getAttribute('data-viewed')).toBe('false');
    await third.unmount();
  });

  it('draws what the thread seam gives under the right line, on the right side', async () => {
    viewport(390);
    const seen: string[] = [];
    const c = client(answer());
    const { container, unmount } = await mount(
      <PullFilesView
        client={c}
        lineExtras={at => {
          seen.push(`${at.path}:${at.side}:${at.line}`);
          return at.side === 'right' && at.line === 2 ? <em data-thread>a thread</em> : null;
        }}
        number={7}
        project={P}
        repo={REPO}
      />,
    );
    await ready(container);
    const thread = must(container.querySelector('[data-thread]'), 'thread');
    expect(thread.closest('[data-diff-line]')?.getAttribute('data-diff-number')).toBe('2');
    expect(seen).toContain('src/a.ts:left:2');
    expect(seen).toContain('src/a.ts:right:2');
    await unmount();
  });

  it('says when GitHub lists fewer files than exist, and when some were unreadable', async () => {
    const { container, unmount } = await mount(view(client(answer({ truncated: true, unreadable: 2 }))));
    await ready(container);
    expect(container.textContent).toContain('GitHub lists at most 3000 files');
    expect(container.textContent).toContain('2 files could not be read');
    await unmount();
  });

  it('a pause is the one sentence, with a way to try again; no files is said plainly', async () => {
    const paused = Object.assign(new Error('x'), {
      code: 'pulls_paused',
      body: { pausedUntilMs: Date.UTC(2026, 10, 19, 17, 5) },
    });
    const a = await mount(view(client(paused)));
    await settleUntil(() => a.container.querySelector('[data-pulls-files="failed"]') !== null, 'the failure', interact);
    expect(a.container.textContent).toMatch(/^Paused until .* to stay inside GitHub's limitTry again$/u);
    await a.unmount();
    const b = await mount(view(client(answer({ files: [] }))));
    await settleUntil(() => b.container.querySelector('[data-pulls-files="empty"]') !== null, 'empty', interact);
    await b.unmount();
  });

  it('shows nothing of another PR while the next one loads', async () => {
    viewport(1280);
    const sent: Sent[] = [];
    let release: (value: PullFilesAnswer) => void = () => undefined;
    const c: PullsClient = {
      call: (async (route: string, init?: { params?: Record<string, string> }) => {
        sent.push({ route, ...(init?.params === undefined ? {} : { params: init.params }) });
        return sent.length === 1 ? answer() : await new Promise<PullFilesAnswer>(resolve => (release = resolve));
      }) as PullsClient['call'],
    };
    const m = await mount(view(c));
    await ready(m.container);
    await m.render(<PullFilesView client={c} number={8} project={P} repo={REPO} />);
    expect(m.container.querySelector('[data-diff-file]')).toBeNull();
    await interact(() => release(answer()));
    await ready(m.container);
    expect(sent.map(x => x.params?.number)).toEqual(['7', '8']);
    await m.unmount();
  });
});
