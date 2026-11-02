import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { agendaConversationPath, type InboxCard } from '../../../src/lib/agenda-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { machineSessionView } from '../../../src/lib/machine-agenda.ts';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

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

const open = async (cards: readonly InboxCard[], initialOpen?: string) => {
  const fake = fakeInbox();
  const navigated: string[] = [];
  view = await mount(
    <InboxHarness
      cards={cards}
      fake={fake}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={inbox}
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
      why: 'The Warden moves a ferret whose login hit a limit.',
      context: 'durian: Not moved: no login could take it.\nkai: Not moved: cap.',
      howToResolve: 'Move one yourself with: fy migrate <id> -a <runtime>',
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
    expect(text).toContain('durian: Not moved: no login could take it.');
    expect(text).toContain('fy migrate <id> -a <runtime>');
    expect(view?.container.querySelector('[data-inbox-open-chat]')).toBeNull();
  });

  test('links its item to the Inbox, not to a conversation', () => {
    expect(agendaConversationPath(daemonId('studio'), 'machine-agenda', 'M1')).not.toContain('/session/');
    expect(agendaConversationPath(daemonId('studio'), 'sess-1', 'A1')).toContain('/session/sess-1');
  });
});
