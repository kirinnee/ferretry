import { describe, expect, test } from 'bun:test';
import { sessionsBarView } from '../../src/shell/sessions-bar-model.ts';
import {
  containsSession,
  rollupWords,
  sessionTree,
  subFerretCount,
  type TreeEntry,
} from '../../src/shell/sessions-bar-tree.ts';
import { sessionView } from '../support/sessions.ts';

const lead = sessionView('lead', { config: { teammate: 'hadi', label: 'Lead the pack' } });
const a = sessionView('a', { config: { parent: 'lead' } });
const b = sessionView('b', {
  config: { parent: 'lead' },
  state: {
    status: 'awaiting_user',
    attention: { open: 1, first: 'A1', ask: 'Ask?', latestAt: '2026-07-31T12:00:00.000Z' },
  },
});
const old = sessionView('old', { config: { parent: 'lead' }, state: { status: 'completed' } });
const deep = sessionView('deep', { config: { parent: 'a' } });

const ids = (entries: readonly TreeEntry[]): unknown[] =>
  entries.map(entry => [`${entry.kind}:${entry.view.config.id}`, ids(entry.children)]);

describe('sessionTree', () => {
  test('nests children under a listed parent, in the order the rows arrive', () => {
    const tree = sessionTree([a, lead, deep, b], [lead, a, b, deep]);
    expect(ids(tree)).toEqual([
      [
        'row:lead',
        [
          ['row:a', [['row:deep', []]]],
          ['row:b', []],
        ],
      ],
    ]);
    const root = tree[0] as Extract<TreeEntry, { kind: 'row' }>;
    expect(root.depth).toBe(0);
    expect(root.children[0]?.depth).toBe(1);
    expect(root.children[0]?.children[0]?.depth).toBe(2);
  });

  test('rolls up what is beneath: running, needs you and stopped, across every depth', () => {
    const [root] = sessionTree([lead, a, b, old, deep], [lead, a, b, old, deep]);
    expect(root?.rollup).toEqual({ total: 4, running: 2, needsYou: 1, stopped: 1 });
    expect(rollupWords(root?.rollup as never)).toBe('1 needs you · 2 running · 1 stopped');
  });

  test('a childless row rolls up to nothing and says nothing', () => {
    const [only] = sessionTree([lead], [lead]);
    expect(only?.rollup.total).toBe(0);
    expect(rollupWords(only?.rollup as never)).toBe('');
  });

  test('a child whose parent is not listed hangs under one faint stub that names the parent', () => {
    const tree = sessionTree([a, b], [lead, a, b]);
    expect(ids(tree)).toEqual([
      [
        'stub:lead',
        [
          ['row:a', []],
          ['row:b', []],
        ],
      ],
    ]);
    const stub = tree[0] as Extract<TreeEntry, { kind: 'stub' }>;
    expect(stub.id).toBe('lead');
    expect(stub.label).toBe('Hadi · Session lead');
    expect(stub.rollup.total).toBe(2);
  });

  test('a missing parent, a self-parent and a cycle are roots, never lost or looping', () => {
    const orphan = sessionView('orphan', { config: { parent: 'ghost' } });
    const self = sessionView('self', { config: { parent: 'self' } });
    const x = sessionView('x', { config: { parent: 'y' } });
    const y = sessionView('y', { config: { parent: 'x' } });
    const tree = sessionTree([orphan, self, x, y], [orphan, self, x, y]);
    expect(ids(tree)).toEqual([
      ['row:orphan', []],
      ['row:self', []],
      ['row:x', []],
      ['row:y', []],
    ]);
  });
});

describe('tree words', () => {
  test('counts sub-ferrets in the singular and the plural', () => {
    expect(subFerretCount(1)).toBe('1 sub-ferret');
    expect(subFerretCount(3)).toBe('3 sub-ferrets');
  });

  test('finds the open session at any depth, never in a stub, and never when none is open', () => {
    const [root] = sessionTree([lead, a, deep], [lead, a, deep]) as [TreeEntry];
    expect(containsSession(root, 'deep')).toBe(true);
    expect(containsSession(root, 'elsewhere')).toBe(false);
    expect(containsSession(root, null)).toBe(false);
    const [stub] = sessionTree([a], [lead, a]) as [TreeEntry];
    expect(containsSession(stub, 'lead')).toBe(false);
    expect(containsSession(stub, 'a')).toBe(true);
  });
});

describe('a real Pack start', () => {
  // What `fy new` records (packages/daemon/src/lib/pack/service.ts): the asking ferret as `parent`, the
  // parent's own folder, an unattended mode and no board, on the runtime's wrapper.
  const cwd = '/home/kirin/Workspace/personal/ferretry';
  const parent = sessionView('mvlead-0001', {
    config: { teammate: 'fernanda', mode: 'interactive', cwd, agent: 'claude-interactive-work' },
    state: { lastActivityAt: '2026-10-20T00:10:00.000Z' },
  });
  const packChild = (id: string, teammate: string, at: string) =>
    sessionView(id, {
      config: {
        teammate,
        parent: 'mvlead-0001',
        mode: 'auto',
        cwd,
        agent: 'claude-auto-work',
        model: 'claude-opus-5-5',
        name: 'Review packages/daemon/src/lib/pack for races',
      },
      state: { lastActivityAt: at },
    });
  const nadia = packChild('mvq1k2-7f3a', 'nadia', '2026-10-20T00:20:00.000Z');
  const tomi = packChild('mvq1k2-8b4c', 'tomi', '2026-10-20T00:05:00.000Z');

  test('nests its sub-ferrets under it in the sessions bar, under the default filter', () => {
    const sessions = [nadia, parent, tomi];
    const { groups } = sessionsBarView(sessions, [{ name: 'ferretry', path: cwd }], {
      mode: 'all',
      showStopped: false,
    });
    expect(groups.map(group => group.name)).toEqual(['ferretry']);
    const tree = sessionTree(groups[0]?.rows ?? [], sessions);
    expect(ids(tree)).toEqual([
      [
        'row:mvlead-0001',
        [
          ['row:mvq1k2-7f3a', []],
          ['row:mvq1k2-8b4c', []],
        ],
      ],
    ]);
    expect(rollupWords(tree[0]?.rollup as never)).toBe('2 running');
  });

  test('listing only unattended ferrets keeps them under a stub that names the interactive parent', () => {
    const sessions = [parent, nadia, tomi];
    const { groups } = sessionsBarView(sessions, [], { mode: 'auto', showStopped: false });
    const tree = sessionTree(groups[0]?.rows ?? [], sessions);
    expect(ids(tree)).toEqual([
      [
        'stub:mvlead-0001',
        [
          ['row:mvq1k2-7f3a', []],
          ['row:mvq1k2-8b4c', []],
        ],
      ],
    ]);
  });
});
