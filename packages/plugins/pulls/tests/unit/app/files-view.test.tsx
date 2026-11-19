import { afterEach, describe, expect, it } from 'bun:test';
import { interact, mount, must, settleUntil } from '@ferretry/app/testing';
import { FIRST_LINES } from '../../../app/features/diff/diff-file.tsx';
import { FILES_PER_PAGE } from '../../../app/features/diff/files-view.tsx';
import { PullFilesView } from '../../../app/features/diff/index.ts';
import type { PullsClient } from '../../../app/features/diff/use-pull-files.ts';
import { MAX_PATCH_LINES } from '../../../contract/diff-hunks.ts';
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

const filterTree = async (container: HTMLElement, query: string): Promise<void> => {
  const input = must(container.querySelector<HTMLInputElement>('input[type="search"]'), 'filter');
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

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
    await filterTree(container, 'logo');
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

  it('draws 25 cards of 3,000 files, folds the rest behind a button, and keeps every file reachable', async () => {
    viewport(1280);
    const files = Array.from({ length: 3000 }, (_, i) => ({
      path: `dir${i % 30}/file${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      patch: PATCH,
    }));
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    expect(container.querySelectorAll('[data-diff-file]')).toHaveLength(FILES_PER_PAGE);
    expect(container.querySelectorAll('*').length).toBeLessThan(3000);
    expect(container.querySelector('[data-files-more]')?.getAttribute('data-files-more')).toBe('2975');
    // The tree lists all of them; picking a folded one draws it, scrolls to it and focuses it.
    // The tree starts with its folders closed (a few dozen rows); a filter opens what it finds.
    expect(container.querySelectorAll('[data-tree-file]')).toHaveLength(0);
    const folder = must(
      container.querySelector<HTMLElement>('[data-file-tree] button[aria-expanded="false"]'),
      'folder',
    );
    await interact(() => folder.click());
    expect(container.querySelectorAll('[data-tree-file]').length).toBeGreaterThan(0);
    await interact(() => folder.click());
    expect(container.querySelectorAll('[data-tree-file]')).toHaveLength(0);
    await filterTree(container, 'file2999');
    const pickable = must(container.querySelector('[data-tree-file="dir29/file2999.ts"]'), 'tree row');
    await interact(() => (pickable as HTMLElement).click());
    const card = must(container.querySelector('[data-diff-file="dir29/file2999.ts"]'), 'the picked card');
    expect(document.activeElement).toBe(card.querySelector('button'));
    expect(container.querySelectorAll('[data-diff-file]')).toHaveLength(FILES_PER_PAGE + 1);
    expect([...container.querySelectorAll('[data-files-more]')].map(n => n.getAttribute('data-files-more'))).toEqual([
      '2974',
    ]);
    await unmount();
  });

  it('more files: each press adds a page, and the button names how many', async () => {
    viewport(1280);
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      patch: PATCH,
    }));
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    const more = must(
      [...container.querySelectorAll('button')].find(b => b.textContent === 'Show 5 more files'),
      'more files button',
    );
    await interact(() => more.click());
    expect(container.querySelectorAll('[data-diff-file]')).toHaveLength(30);
    expect(container.querySelector('[data-files-more]')).toBeNull();
    // A tree row that is already drawn just scrolls to it; a path the list does not hold does nothing.
    await interact(() => (container.querySelector('[data-tree-file="f3.ts"]') as HTMLElement).click());
    expect(document.activeElement).toBe(container.querySelector('[data-diff-file="f3.ts"] button'));
    await unmount();
  });

  it('two paths that look alike keep two ids, so the tree focuses the right card', async () => {
    viewport(1280);
    const mk = (path: string) => ({ path, status: 'modified' as const, additions: 1, deletions: 1, patch: PATCH });
    const { container, unmount } = await mount(view(client(answer({ files: [mk('a b.ts'), mk('a_b.ts')] }))));
    await ready(container);
    const ids = [...container.querySelectorAll('[data-diff-file]')].map(n => n.id);
    expect(new Set(ids).size).toBe(2);
    await interact(() => (container.querySelector('[data-tree-file="a_b.ts"]') as HTMLElement).click());
    expect(document.activeElement).toBe(container.querySelector('[data-diff-file="a_b.ts"] button'));
    await unmount();
  });

  it('a 64 KiB line is cut with a visible note, so its row stays short; the parse waits for a large file’s button', async () => {
    viewport(390);
    const long = 'y'.repeat(64 * 1024);
    const files = [
      { path: 'min.js', status: 'modified' as const, additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${long}` },
    ];
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    expect(container.querySelector('[data-diff-cut]')?.textContent).toContain('more characters not shown');
    expect(must(container.querySelector('[data-diff-line]'), 'line').textContent?.length).toBeLessThan(700);
    await unmount();

    const huge = `@@ -0,0 +1,2 @@\n+${'z'.repeat(130_000)}\n+b`;
    const big = await mount(view(client(answer({ files: [{ ...files[0]!, patch: huge }] }))));
    await ready(big.container);
    expect(big.container.querySelector('[data-diff-line]')).toBeNull();
    expect(big.container.textContent).toContain('This is a large diff.');
    await interact(() => must(big.container.querySelector<HTMLElement>('[data-diff-file] p button'), 'show').click());
    expect(big.container.querySelectorAll('[data-diff-line]')).toHaveLength(2);
    await big.unmount();
  });

  it('a long diff draws a window of lines, doubles it on request, and says what the parser left out', async () => {
    viewport(390);
    const rows = Array.from({ length: 450 }, (_, i) => `+line ${i}`).join('\n');
    const files = [
      {
        path: 'long.txt',
        status: 'added' as const,
        additions: 450,
        deletions: 0,
        patch: `@@ -0,0 +1,450 @@\n${rows}`,
        url: 'https://github.com/octo/widgets/blob/x/long.txt',
      },
      {
        path: 'huge.txt',
        status: 'added' as const,
        additions: 1,
        deletions: 0,
        patch: `@@ -0,0 +1 @@\n${Array.from({ length: MAX_PATCH_LINES + 5 }, () => '+x').join('\n')}`,
        url: 'javascript:alert(1)',
      },
    ];
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    const long = must(container.querySelector('[data-diff-file="long.txt"]'), 'long card');
    expect(long.querySelectorAll('[data-diff-line]')).toHaveLength(FIRST_LINES);
    expect(long.querySelector('[data-diff-more]')?.getAttribute('data-diff-more')).toBe('250');
    await interact(() => must(long.querySelector<HTMLElement>('[data-diff-more] button'), 'show more').click());
    expect(long.querySelectorAll('[data-diff-line]')).toHaveLength(400);
    await interact(() => must(long.querySelector<HTMLElement>('[data-diff-more] button'), 'show more').click());
    expect(long.querySelectorAll('[data-diff-line]')).toHaveLength(450);
    expect(long.querySelector('[data-diff-more]')).toBeNull();
    expect(long.querySelector('[data-diff-omitted]')).toBeNull();
    const huge = must(container.querySelector('[data-diff-file="huge.txt"]'), 'huge card');
    expect(huge.querySelector('[data-diff-omitted]')?.textContent).toContain('5 more lines are too many to show here.');
    // Its url is not an https://github.com address, so there is no link to follow.
    expect(huge.querySelector('a')).toBeNull();
    await unmount();
  });

  it('draws bidi and zero-width controls as named chips in lines, hunk headers and paths', async () => {
    viewport(390);
    const files = [
      {
        path: 'src/‮evil.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@ sect⁧ion\n+a‮b​c﻿',
      },
    ];
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    const chips = (root: Element): string[] =>
      [...root.querySelectorAll('[data-diff-control]')].map(n => n.getAttribute('data-diff-control') ?? '');
    const line = must(container.querySelector('[data-diff-line]'), 'line');
    expect(chips(line)).toEqual(['U+202E', 'U+200B', 'U+FEFF']);
    expect(line.textContent).toContain('<U+202E>');
    expect(line.textContent).not.toMatch(/[‮​﻿]/u);
    expect(chips(must(container.querySelector('[data-diff-hunk]'), 'hunk header'))).toEqual(['U+2067']);
    const card = must(container.querySelector('[data-diff-file]'), 'card');
    expect(chips(card.querySelector('header')!)).toContain('U+202E');
    expect(card.querySelector('header bdi')).not.toBeNull();
    await unmount();
  });

  it('a thread seam is asked for both sides of a context line, in unified and in split', async () => {
    for (const width of [390, 1280]) {
      viewport(width);
      const seen: string[] = [];
      const { container, unmount } = await mount(
        <PullFilesView
          client={client(answer())}
          lineExtras={at => {
            seen.push(`${at.side}:${at.line}`);
            return at.side === 'left' && at.line === 3 ? <em data-thread>left thread</em> : null;
          }}
          number={7}
          project={P}
          repo={REPO}
        />,
      );
      await ready(container);
      // "tail" is old line 3 and new line 3: a LEFT thread on it has a place to draw.
      expect(must(container.querySelector('[data-thread]'), 'left thread on a context line').textContent).toBe(
        'left thread',
      );
      expect(seen).toContain('left:3');
      expect(seen).toContain('right:3');
      await unmount();
    }
  });

  it('never links a file url that is not an https://github.com address', async () => {
    const files = [{ path: 'x.bin', status: 'added' as const, additions: 0, deletions: 0, url: 'javascript:alert(1)' }];
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    expect(container.querySelector('[data-diff-file] a')).toBeNull();
    await unmount();
  });

  it('a card folds and opens from its header; a lone added line and a missing final newline are drawn in both views', async () => {
    const files = [
      {
        path: 'n.txt',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1,2 @@\n a\n+b\n\\ No newline at end of file',
      },
    ];
    for (const width of [390, 1280]) {
      viewport(width);
      const { container, unmount } = await mount(view(client(answer({ files }))));
      await ready(container);
      expect(container.textContent).toContain('no newline at end of file');
      const toggle = must(container.querySelector<HTMLElement>('[data-diff-file] header button'), 'header');
      await interact(() => toggle.click());
      expect(container.querySelector('[data-diff-body]')).toBeNull();
      await interact(() => toggle.click());
      expect(container.querySelector('[data-diff-body]')).not.toBeNull();
      if (width > 1000) {
        await filterTree(container, 'nothing-like-this');
        expect(container.textContent).toContain('No file matches');
      }
      await unmount();
    }
  });

  it('folded files between picked cards are said once per run, and only the first run has the button', async () => {
    viewport(1280);
    const files = Array.from({ length: 3000 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      patch: PATCH,
    }));
    const { container, unmount } = await mount(view(client(answer({ files }))));
    await ready(container);
    for (const name of ['f2999.ts', 'f100.ts']) {
      await filterTree(container, name);
      await interact(() => must(container.querySelector<HTMLElement>(`[data-tree-file="${name}"]`), 'row').click());
    }
    const runs = [...container.querySelectorAll('[data-files-more]')];
    expect(runs.map(n => n.getAttribute('data-files-more'))).toEqual(['75', '2898']);
    expect(runs.map(n => n.querySelector('button') !== null)).toEqual([true, false]);
    await unmount();
  });
});
