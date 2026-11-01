import { describe, expect, it } from 'bun:test';
import type { AgendaId } from '@ferretry/protocol';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { InboxCard } from '../../../src/lib/agenda-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import {
  agendaItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/agenda-inbox.tsx';
import { mount } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const shipIt = inboxCard(
  agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold') }),
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
