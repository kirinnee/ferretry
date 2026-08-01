import '../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  ActivityLine,
  AttentionFlags,
  ContextMeter,
  LeanSessionCard,
  LeanSessionRow,
  ProjectHeading,
  SessionCard,
  SessionRow,
  SkeletonRows,
  Th,
} from '../../src/components/session-dashboard-rows.tsx';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { DaemonUsageIndex } from '../../src/lib/usage.ts';
import { render, run } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = daemonId('dashboard-daemon');
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const text = (node: ReactTestInstance): string =>
  node.children
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : text(child)))
    .join('');

const view = (id = 'session-one', overrides: Parameters<typeof sessionView>[1] = {}) =>
  sessionView(id, {
    config: {
      teammate: 'ada-lovelace',
      name: '[Ada] Ship dashboard rows',
      harness: 'claude',
      model: 'claude-test',
      remoteControl: true,
      ...overrides.config,
    },
    state: {
      activity: 'Writing tests',
      contextPercent: 42,
      lastActivityAt: '2026-08-01T11:59:48.000Z',
      ...overrides.state,
    },
    directory: overrides.directory,
  });

const fullProps = (overrides: Partial<React.ComponentProps<typeof SessionRow>> = {}) => ({
  view: view(),
  daemonId: DAEMON,
  usage: null,
  now: NOW,
  ...overrides,
});

describe('session dashboard row leaves', () => {
  it('renders headers, bounded context bands, and all six skeleton floors', () => {
    const header = render(<Th className="w-[16%]">Teammate</Th>).root.findByType('th');
    expect(header.props.scope).toBe('col');
    expect(header.props.className).toContain('w-[16%]');

    const calm = render(<ContextMeter value={12} />).root;
    const warning = render(<ContextMeter value={75} />).root;
    const error = render(<ContextMeter value={150} />).root;
    const clamped = render(<ContextMeter value={-1} />).root;
    expect([calm, warning, error, clamped].map(meter => text(meter))).toEqual(['12%', '75%', '100%', '0%']);
    expect(warning.findByProps({ className: 'kt-meter__fill bg-warn' }).props.style).toEqual({ width: '75%' });
    expect(error.findByProps({ className: 'kt-meter__fill bg-err' }).props.style).toEqual({ width: '100%' });
    expect(clamped.findByProps({ className: 'kt-meter__fill bg-ok' }).props.style).toEqual({ width: '0%' });
    expect(render(<SkeletonRows />).root.findAll(node => node.props.className?.includes('animate-pulse'))).toHaveLength(
      6,
    );
  });

  it('renders live, quiet, and declared-wait activity variants', () => {
    const live = render(<ActivityLine view={view()} />).root;
    expect(text(live)).toContain('Writing tests');
    expect(live.findByProps({ title: 'Writing tests' }).props.className).toContain('shimmer');

    const quiet = render(<ActivityLine view={view('idle', { state: { activity: undefined } })} />).root;
    expect(text(quiet)).toContain('awaiting activity');
    expect(quiet.findByProps({ title: 'awaiting activity' }).props.className).toContain('text-muted');

    const parked = render(
      <ActivityLine
        view={view('parked', { state: { waiting: { since: '2026-08-01T11:00:00.000Z', condition: 'CI' } } })}
      />,
    ).root;
    expect(text(parked)).toContain('waiting: CI');
  });

  it('keeps declared parks and human escalation distinct, with the escalation reason on title', () => {
    const flags = render(
      <AttentionFlags
        view={view('attention', {
          state: { waiting: { since: '2026-08-01T11:00:00.000Z' }, needsHuman: 'Approve production deploy' },
        })}
      />,
    ).root;
    expect(text(flags)).toContain('parkedneeds human');
    expect(flags.findByProps({ title: 'Approve production deploy' })).toBeDefined();
    expect(render(<AttentionFlags view={view()} />).toJSON()).toBeNull();
  });

  it('renders every full-table conditional and navigates through the daemon-aware route', () => {
    const usage = new DaemonUsageIndex();
    usage.apply(DAEMON, { accounts: [{ agent: 'claude', fiveHourPercent: 76 }] });
    const paths: string[] = [];
    const rendered = render(
      <SessionRow
        {...fullProps({
          usage,
          onNavigate: path => paths.push(path),
          view: view('row / one', {
            config: { label: 'primary', remoteControl: true },
            state: { remoteControlUrl: 'https://rc.invalid/one' },
          }),
        })}
      />,
    );
    const link = rendered.root.findAllByType('a').find(anchor => anchor.props.href.startsWith('/d/'));
    if (link === undefined) throw new Error('missing session route link');
    expect(link.props.href).toBe('/d/dashboard-daemon/session/row%20%2F%20one');
    run(() => link.props.onClick({ preventDefault: () => undefined, button: 0 }));
    expect(paths).toEqual(['/d/dashboard-daemon/session/row%20%2F%20one']);
    expect(text(rendered.root)).toContain('quota');
    expect(text(rendered.root)).toContain('12s');
    expect(rendered.root.findAllByType('td')).toHaveLength(6);

    const sparse = render(
      <SessionRow
        {...fullProps({
          view: view('sparse', {
            config: { harness: 'codex', model: undefined, modelHint: '' },
            state: { contextPercent: undefined },
          }),
        })}
      />,
    ).root;
    expect(text(sparse)).toContain('no context');
    expect(text(sparse)).toContain('default');
  });

  it('renders the full phone card with and without optional label, RC URL, context, and quota data', () => {
    const card = render(<SessionCard {...fullProps()} />).root;
    expect(card.findByType('a').props.href).toBe('/d/dashboard-daemon/session/session-one');
    expect(text(card)).toContain('Ada-Lovelace');
    expect(text(card)).toContain('Writing tests');

    const sparse = render(
      <SessionCard
        {...fullProps({
          view: view('card-sparse', {
            config: { label: undefined, remoteControl: false, harness: 'codex', model: undefined, modelHint: '' },
            state: { contextPercent: undefined, remoteControlUrl: undefined },
          }),
        })}
      />,
    ).root;
    expect(text(sparse)).toContain('default');
    expect(text(sparse)).not.toContain('rc');
  });

  it('uses distinct compact and minimal table DOM, retaining flags only where compact has a signals cell', () => {
    const compact = render(
      <LeanSessionRow
        daemonId={DAEMON}
        density="compact"
        view={view('compact', { state: { status: 'awaiting_user', needsHuman: 'Reply now' } })}
      />,
    ).root;
    expect(compact.findAllByType('td')).toHaveLength(3);
    expect(text(compact)).toContain('youneeds human');

    const parked = render(
      <LeanSessionRow
        daemonId={DAEMON}
        density="compact"
        view={view('parked', { state: { waiting: { since: '2026-08-01T11:00:00.000Z' } } })}
      />,
    ).root;
    expect(text(parked)).toContain('parked');
    expect(text(parked)).not.toContain('run');

    const minimal = render(<LeanSessionRow daemonId={DAEMON} density="minimal" view={view('minimal')} />).root;
    expect(minimal.findAllByType('td')).toHaveLength(2);
    expect(text(minimal)).not.toContain('run');
  });

  it('renders compact-card status and flag exceptions while minimal mounts neither', () => {
    const compact = render(
      <LeanSessionCard
        daemonId={DAEMON}
        density="compact"
        view={view('lean', { state: { needsHuman: 'Take over', status: 'running' } })}
      />,
    ).root;
    expect(text(compact)).toContain('runneeds human');

    const hoisted = render(
      <LeanSessionCard daemonId={DAEMON} density="compact" statusHoisted view={view('hoisted')} />,
    ).root;
    expect(text(hoisted)).not.toContain('run');

    const parked = render(
      <LeanSessionCard
        daemonId={DAEMON}
        density="compact"
        view={view('lean-parked', { state: { waiting: { since: '2026-08-01T11:00:00.000Z' } } })}
      />,
    ).root;
    expect(text(parked)).toContain('parked');

    const minimal = render(<LeanSessionCard daemonId={DAEMON} density="minimal" view={view('lean-minimal')} />).root;
    expect(text(minimal)).not.toContain('run');
    expect(text(minimal)).not.toContain('parked');
  });

  it('renders and activates a project heading with optional path and its exact row count', () => {
    const focused: string[] = [];
    const group = { name: 'ferretry', path: '/work/ferretry', rows: [view('one'), view('two')] };
    const heading = render(<ProjectHeading group={group} onFocus={path => focused.push(path)} />).root.findByType(
      'button',
    );
    expect(text(heading)).toContain('ferretry/work/ferretry2');
    expect(heading.props.className).toContain('min-h-[44px]');
    run(() => heading.props.onClick());
    expect(focused).toEqual(['/work/ferretry']);

    const pathless = render(<ProjectHeading group={{ ...group, path: '', rows: [] }} onFocus={() => undefined} />).root;
    expect(text(pathless)).toContain('ferretry0');
    expect(text(pathless)).not.toContain('/work/ferretry');
  });
});
