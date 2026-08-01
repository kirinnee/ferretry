import { beforeEach, describe, expect, it } from 'bun:test';
import {
  changeDescription,
  fileRefusal,
  filesTreeOpenByDefault,
  readFilesTabState,
  resetFilesTabStates,
  scrollFileLineIntoView,
  selectionFromReference,
  writeFilesTabState,
} from '../../src/components/files-tab-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';

const daemon = daemonConnection({
  daemonId: 'files-daemon',
  baseUrl: 'https://files.example.test',
  deviceToken: 'files-token',
});
const other = daemonConnection({
  daemonId: 'other-daemon',
  baseUrl: 'https://other.example.test',
  deviceToken: 'other-token',
});
const scope = daemonSessionScope(daemon, 'shared-session-id');
const otherScope = daemonSessionScope(other, 'shared-session-id');

beforeEach(resetFilesTabStates);

describe('the folder tree default', () => {
  it('lets an explicit choice win, and collapses only the drawer layout', () => {
    expect(filesTreeOpenByDefault(undefined, 'full')).toBe(true);
    expect(filesTreeOpenByDefault(undefined, 'rail')).toBe(true);
    expect(filesTreeOpenByDefault(undefined, 'drawer')).toBe(false);
    expect(filesTreeOpenByDefault(true, 'drawer')).toBe(true);
    expect(filesTreeOpenByDefault(false, 'full')).toBe(false);
  });
});

describe('remembered open files', () => {
  it('starts empty and hands back a copy rather than the stored array', () => {
    const empty = readFilesTabState(scope);
    expect(empty).toEqual({ dir: '', tabs: [], activePath: null });
    writeFilesTabState(scope, { dir: 'src', tabs: [{ path: 'src/a.ts', view: 'normal' }], activePath: 'src/a.ts' });
    const read = readFilesTabState(scope);
    expect(read.tabs).toHaveLength(1);
    (read.tabs as { path: string; view: 'normal' }[]).push({ path: 'intruder.ts', view: 'normal' });
    expect(readFilesTabState(scope).tabs).toHaveLength(1);
  });

  it('never hands one daemon’s open files to another daemon with the same session id', () => {
    writeFilesTabState(scope, {
      dir: 'private',
      tabs: [{ path: 'private/secrets.md', view: 'normal' }],
      activePath: 'private/secrets.md',
      tree: false,
    });
    expect(readFilesTabState(otherScope)).toEqual({ dir: '', tabs: [], activePath: null });
    expect(readFilesTabState(scope).dir).toBe('private');
    expect(readFilesTabState(scope).tree).toBe(false);
    resetFilesTabStates();
    expect(readFilesTabState(scope).dir).toBe('');
  });
});

describe('a selection built from a reference', () => {
  it('ignores a line it cannot address', () => {
    expect(selectionFromReference({ path: 'a.ts' })).toBeUndefined();
    expect(selectionFromReference({ path: 'a.ts', line: 0 })).toBeUndefined();
    expect(selectionFromReference({ path: 'a.ts', line: 1.5 })).toBeUndefined();
  });

  it('keeps a valid range and drops one that ends before it starts', () => {
    expect(selectionFromReference({ path: 'a.ts', line: 4, endLine: 9 })).toEqual({ line: 4, endLine: 9 });
    expect(selectionFromReference({ path: 'a.ts', line: 4, endLine: 2 })).toEqual({ line: 4 });
    expect(selectionFromReference({ path: 'a.ts', line: 4, endLine: 4.5 })).toEqual({ line: 4 });
  });

  it('carries a column only for a single line, and only a real one', () => {
    expect(selectionFromReference({ path: 'a.ts', line: 4, column: 12 })).toEqual({ line: 4, column: 12 });
    expect(selectionFromReference({ path: 'a.ts', line: 4, endLine: 9, column: 12 })).toEqual({ line: 4, endLine: 9 });
    expect(selectionFromReference({ path: 'a.ts', line: 4, column: 0 })).toEqual({ line: 4 });
    expect(selectionFromReference({ path: 'a.ts', line: 4, column: 1.5 })).toEqual({ line: 4 });
  });
});

describe('scrolling a selected line into view', () => {
  it('parks the target at the pane’s upper third without going negative', () => {
    const pane = {
      clientHeight: 300,
      scrollTop: 40,
      getBoundingClientRect: () => ({ top: 100 }) as DOMRect,
    };
    scrollFileLineIntoView(pane, { getBoundingClientRect: () => ({ top: 500 }) as DOMRect });
    // 40 + 500 - 100 = 440, minus a third of 300.
    expect(pane.scrollTop).toBe(340);

    const atTop = { clientHeight: 300, scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) as DOMRect };
    scrollFileLineIntoView(atTop, { getBoundingClientRect: () => ({ top: 120 }) as DOMRect });
    expect(atTop.scrollTop).toBe(0);
  });
});

describe('the spoken change description', () => {
  it('states the status word and only the counts git actually reported', () => {
    expect(changeDescription({ path: 'a.ts', status: 'M', additions: 3, deletions: 1 })).toBe(
      'Modified (staged) · +3 · −1',
    );
    expect(changeDescription({ path: 'a.ts', status: 'A', additions: 0, deletions: 0 })).toBe('Added (staged) · +0');
    expect(changeDescription({ path: 'a.ts', status: 'D', additions: 0, deletions: 0 })).toBe('Deleted (staged) · −0');
    expect(changeDescription({ path: 'a.ts', status: 'M', additions: 0, deletions: 0 })).toBe('Modified (staged)');
    expect(changeDescription({ path: 'a.ts', status: 'M' })).toBe('Modified (staged)');
  });

  it('includes the chip’s detail when git supplied one', () => {
    const described = changeDescription({ path: 'b.ts', status: 'R', from: 'a.ts' });
    expect(described.startsWith('Renamed (')).toBe(true);
  });
});

describe('the file endpoint’s refusals', () => {
  it('reports them in reading order and stays silent when nothing was refused', () => {
    expect(fileRefusal({ path: 'a', denied: true, ignored: true, binary: true })).toContain('denylist');
    expect(fileRefusal({ path: 'a', ignored: true })).toContain('gitignored');
    // A gitignored file whose content the daemon DID serve is readable.
    expect(fileRefusal({ path: 'a', ignored: true, content: 'x' })).toBeNull();
    expect(fileRefusal({ path: 'a', tooLarge: true, size: 4_194_304 })).toBe(
      'This file is 4.0 MB — over the daemon’s 1 MB view limit.',
    );
    expect(fileRefusal({ path: 'a', tooLarge: true })).toContain('too large');
    expect(fileRefusal({ path: 'a', binary: true })).toContain('binary');
    expect(fileRefusal({ path: 'a', content: 'hello' })).toBeNull();
  });
});
