import { afterEach, describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { AgendaInboxContext } from '../../src/hooks/use-agenda-inbox.ts';
import { SessionsBarNeedsYou } from '../../src/shell/sessions-bar-needs-you.tsx';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = 'alpha' as DaemonId;
const view = sessionView('s-1', {
  config: { teammate: 'zoe', label: 'Fix the build' },
  state: { attention: { open: 2, first: 'A1', ask: 'Ship it?', latestAt: '2026-10-16T12:00:00.000Z' } },
});

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const draw = async (rows: Parameters<typeof SessionsBarNeedsYou>[0]['rows']) => {
  const cards = [inboxCard(agendaItem('A1'), view, 'Workshop', DAEMON)];
  mounted = await mount(
    <InboxHarness
      cards={cards}
      fake={fakeInbox()}
      reading={false}
      render={inbox => (
        <AgendaInboxContext.Provider value={inbox}>
          <SessionsBarNeedsYou isActive={() => false} learns={() => false} onNavigate={() => {}} rows={rows} />
        </AgendaInboxContext.Provider>
      )}
    />,
  );
  return mounted.container;
};

describe('the sidebar Needs you rows', () => {
  test('carry no Done, Dismiss, Open or Hide control: nothing on a row settles an ask', async () => {
    const root = await draw([{ daemonId: DAEMON, view }]);

    expect(root.querySelectorAll('[data-sbar-needs-you-group] button')).toHaveLength(0);
    expect(root.textContent).not.toContain('Done');
    expect(root.textContent).not.toContain('Dismiss');
    expect(root.textContent).not.toContain('asked for you');
  });

  test('open the conversation at its first open item', async () => {
    const root = await draw([{ daemonId: DAEMON, view }]);

    const link = must(root.querySelector<HTMLAnchorElement>('[data-sbar-needs-you-group] a'), 'row link');
    expect(link.getAttribute('href')).toContain('agenda=A1');
  });

  test('count the rows in the heading, and draw nothing when there are none', async () => {
    const other = sessionView('s-2', {
      state: { attention: { open: 1, first: 'A4', ask: 'Rotate it?', latestAt: '2026-10-16T13:00:00.000Z' } },
    });
    const root = await draw([
      { daemonId: DAEMON, view },
      { daemonId: DAEMON, view: other, machine: 'studio' },
    ]);
    expect(must(root.querySelector('.fy-sbar__count'), 'count').textContent).toBe('2');
    await mounted?.unmount();

    const empty = await draw([]);
    expect(empty.querySelector('[data-sbar-needs-you-group]')).toBeNull();
  });
});
