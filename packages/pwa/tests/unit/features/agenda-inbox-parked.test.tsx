import { describe, expect, it } from 'bun:test';
import type { AgendaId } from '@ferretry/protocol';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { agendaConversationPath, type InboxCard } from '../../../src/lib/agenda-inbox.ts';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import {
  agendaItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/agenda-inbox.tsx';
import { interact, mount, must } from '../../support/dom.ts';
import { typeInto } from '../../support/learning-dom.ts';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const LATER = '2026-08-02T09:00:00.000Z';
const SOONER = '2026-08-01T15:00:00.000Z';

const open = inboxCard(agendaItem('A1', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait') }));
const snoozed = (id: string, until: string): InboxCard =>
  inboxCard(
    agendaItem(id, {
      subject: `Waiting for approval ${id}`,
      parked: { reason: 'snoozed', at: '2026-08-01T11:00:00.000Z', until },
    }),
    sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
  );
const replied = (id: string): InboxCard =>
  inboxCard(
    agendaItem(id, { subject: `Sent my answer ${id}`, parked: { reason: 'replied', at: '2026-08-01T11:02:00.000Z' } }),
    sessionView('sess-3', { config: { teammate: 'moe', name: 'Tidy up' } }),
  );

const mountPage = async (
  extra: { parked?: readonly InboxCard[]; resolvedReading?: boolean } = {},
  navigated: string[] = [],
  fake: FakeInbox = fakeInbox(),
  initialOpen?: string,
) => {
  const loads = { count: 0 };
  const view = await mount(
    <InboxHarness
      cards={[open]}
      fake={fake}
      loadResolved={() => {
        loads.count += 1;
      }}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={inbox}
          now={NOW}
          onNavigate={to => navigated.push(to)}
          phone={false}
          {...(initialOpen === undefined ? {} : { initialOpen })}
        />
      )}
      {...extra}
    />,
  );
  const option = (which: string) =>
    must(view.container.querySelector<HTMLButtonElement>(`[data-agenda-filter-option="${which}"]`), which);
  const choose = (which: string) => interact(() => option(which).click());
  const rowIds = (): string[] =>
    [...view.container.querySelectorAll('[data-agenda-parked]')].map(
      row => row.textContent?.match(/!(A\d+)/u)?.[1] ?? '',
    );
  return { view, fake, option, choose, rowIds, loads, navigated };
};

describe('AgendaInboxPage Snoozed and Replied filters', () => {
  it('says how many are snoozed and how many replied, and keeps them off the open list', async () => {
    const { view, option } = await mountPage({ parked: [snoozed('A2', LATER), snoozed('A3', SOONER), replied('A4')] });
    expect(option('snoozed').textContent).toBe('Snoozed (2)');
    expect(option('replied').textContent).toBe('Replied (1)');
    expect(option('open').textContent).toBe('Open');
    expect(option('resolved').textContent).toBe('Resolved');
    expect(view.container.querySelectorAll('[data-agenda-row]')).toHaveLength(1);
    expect(view.container.querySelector('[data-agenda-parked-pane]')).toBeNull();
    await view.unmount();
  });

  it('shows Snoozed, reading the boards, the one that wakes soonest first, each with where it stands', async () => {
    const { view, option, choose, rowIds, loads } = await mountPage({
      parked: [snoozed('A2', LATER), snoozed('A3', SOONER), replied('A4')],
    });
    await choose('snoozed');
    expect(loads.count).toBe(1);
    expect(option('snoozed').getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelector('[data-agenda-parked-pane="snoozed"]')).not.toBeNull();
    expect(rowIds()).toEqual(['A3', 'A2']);
    const status = view.container.querySelector('[data-agenda-parked-status]')?.textContent ?? '';
    expect(status).toStartWith('Snoozed until');
    expect(view.container.querySelector('.fy-parked-row')?.textContent).toContain('Kai');
    const buttons = [...view.container.querySelectorAll<HTMLElement>('[data-agenda-unsnooze]')];
    expect(buttons.map(button => [button.getAttribute('data-agenda-unsnooze'), button.textContent])).toEqual([
      ['snoozed', 'Unsnooze'],
      ['snoozed', 'Unsnooze'],
    ]);
    await choose('open');
    expect(view.container.querySelector('[data-agenda-parked-pane]')).toBeNull();
    await view.unmount();
  });

  it('shows Replied with who it waits on and a Back to my list button', async () => {
    const { view, choose, loads } = await mountPage({ parked: [snoozed('A2', LATER), replied('A4')] });
    await choose('replied');
    expect(loads.count).toBe(1);
    expect(view.container.querySelector('[data-agenda-parked-status]')?.textContent).toMatch(
      /^Replied .* — waiting on Moe$/u,
    );
    const back = must(
      view.container.querySelector<HTMLButtonElement>('[data-agenda-unsnooze="replied"]'),
      'Back to my list',
    );
    expect(back.textContent).toBe('Back to my list');
    expect(view.container.querySelector('.fy-parked-row')?.textContent?.match(/Moe/gu)).toHaveLength(1);
    await view.unmount();
  });

  it('puts an item back on the list: it leaves at once and says so while Undo is open', async () => {
    const fake = fakeInbox();
    const { view, choose, rowIds } = await mountPage(
      { parked: [snoozed('A2', LATER), snoozed('A3', SOONER)] },
      [],
      fake,
    );
    await choose('snoozed');
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-agenda-unsnooze]'), 'Unsnooze').click(),
    );
    expect(rowIds()).toEqual(['A2']);
    expect(must(view.container.querySelector('[data-agenda-undo]'), 'toast').textContent).toContain(
      '!A3 is back on your list',
    );
    await interact(() => fake.clock.advance(6_000));
    await interact(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.commits.map(commit => [commit.card.item.id, commit.action.kind])).toEqual([['A3', 'unsnooze']]);
    await view.unmount();
  });

  it('opens the conversation at the item from a row', async () => {
    const navigated: string[] = [];
    const { view, choose } = await mountPage({ parked: [replied('A4')] }, navigated);
    await choose('replied');
    await interact(() => must(view.container.querySelector<HTMLElement>('.fy-parked-row__link'), 'row link').click());
    expect(navigated).toHaveLength(1);
    expect(navigated[0]).toContain('A4');
    await view.unmount();
  });

  it('opens a parked item on ANOTHER machine through that machine — the chat that opens its card (#B76)', async () => {
    const navigated: string[] = [];
    const elsewhere = inboxCard(
      agendaItem('A89', { subject: 'Update the MBP', parked: { reason: 'replied', at: '2026-08-01T11:02:00.000Z' } }),
      sessionView('lead-1', { config: { teammate: 'liz', name: 'Lead' } }),
      'Liftoff MBP',
      'mbp' as DaemonId,
    );
    const { view, choose } = await mountPage({ parked: [elsewhere] }, navigated);
    await choose('replied');
    await interact(() => must(view.container.querySelector<HTMLElement>('.fy-parked-row__link'), 'row link').click());
    expect(navigated).toEqual([agendaConversationPath('mbp' as DaemonId, 'lead-1', 'A89' as AgendaId)]);
    await view.unmount();
  });

  it('says nothing is snoozed, and nothing is waiting after a reply', async () => {
    const { view, choose } = await mountPage();
    await choose('snoozed');
    expect(view.container.querySelector('[data-agenda-parked-empty="snoozed"]')?.textContent).toBe(
      'Nothing is snoozed.',
    );
    await choose('replied');
    expect(view.container.querySelector('[data-agenda-parked-empty="replied"]')?.textContent).toBe(
      'Nothing is waiting on a ferret after your reply.',
    );
    await view.unmount();
  });

  it('says it is reading while the boards are still being read', async () => {
    const { view, choose } = await mountPage({ resolvedReading: true });
    await choose('snoozed');
    expect(view.container.textContent).toContain('Reading agenda items');
    await view.unmount();
  });

  it('says it is still reading more beside the rows it has', async () => {
    const { view, choose } = await mountPage({ parked: [snoozed('A2', LATER)], resolvedReading: true });
    await choose('snoozed');
    expect(view.container.querySelector('.fy-attn-inbox__hint')?.textContent).toContain('reading more');
    await view.unmount();
  });

  it('says nothing matches when Find hides every row, and Show everything brings them back', async () => {
    const { view, choose, rowIds } = await mountPage({ parked: [snoozed('A2', LATER)] });
    await choose('snoozed');
    await typeInto(
      must(view.container.querySelector<HTMLInputElement>('[data-agenda-find]'), 'Find'),
      'zzz-no-such-thing',
    );
    expect(rowIds()).toEqual([]);
    expect(view.container.querySelector('[data-agenda-parked-empty]')).toBeNull();
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-agenda-no-match] button'), 'Show everything').click(),
    );
    expect(rowIds()).toEqual(['A2']);
    await view.unmount();
  });

  it('reads a parked row with no readable instant without a status guess', async () => {
    const { view, choose } = await mountPage({ parked: [snoozed('A2', 'nonsense')] });
    await choose('snoozed');
    expect(view.container.querySelector('[data-agenda-parked-status]')?.textContent).toBe('Snoozed');
    await view.unmount();
  });
});

describe('AgendaInboxPage snooze from the open item', () => {
  it('snoozes the open item from its clock menu: it leaves and the toast says until when', async () => {
    const fake = fakeInbox();
    const { view } = await mountPage({}, [], fake, open.key);
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[data-agenda-view="A1"] [data-agenda-info-toggle]'),
        'ⓘ',
      ).click(),
    );
    const clock = must(
      view.container.querySelector<HTMLButtonElement>('[data-agenda-view="A1"] [data-agenda-snooze]'),
      'the clock',
    );
    await interact(() => clock.click());
    await interact(() => must(view.container.querySelector<HTMLElement>('[role="menuitem"]'), '1 hour').click());
    expect(view.container.querySelector('[data-agenda-view="A1"]')).toBeNull();
    expect(must(view.container.querySelector('[data-agenda-undo]'), 'toast').textContent).toContain(
      'Snoozed !A1 until',
    );
    await interact(() => fake.clock.advance(6_000));
    await interact(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.commits.map(commit => commit.action.kind)).toEqual(['snooze']);
    await view.unmount();
  });
});
