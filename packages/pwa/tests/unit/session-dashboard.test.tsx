import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import { SessionDashboard, type SessionDashboardProps } from '../../src/components/session-dashboard.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { SessionGroup } from '../../src/lib/fleet-grouping.ts';
import { render, run } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const connection = daemonConnection({
  daemonId: 'dashboard-daemon',
  baseUrl: 'https://dashboard.invalid',
  deviceToken: 'dashboard-token',
});
const now = Date.parse('2026-08-01T12:00:00.000Z');

const session = (id: string, status: SessionView['state']['status'] = 'running'): SessionView =>
  sessionView(id, {
    config: { teammate: id, name: `Task ${id}`, harness: 'codex', modelHint: 'gpt-5.6-terra' },
    state: { status, lastActivityAt: '2026-08-01T11:59:00.000Z' },
  });

const rows = [session('zelda'), session('fable', 'completed')];
const groups: readonly SessionGroup[] = [{ name: 'ferretry', path: '/work/ferretry', rows }];

const props = (overrides: Partial<SessionDashboardProps> = {}): SessionDashboardProps => ({
  connection,
  dashboardView: null,
  density: 'full',
  error: null,
  groups,
  narrow: false,
  now,
  onEnterScope: () => undefined,
  onExitScope: () => undefined,
  onOpenWardenReport: () => undefined,
  onSetView: () => undefined,
  scope: null,
  scopeName: '',
  scopeRecovered: false,
  sessions: rows,
  usage: null,
  wardenStatus: null,
  wardenVerdicts: [],
  ...overrides,
});

const text = (node: ReactTestInstance): string =>
  node.children
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : text(child)))
    .join('');

const clickLink = (link: ReactTestInstance): void => {
  run(() =>
    link.props.onClick({
      altKey: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => undefined,
      shiftKey: false,
    }),
  );
};

describe('SessionDashboard', () => {
  it('renders the unscoped full table, count, pull marker, and daemon-qualified navigation', () => {
    const navigated: string[] = [];
    const focused: string[] = [];
    const view = render(
      <SessionDashboard
        {...props({ onEnterScope: path => focused.push(path), onNavigate: path => navigated.push(path) })}
      />,
    );

    expect(text(view.root.findByType('h1'))).toBe('Sessions');
    expect(view.root.findByType('main').props['data-density']).toBe('full');
    expect(view.root.findByProps({ 'data-density-region': 'dashboard-scroller' }).props['data-pull-to-palette']).toBe(
      '',
    );
    expect(view.root.findAllByProps({ title: 'visible / total sessions' })).toHaveLength(2);
    expect(view.root.findByType('table').props.className).toContain('table-fixed');
    expect(view.root.findByProps({ 'aria-label': 'Sessions view' }).props.className).toContain('bg-surface');

    clickLink(view.root.findByProps({ href: '/d/dashboard-daemon/new' }));
    run(() => view.root.findByProps({ 'aria-label': 'Focus folder ferretry' }).props.onClick());
    expect(navigated).toEqual(['/d/dashboard-daemon/new']);
    expect(focused).toEqual(['/work/ferretry']);
  });

  it('switches desktop view and preserves an explicit preference on a narrow screen', () => {
    const selected: string[] = [];
    const view = render(<SessionDashboard {...props({ onSetView: mode => selected.push(mode) })} />);
    const cards = view.root.findAllByType('button').find(button => text(button).includes('cards'));
    if (cards === undefined) throw new Error('expected cards view button');
    run(() => cards.props.onClick());
    expect(selected).toEqual(['cards']);

    run(() =>
      view.update(
        <SessionDashboard
          {...props({
            dashboardView: 'table',
            narrow: true,
          })}
        />,
      ),
    );
    expect(view.root.findAllByProps({ 'aria-label': 'Sessions view' })).toHaveLength(0);
    expect(view.root.findByType('table')).toBeDefined();
  });

  it('renders scoped compact cards in one-row chrome and exits scope through the canonical route', () => {
    const events: string[] = [];
    const view = render(
      <SessionDashboard
        {...props({
          dashboardView: 'cards',
          density: 'compact',
          narrow: true,
          onExitScope: () => events.push('exit'),
          onNavigate: path => events.push(path),
          scope: '/work/ferretry',
          scopeName: 'ferretry',
        })}
      />,
    );

    expect(view.root.findByType('h1').props.title).toBe('ferretry');
    expect(JSON.stringify(view.toJSON())).toContain('2 sessions');
    expect(view.root.findAllByProps({ title: 'visible / total sessions' })).toHaveLength(0);
    expect(view.root.findAllByProps({ 'aria-label': 'Focus folder ferretry' })).toHaveLength(0);
    expect(view.root.findByProps({ children: 'All folders' }).props.className).toContain('hidden sm:inline');
    expect(view.root.findByProps({ children: 'New session' }).props.className).toContain('hidden sm:inline');
    clickLink(view.root.findByProps({ href: '/d/dashboard-daemon' }));
    expect(events).toEqual(['exit', '/d/dashboard-daemon']);
  });

  it('distinguishes loading, unscoped empty, scoped empty, recovery, and errors', () => {
    const view = render(<SessionDashboard {...props({ groups: [], sessions: null })} />);
    expect(view.root.findAll(node => node.props.className?.includes?.('animate-pulse'))).toHaveLength(6);

    run(() => view.update(<SessionDashboard {...props({ groups: [], sessions: [] })} />));
    expect(JSON.stringify(view.toJSON())).toContain('No matching sessions.');

    run(() =>
      view.update(
        <SessionDashboard
          {...props({
            error: 'daemon unavailable',
            groups: [],
            scope: '/work/missing',
            scopeName: 'missing',
            scopeRecovered: true,
            sessions: [],
          })}
        />,
      ),
    );
    expect(JSON.stringify(view.toJSON())).toContain('No sessions in this folder match the filters.');
    expect(text(view.root.findByProps({ role: 'status' }))).toContain('folder is no longer available');
    expect(text(view.root.findByProps({ role: 'alert' }))).toBe('daemon unavailable');
  });

  it('renders minimal grouped cards through the lean projection', () => {
    const view = render(
      <SessionDashboard
        {...props({
          dashboardView: 'cards',
          density: 'minimal',
        })}
      />,
    );
    expect(view.root.findByType('main').props['data-density']).toBe('minimal');
    expect(view.root.findAllByType('table')).toHaveLength(0);
    expect(view.root.findByProps({ href: '/d/dashboard-daemon/session/zelda' })).toBeDefined();
  });
});
