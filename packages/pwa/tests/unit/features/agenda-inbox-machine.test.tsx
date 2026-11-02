import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { agendaConversationPath, type InboxCard } from '../../../src/lib/agenda-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { machineSessionView } from '../../../src/lib/machine-agenda.ts';
import { agendaItem, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const moved = agendaItem('M1', {
  notice: true,
  subject: '3 ferrets could not be moved',
  sourceRef: 'warden:auto-move-failed',
  waitingSince: '2026-08-01T10:00:00.000Z',
} as never);
const machineView = machineSessionView({
  sessionId: '@machine',
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

  test('links its item to the Inbox, not to a conversation', () => {
    expect(agendaConversationPath(daemonId('studio'), '@machine', 'M1')).not.toContain('/session/');
    expect(agendaConversationPath(daemonId('studio'), 'sess-1', 'A1')).toContain('/session/sess-1');
  });
});
