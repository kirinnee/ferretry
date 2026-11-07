import { describe, expect, it } from 'bun:test';
import { FileTree, FileTreeRows } from '../../../../app/features/files/file-tree.tsx';
import type { TreeRow } from '../../../../app/features/files/file-tree-model.ts';
import { render, run, runAsync } from '../support/react.ts';
import { type FsCall, type FsFixture, fsClient, refusal, scopeOf } from './support/fs-client.ts';

const scopeFor = (fixture: FsFixture, calls: FsCall[] = []) =>
  scopeOf(
    fsClient(() => fixture, calls),
    'tree/ferret',
  );

describe('file tree rows', () => {
  it('renders semantic list rows and makes only addressable entries interactive', () => {
    const actions: string[] = [];
    const rows: TreeRow[] = [
      { kind: 'dir', path: 'src', name: 'src', depth: 0, refusal: null, expanded: false, selected: true },
      {
        kind: 'file',
        path: 'src/a.ts',
        name: 'a.ts',
        depth: 1,
        refusal: null,
        expanded: false,
        selected: false,
        size: 1024,
      },
      {
        kind: 'file',
        path: 'bad\\name',
        name: 'bad\\name',
        depth: 0,
        refusal: 'not served',
        expanded: false,
        selected: false,
      },
      { kind: 'note', note: 'error', dir: 'src', depth: 1, error: 'offline' },
      { kind: 'note', note: 'empty', dir: 'empty', depth: 1 },
      { kind: 'note', note: 'truncated', dir: 'truncated', depth: 1 },
    ];
    const tree = render(
      <FileTreeRows
        rows={rows}
        onToggle={path => actions.push(`toggle:${path}`)}
        onEnter={path => actions.push(`enter:${path}`)}
        onOpenFile={path => actions.push(`open:${path}`)}
        onRetry={path => actions.push(`retry:${path}`)}
      />,
    ).root;
    expect(tree.findAllByType('li')).toHaveLength(6);
    expect(tree.findByProps({ 'data-inert': 'true' }).type).toBe('div');
    run(() => tree.findByProps({ 'aria-label': 'Expand src' }).props.onClick());
    run(() => tree.findByProps({ 'aria-label': 'Go to folder src' }).props.onClick());
    run(() => tree.findByProps({ 'aria-label': 'Open file src/a.ts, 1.0 KB' }).props.onClick());
    run(() => tree.findByProps({ 'aria-label': 'Retry listing src' }).props.onClick());
    expect(actions).toEqual(['toggle:src', 'enter:src', 'open:src/a.ts', 'retry:src']);
  });

  it('shows an entry that leaves the ferret root with its own icon, apart from other refusals', () => {
    const rows: TreeRow[] = [
      {
        kind: 'file',
        path: 'escape',
        name: 'escape',
        depth: 0,
        refusal: 'symlink leaves the ferret root',
        expanded: false,
        selected: false,
      },
      { kind: 'dir', path: 'vault', name: 'vault', depth: 0, refusal: 'not served', expanded: false, selected: false },
    ];
    const tree = render(
      <FileTreeRows rows={rows} onToggle={() => {}} onEnter={() => {}} onOpenFile={() => {}} onRetry={() => {}} />,
    ).root;
    const iconOf = (title: string): string =>
      String(tree.findByProps({ title }).findByType('svg').props.className).match(/lucide-[a-z0-9-]+/u)?.[0] ?? '';

    expect(iconOf('symlink leaves the ferret root')).toContain('link');
    expect(iconOf('not served')).toContain('lock');
    expect(tree.findAllByProps({ 'data-inert': 'true' })).toHaveLength(2);
  });

  it('loads, refreshes, hides and tears down a ferret-scoped listing', async () => {
    const asked: FsCall[] = [];
    const scope = scopeFor({ listings: { '': { entries: [{ name: 'a.ts', type: 'file' }] } } }, asked);
    {
      const renderer = render(<FileTree scope={scope} dir="" hidden onEnter={() => {}} onOpenFile={() => {}} />);
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findByType('nav').props.hidden).toBe(true);
      run(() =>
        renderer.update(<FileTree scope={scope} dir="src" refreshNonce={1} onEnter={() => {}} onOpenFile={() => {}} />),
      );
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every(call => call.ferretId === 'tree/ferret')).toBeTrue();
      renderer.unmount();
    }
  });

  it('renders a listing error instead of silently presenting an empty tree', async () => {
    const scope = scopeFor({ listings: { '': new TypeError('offline') } });
    {
      const renderer = render(<FileTree scope={scope} dir="" onEnter={() => {}} onOpenFile={() => {}} />);
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findAll(node => node.props.role === 'alert')).toHaveLength(1);
      renderer.unmount();
    }
  });

  it('shows the daemon’s refusal of a listing as that refusal, never as an empty tree', async () => {
    const scope = scopeFor({ listings: { '': refusal(403, 'grant_not_granted', '') } });
    const renderer = render(<FileTree scope={scope} dir="" onEnter={() => {}} onOpenFile={() => {}} />);
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('switched off the project filesystem');
    renderer.unmount();
  });
});
