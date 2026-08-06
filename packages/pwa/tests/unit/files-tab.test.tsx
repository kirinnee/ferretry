import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resetFsProbes, type FsChanges, type FsFile, type FsListing } from '../../src/components/files-api.ts';
import { FilesTab } from '../../src/components/files-tab.tsx';
import { readFilesTabState, resetFilesTabStates } from '../../src/components/files-tab-model.ts';
import { SessionSearchProvider } from '../../src/features/session-search/session-search.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { interact, mount, must, type Mounted } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'files-daemon',
  baseUrl: 'https://files.example.test',
  deviceToken: 'files-token',
});
const scope = daemonSessionScope(daemon, 'work');

const second = daemonConnection({
  daemonId: 'second-daemon',
  baseUrl: 'https://second.example.test',
  deviceToken: 'second-token',
});
const secondScope = daemonSessionScope(second, 'work');

interface DaemonFixture {
  changes?: FsChanges | Error;
  listings?: Record<string, FsListing>;
  files?: Record<string, FsFile | Error>;
  diffs?: Record<string, string | Error>;
}

let fixture: DaemonFixture = {};
let asked: string[] = [];
const originalFetch = globalThis.fetch;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** Answers every daemon read the pane can make, from `fixture`. */
const route = (url: string): Response => {
  const parsed = new URL(url);
  const path = parsed.searchParams.get('path') ?? '';
  if (parsed.pathname.endsWith('/fs/changes')) {
    if (fixture.changes instanceof Error) throw fixture.changes;
    return json(fixture.changes ?? { repo: false, changes: [] });
  }
  if (parsed.pathname.endsWith('/fs/file')) {
    const answer = fixture.files?.[path];
    if (answer instanceof Error) throw answer;
    return json(answer ?? { path, content: `contents of ${path}` });
  }
  if (parsed.pathname.endsWith('/fs/diff')) {
    const answer = fixture.diffs?.[path];
    if (answer instanceof Error) throw answer;
    return new Response(answer ?? '', { headers: { 'content-type': 'text/plain' } });
  }
  return json(fixture.listings?.[path] ?? { entries: [] });
};

/**
 * The pane reads `useLayoutMode`, which reads `window.innerWidth`. happy-dom is
 * registered once for the whole process, so a sibling suite that set a phone
 * width would otherwise decide whether this pane's tree starts open — an
 * order-dependent test that passes locally and fails on another machine.
 * Every case states the width it means.
 */
const setViewport = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

/** Wide enough for the tree to sit beside the listing (`rail`/`full`). */
const DESKTOP_WIDTH = 1_280;
/** Below `DRAWER_MAX`, where the tree starts collapsed. */
const PHONE_WIDTH = 390;
/** Handed back afterwards: the DOM is shared with every other suite. */
const ORIGINAL_WIDTH = typeof window === 'undefined' ? DESKTOP_WIDTH : window.innerWidth;

beforeEach(() => {
  fixture = {};
  asked = [];
  setViewport(DESKTOP_WIDTH);
  resetFilesTabStates();
  resetFsProbes();
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return route(String(input));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setViewport(ORIGINAL_WIDTH);
});

/** Lets every queued daemon read and its follow-up render settle. */
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};

/** Mirrors the session-route provider boundary above every Files tab mount. */
const withSessionSearch = (
  element: Parameters<typeof mount>[0],
  connection = daemon,
  sessionScope = scope,
): Parameters<typeof mount>[0] => (
  <SessionSearchProvider connection={connection} focusSignal={0} scope={sessionScope}>
    {element}
  </SessionSearchProvider>
);

const open = async (
  element: Parameters<typeof mount>[0],
  connection = daemon,
  sessionScope = scope,
): Promise<Mounted> => {
  const view = await mount(withSessionSearch(element, connection, sessionScope));
  await settle();
  return view;
};

const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `an element labelled ${label}`);

const click = (container: HTMLElement, label: string): Promise<void> =>
  interact(() => byLabel(container, label).click());

describe('the Files tab', () => {
  it('browses the paired daemon, walks into a folder and back out through the crumbs', async () => {
    fixture.listings = {
      '': { entries: [{ name: 'src', type: 'dir' }] },
      src: { entries: [{ name: 'a.ts', type: 'file', size: 12 }] },
    };
    const view = await open(<FilesTab daemon={daemon} scope={scope} cwd="/work/ferretry" />);
    try {
      expect(view.container.textContent).toContain('src/');
      expect(byLabel(view.container, 'Go to the session root (/work/ferretry)')).toBeDefined();

      await click(view.container, 'Open folder src');
      await settle();
      expect(view.container.textContent).toContain('a.ts');
      expect(byLabel(view.container, 'Go to src').getAttribute('aria-current')).toBe('page');

      await click(view.container, 'Go to the session root (/work/ferretry)');
      await settle();
      expect(view.container.textContent).toContain('src/');
      // Every read went to the paired daemon, never a page-relative URL.
      expect(asked.every(url => url.startsWith('https://files.example.test/'))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('opens a file, remembers it, and hands the tab back on a later mount', async () => {
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file', size: 12 }] } };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file a.ts, 12 B');
      await settle();
      expect(view.container.textContent).toContain('contents of a.ts');
      expect(readFilesTabState(scope)).toMatchObject({ activePath: 'a.ts' });
      await view.unmount();

      const reopened = await open(<FilesTab daemon={daemon} scope={scope} />);
      expect(reopened.container.textContent).toContain('contents of a.ts');
      await reopened.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never shows one daemon’s open files under another daemon’s connection', async () => {
    fixture.listings = { '': { entries: [{ name: 'secrets.md', type: 'file' }] } };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file secrets.md');
      await settle();
      expect(view.container.textContent).toContain('contents of secrets.md');

      // Same session id, different daemon: the pane must not carry the tab over.
      await view.render(withSessionSearch(<FilesTab daemon={second} scope={secondScope} />, second, secondScope));
      await settle();
      expect(view.container.textContent).not.toContain('contents of secrets.md');
      expect(view.container.querySelector('.kt-fs-tabs')).toBeNull();
      expect(readFilesTabState(secondScope).activePath).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('switches a file between rendered, raw and diff, and closes it again', async () => {
    fixture.changes = { repo: true, changes: [{ path: 'a.ts', status: ' M', additions: 1, deletions: 1 }] };
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    fixture.files = { 'a.ts': { path: 'a.ts', lang: 'ts', content: 'const a = 1;' } };
    fixture.diffs = {
      'a.ts': ['diff --git a/a.ts b/a.ts', '@@ -1 +1 @@', '-const a = 0;', '+const a = 1;'].join('\n'),
    };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file a.ts, Modified (unstaged) · +1 · −1');
      await settle();

      await click(view.container, 'Show raw bytes for a.ts');
      await settle();
      expect(byLabel(view.container, 'Show a.ts normally').getAttribute('aria-pressed')).toBe('true');

      await click(view.container, 'Show a.ts normally');
      await settle();
      await click(view.container, 'Show git diff for a.ts');
      await settle();
      expect(view.container.querySelectorAll('.kt-fs-diff-line').length).toBeGreaterThan(0);

      await click(view.container, 'Close a.ts');
      await settle();
      expect(view.container.querySelector('.kt-fs-tabs')).toBeNull();
      expect(view.container.textContent).toContain('a.ts');
    } finally {
      await view.unmount();
    }
  });

  it('lands a programmatic reference on its exact lines and lets the reader clear them', async () => {
    fixture.files = { 'src/a.ts': { path: 'src/a.ts', content: 'one\ntwo\nthree' } };
    const handled: number[] = [];
    const view = await open(
      <FilesTab
        daemon={daemon}
        scope={scope}
        requestedReference={{ sequence: 1, reference: { path: 'src/a.ts', line: 2 } }}
        onRequestedReferenceHandled={sequence => handled.push(sequence)}
      />,
    );
    try {
      expect(handled).toEqual([1]);
      expect(view.container.textContent).toContain('Line 2 highlighted.');
      expect(must(view.container.querySelector('.kt-fs-title-path'), 'the title').textContent).toBe('@src/a.ts:2');

      await click(view.container, 'Clear line selection for src/a.ts');
      await settle();
      expect(view.container.querySelector('.kt-fs-location')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('ignores a reference whose path this viewer cannot address', async () => {
    fixture.listings = { '': { entries: [] } };
    const view = await open(
      <FilesTab
        daemon={daemon}
        scope={scope}
        requestedReference={{ sequence: 4, reference: { path: '../escape.ts', line: 1 } }}
      />,
    );
    try {
      expect(view.container.querySelector('.kt-fs-tabs')).toBeNull();
      expect(view.container.textContent).toContain('This folder is empty.');
    } finally {
      await view.unmount();
    }
  });

  it('goes back to the list, toggles the folder tree, and reloads whichever pane is showing', async () => {
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      const listReads = () => asked.filter(url => url.endsWith('/fs')).length;
      const before = listReads();
      await click(view.container, 'Reload files');
      await settle();
      expect(listReads()).toBeGreaterThan(before);

      await click(view.container, 'Hide the folder tree');
      await settle();
      expect(view.container.querySelector('[aria-label="Folder tree"]')).toBeNull();
      await click(view.container, 'Show the folder tree');
      await settle();
      expect(view.container.querySelector('[aria-label="Folder tree"]')).not.toBeNull();

      await click(view.container, 'Open file a.ts');
      await settle();
      const fileReads = () => asked.filter(url => url.includes('/fs/file')).length;
      const beforeFile = fileReads();
      await click(view.container, 'Reload a.ts');
      await settle();
      expect(fileReads()).toBeGreaterThan(beforeFile);

      await click(view.container, 'Back to the file list');
      await settle();
      expect(view.container.textContent).toContain('a.ts');
      expect(view.container.querySelector('.kt-fs-crumbs')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('starts with the tree collapsed on a phone, and opens it only when asked', async () => {
    setViewport(PHONE_WIDTH);
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      // A phone cannot fit a tree beside a listing, so it starts closed.
      expect(view.container.querySelector('[aria-label="Folder tree"]')).toBeNull();
      await click(view.container, 'Show the folder tree');
      await settle();
      expect(view.container.querySelector('[aria-label="Folder tree"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('keeps the standalone viewer’s bytes on screen when its Reload fails, and says which copy it is', async () => {
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    fixture.files = { 'a.ts': { path: 'a.ts', content: 'the copy that survived' } };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file a.ts');
      await settle();
      expect(view.container.textContent).toContain('the copy that survived');

      fixture.files = { 'a.ts': new Error('the session host went away') };
      await click(view.container, 'Reload a.ts');
      await settle();

      // Same decision as the instance viewer, because it is the same decision.
      expect(view.container.textContent).toContain('the copy that survived');
      const notice = must(view.container.querySelector('.kt-fs-stale'), 'the failed-reload notice');
      expect(notice.getAttribute('role')).toBe('alert');
      expect(notice.textContent).toContain('the session host went away');

      fixture.files = { 'a.ts': { path: 'a.ts', content: 'the retry that worked' } };
      await interact(() => must(notice.querySelector('button'), 'the try-again control').click());
      await settle();
      expect(view.container.textContent).toContain('the retry that worked');
      expect(view.container.querySelector('.kt-fs-stale')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('reloads the diff rather than the file while the diff is showing', async () => {
    fixture.changes = { repo: true, changes: [] };
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    fixture.diffs = { 'a.ts': '@@ -1 +1 @@\n-old\n+new' };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file a.ts');
      await settle();
      await click(view.container, 'Show git diff for a.ts');
      await settle();
      const diffReads = () => asked.filter(url => url.includes('/fs/diff')).length;
      const before = diffReads();
      await click(view.container, 'Reload a.ts');
      await settle();
      expect(diffReads()).toBeGreaterThan(before);
    } finally {
      await view.unmount();
    }
  });

  it('reports what git said about a diff it cannot show as text', async () => {
    fixture.changes = { repo: true, changes: [], truncated: true };
    fixture.listings = { '': { entries: [{ name: 'logo.png', type: 'file' }] } };
    fixture.diffs = {
      'logo.png': 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ',
      'empty.ts': 'diff --git a/empty.ts b/empty.ts\nindex 1111111..2222222 100644',
    };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      expect(view.container.textContent).toContain('Some change dots may be missing');
      await click(view.container, 'Open file logo.png');
      await settle();
      await click(view.container, 'Show git diff for logo.png');
      await settle();
      expect(view.container.textContent).toContain('git reports this pair as binary');

      await click(view.container, 'Back to the file list');
      await settle();
    } finally {
      await view.unmount();
    }
  });

  it('says a file has no textual changes rather than showing an empty diff', async () => {
    fixture.changes = { repo: true, changes: [] };
    fixture.listings = { '': { entries: [{ name: 'empty.ts', type: 'file' }] } };
    fixture.diffs = { 'empty.ts': 'diff --git a/empty.ts b/empty.ts\nindex 1111111..2222222 100644' };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file empty.ts');
      await settle();
      await click(view.container, 'Show git diff for empty.ts');
      await settle();
      expect(view.container.textContent).toContain('No textual changes in this file.');
    } finally {
      await view.unmount();
    }
  });

  it('surfaces a failed diff, a failed file and a failed listing with a retry each', async () => {
    fixture.changes = { repo: true, changes: [] };
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    fixture.files = { 'a.ts': new TypeError('file offline') };
    fixture.diffs = { 'a.ts': new TypeError('diff offline') };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file a.ts');
      await settle();
      expect(view.container.textContent).toContain('Could not load a.ts: could not reach the daemon');
      await click(view.container, 'Retry loading a.ts');
      await settle();
      expect(view.container.textContent).toContain('Could not load a.ts: could not reach the daemon');

      await click(view.container, 'Show git diff for a.ts');
      await settle();
      expect(view.container.textContent).toContain('Could not load the diff: could not reach the daemon');
      await click(view.container, 'Retry loading the diff');
      await settle();

      await click(view.container, 'Back to the file list');
      await settle();
      fixture.listings = {};
      await click(view.container, 'Close a.ts');
      await settle();
    } finally {
      await view.unmount();
    }
  });

  it('keeps browsing when the git status probe itself fails', async () => {
    fixture.changes = new TypeError('status offline');
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      expect(view.container.textContent).toContain('git change markers are unavailable');
      expect(view.container.textContent).toContain('a.ts');
      // With no repo, the diff action is not offered at all.
      await click(view.container, 'Open file a.ts');
      await settle();
      expect(view.container.querySelector('[aria-label="Show git diff for a.ts"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('says a daemon that cannot serve files ONCE, with nothing to retry', async () => {
    // Arrange: the shape a macOS daemon answers with. Before this, one condition produced three
    // messages — an amber "files still browse normally" over two red panels saying they did not.
    const reason =
      'file browsing is not available on macOS yet — this daemon confines every read to the session folder';
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ error: reason, code: 'unsupported' }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    // A remembered open file must not resurrect a second failing panel either.
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      const text = view.container.textContent ?? '';
      expect(text).toContain('not available on the computer running this daemon');
      // The precise mechanism stays reachable for whoever needs it, folded away from everyone else.
      expect(must(view.container.querySelector('details'), 'the reason disclosure').textContent).toContain(reason);
      // One statement, no contradiction, and no control that cannot work.
      expect(text).not.toContain('still browse normally');
      expect(text).not.toContain('Could not load');
      expect(view.container.querySelectorAll('button').length).toBe(0);
      // And it stops asking. The first render's reads race the probe, but once the daemon has said
      // what it is, nothing re-asks it — a refused surface is not a flaky one.
      const settled = asked.length;
      await settle();
      expect(asked.length).toBe(settled);
    } finally {
      await view.unmount();
    }
  });

  it('states a listing failure instead of presenting an empty directory', async () => {
    const failing = new TypeError('listing offline');
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.includes('/fs/changes')) return json({ repo: false, changes: [] });
      throw failing;
    }) as unknown as typeof fetch;
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      expect(view.container.textContent).toContain('Could not load the session root: could not reach the daemon');
      await click(view.container, 'Retry loading the session root');
      await settle();
      expect(view.container.textContent).toContain('Could not load the session root: could not reach the daemon');
    } finally {
      await view.unmount();
    }
  });

  it('shows a truncated diff’s own count rather than pretending it is complete', async () => {
    const hunk = ['diff --git a/big.ts b/big.ts', '@@ -1,9000 +1,9000 @@'];
    for (let line = 0; line < 4_200; line += 1) hunk.push(`+line ${line}`);
    fixture.changes = { repo: true, changes: [] };
    fixture.listings = { '': { entries: [{ name: 'big.ts', type: 'file' }] } };
    fixture.diffs = { 'big.ts': hunk.join('\n') };
    const view = await open(<FilesTab daemon={daemon} scope={scope} />);
    try {
      await click(view.container, 'Open file big.ts');
      await settle();
      await click(view.container, 'Show git diff for big.ts');
      await settle();
      expect(view.container.textContent).toContain('diff lines.');
    } finally {
      await view.unmount();
    }
  });
});

/**
 * Handover #35 — one tab per file. A host that owns a tab strip takes the
 * opens, and this pane must then be nothing but the picker: no second strip of
 * its own, no viewer, no competing notion of which file is "active".
 */
describe('the Files tab as a picker for a host that owns the tabs', () => {
  it('hands a row-open to the host instead of opening the file itself', async () => {
    const opened: Array<[string, unknown]> = [];
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    const view = await open(
      <FilesTab daemon={daemon} scope={scope} onOpenFile={(path, selection) => opened.push([path, selection])} />,
    );
    try {
      await click(view.container, 'Open file a.ts');
      await settle();

      expect(opened).toEqual([['a.ts', undefined]]);
      // Still the listing, never a viewer: no back control, no file bytes.
      expect(view.container.querySelector('[aria-label="Back to the file list"]')).toBeNull();
      expect(view.container.textContent).not.toContain('contents of a.ts');
      expect(asked.some(url => url.includes('/fs/file'))).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('renders no open-file strip of its own — the host owns the one strip', async () => {
    const opened: string[] = [];
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    const view = await open(<FilesTab daemon={daemon} scope={scope} onOpenFile={path => opened.push(path)} />);
    try {
      await click(view.container, 'Open file a.ts');
      await settle();

      expect(opened).toEqual(['a.ts']);
      expect(view.container.querySelector('[aria-label="Open files"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('hands a code reference to the host with its line range intact', async () => {
    const opened: Array<[string, unknown]> = [];
    fixture.listings = { '': { entries: [] } };
    const view = await open(
      <FilesTab
        daemon={daemon}
        scope={scope}
        requestedReference={{ sequence: 1, reference: { path: 'src/api.ts', line: 4, endLine: 9 } }}
        onOpenFile={(path, selection) => opened.push([path, selection])}
      />,
    );
    try {
      expect(opened).toEqual([['src/api.ts', { line: 4, endLine: 9 }]]);
    } finally {
      await view.unmount();
    }
  });

  it('does not resurrect a viewer from state remembered before the host claimed the opens', async () => {
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file' }] } };
    // A standalone mount remembers `a.ts` as its own open, active file.
    const standalone = await open(<FilesTab daemon={daemon} scope={scope} />);
    await click(standalone.container, 'Open file a.ts');
    await settle();
    expect(readFilesTabState(scope).activePath).toBe('a.ts');
    await standalone.unmount();

    const view = await open(<FilesTab daemon={daemon} scope={scope} onOpenFile={() => undefined} />);
    try {
      expect(view.container.querySelector('[aria-label="Back to the file list"]')).toBeNull();
      expect(view.container.querySelector('[aria-label="Open files"]')).toBeNull();
      expect(view.container.textContent).toContain('a.ts');
    } finally {
      await view.unmount();
    }
  });
});
