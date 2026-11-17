import { beforeEach, describe, expect, it } from 'bun:test';
import { useRef } from 'react';
import { useFileInstanceSurface } from '../../../../app/features/files/file-instance-surface.tsx';
import { resetFsProbes } from '../../../../app/features/files/files-api.ts';
import { type OpenFileTab, resetFilesTabStates } from '../../../../app/features/files/files-tab-model.ts';
import { FilesTab } from '../../../../app/features/files/files-tab.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { type FsCall, type FsFixture, fsClient, scopeOf } from './support/fs-client.ts';

/**
 * S-0102 (FileInstanceSurface), S-0103 (FilesTab) and S-0167 (OpenFileTabs): one file is one tab, and each tab is its
 * own instance — its view, its reads and its reload — while the folder tree beside it is the picker's and stays put.
 */

let fixture: FsFixture = {};
let calls: FsCall[] = [];
const fresh = () => {
  calls = [];
  return scopeOf(
    fsClient(() => fixture, calls),
    'work',
  );
};

beforeEach(() => {
  fixture = {};
  resetFilesTabStates();
  resetFsProbes();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1_280 });
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};
const open = async (element: Parameters<typeof mount>[0]): Promise<Mounted> => {
  const view = await mount(element);
  await settle();
  return view;
};
const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `an element labelled ${label}`);
const click = async (container: HTMLElement, label: string): Promise<void> => {
  await interact(() => byLabel(container, label).click());
  await settle();
};
const fileReads = (): readonly string[] =>
  calls.filter(call => call.route.endsWith('/fs/file')).map(call => call.query.path ?? '');

describe('the file instance surface', () => {
  it('reads and draws nothing while no tab is on show', async () => {
    const view = fresh();
    let parts: ReturnType<typeof useFileInstanceSurface> | undefined;
    const Probe = () => {
      parts = useFileInstanceSurface({
        scope: view,
        tab: null,
        repo: true,
        probeRefreshing: false,
        onReloadProbe: () => undefined,
        onBack: () => undefined,
        onViewChange: () => undefined,
        onClearSelection: () => undefined,
        focusRequest: 0,
        focusedRequest: useRef(0),
      });
      return null;
    };
    const mounted = await open(<Probe />);
    try {
      expect(parts).toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      await mounted.unmount();
    }
  });

  it('S-0102 draws one tab as an instance: its bar, its notice and its body, read once', async () => {
    const view = fresh();
    const tab: OpenFileTab = { path: 'a.ts', view: 'normal' };
    const Probe = () => {
      const parts = useFileInstanceSurface({
        scope: view,
        tab,
        repo: false,
        probeRefreshing: false,
        onReloadProbe: () => undefined,
        onBack: () => undefined,
        onViewChange: () => undefined,
        onClearSelection: () => undefined,
        focusRequest: 0,
        focusedRequest: useRef(0),
      });
      return (
        <div className="kt-fs">
          {parts?.bar}
          {parts?.notice}
          <div ref={parts?.paneRef}>{parts?.body}</div>
        </div>
      );
    };
    const mounted = await open(<Probe />);
    try {
      expect(must(mounted.container.querySelector('.kt-fs-title-path'), 'the title').textContent).toBe('@a.ts');
      expect(mounted.container.textContent).toContain('contents of a.ts');
      expect(byLabel(mounted.container, 'Show raw bytes for a.ts')).toBeDefined();
      // No repository, so no diff to offer.
      expect(mounted.container.querySelector('[aria-label="Show git diff for a.ts"]')).toBeNull();
      expect(fileReads()).toEqual(['a.ts']);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the Files pane as a tab strip', () => {
  it('S-0103 gives every opened file its own tab and keeps each tab’s own view', async () => {
    fixture.listings = {
      '': {
        entries: [
          { name: 'a.ts', type: 'file', size: 12 },
          { name: 'b.ts', type: 'file', size: 12 },
        ],
      },
    };
    const view = await open(<FilesTab scope={fresh()} />);
    try {
      await click(view.container, 'Open file a.ts, 12 B');
      await click(view.container, 'Show raw bytes for a.ts');
      await click(view.container, 'Back to the file list');
      await click(view.container, 'Open file b.ts, 12 B');
      expect(view.container.querySelectorAll('[aria-label="Open files"] [aria-label^="Show "]')).toHaveLength(2);
      expect(view.container.textContent).toContain('contents of b.ts');

      // Back on a.ts: still raw, as it was left.
      await click(view.container, 'Show a.ts');
      expect(byLabel(view.container, 'Show a.ts normally')).toBeDefined();
      expect(byLabel(view.container, 'Show b.ts')).toBeDefined();
    } finally {
      await view.unmount();
    }
  });

  it('keeps the folder tree mounted while a file is open, so its expansion survives Back', async () => {
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file', size: 12 }] } };
    const view = await open(<FilesTab scope={fresh()} />);
    try {
      const tree = must(view.container.querySelector('[aria-label="Folder tree"]'), 'the tree');
      await click(view.container, 'Open file a.ts, 12 B');
      // The same node, hidden — not a new one built after the way back.
      const during = view.container.querySelector('[aria-label="Folder tree"]');
      expect(during).toBe(tree);
      await click(view.container, 'Back to the file list');
      expect(view.container.querySelector('[aria-label="Folder tree"]')).toBe(tree);
    } finally {
      await view.unmount();
    }
  });

  it('hands the opens to a host that owns the tab strip, and draws no strip of its own', async () => {
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file', size: 12 }] } };
    const opened: Array<readonly [string, unknown]> = [];
    const view = await open(
      <FilesTab scope={fresh()} onOpenFile={(path, selection) => opened.push([path, selection])} />,
    );
    try {
      await click(view.container, 'Open file a.ts, 12 B');
      expect(opened).toEqual([['a.ts', undefined]]);
      expect(view.container.querySelector('[aria-label="Open files"]')).toBeNull();
      expect(view.container.querySelector('[aria-label="Back to the file list"]')).toBeNull();
      expect(fileReads()).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it('closing the last tab returns to the folder listing', async () => {
    fixture.listings = { '': { entries: [{ name: 'a.ts', type: 'file', size: 12 }] } };
    const view = await open(<FilesTab scope={fresh()} />);
    try {
      await click(view.container, 'Open file a.ts, 12 B');
      await click(view.container, 'Close a.ts');
      expect(view.container.querySelector('[aria-label="Open files"]')).toBeNull();
      expect(view.container.textContent).toContain('a.ts');
      expect(view.container.querySelector('[aria-label="Back to the file list"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('reloads only the file on show, not every open tab', async () => {
    fixture.listings = {
      '': {
        entries: [
          { name: 'a.ts', type: 'file', size: 12 },
          { name: 'b.ts', type: 'file', size: 12 },
        ],
      },
    };
    const view = await open(<FilesTab scope={fresh()} />);
    try {
      await click(view.container, 'Open file a.ts, 12 B');
      await click(view.container, 'Back to the file list');
      await click(view.container, 'Open file b.ts, 12 B');
      const before = fileReads().length;
      await click(view.container, 'Reload b.ts');
      expect(fileReads().slice(before)).toEqual(['b.ts']);
    } finally {
      await view.unmount();
    }
  });
});
