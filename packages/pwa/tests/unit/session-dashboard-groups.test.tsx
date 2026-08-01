import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  FullDensityGroups,
  LeanDensityGroups,
  LeanGroupPanel,
} from '../../src/components/session-dashboard-groups.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { SessionGroup } from '../../src/lib/fleet-grouping.ts';
import { render, run } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const daemonId = daemonConnection({
  daemonId: 'dashboard-daemon',
  baseUrl: 'https://dashboard.invalid',
  deviceToken: 'dashboard-token',
}).daemonId;
const now = Date.parse('2026-08-01T12:00:00.000Z');

const view = (id: string, status: SessionView['state']['status'] = 'running'): SessionView =>
  sessionView(id, {
    config: { teammate: id, name: `Task ${id}`, harness: 'codex', modelHint: 'gpt-5.6-terra' },
    state: { status, lastActivityAt: '2026-08-01T11:59:00.000Z' },
  });

const group = (name: string, rows: readonly SessionView[], path = `/work/${name}`): SessionGroup => ({
  name,
  path,
  rows,
});

const text = (node: ReactTestInstance): string =>
  node.children
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : text(child)))
    .join('');

describe('session dashboard groups', () => {
  it('renders the full six-column fixed table and wires its folder heading', () => {
    const focused: string[] = [];
    const rows = [view('zelda'), view('fable', 'completed')];
    const tree = render(
      <FullDensityGroups
        daemonId={daemonId}
        groups={[group('ferretry', rows)]}
        mode="table"
        now={now}
        onFocus={path => focused.push(path)}
        scoped={false}
        usage={null}
      />,
    );

    const table = tree.root.findByType('table');
    expect(table.props.className).toContain('table-fixed');
    expect(table.props.className).toContain('min-w-[900px]');
    expect(table.parent?.props.className).toContain('overflow-x-auto');
    expect(tree.root.findAllByType('th').map(header => text(header))).toEqual([
      'Teammate',
      'Task',
      'Status',
      'Runtime',
      'Activity',
      'Signals',
    ]);
    expect(tree.root.findAllByType('th').map(header => header.props.className)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('w-[16%]'),
        expect.stringContaining('w-[24%]'),
        expect.stringContaining('w-[13%]'),
      ]),
    );
    expect(tree.root.findAllByType('tr')).toHaveLength(3);
    run(() => tree.root.findByProps({ 'aria-label': 'Focus folder ferretry' }).props.onClick());
    expect(focused).toEqual(['/work/ferretry']);
  });

  it('renders full cards without a repeated heading while scoped', () => {
    const tree = render(
      <FullDensityGroups
        daemonId={daemonId}
        groups={[group('ferretry', [view('zelda')])]}
        mode="cards"
        now={now}
        onFocus={() => undefined}
        scoped
        usage={null}
      />,
    );

    expect(tree.root.findAllByProps({ 'aria-label': 'Focus folder ferretry' })).toHaveLength(0);
    expect(tree.root.findAllByType('table')).toHaveLength(0);
    expect(tree.root.findByProps({ href: '/d/dashboard-daemon/session/zelda' })).toBeDefined();
  });

  it('uses the compact and minimal fixed-width table projections', () => {
    const compact = render(
      <LeanDensityGroups
        daemonId={daemonId}
        density="compact"
        groups={[group('ferretry', [view('zelda')])]}
        mode="table"
        onFocus={() => undefined}
        scoped={false}
      />,
    );
    expect(compact.root.findAllByType('th').map(header => text(header))).toEqual(['Teammate', 'Task', 'Status']);
    expect(
      compact.root
        .findAllByType('th')
        .map(header => header.props.className)
        .join(' '),
    ).toContain('w-[44%]');

    run(() =>
      compact.update(
        <LeanDensityGroups
          daemonId={daemonId}
          density="minimal"
          groups={[group('ferretry', [view('zelda')])]}
          mode="table"
          onFocus={() => undefined}
          scoped
        />,
      ),
    );
    expect(compact.root.findAllByType('th').map(header => text(header))).toEqual(['Teammate', 'Task']);
    expect(
      compact.root
        .findAllByType('th')
        .map(header => header.props.className)
        .join(' '),
    ).toContain('w-[62%]');
    expect(compact.root.findAllByProps({ 'aria-label': 'Focus folder ferretry' })).toHaveLength(0);
  });

  it('hoists a strict compact-card majority and preserves the exception pill', () => {
    const tree = render(
      <LeanDensityGroups
        daemonId={daemonId}
        density="compact"
        groups={[group('ferretry', [view('a'), view('b'), view('c', 'failed')])]}
        mode="cards"
        onFocus={() => undefined}
        scoped={false}
      />,
    );
    const panel = tree.root.findByType(LeanGroupPanel);
    expect(panel.props.hue).toMatch(/^var\(--tool-/);
    expect(JSON.stringify(tree.toJSON())).toContain('2× run');
    expect(JSON.stringify(tree.toJSON())).toContain('failed');
    expect(tree.root.findByProps({ 'aria-label': 'Focus folder ferretry' }).props.className).toContain('min-h-[44px]');
  });

  it('suppresses the panel header and status hoist in scoped minimal cards', () => {
    const tree = render(
      <LeanGroupPanel
        daemonId={daemonId}
        density="minimal"
        group={group('fallback', [view('solo')], '')}
        hue="var(--tool-read)"
        onFocus={() => undefined}
        scoped
      />,
    );
    expect(tree.root.findAllByType('button')).toHaveLength(0);
    expect(tree.root.findAll(node => node.props['data-tone'] !== undefined)).toHaveLength(0);
    expect(tree.root.findByType('section').props.style).toEqual({
      borderLeftWidth: 3,
      borderLeftColor: 'var(--tool-read)',
    });
  });
});
