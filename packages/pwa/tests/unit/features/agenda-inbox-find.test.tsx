import { afterEach, describe, expect, it } from 'bun:test';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { InboxCard, InboxResolved } from '../../../src/lib/agenda-inbox.ts';
import { findRows, isFinding } from '../../../src/lib/agenda-inbox-find.ts';
import { NO_FILTER } from '../../../src/lib/agenda-inbox-list.ts';
import { splitSnoozed, toTestCards } from '../../../src/lib/to-test-inbox.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { chooseFromMenu, openFind } from '../../support/inbox-menus.ts';
import { sessionView } from '../../support/sessions.ts';
import { boardModelOf, card, flush } from '../board-support.ts';
import { fill } from './board-detail-support.tsx';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const UNTIL = '2026-08-02T09:00:00.000Z';

const open = inboxCard(agendaItem('A1', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait') }));
const parked = (id: string, subject: string, park: Record<string, string>): InboxCard =>
  inboxCard(
    agendaItem(id, { subject, parked: { at: '2026-08-01T11:00:00.000Z', ...park } } as never),
    sessionView(`sess-${id}`, { config: { teammate: 'kai', name: 'Release train' } }),
  );
const snoozed = parked('A2', 'Rebase the relay branch later', { reason: 'snoozed', until: UNTIL });
const replied = parked('A3', 'Relay answer sent', { reason: 'replied' });
const resolved = {
  key: 'resolved-A4',
  daemonId: open.daemonId,
  machineName: open.machineName,
  view: sessionView('sess-A4', { config: { teammate: 'moe', name: 'Tidy up' } }),
  record: { ...agendaItem('A4', { subject: 'Rebase done in the relay repo' }), resolvedAt: '2026-08-01T00:00:00.000Z' },
} as unknown as InboxResolved;

const toTestRows = async () =>
  toTestCards(
    await boardModelOf([
      card('F22', { laneId: 'tested', title: 'Relay card to try' }),
      card('F25', {
        laneId: 'tested',
        title: 'Relay card parked',
        snoozed: { until: '2026-08-02T16:00:00.000Z', laneId: 'tested' },
      }),
    ]),
  );

const sources = async () => {
  const rows = await toTestRows();
  const split = splitSnoozed(rows, NOW);
  return {
    cards: [open],
    withFerret: [],
    parked: [snoozed, replied],
    resolved: [resolved],
    toTest: split.awake,
    toTestSnoozed: split.snoozed,
  };
};

describe('isFinding', () => {
  it('is a search only once words are typed', () => {
    expect(isFinding('')).toBe(false);
    expect(isFinding('   ')).toBe(false);
    expect(isFinding(' relay ')).toBe(true);
  });
});

describe('findRows', () => {
  it('looks in every tab and gives each row the state it is in', async () => {
    const rows = findRows(await sources(), { ...NO_FILTER, query: 'relay' }, false, NOW);
    expect(rows.map(row => [row.key.includes('A2') ? 'A2' : row.chip.tone, row.chip.label])).toEqual(
      expect.arrayContaining([['A2', expect.stringMatching(/^Snoozed until /u)]]),
    );
    expect(rows.map(row => row.chip.tone).sort()).toEqual(['card', 'replied', 'resolved', 'snoozed', 'snoozed']);
    expect(rows.find(row => row.chip.tone === 'replied')?.chip.label).toBe('Replied');
    expect(rows.find(row => row.chip.tone === 'resolved')?.chip.label).toBe('Resolved');
  });

  it('puts the open items first, and the resolved last', async () => {
    const rows = findRows(await sources(), { ...NO_FILTER, query: 'rebase' }, false, NOW);
    expect(rows.map(row => row.chip.tone)).toEqual(['open', 'snoozed', 'resolved']);
  });

  it('leaves out a card to test when only the agenda was asked about', async () => {
    const rows = findRows(await sources(), { ...NO_FILTER, query: 'relay' }, true, NOW);
    expect(rows.some(row => row.kind === 'card')).toBe(false);
  });

  it('finds nothing for words that match nothing', async () => {
    expect(findRows(await sources(), { ...NO_FILTER, query: 'zebra' }, false, NOW)).toEqual([]);
  });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const mountPage = async () => {
  const fake = fakeInbox();
  const all = await sources();
  const navigated: string[] = [];
  const loads = { count: 0 };
  view = await mount(
    <InboxHarness
      cards={[open]}
      fake={fake}
      loadResolved={() => {
        loads.count += 1;
      }}
      parked={[snoozed, replied]}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={inbox}
          now={NOW}
          onNavigate={to => navigated.push(to)}
          phone={false}
          reducedMotion
        />
      )}
      resolved={[resolved]}
      toTest={all.toTest}
      toTestSnoozed={all.toTestSnoozed}
    />,
  );
  await interact(() => flush());
  return { root: view.container, navigated, loads };
};

const results = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-find-row]')].map(row => ({
    text: row.textContent ?? '',
    chip: row.querySelector('[data-find-chip]')?.getAttribute('data-find-chip'),
    label: row.querySelector('[data-find-chip]')?.textContent,
  }));

describe('Inbox Find across every tab', () => {
  it('keeps the Open list exactly as it was until words are typed', async () => {
    const { root } = await mountPage();
    await openFind(root);
    expect(root.querySelector('[data-inbox-find]')).toBeNull();
    expect(root.querySelectorAll('[data-agenda-row]')).toHaveLength(1);
  });

  it('lists a snoozed and a replied item beside open ones, each with its chip, from the Open tab', async () => {
    const { root, loads } = await mountPage();
    const find = await openFind(root);
    await fill(find, 'relay');
    const rows = results(root);
    expect(rows.map(row => row.chip).sort()).toEqual(['card', 'replied', 'resolved', 'snoozed', 'snoozed']);
    expect(rows.find(row => row.chip === 'snoozed' && row.text.includes('!A2'))?.label).toStartWith('Snoozed until');
    expect(rows.find(row => row.chip === 'replied')?.label).toBe('Replied');
    expect(root.querySelector('[data-agenda-parked-pane]')).toBeNull();
    expect(loads.count).toBeGreaterThan(0);
  });

  it('searches every tab whichever one is showing, and returns to that tab when cleared', async () => {
    const { root } = await mountPage();
    await chooseFromMenu(root, 'filter', 'resolved');
    const find = await openFind(root);
    await fill(find, 'rebase');
    expect(results(root).map(row => row.chip)).toEqual(['open', 'snoozed', 'resolved']);
    await fill(find, '');
    expect(root.querySelector('[data-inbox-find]')).toBeNull();
    expect(root.querySelector('[data-agenda-resolved-pane], [data-agenda-resolved]')).not.toBeNull();
  });

  it('says so, and offers the way back, when nothing in any tab matches', async () => {
    const { root } = await mountPage();
    const find = await openFind(root);
    await fill(find, 'zebra');
    expect(root.querySelector('[data-inbox-find="empty"]')?.textContent).toContain('Nothing matches.');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-attn-inbox__clear'), 'the clear button').click(),
    );
    expect(root.querySelector('[data-inbox-find]')).toBeNull();
  });

  it('opens a parked item in its conversation', async () => {
    const { root, navigated } = await mountPage();
    const find = await openFind(root);
    await fill(find, 'relay answer');
    const link = must(root.querySelector<HTMLAnchorElement>('[data-find-row] a'), 'the result link');
    await interact(() => link.click());
    expect(navigated).toHaveLength(1);
    expect(navigated[0]).toContain('A3');
  });
});
