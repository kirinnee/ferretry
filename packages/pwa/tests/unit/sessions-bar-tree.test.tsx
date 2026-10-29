import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { MachineSource } from '../../src/lib/all-machines.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = 'alpha' as DaemonId;
const recent = '2026-10-16T11:59:00.000Z';
const at = (cwd: string) => ({ cwd, teammate: undefined as never });

const LEAD = sessionView('lead', { config: { teammate: 'hadi', label: 'Lead', cwd: '/work/pack' } });
const KIDS = [
  sessionView('kid-1', { config: { ...at('/work/pack'), label: 'One', parent: 'lead' } }),
  sessionView('kid-2', {
    config: { ...at('/work/pack'), label: 'Two', parent: 'lead' },
    state: {
      status: 'awaiting_user',
      attention: { open: 1, first: 'A1', ask: 'Ask?', latestAt: '2026-07-31T12:00:00.000Z' },
    },
  }),
  sessionView('kid-3', { config: { ...at('/work/pack'), label: 'Three', parent: 'lead' } }),
];
const GRAND = sessionView('grand', { config: { ...at('/work/pack'), label: 'Deep', parent: 'kid-1' } });
const GREAT = sessionView('great', { config: { ...at('/work/pack'), label: 'Deeper', parent: 'grand' } });
const GONE = sessionView('gone', {
  config: { ...at('/work/pack'), label: 'Done', parent: 'lead' },
  state: { status: 'completed' },
});
const all = [LEAD, ...KIDS, GRAND, GREAT, GONE].map(v => ({
  ...v,
  state: { ...v.state, lastActivityAt: recent },
}));

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
    daemonId={DAEMON}
    machineName="work-mac"
    initialMode="all"
    machines={[{ daemonId: DAEMON, name: 'work-mac' }]}
    onAddMachine={() => undefined}
    onCollapse={() => undefined}
    onNavigate={() => undefined}
    onOpenPalette={() => undefined}
    presentation="column"
    projects={[]}
    groupNeedsYou={false}
    sessions={all}
    {...props}
  />
);

const click = async (node: Element | null, what: string) => interact(() => (must(node, what) as HTMLElement).click());
const q = (selector: string) => view?.container.querySelector<HTMLElement>(selector) ?? null;
const listed = () =>
  [...(view?.container.querySelectorAll('[data-sbar-session]') ?? [])].map(n => n.getAttribute('data-sbar-session'));

describe('the sessions bar as a tree', () => {
  test('nests children under their parent with a fold that says what is inside; stopped ones stay hidden', async () => {
    view = await mount(bar());
    expect(listed()).toEqual(['lead', 'kid-1', 'grand', 'great', 'kid-2', 'kid-3']);
    expect(q('[data-sbar-session="lead"]')?.closest('li')?.getAttribute('data-sbar-depth')).toBe('0');
    expect(q('[data-sbar-session="kid-1"]')?.closest('li')?.getAttribute('data-sbar-depth')).toBe('1');
    // The indent stops at the second step.
    expect(q('[data-sbar-session="great"]')?.closest('li')?.getAttribute('data-sbar-depth')).toBe('2');
    const fold = must(q('[data-sbar-fold="lead"]'), 'the lead fold');
    expect(fold.textContent).toBe('5 sub-ferrets1 needs you · 4 running');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(fold.hasAttribute('data-sbar-fold-needs-you')).toBe(true);
    expect(q('[data-sbar-fold="kid-1"]')?.textContent).toBe('2 sub-ferrets2 running');
    expect(q('[data-sbar-fold="kid-1"]')?.hasAttribute('data-sbar-fold-needs-you')).toBe(false);
    expect(q('[data-sbar-fold="kid-3"]')).toBeNull();
  });

  test('folds a branch away and back, and still says what is inside while shut', async () => {
    view = await mount(bar());
    await click(q('[data-sbar-fold="lead"]'), 'the lead fold');
    expect(listed()).toEqual(['lead']);
    expect(q('[data-sbar-fold="lead"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(q('[data-sbar-fold="lead"]')?.textContent).toContain('1 needs you');
    await click(q('[data-sbar-fold="lead"]'), 'the lead fold');
    expect(listed()).toContain('kid-2');
  });

  test('a branch holding the open session cannot be folded away', async () => {
    view = await mount(bar({ activeSessionId: 'great' }));
    await click(q('[data-sbar-fold="lead"]'), 'the lead fold');
    expect(listed()).toContain('great');
    expect(q('[data-sbar-fold="lead"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  test('Show stopped lists the stopped child in its branch and counts it in the rollup', async () => {
    view = await mount(bar());
    await click(q('[data-sbar-show-stopped]'), 'Show stopped');
    expect(listed()).toContain('gone');
    expect(q('[data-sbar-fold="lead"]')?.textContent).toContain('1 stopped');
  });

  test('a kind filter applies to children like any row, and a parent the filter hid becomes a faint stub', async () => {
    const interactive = [LEAD, ...KIDS].map(v =>
      v.config.id === 'lead' ? { ...v, config: { ...v.config, mode: 'interactive' as const } } : v,
    );
    view = await mount(bar({ sessions: interactive }));
    await click(q('[data-sbar-filter="auto"]'), 'Agents');
    expect(listed()).toEqual(['kid-1', 'kid-2', 'kid-3']);
    const stub = must(q('[data-sbar-stub="lead"]'), 'the stub');
    expect(stub.querySelector('.fy-sbar__stub-link')?.textContent).toBe('Hadi · Session lead');
    expect(q('[data-sbar-fold="lead"]')?.textContent).toBe('3 sub-ferrets1 needs you · 2 running');
    // The stub is a link to the parent that is hidden.
    await click(stub.querySelector('.fy-sbar__stub-link'), 'the stub link');
  });

  test('the group count still counts every row, children included', async () => {
    view = await mount(bar());
    expect(q('.fy-sbar__project .fy-sbar__count')?.textContent).toBe('6');
  });

  test('the all-machines list nests per machine, with folds that do not collide across machines', async () => {
    const machine = (id: string, name: string): MachineSource => ({
      daemonId: id as DaemonId,
      name,
      reach: 'online',
      projects: [],
      slice: { sessions: [LEAD, KIDS[0] as never, KIDS[2] as never], byId: new Map(), status: 'ready', error: null },
    });
    view = await mount(bar({ machineSources: [machine('alpha', 'work-mac'), machine('beta', 'kirin-box')] }));
    const folds = [...(view.container.querySelectorAll('[data-sbar-fold="lead"]') ?? [])];
    expect(folds.map(f => f.textContent)).toEqual(['2 sub-ferrets2 running', '2 sub-ferrets2 running']);
    await interact(() => (folds[1] as HTMLElement).click());
    expect(
      [...view.container.querySelectorAll('[data-sbar-fold="lead"]')].map(f => f.getAttribute('aria-expanded')),
    ).toEqual(['true', 'false']);
  });
});
