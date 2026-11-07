import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { DaemonId } from '../../../app/lib/daemon-connection.ts';
import { SessionsBar } from '../../../app/shell/sessions-bar.tsx';
import type { SessionsBarArchived } from '../../../app/shell/sessions-bar-archived.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const ALPHA = 'alpha' as DaemonId;
const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 2, 9, minutes)).toISOString();

const live = sessionView('live-one', {
  config: { teammate: 'hadi', name: 'Live work', cwd: '/work/live', mode: 'interactive' },
});

/** An archived row, as the route answers it: finished, with the instants that order it. */
const archivedView = (id: string, endedAt: string) =>
  sessionView(id, {
    config: { teammate: 'ora', name: `Old work ${id}`, cwd: '/work/old', mode: 'auto' },
    state: { status: 'completed', startedAt: at(0), finishedAt: endedAt },
  });
const older = archivedView('arch-old', at(5));
const newer = archivedView('arch-new', at(30));

const archived = (overrides: Partial<SessionsBarArchived> = {}): SessionsBarArchived => ({
  count: 2,
  sessions: null,
  shown: false,
  loading: false,
  onShow: () => undefined,
  onHide: () => undefined,
  ...overrides,
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
    sessions={[live]}
    {...props}
  />
);

const footerWords = (root: Element): string | null =>
  root.querySelector('[data-sbar-archived] .fy-sbar__archived-words')?.textContent ?? null;

const archivedIds = (root: Element): (string | null)[] =>
  [...root.querySelectorAll('[data-sbar-archived] [data-sbar-session]')].map(node =>
    node.getAttribute('data-sbar-session'),
  );

const click = async (element: Element | null, what: string): Promise<void> => {
  await interact(() => (must(element, what) as HTMLElement).click());
};

describe('the archived footer in the sessions bar', () => {
  test('is absent while the count is unread, zero, or not given', async () => {
    // Arrange — `null` is both a count never read and a daemon too old to serve one.
    const cases: (Partial<BarProps> | undefined)[] = [
      undefined,
      { archived: archived({ count: null }) },
      { archived: archived({ count: 0 }) },
    ];

    // Act / Assert
    for (const props of cases) {
      view = await mount(bar(props));
      expect(view.container.querySelector('[data-sbar-archived]')).toBeNull();
      await view.unmount();
      view = null;
    }
  });

  test('says how many older finished sessions are archived, with a Show beside the words', async () => {
    // Arrange / Act
    view = await mount(bar({ archived: archived({ count: 23 }) }));

    // Assert
    expect(footerWords(view.container)).toBe('23 older finished sessions archived');
    const toggle = must(view.container.querySelector('[data-sbar-archived-toggle]'), 'the Show control');
    expect(toggle.textContent).toBe('Show');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('the control says Hide while the rows are listed, and each press is the host hook’s act', async () => {
    // Arrange
    const acts: string[] = [];

    // Act — a bar already showing the rows offers Hide; one collapsed offers Show.
    view = await mount(
      bar({ archived: archived({ shown: true, sessions: [newer], onHide: () => acts.push('hide') }) }),
    );
    const hide = must(view.container.querySelector('[data-sbar-archived-toggle]'), 'the Hide control');
    expect(hide.textContent).toBe('Hide');
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    await click(hide, 'the Hide control');
    await view.unmount();
    view = await mount(bar({ archived: archived({ onShow: () => acts.push('show') }) }));
    await click(view.container.querySelector('[data-sbar-archived-toggle]'), 'the Show control');

    // Assert
    expect(acts).toEqual(['hide', 'show']);
  });

  test('lists the archived rows newest first, and a press opens the session like any row', async () => {
    // Arrange
    const opened: string[] = [];
    view = await mount(
      bar({
        archived: archived({ shown: true, sessions: [older, newer] }),
        onNavigate: to => opened.push(to),
      }),
    );

    // Act
    const rows = archivedIds(view.container);

    // Assert
    expect(rows).toEqual(['arch-new', 'arch-old']);
    await click(
      view.container.querySelector('[data-sbar-archived] [data-sbar-session="arch-new"]'),
      'the newest archived row',
    );
    expect(opened).toEqual(['/d/alpha/session/arch-new']);
  });

  test('keeps the archived rows read-only: no pin control, and out of every filter count', async () => {
    // Arrange / Act
    view = await mount(
      bar({
        archived: archived({ shown: true, sessions: [older, newer] }),
        onTogglePin: () => undefined,
      }),
    );

    // Assert — the pin the live rows carry is absent from the archived list…
    expect(view.container.querySelector('[data-sbar-archived] [data-sbar-pin-toggle]')).toBeNull();
    // …and the segments still count the live set alone.
    const all = must(view.container.querySelector('[data-sbar-filter="all"] .fy-sbar__count'), 'the All count');
    expect(all.textContent).toBe('1');
  });

  test('waits with a sentence while the reader’s Show is still reading', async () => {
    // Arrange / Act
    view = await mount(bar({ archived: archived({ shown: true, loading: true }) }));

    // Assert
    expect(view.container.querySelector('[data-sbar-archived] [role="status"]')?.textContent).toBe(
      'Reading archived sessions…',
    );
  });

  test('is not drawn on the all-machines list, which is not one machine’s archive', async () => {
    // Arrange / Act — an all-machines list replaces the single-machine one the footer belongs to.
    view = await mount(
      bar({
        machineSources: [
          {
            daemonId: ALPHA,
            name: 'work-mac',
            slice: { sessions: [live], byId: new Map(), status: 'ready', error: null },
            projects: [],
            reach: 'online',
          },
        ],
        archived: archived({ count: 4 }),
      }),
    );

    // Assert
    expect(view.container.querySelector('[data-sbar-archived]')).toBeNull();
  });
});
