import { describe, expect, it } from 'bun:test';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { AgendaSwipeDeck, deckIntent, dragOffset } from '../../../src/features/agenda/agenda-swipe-deck.tsx';
import { swipeTargets } from '../../../src/lib/agenda-answers.ts';
import type { InboxCard } from '../../../src/lib/agenda-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';
import {
  agendaItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const shipIt = inboxCard(
  agendaItem('A2', {
    subject: 'Ship it?',
    ask: choices('Ship', 'Hold'),
    waitingSince: '2026-08-01T10:00:00.000Z',
    task: { id: 'F12' },
  } as never),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train', focusTask: { id: 'F9' } } as never }),
  'Laptop',
  daemonId('laptop'),
);
const rebase = inboxCard(
  agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Later') }),
  sessionView('sess-1', { config: { teammate: 'zoe', name: 'Fix the build', focusTask: { id: 'F4' } } as never }),
);

const page = (
  fake: FakeInbox,
  cards: readonly InboxCard[],
  props: Partial<AgendaInboxPageProps> = {},
  navigated: string[] = [],
) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={false}
    render={inbox => (
      <AgendaInboxPage
        clock={fake.clock.now}
        inbox={inbox}
        now={NOW}
        onNavigate={to => navigated.push(to)}
        phone
        reducedMotion
        {...props}
      />
    )}
  />
);

const pointer = (type: string, x: number, y: number): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 7,
    pointerType: 'touch',
  });

/** Drags from `start` by (dx, dy) and lets go. */
const swipeFrom = async (start: Element, dx: number, dy: number, letGo = true): Promise<void> => {
  await interact(() => start.dispatchEvent(pointer('pointerdown', 100, 300)));
  await interact(() => start.dispatchEvent(pointer('pointermove', 100 + dx / 2, 300 + dy / 2)));
  await interact(() => start.dispatchEvent(pointer('pointermove', 100 + dx, 300 + dy)));
  if (letGo) await interact(() => start.dispatchEvent(pointer('pointerup', 100 + dx, 300 + dy)));
};

const topView = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-view]'), 'the open item');
const head = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-top]'), 'the item head');
const cardTop = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-card-top]'), 'the card top bar');
/** The deck's own handle on a phone: the who-and-what line (the view's head and row swipe on their own there). */
const whoLine = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top [data-inbox-who]'), 'the who line');
const pending = (fake: FakeInbox): string[] => fake.deferred.getSnapshot().pending.map(entry => entry.action.label);
const key = (target: Element, name: string) =>
  interact(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));

describe('the open Inbox item', () => {
  it('is the chat’s own full item view, under a line that says who, what and where', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt], { initialOpen: shipIt.key }));
    expect(topView(mounted).getAttribute('data-agenda-view')).toBe('A2');
    const who = must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top [data-inbox-who]'), 'who');
    expect(who.querySelector('[data-inbox-who-ferret]')?.textContent).toBe('Kai');
    expect(who.querySelector('[data-inbox-who-task]')?.textContent).toBe('Release train');
    // The item's own card wins over the conversation's focus card.
    expect(who.querySelector('[data-inbox-who-card]')?.textContent).toBe('&F12');
    expect(who.textContent).toContain('Laptop');
    const chat = must(who.querySelector<HTMLAnchorElement>('[data-inbox-open-chat]'), 'Open chat');
    expect(chat.getAttribute('href')).toBe('/d/laptop/session/sess-2?agenda=A2');
    // ✕ goes back to the Inbox, and says so.
    expect(mounted.container.querySelector('[data-agenda-close]')?.getAttribute('aria-label')).toBe(
      'Back to the Inbox',
    );
    await mounted.unmount();
  });

  it('takes the conversation’s focus card when the item names none, and says no card when there is none', async () => {
    const mounted = await mount(page(fakeInbox(), [rebase], { initialOpen: rebase.key }));
    expect(mounted.container.querySelector('[data-inbox-who-card]')?.textContent).toBe('&F4');
    await mounted.unmount();
    const bare = inboxCard(
      agendaItem('A7', { subject: 'Look' }),
      sessionView('sess-7', { config: { teammate: 'moe' } }),
    );
    const none = await mount(page(fakeInbox(), [bare], { initialOpen: bare.key }));
    expect(none.container.querySelector('[data-inbox-who-card]')).toBeNull();
    await none.unmount();
  });

  it('answers the middle reply — the second option — on a swipe up from its who-and-what line, into the undo window', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [shipIt, rebase], { initialOpen: rebase.key }));
    await swipeFrom(whoLine(mounted), 0, -200);
    expect(pending(fake)).toEqual(['Wait']);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('says Not needed on a swipe down of the item’s title head — into the undo window — and the next item comes on top', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [shipIt, rebase], { initialOpen: shipIt.key }));
    const first = topView(mounted).getAttribute('data-agenda-view');
    await swipeFrom(head(mounted), 0, 200);
    expect(pending(fake)).toEqual(['Dismiss']);
    expect(fake.commits).toEqual([]);
    expect(topView(mounted).getAttribute('data-agenda-view')).not.toBe(first);
    await mounted.unmount();
  });

  it('stamps what a drag would do while it is held: ← the first option, ↓ Not needed', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt], { initialOpen: shipIt.key }));
    await swipeFrom(whoLine(mounted), -200, 0, false);
    const up = must(mounted.container.querySelector('.fy-attn-deck__top[data-swipe-direction]'), 'the card mid-drag');
    expect(up.getAttribute('data-swipe-direction')).toBe('left');
    expect(up.getAttribute('data-swipe-answer')).toBe('Ship');
    await interact(() => whoLine(mounted).dispatchEvent(pointer('pointercancel', 100, 100)));
    await swipeFrom(whoLine(mounted), 0, 200, false);
    const down = must(mounted.container.querySelector('.fy-attn-deck__top[data-swipe-direction]'), 'the card mid-drag');
    expect(down.getAttribute('data-swipe-direction')).toBe('down');
    expect(down.getAttribute('data-swipe-answer')).toBe('Not needed');
    expect(down.hasAttribute('data-swipe-committed')).toBe(true);
    await mounted.unmount();
  });

  it('leaves a drag on a phone’s card top bar to the view: the deck neither stamps it nor moves the card', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt], { initialOpen: shipIt.key }));
    await swipeFrom(cardTop(mounted), 0, -200, false);
    expect(mounted.container.querySelector('.fy-attn-deck__top[data-swipe-direction]')).toBeNull();
    expect(mounted.container.querySelector('.fy-attn-deck__top')?.hasAttribute('data-dragging')).toBe(false);
    await mounted.unmount();
  });

  it('answers ↑, says Not needed on ↓ from the keyboard (into the undo window), and Escape goes back', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [shipIt, rebase], { initialOpen: shipIt.key, phone: false }));
    await key(topView(mounted), 'ArrowDown');
    expect(pending(fake)).toEqual(['Dismiss']);
    expect(fake.commits).toEqual([]);
    await key(topView(mounted), 'ArrowUp');
    expect(pending(fake)).toHaveLength(2);
    await mounted.unmount();
    const back = await mount(page(fakeInbox(), [shipIt], { initialOpen: shipIt.key }));
    await key(topView(back), 'Escape');
    expect(back.container.querySelector('[data-agenda-inbox]')?.getAttribute('data-agenda-inbox')).toBe('list');
    await back.unmount();
  });

  it('draws the ferret’s own composer under the item, for the item on top', async () => {
    const asked: string[] = [];
    const mounted = await mount(
      page(fakeInbox(), [shipIt], {
        initialOpen: shipIt.key,
        renderComposer: card => {
          asked.push(card.item.id);
          return <textarea aria-label="Message this session" data-fake-composer={card.view.config.id} />;
        },
      }),
    );
    const composer = must(mounted.container.querySelector('[data-inbox-composer]'), 'the composer');
    expect(composer.querySelector('[data-fake-composer]')?.getAttribute('data-fake-composer')).toBe('sess-2');
    expect(asked.at(-1)).toBe('A2');
    // Typing in it is the reader's: a drag never starts there.
    await mounted.unmount();
  });

  it('answers a form from its composer’s one Send: the picks and the typed words go into the undo window together', async () => {
    const fake = fakeInbox();
    let draft = 'and keep the logs';
    const formCard = inboxCard(
      agendaItem('A4', {
        kind: 'form',
        ask: { kind: 'open-question' },
        fields: [{ id: '1', type: 'yesno', label: 'OK to restart?', recommended: ['Yes'] }],
      } as never),
      sessionView('sess-3'),
    );
    const unregister = registerComposerQuoteTarget({
      daemonId: formCard.daemonId,
      sessionId: formCard.view.config.id,
      draft: () => draft,
      replaceDraft: next => {
        draft = next;
      },
    });
    const mounted = await mount(
      page(fake, [formCard], {
        initialOpen: formCard.key,
        renderComposer: (_card, answerForm) => (
          <button data-fake-send="" onClick={answerForm} type="button">
            Send
          </button>
        ),
      }),
    );
    await interact(() => must(mounted.container.querySelector<HTMLButtonElement>('[data-fake-send]'), 'Send').click());
    expect(fake.deferred.getSnapshot().pending).toHaveLength(1);
    expect(draft).toBe('');
    unregister();
    await mounted.unmount();
  });

  it('carries what is typed in the ferret’s composer as a quick reply’s note, and empties it', async () => {
    const fake = fakeInbox();
    let draft = 'only after the smoke test';
    const unregister = registerComposerQuoteTarget({
      daemonId: shipIt.daemonId,
      sessionId: shipIt.view.config.id,
      draft: () => draft,
      replaceDraft: next => {
        draft = next;
      },
    });
    const mounted = await mount(page(fake, [shipIt], { initialOpen: shipIt.key }));
    const ship = must(
      [
        ...mounted.container.querySelectorAll<HTMLButtonElement>(
          '.fy-attn-deck__top [data-agenda-quick-replies] button',
        ),
      ].find(button => button.textContent?.includes('Ship')),
      'Ship',
    );
    await interact(() => ship.click());
    expect(
      fake.deferred.getSnapshot().pending.map(entry => ('note' in entry.action ? entry.action.note : undefined)),
    ).toEqual(['only after the smoke test']);
    expect(draft).toBe('');
    unregister();
    await mounted.unmount();
  });

  it('opens on a wide screen too, from a row, and the row still links to the chat', async () => {
    const navigated: string[] = [];
    const mounted = await mount(page(fakeInbox(), [shipIt], { phone: false }, navigated));
    const row = must(mounted.container.querySelector<HTMLAnchorElement>('[data-agenda-row]'), 'the row');
    await interact(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual([]);
    expect(topView(mounted).getAttribute('data-agenda-view')).toBe('A2');
    await mounted.unmount();
  });
});

describe('the Inbox list says who and what', () => {
  it('puts the ferret’s card on its group head, and an item’s other card on its row', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt, rebase], { phone: false }));
    const cards = [...mounted.container.querySelectorAll('[data-agenda-group-card]')].map(node => node.textContent);
    expect(cards.sort()).toEqual(['&F4', '&F9']);
    // A2 is about &F12, not the &F9 its ferret is on: its row says so; A3 is about its ferret's own card.
    expect([...mounted.container.querySelectorAll('[data-agenda-row-card]')].map(node => node.textContent)).toEqual([
      '&F12',
    ]);
    await mounted.unmount();
  });
});

describe('the deck: ↓ is Not needed, Skip a tap', () => {
  const targets = swipeTargets(agendaItem('A1', { ask: choices('Yes', 'No') }));

  it('reads a mostly-downward drag as a skip only when the deck can skip', () => {
    expect(deckIntent(0, 200, 300, targets, true)).toEqual({ direction: 'down', progress: 1, committed: true });
    expect(deckIntent(0, 40, 300, targets, true).committed).toBe(false);
    expect(deckIntent(0, 200, 300, targets, false).direction).toBeNull();
    expect(deckIntent(-200, 10, 300, targets, true).direction).toBe('left');
  });

  it('follows a downward drag only when it can skip', () => {
    expect(dragOffset(0, 80, targets, true)).toEqual({ dx: 0, dy: 80 });
    expect(dragOffset(0, 80, targets)).toEqual({ dx: 0, dy: 0 });
  });

  it('says Not needed on ↓ and flies the card down; Skip is a tap, never a swipe', async () => {
    const skipped: string[] = [];
    const acted: string[] = [];
    const cards = [inboxCard(agendaItem('A1', { ask: choices('Ship', 'Hold') }))];
    const mounted = await mount(
      <AgendaSwipeDeck
        cards={cards}
        onAct={(_card, action) => acted.push(action.kind)}
        onSkip={card => skipped.push(card.item.id)}
        reducedMotion={false}
        renderCard={(card, _act, skip) => (
          <button data-skip-here="" onClick={skip} type="button">
            {card.item.id}
          </button>
        )}
      />,
    );
    const frame = must(mounted.container.querySelector<HTMLElement>('[data-agenda-frame]'), 'the frame');
    expect(frame.textContent).toContain('Arrow down: not needed.');
    // The card's own row, in the options list's order: the first option on ←.
    expect(frame.textContent).toContain('Arrow left: Ship.');
    await key(frame, 'ArrowDown');
    expect([acted, skipped]).toEqual([['dismiss'], []]);
    expect(mounted.container.querySelector('.fy-attn-deck__leaving')?.getAttribute('data-direction')).toBe('down');
    await interact(() => must(mounted.container.querySelector<HTMLButtonElement>('[data-skip-here]'), 'skip').click());
    expect(skipped).toEqual(['A1']);
    await mounted.unmount();
  });
});

describe('the open Inbox item’s History', () => {
  it('shows the owner’s replies and the ferret’s answers as chat bubbles, read for the card on top', async () => {
    const asked: string[] = [];
    const mounted = await mount(
      page(fakeInbox(), [shipIt], {
        initialOpen: shipIt.key,
        readConversation: async card => {
          asked.push(card.key);
          return [
            { id: '1', kind: 'assistant', text: 'Asking about !A2 — ship it?', at: NOW - 3_600_000 },
            { id: '2', kind: 'user', text: 'Hold until Monday !A2', at: NOW - 1_800_000 },
          ];
        },
      }),
    );
    await interact(() => Promise.resolve());
    const owner = [...mounted.container.querySelectorAll('[data-history="owner"]')].map(node => node.textContent);
    const ferret = [...mounted.container.querySelectorAll('[data-history="ferret"]')].map(node => node.textContent);
    expect(owner.some(text => text?.includes('Hold until Monday'))).toBe(true);
    expect(ferret.some(text => text?.includes('Asking about'))).toBe(true);
    expect(asked).toEqual([shipIt.key]);
    await mounted.unmount();
  });

  it('keeps the revisions when the conversation cannot be read', async () => {
    const mounted = await mount(
      page(fakeInbox(), [shipIt], {
        initialOpen: shipIt.key,
        readConversation: async () => {
          throw new Error('offline');
        },
      }),
    );
    await interact(() => Promise.resolve());
    expect(topView(mounted).getAttribute('data-agenda-view')).toBe('A2');
    await mounted.unmount();
  });
});
