import { describe, expect, it } from 'bun:test';
import type { AgendaId } from '../../../../app/wire/index.ts';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import type { InboxCard } from '../../../../app/lib/agenda-inbox.ts';
import { daemonId } from '../../../../app/shell.ts';
import {
  agendaItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../../support/app/agenda-inbox.tsx';
import { interact, mount, must } from '@ferretry/app/testing';
import { sessionView } from '../../../support/app/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const shipIt = inboxCard(
  agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold') }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } as never }),
  'Laptop',
  daemonId('laptop'),
);

const holdIt = inboxCard(
  agendaItem('A3', { subject: 'Hold it?', ask: choices('Hold', 'Go') }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } as never }),
  'Laptop',
  daemonId('laptop'),
);

const withGate = inboxCard(
  agendaItem('A4', {
    subject: 'Which colour?',
    ask: choices('Blue', 'Green'),
    gateAttached: {
      cardId: 'F12',
      laneId: 'tested',
      laneName: 'Try it',
      entry: 3,
      projectId: 'p1',
      options: [
        { id: 'o0', label: 'Done', outcome: 'close' },
        { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
      ],
    },
  } as never),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } as never }),
  'Laptop',
  daemonId('laptop'),
);

const target = (id: string, settled: boolean, sessionId = 'sess-2') => ({
  daemonId: daemonId('laptop'),
  sessionId,
  id: id as AgendaId,
  settled,
});

const page = (fake: FakeInbox, cards: readonly InboxCard[], props: Partial<AgendaInboxPageProps>, reading = false) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={reading}
    render={inbox => (
      <AgendaInboxPage
        clock={fake.clock.now}
        inbox={inbox}
        now={NOW}
        onNavigate={() => undefined}
        phone
        reducedMotion
        {...props}
      />
    )}
  />
);

const openView = (container: HTMLElement): string | null =>
  container.querySelector('.fy-attn-deck__top [data-agenda-view]')?.getAttribute('data-agenda-view') ?? null;

describe('a notification tap that names an Inbox item', () => {
  it('opens that item as a card and reports it opened', async () => {
    const reported: boolean[] = [];
    const mounted = await mount(
      page(fakeInbox(), [shipIt], { open: target('A2', true), onOpenSettled: opened => reported.push(opened) }),
    );
    expect(openView(mounted.container)).toBe('A2');
    expect(reported).toEqual([true]);
    await mounted.unmount();
  });

  it('opens it AT ITS ASK: "What I need from you" has the focus, so a Needs-you push lands on what to do', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt], { open: target('A2', true) }));
    const ask = mounted.container.querySelector('.fy-attn-deck__top [data-agenda-part="needs"]');
    expect(ask).not.toBeNull();
    expect(document.activeElement).toBe(ask);
    await mounted.unmount();
  });

  it('brings an item to its ask again on every new tap, once the first request has left the address', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [shipIt], { open: target('A2', true) }));
    const ask = () => mounted.container.querySelector('.fy-attn-deck__top [data-agenda-part="needs"]');
    expect(document.activeElement).toBe(ask());
    await interact(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).not.toBe(ask());
    await mounted.render(page(fake, [shipIt], { open: null }));
    await mounted.render(page(fake, [shipIt], { open: target('A2', true) }));
    expect(document.activeElement).toBe(ask());
    await mounted.unmount();
  });

  it('leaves the request once the owner pages on: the item opens at its top when it comes round again', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt, holdIt], { open: target('A2', true) }));
    expect(document.activeElement?.getAttribute('data-agenda-part')).toBe('needs');
    const skip = () =>
      must(mounted.container.querySelector<HTMLButtonElement>('.fy-attn-deck__top [aria-label="Next item"]'), 'Skip');
    await interact(() => skip().click());
    expect(openView(mounted.container)).toBe('A3');
    await interact(() => skip().click());
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-review]'), 'Review').click(),
    );
    expect(openView(mounted.container)).toBe('A2');
    expect(document.activeElement?.getAttribute('data-agenda-part')).not.toBe('needs');
    await mounted.unmount();
  });

  it('shows a card ask’s test steps from the board the Inbox already reads', async () => {
    const asked: string[] = [];
    const fake = fakeInbox();
    const mounted = await mount(
      <InboxHarness
        cards={[withGate]}
        fake={fake}
        render={inbox => (
          <AgendaInboxPage
            clock={fake.clock.now}
            inbox={{
              ...inbox,
              howToTestFor: (machine, card) => {
                asked.push(`${machine}:${card}`);
                return '1. Open the badge.\n2. See it is blue.';
              },
            }}
            initialOpen={withGate.key}
            now={NOW}
            onNavigate={() => undefined}
            phone
            reducedMotion
          />
        )}
      />,
    );
    const steps = must(
      mounted.container.querySelector('.fy-attn-deck__top [data-agenda-card-ask-test]'),
      'the card ask’s test steps',
    );
    expect(steps.textContent).toContain('Open the badge.');
    expect(asked).toContain('laptop:F12');
    await mounted.unmount();
  });

  it('opens an item the owner picked themselves at its top, not at its ask', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt], { initialOpen: shipIt.key }));
    expect(openView(mounted.container)).toBe('A2');
    expect(document.activeElement?.getAttribute('data-agenda-view')).toBe('A2');
    await mounted.unmount();
  });

  it('reports not-opened once the machine has been read and the item is not among the open ones', async () => {
    const reported: boolean[] = [];
    const mounted = await mount(
      page(fakeInbox(), [shipIt], { open: target('A9', true), onOpenSettled: opened => reported.push(opened) }),
    );
    expect(openView(mounted.container)).toBeNull();
    expect(reported).toEqual([false]);
    await mounted.unmount();
  });

  it('is the item of THAT conversation, not another one with the same number', async () => {
    const reported: boolean[] = [];
    const mounted = await mount(
      page(fakeInbox(), [shipIt], {
        open: target('A2', true, 'another-session'),
        onOpenSettled: opened => reported.push(opened),
      }),
    );
    expect(openView(mounted.container)).toBeNull();
    expect(reported).toEqual([false]);
    await mounted.unmount();
  });

  it('waits while the machine is still being read, and does not give up early', async () => {
    const reported: boolean[] = [];
    const mounted = await mount(
      page(fakeInbox(), [], { open: target('A2', false), onOpenSettled: opened => reported.push(opened) }, true),
    );
    expect(reported).toEqual([]);
    await mounted.unmount();
  });

  it('asks for nothing when no item was named', async () => {
    const reported: boolean[] = [];
    const mounted = await mount(
      page(fakeInbox(), [shipIt], { open: null, onOpenSettled: opened => reported.push(opened) }),
    );
    expect(openView(mounted.container)).toBeNull();
    expect(reported).toEqual([]);
    await mounted.unmount();
  });
});
