import { describe, expect, it } from 'bun:test';
import { FileTreeRows } from '../../src/components/file-tree.tsx';
import type { TreeRow } from '../../src/components/file-tree-model.ts';
import { render, run } from '../support/react.ts';

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
    expect(tree.findAllByType('li')).toHaveLength(4);
    expect(tree.findByProps({ 'data-inert': 'true' }).type).toBe('div');
    run(() => tree.findByProps({ 'aria-label': 'Expand src' }).props.onClick());
    run(() => tree.findByProps({ 'aria-label': 'Go to folder src' }).props.onClick());
    run(() => tree.findByProps({ 'aria-label': 'Open file src/a.ts, 1.0 KB' }).props.onClick());
    run(() => tree.findByProps({ 'aria-label': 'Retry listing src' }).props.onClick());
    expect(actions).toEqual(['toggle:src', 'enter:src', 'open:src/a.ts', 'retry:src']);
  });
});
