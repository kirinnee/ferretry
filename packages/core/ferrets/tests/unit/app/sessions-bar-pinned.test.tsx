import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { MachineSource } from '../../../app/lib/all-machines.ts';
import type { DaemonId } from '../../../app/lib/daemon-connection.ts';
import { SessionsBar } from '../../../app/shell/sessions-bar.tsx';
import '../support/dom.ts';
import { type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const ALPHA = 'alpha' as DaemonId;
const BETA = 'beta' as DaemonId;
const pinnedAt = (minutes: number): string => new Date(Date.UTC(2026, 10, 2, 10, minutes)).toISOString();
const asking = { open: 1, first: 'A1', ask: 'Ship it?', latestAt: pinnedAt(30) };

const live = sessionView('live-pin', {
  config: { teammate: 'hadi', name: 'Live work', cwd: '/work/live', mode: 'interactive' },
  pinnedAt: pinnedAt(5),
});
const finished = sessionView('done-pin', {
  config: { teammate: 'ora', name: 'Finished work', cwd: '/work/done', mode: 'interactive' },
  state: { status: 'completed' },
  pinnedAt: pinnedAt(1),
});
const waiting = sessionView('waiting', {
  config: { teammate: 'sam', name: 'Needs work', cwd: '/work/wait', mode: 'interactive' },
  state: { agenda: asking as never },
});
const plain = sessionView('plain', {
  config: { teammate: 'ava', name: 'Plain work', cwd: '/work/plain', mode: 'interactive' },
});
const hiddenDone = sessionView('hidden-done', {
  config: { name: 'Old work', cwd: '/work/old', mode: 'interactive' },
  state: { status: 'completed' },
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

type BarProps = ComponentProps<typeof SessionsBar>;

const bar = (props: Partial<BarProps> = {}) => (
  <SessionsBar
    active={null}
    activeSessionId={null}
    daemonId={ALPHA}
    initialMode="all"
    machineName="work-mac"
    machines={[{ daemonId: ALPHA, name: 'work-mac' }]}
    onAddMachine={() => undefined}
    onCollapse={() => undefined}
    onNavigate={() => undefined}
    onOpenPalette={() => undefined}
    presentation="column"
    projects={[]}
    sessions={[plain, waiting, live, finished, hiddenDone]}
    {...props}
  />
);

const ids = (root: Element): (string | null)[] =>
  [...root.querySelectorAll('[data-sbar-session]')].map(node => node.getAttribute('data-sbar-session'));

const source = (daemonId: DaemonId, name: string, sessions: (typeof live)[]): MachineSource => ({
  daemonId,
  name,
  slice: { sessions, byId: new Map(), status: 'ready', error: null },
  projects: [],
  reach: 'online',
});

describe('the Pinned group in the sessions bar', () => {
  test('sits above Needs you, lists pins oldest first, and shows each ferret only once', async () => {
    view = await mount(bar());
    const groups = [...view.container.querySelectorAll('section.fy-sbar__group')].map(node =>
      node.getAttribute('aria-label'),
    );
    expect(groups.slice(0, 2)).toEqual(['Pinned', 'Needs you']);
    const pinned = must(view.container.querySelector('[data-sbar-pinned-group]'), 'the Pinned group');
    expect(ids(pinned)).toEqual(['done-pin', 'live-pin']);
    expect(ids(view.container).sort()).toEqual(['done-pin', 'live-pin', 'plain', 'waiting']);
  });

  test('keeps a finished pinned ferret listed, marked so it reads dimmed', async () => {
    view = await mount(bar());
    const row = must(view.container.querySelector('[data-sbar-session="done-pin"]'), 'the finished row');
    expect(row.hasAttribute('data-sbar-stopped')).toBe(true);
    expect(row.hasAttribute('data-sbar-pinned')).toBe(true);
    expect(view.container.querySelector('[data-sbar-session="hidden-done"]')).toBeNull();
  });

  test('is hidden when nothing is pinned', async () => {
    view = await mount(bar({ sessions: [plain, waiting] }));
    expect(view.container.querySelector('[data-sbar-pinned-group]')).toBeNull();
  });

  test('follows the kind filter', async () => {
    view = await mount(bar({ initialMode: 'auto' }));
    expect(view.container.querySelector('[data-sbar-pinned-group]')).toBeNull();
  });

  test('spans machines, naming each ferret’s machine', async () => {
    view = await mount(
      bar({
        machineSources: [source(ALPHA, 'work-mac', [live, plain]), source(BETA, 'kirin-box', [finished])],
      }),
    );
    const pinned = must(view.container.querySelector('[data-sbar-pinned-group]'), 'the Pinned group');
    expect(ids(pinned)).toEqual(['done-pin', 'live-pin']);
    expect([...pinned.querySelectorAll('[data-machine-chip]')].map(chip => chip.textContent)).toEqual([
      'kirin-box',
      'work-mac',
    ]);
  });

  test('leads the collapsed rail', async () => {
    view = await mount(bar({ presentation: 'rail' }));
    expect(ids(view.container)).toEqual([]);
    const dots = [...view.container.querySelectorAll('.fy-sbar__dot')].map(dot => dot.getAttribute('aria-label') ?? '');
    expect(dots.slice(0, 2).map(label => label.split(' — ')[0])).toEqual(['Finished work', 'Live work']);
  });

  test('says what moved when a machine’s ferrets are all pinned or waiting', async () => {
    view = await mount(
      bar({
        machineSources: [
          source(ALPHA, 'work-mac', [plain]),
          source(BETA, 'kirin-box', [finished]),
          source('gamma' as DaemonId, 'third-box', [
            sessionView('gamma-pin', {
              config: { teammate: 'gus', name: 'Gamma pin', cwd: '/work/g', mode: 'interactive' },
              pinnedAt: pinnedAt(9),
            }),
            sessionView('gamma-ask', {
              config: { teammate: 'gil', name: 'Gamma ask', cwd: '/work/g', mode: 'interactive' },
              state: { agenda: asking as never },
            }),
          ]),
        ],
      }),
    );
    const empty = (id: string): string | undefined =>
      view?.container.querySelector(`[data-sbar-machine-group="${id}"] .fy-sbar__empty`)?.textContent ?? undefined;
    expect([empty('beta'), empty('gamma')]).toEqual([
      'Everything here is pinned.',
      'Everything here is pinned or in Needs you.',
    ]);
  });

  test('leads the collapsed rail across machines', async () => {
    view = await mount(
      bar({
        presentation: 'rail',
        machineSources: [source(ALPHA, 'work-mac', [plain, live]), source(BETA, 'kirin-box', [finished])],
      }),
    );
    const dots = [...view.container.querySelectorAll('.fy-sbar__dot')].map(dot => dot.getAttribute('aria-label') ?? '');
    expect(dots.slice(0, 2).map(label => label.split(' — ')[0])).toEqual([
      'Finished work on kirin-box',
      'Live work on work-mac',
    ]);
  });
});
