import { describe, expect, it } from 'bun:test';
import { interact, mount, must, settleUntil } from '@ferretry/app/testing';
import type { ReviewThread } from '../../contract/index.ts';
import {
  fetchThreads,
  LineThreads,
  useThreads,
  OutdatedThreads,
  placeThreads,
  type DiffRows,
  type DiffSide,
} from '../../app/features/threads/index.ts';
import { threadWhere } from '../../app/features/threads/thread-card.tsx';
import { safeGithubUrl } from '../../app/features/threads/place.ts';

/** Test-only stand-in for E5's hunk parser: walks a unified patch and records the old and new line numbers it draws. */
function rowsOfPatches(patches: Readonly<Record<string, string>>): DiffRows {
  const seen = new Set<string>();
  for (const [path, patch] of Object.entries(patches)) {
    let oldLine = 0;
    let newLine = 0;
    for (const text of patch.split('\n')) {
      const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
      if (head !== null) {
        oldLine = Number(head[1]);
        newLine = Number(head[2]);
      } else if (text.startsWith('+')) seen.add(`${path}|right|${newLine++}`);
      else if (text.startsWith('-')) seen.add(`${path}|left|${oldLine++}`);
      else if (text.startsWith(' ')) {
        seen.add(`${path}|left|${oldLine++}`);
        seen.add(`${path}|right|${newLine++}`);
      }
    }
  }
  return { hasLine: (path: string, side: DiffSide, line: number) => seen.has(`${path}|${side}|${line}`) };
}

const PATCH = ['@@ -10,4 +10,4 @@', ' keep', '-old line', '+new line', ' tail'].join('\n');
const rows = rowsOfPatches({ 'src/a.ts': PATCH });

const comment = (id: string, body: string, at = '2026-11-01T10:00:00Z') => ({
  id,
  author: { login: 'reviewer' },
  body,
  createdAt: at,
  url: `https://github.com/octo/demo/pull/7#discussion_${id}`,
});
const thread = (id: string, patch: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  resolved: false,
  outdated: false,
  path: 'src/a.ts',
  line: 11,
  side: 'right',
  comments: [comment(`${id}c`, 'rename this')],
  ...patch,
});

describe('placeThreads', () => {
  it('puts a thread on its line on its own side: line 11 is the NEW line on the right and the OLD line on the left', () => {
    const right = thread('R', { line: 11, side: 'right' });
    const left = thread('L', { line: 11, side: 'left' });
    const placed = placeThreads([right, left], rows);
    expect(placed.onLine.size).toBe(2);
    expect(placed.elsewhere).toEqual([]);
    const sides = [...placed.onLine.values()].flat().map(t => t.id);
    expect(sides.sort()).toEqual(['L', 'R']);
  });

  it('a side with no such row is not drawn there: the old side has no line 12, so that thread is listed instead', () => {
    const placed = placeThreads([thread('X', { line: 13, side: 'left' })], rows);
    expect(placed.onLine.size).toBe(0);
    expect(placed.elsewhere.map(t => t.id)).toEqual(['X']);
  });

  it('lists outdated threads and never places them, even when their line number still exists', () => {
    const placed = placeThreads([thread('O', { outdated: true, line: 11 }), thread('N', { outdated: true })], rows);
    expect(placed.onLine.size).toBe(0);
    expect(placed.outdated.map(t => t.id).sort()).toEqual(['N', 'O']);
  });

  it('a thread with no line, or in a file not in the diff, is listed, not dropped', () => {
    const { line: _, ...noLine } = thread('A');
    const placed = placeThreads([noLine as ReviewThread, thread('B', { path: 'src/other.ts' })], rows);
    expect(placed.elsewhere.map(t => t.id).sort()).toEqual(['A', 'B']);
  });

  it('orders the threads on one line by when they began', () => {
    const late = thread('late', { comments: [comment('c1', 'x', '2026-11-03T00:00:00Z')] });
    const early = thread('early', { comments: [comment('c2', 'y', '2026-11-01T00:00:00Z')] });
    const placed = placeThreads([late, early], rows);
    expect([...placed.onLine.values()][0]?.map(t => t.id)).toEqual(['early', 'late']);
  });
});

describe('the thread views', () => {
  it('draws a thread under its row and nothing under a row with none', async () => {
    const placed = placeThreads([thread('T1')], rows);
    const mounted = await mount(
      <div>
        <LineThreads placement={placed} path="src/a.ts" side="right" line={11} />
        <LineThreads placement={placed} path="src/a.ts" side="right" line={10} />
      </div>,
    );
    expect(mounted.container.querySelectorAll('[data-line-threads]')).toHaveLength(1);
    expect(mounted.container.textContent).toContain('rename this');
  });

  it('collapses a resolved thread and keeps an open one open', async () => {
    const placed = placeThreads([thread('open'), thread('done', { resolved: true, line: 10 })], rows);
    const mounted = await mount(
      <div>
        <LineThreads placement={placed} path="src/a.ts" side="right" line={11} />
        <LineThreads placement={placed} path="src/a.ts" side="right" line={10} />
      </div>,
    );
    const open = mounted.container.querySelector('[data-thread="open"]') as HTMLDetailsElement;
    const done = mounted.container.querySelector('[data-thread="done"]') as HTMLDetailsElement;
    expect(open.open).toBe(true);
    expect(done.open).toBe(false);
    expect(done.textContent).toContain('Resolved');
  });

  it('lists the outdated and the unplaced threads with their file and line', async () => {
    const placed = placeThreads(
      [thread('O', { outdated: true, line: 99, startLine: 97 }), thread('E', { path: 'src/other.ts', line: 3 })],
      rows,
    );
    const mounted = await mount(<OutdatedThreads placement={placed} />);
    expect(mounted.container.querySelector('[data-outdated-group="outdated"]')?.textContent).toContain(
      'src/a.ts:97-99',
    );
    expect(mounted.container.querySelector('[data-outdated-group="elsewhere"]')?.textContent).toContain(
      'src/other.ts:3',
    );
  });

  it('renders a stranger’s text inert: no element from the body, a javascript: link is never an anchor', async () => {
    const evil = thread('E', {
      comments: [
        {
          ...comment('c', '<img src=x onerror=alert(1)><script>boom()</script> [x](javascript:alert(1)) &F1 :agent'),
          url: 'javascript:alert(1)',
        },
      ],
    });
    const mounted = await mount(<OutdatedThreads placement={placeThreads([{ ...evil, outdated: true }], rows)} />);
    expect(mounted.container.querySelector('img, script')).toBeNull();
    expect(mounted.container.querySelector('a')).toBeNull();
    expect(mounted.container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('links only an https://github.com address, outside the app', async () => {
    expect(safeGithubUrl('https://github.com/octo/demo/pull/7#x')).toBeDefined();
    expect(safeGithubUrl('http://github.com/a')).toBeUndefined();
    expect(safeGithubUrl('https://evil.example/github.com')).toBeUndefined();
    expect(safeGithubUrl('not a url')).toBeUndefined();
    const placed = placeThreads([thread('T')], rows);
    const mounted = await mount(<LineThreads placement={placed} path="src/a.ts" side="right" line={11} />);
    const link = mounted.container.querySelector('a') as HTMLAnchorElement;
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.target).toBe('_blank');
  });

  it('says where a thread was made', () => {
    expect(threadWhere(thread('a', { line: 5 }))).toBe('src/a.ts:5');
    expect(threadWhere(thread('a', { line: 5, startLine: 3 }))).toBe('src/a.ts:3-5');
  });
});

describe('fetchThreads', () => {
  it('calls the route with owner~name and parses the answer', async () => {
    const calls: unknown[] = [];
    const client = {
      call: async (route: string, init?: unknown) => {
        calls.push([route, init]);
        return { threads: [thread('T')], truncated: false, fetchedAt: '2026-11-19T00:00:00.000Z' };
      },
    };
    const answer = await fetchThreads(client as never, 'p1', 'octo', 'demo', 7);
    expect(answer.threads).toHaveLength(1);
    expect(calls).toEqual([
      ['GET /v1/pulls/:project/:repo/:number/threads', { params: { project: 'p1', repo: 'octo~demo', number: '7' } }],
    ]);
    await expect(
      fetchThreads({ call: async () => ({ threads: 'no' }) } as never, 'p1', 'octo', 'demo', 7),
    ).rejects.toThrow();
  });
});

describe('useThreads', () => {
  const answer = (n: number) => ({
    threads: Array.from({ length: n }, (_, i) => thread(`T${i}`)),
    truncated: false,
    fetchedAt: '2026-11-19T00:00:00.000Z',
  });
  const Probe = ({ client, updatedAt }: { client: { call: () => Promise<unknown> }; updatedAt: string }) => {
    const state = useThreads(client as never, { project: 'p1', owner: 'octo', name: 'demo', number: 7, updatedAt });
    const count = state.status === 'loading' ? 'loading' : String(state.answer?.threads.length ?? 'none');
    return (
      <p data-probe={state.status}>
        {count}
        {state.status === 'ready' && state.refreshing ? ' refreshing' : ''}
      </p>
    );
  };
  const text = (container: HTMLElement) => container.querySelector('[data-probe]')?.textContent;

  it('reads on open, keeps the old threads while it re-reads when the PR changes, and keeps them when the re-read fails', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const client = {
      call: async () => {
        reads += 1;
        if (reads === 2) await new Promise<void>(resolve => (release = resolve));
        if (reads === 3) throw new Error('GitHub could not answer that query');
        return answer(reads === 1 ? 1 : 2);
      },
    };
    const mounted = await mount(<Probe client={client} updatedAt="a" />);
    await settleUntil(() => text(mounted.container) === '1', 'the first answer', interact);

    await mounted.render(<Probe client={client} updatedAt="b" />);
    // One draw per state: the old threads stay up (marked refreshing), never an empty frame.
    expect(text(mounted.container)).toBe('1 refreshing');
    release();
    await settleUntil(() => text(mounted.container) === '2', 'the second answer', interact);

    await mounted.render(<Probe client={client} updatedAt="c" />);
    await settleUntil(
      () => must(mounted.container.querySelector('[data-probe]'), 'probe').getAttribute('data-probe') === 'failed',
      'the failure',
      interact,
    );
    expect(text(mounted.container)).toBe('2');
  });
});
