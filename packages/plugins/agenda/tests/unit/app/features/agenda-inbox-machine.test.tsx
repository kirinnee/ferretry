import { afterEach, describe, expect, mock, test } from 'bun:test';
import { callFromFetch, type TestFetch } from '../../../support/app/call-from-fetch.ts';
import { agendaListSnapshot } from '@ferretry/core-asks/contract';
import { projectionRecord, projectionSnapshot } from '../../../support/app/agenda-projection.ts';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { agendaConversationPath, type InboxCard } from '../../../../app/lib/agenda-inbox.ts';
import { daemonConnection, daemonId } from '../../../../app/shell.ts';
import { machineSessionView } from '../../../../app/lib/machine-agenda.ts';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { chooseFromMenu } from '../../../support/app/inbox-menus.ts';
import type { InboxResolved } from '../../../../app/lib/agenda-inbox.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const PAIRED = daemonConnection({ daemonId: 'studio' });

const moved = agendaItem('M1', {
  notice: true,
  subject: '3 ferrets could not be moved',
  sourceRef: 'warden:auto-move-failed',
  waitingSince: '2026-08-01T10:00:00.000Z',
} as never);
const machineView = machineSessionView({
  sessionId: 'machine-agenda',
  items: [moved],
  resolved: [],
  updatedAt: '2026-08-01T11:00:00.000Z',
} as never);

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const open = async (cards: readonly InboxCard[], initialOpen?: string, paired = false) => {
  const fake = fakeInbox();
  const navigated: string[] = [];
  view = await mount(
    <InboxHarness
      cards={cards}
      fake={fake}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={paired ? { ...inbox, connectionFor: () => PAIRED } : inbox}
          initialOpen={initialOpen}
          now={NOW}
          onNavigate={to => navigated.push(to)}
          phone={false}
          renderComposer={() => <textarea data-composer="" />}
        />
      )}
    />,
  );
  return navigated;
};

describe('the Machine group in the Inbox', () => {
  test('opens a resolved machine deep link in the Inbox when it has no chat to navigate to', async () => {
    // Arrange
    const read = mock<TestFetch>(async () => Response.json(projectionRecord()));
    try {
      const record = must(agendaListSnapshot(projectionSnapshot(0, 1)).resolved[0], 'resolved header');
      const row: InboxResolved = {
        key: 'machine:A1',
        daemonId: PAIRED.daemonId,
        machineName: 'Studio',
        view: must(machineView, 'the machine view'),
        record,
      };
      const settled: boolean[] = [];
      // Act
      view = await mount(
        <InboxHarness
          client={callFromFetch(read)}
          cards={[]}
          fake={fakeInbox()}
          resolved={[row]}
          render={inbox => (
            <AgendaInboxPage
              inbox={{ ...inbox, connectionFor: () => PAIRED }}
              onNavigate={() => {}}
              open={{ daemonId: PAIRED.daemonId, sessionId: 'machine-agenda', id: 'A1', settled: true }}
              onOpenSettled={opened => settled.push(opened)}
              phone={false}
              now={NOW}
            />
          )}
        />,
      );
      // Assert
      expect(settled).toEqual([true]);
      expect(view.container.querySelector('[data-agenda-view="A1"]')).not.toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });
  test('opens a resolved machine header from the list through its one-item read', async () => {
    // Arrange
    const read = mock<TestFetch>(async () => Response.json(projectionRecord()));
    try {
      const record = must(agendaListSnapshot(projectionSnapshot(0, 1)).resolved[0], 'resolved header');
      const row: InboxResolved = {
        key: 'machine:A1',
        daemonId: PAIRED.daemonId,
        machineName: 'Studio',
        view: must(machineView, 'the machine view'),
        record,
      };
      view = await mount(
        <InboxHarness
          client={callFromFetch(read)}
          cards={[]}
          fake={fakeInbox()}
          resolved={[row]}
          render={inbox => (
            <AgendaInboxPage
              inbox={{ ...inbox, connectionFor: () => PAIRED }}
              onNavigate={() => {}}
              phone={false}
              now={NOW}
            />
          )}
        />,
      );
      // Act
      await chooseFromMenu(view.container, 'filter', 'resolved');
      await interact(() =>
        must(view?.container.querySelector<HTMLButtonElement>('.fy-attn-panel__record-link'), 'resolved row').click(),
      );
      // Assert
      expect(read).toHaveBeenCalledTimes(1);
      expect(String(read.mock.calls[0]?.[0])).toContain('/v1/machine/agenda/A1');
      expect(view.container.querySelector('[data-agenda-view="A1"]')).not.toBeNull();
      await interact(() =>
        must(
          view?.container.querySelector<HTMLButtonElement>('button[aria-label="Back to the Inbox"]'),
          'close',
        ).click(),
      );
      expect(view.container.querySelector('[data-agenda-view="A1"]')).toBeNull();
    } finally {
      read.mockRestore();
    }
  });
  test('is a header that goes nowhere, and its item opens no conversation', async () => {
    const view0 = must(machineView, 'the machine view');
    await open([inboxCard(moved, view0)]);

    const head = must(view?.container.querySelector('[data-agenda-group-machine]'), 'the Machine header');
    expect(head.textContent).toContain('Machine');
    expect(view?.container.querySelector('[data-agenda-group-link]')).toBeNull();
    expect(view?.container.querySelector('[data-inbox-open-chat]')).toBeNull();
  });

  test('opens with no conversation link and no composer', async () => {
    const card = inboxCard(moved, must(machineView, 'the machine view'));
    await open([card], card.key);

    expect(view?.container.querySelector('[data-inbox-open-chat]')).toBeNull();
    expect(view?.container.querySelector('[data-composer]')).toBeNull();
    expect(view?.container.textContent).toContain('3 ferrets could not be moved');
  });

  test('names its machine only when several are paired', async () => {
    const view0 = must(machineView, 'the machine view');
    await open([
      inboxCard(moved, view0, 'Studio', daemonId('studio')),
      inboxCard({ ...moved, id: 'M2' }, view0, 'Laptop', daemonId('laptop')),
    ]);

    const heads = [...(view?.container.querySelectorAll('[data-agenda-group-machine]') ?? [])];
    expect(heads.map(head => head.textContent).join('|')).toMatch(/Studio.*\|.*Laptop|Laptop.*\|.*Studio/);
  });

  test('draws the group with an icon, and its notices as full rows rather than grey lines', async () => {
    // Arrange
    const view0 = must(machineView, 'the machine view');

    // Act
    await open([inboxCard(moved, view0)]);

    // Assert
    expect(view?.container.querySelector('[data-agenda-group-machine] [data-agenda-group-icon]')).not.toBeNull();
    expect(view?.container.querySelector('[data-agenda-notice]')).toBeNull();
    expect(view?.container.querySelector('.fy-inbox-row')).not.toBeNull();
  });

  test('opens the item’s detail when its row is tapped: the ferrets with their reasons and the command', async () => {
    // Arrange
    const detailed = agendaItem('M3', {
      notice: true,
      subject: '2 ferrets could not be moved',
      why: "Ferretry moves a ferret to another login when its login hits a limit. These 3 couldn't be moved.",
      context:
        'durian (s-1): No login could take it. Wait for a login to reset.\n' +
        'kai (s-2): Its login is full. A login can take it now:\n$ fy migrate s-2 -a codex-2\n' +
        'piper (s-3): Mid-turn. Wait for it to finish its turn.',
      howToResolve: 'Run the command under a ferret to move it yourself.',
      body: 'Run the command under a ferret to move it yourself.',
      sourceRef: 'warden:auto-move-failed',
      waitingSince: '2026-08-01T10:00:00.000Z',
    } as never);
    const card = inboxCard(detailed, must(machineView, 'the machine view'));
    await open([card]);

    // Act
    const row = must(view?.container.querySelector<HTMLElement>('[data-agenda-row]'), 'the row');
    await interact(() => row.click());

    // Assert
    const text = view?.container.querySelector('[data-inbox-open]')?.textContent ?? '';
    const said = [...(view?.container.querySelectorAll('[data-inbox-machine-said]') ?? [])].map(e => e.textContent);
    expect(said).toEqual([
      'No login could take it. Wait for a login to reset.',
      'Its login is full. A login can take it now:',
      'Mid-turn. Wait for it to finish its turn.',
    ]);
    const commands = [...(view?.container.querySelectorAll('[data-inbox-machine-command]') ?? [])];
    expect(commands.map(e => e.textContent)).toEqual(['fy migrate s-2 -a codex-2']);
    expect(text).not.toContain('<runtime>');
    expect(text).not.toContain('warden.yaml');
    expect(text.split('Wait for a login to reset').length).toBe(2);
    expect(text.split('Run the command under a ferret').length).toBe(1);
    expect(view?.container.querySelector('[data-agenda-section="context"]')).toBeNull();
    expect(view?.container.querySelector('[data-inbox-open-chat]')).toBeNull();
  });

  test('keeps the detail title on one line, and draws no moves for a notice that lists no ferret', async () => {
    // Arrange
    const card = inboxCard(moved, must(machineView, 'the machine view'));
    await open([card], card.key);

    // Assert
    expect(view?.container.querySelector('[data-agenda-title]')?.hasAttribute('data-wrap')).toBe(false);
    expect(view?.container.querySelector('[data-inbox-machine-moves]')).toBeNull();
  });

  test('draws an orphan notice with a row of buttons per card, keeps Got it, and says the lines once', async () => {
    // Arrange
    const line = (id: string) =>
      `&${id} Fix it is waiting in Review/CI, but no ferret is assigned, so nothing will happen to it.`;
    const orphans = agendaItem('M4', {
      notice: true,
      kind: 'info',
      subject: '2 cards have nobody working on them',
      context: `${line('B1')}\n${line('B2')}`,
      sourceRef: 'warden:orphans',
      cards: [
        { task: { id: 'B1' }, line: line('B1') },
        { task: { id: 'B2' }, line: line('B2') },
      ],
      waitingSince: '2026-08-01T10:00:00.000Z',
    } as never);
    const card = inboxCard(orphans, must(machineView, 'the machine view'));

    // Act
    await open([card], card.key, true);

    // Assert
    const text = view?.container.querySelector('[data-inbox-open]')?.textContent ?? '';
    expect(view?.container.querySelectorAll('[data-agenda-card-row]').length).toBe(2);
    expect(view?.container.querySelectorAll('[data-agenda-card-open]').length).toBe(2);
    expect(view?.container.querySelectorAll('[data-agenda-card-start]').length).toBe(2);
    expect(view?.container.querySelectorAll('[data-agenda-card-close]').length).toBe(2);
    expect(text).not.toContain('Tap Got it to dismiss this notice.');
    expect(text.split(line('B1')).length).toBe(2);
    expect(text).not.toContain('Nothing to decide');
  });

  test('says the line of a lone card once, in its row, and not again above the list', async () => {
    // Arrange
    const line = '&B1 Fix it is waiting in Review/CI, but no ferret is assigned, so nothing will happen to it.';
    const orphan = agendaItem('M5', {
      notice: true,
      title: 'A card has nobody working on it',
      kind: 'info',
      subject: line,
      sourceRef: 'warden:orphans',
      cards: [{ task: { id: 'B1' }, line }],
      waitingSince: '2026-08-01T10:00:00.000Z',
    } as never);
    const card = inboxCard(orphan, must(machineView, 'the machine view'));

    // Act
    await open([card], card.key, true);

    // Assert
    const text = view?.container.querySelector('[data-inbox-open]')?.textContent ?? '';
    expect(view?.container.querySelector('[data-agenda-card-line]')?.textContent).toBe(line);
    expect(text.split(line).length).toBe(2);
  });

  test('links its item to the Inbox, not to a conversation', () => {
    expect(agendaConversationPath(daemonId('studio'), 'machine-agenda', 'M1')).not.toContain('/session/');
    // A ferret's item opens on its own ask page, its conversation under the ask.
    expect(agendaConversationPath(daemonId('studio'), 'sess-1', 'A1')).toBe('/d/studio/agenda/sess-1/A1');
  });
});
