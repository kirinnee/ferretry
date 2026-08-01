import { describe, expect, it } from 'bun:test';
import { FileTree, FileTreeRows } from '../../src/components/file-tree.tsx';
import type { TreeRow } from '../../src/components/file-tree-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { render, run, runAsync } from '../support/react.ts';

const daemon = daemonConnection({
  daemonId: 'tree-daemon',
  baseUrl: 'https://tree.example.test',
  deviceToken: 'tree-token',
});
const scope = daemonSessionScope(daemon, 'tree/session');

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

  it('loads, refreshes, hides and tears down a daemon-scoped listing', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ entries: [{ name: 'a.ts', type: 'file' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const renderer = render(
        <FileTree daemon={daemon} scope={scope} dir="" hidden onEnter={() => {}} onOpenFile={() => {}} />,
      );
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findByType('nav').props.hidden).toBe(true);
      run(() =>
        renderer.update(
          <FileTree
            daemon={daemon}
            scope={scope}
            dir="src"
            refreshNonce={1}
            onEnter={() => {}}
            onOpenFile={() => {}}
          />,
        ),
      );
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toBeGreaterThan(0);
      renderer.unmount();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('renders a listing error instead of silently presenting an empty tree', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    try {
      const renderer = render(
        <FileTree daemon={daemon} scope={scope} dir="" onEnter={() => {}} onOpenFile={() => {}} />,
      );
      await runAsync(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findAll(node => node.props.role === 'alert')).toHaveLength(1);
      renderer.unmount();
    } finally {
      globalThis.fetch = original;
    }
  });
});
