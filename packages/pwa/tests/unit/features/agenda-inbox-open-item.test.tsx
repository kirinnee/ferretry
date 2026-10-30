import { describe, expect, it } from 'bun:test';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { AgendaSwipeDeck, deckIntent, dragOffset } from '../../../src/features/agenda/agenda-swipe-deck.tsx';
import { swipeTargets } from '../../../src/lib/agenda-answers.ts';
import type { InboxCard } from '../../../src/lib/agenda-inbox.ts';
import { inboxSwipeTargets } from '../../../src/lib/agenda-inbox-list.ts';
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

  it('answers the PRIMARY reply on a swipe up from its head, into the undo window', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [shipIt, rebase], { initialOpen: rebase.key }));
    await swipeFrom(head(mounted), 0, -200);
    expect(pending(fake)).toEqual(['Rebase now']);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('skips on a swipe down — nothing is answered and the next item comes on top', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [shipIt, rebase], { initialOpen: shipIt.key }));
    const first = topView(mounted).getAttribute('data-agenda-view');
    await swipeFrom(head(mounted), 0, 200);
    expect(pending(fake)).toEqual([]);
    expect(topView(mounted).getAttribute('data-agenda-view')).not.toBe(first);
    await mounted.unmount();
  });

  it('stamps what a drag would do while it is held: ↑ the primary, ↓ Skip', async () => {
    const mounted = await mount(page(fakeInbox(), [shipIt], { initialOpen: shipIt.key }));
    await swipeFrom(head(mounted), 0, -200, false);
    const up = must(mounted.container.querySelector('[data-agenda-stamp]'), 'the stamp');
    expect(up.getAttribute('data-agenda-stamp')).toBe('up');
    expect(up.textContent).toBe('Ship');
    await interact(() => head(mounted).dispatchEvent(pointer('pointercancel', 100, 100)));
    await swipeFrom(head(mounted), 0, 200, false);
    const down = must(mounted.container.querySelector('[data-agenda-stamp]'), 'the stamp');
    expect(down.getAttribute('data-agenda-stamp')).toBe('down');
    expect(down.textContent).toBe('Skip');
    expect(down.hasAttribute('data-committed')).toBe(true);
    await mounted.unmount();
  });

  it('answers ↑ and skips ↓ from the keyboard, and Escape goes back to the list', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [shipIt, rebase], { initialOpen: shipIt.key, phone: false }));
    const first = topView(mounted).getAttribute('data-agenda-view');
    await key(topView(mounted), 'ArrowDown');
    expect(pending(fake)).toEqual([]);
    const second = topView(mounted);
    expect(second.getAttribute('data-agenda-view')).not.toBe(first);
    await key(second, 'ArrowUp');
    expect(pending(fake)).toHaveLength(1);
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
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.note)).toEqual(['only after the smoke test']);
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

describe('the deck that skips', () => {
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

  it('skips the focused card on ↓ and says so to a screen reader, and flies it down with motion on', async () => {
    const skipped: string[] = [];
    const cards = [inboxCard(agendaItem('A1', { ask: choices('Yes', 'No') }))];
    const mounted = await mount(
      <AgendaSwipeDeck
        cards={cards}
        onAct={() => undefined}
        onSkip={card => skipped.push(card.item.id)}
        reducedMotion={false}
        renderCard={(card, _act, skip) => (
          <button data-skip-here="" onClick={skip} type="button">
            {card.item.id}
          </button>
        )}
        targetsFor={card => inboxSwipeTargets(swipeTargets(card.item))}
      />,
    );
    const frame = must(mounted.container.querySelector<HTMLElement>('[data-agenda-frame]'), 'the frame');
    expect(frame.textContent).toContain('Arrow down: skip.');
    expect(frame.textContent).toContain('Arrow up: Yes.');
    await key(frame, 'ArrowDown');
    expect(skipped).toEqual(['A1']);
    expect(mounted.container.querySelector('.fy-attn-deck__leaving')?.getAttribute('data-direction')).toBe('down');
    await interact(() => must(mounted.container.querySelector<HTMLButtonElement>('[data-skip-here]'), 'skip').click());
    expect(skipped).toEqual(['A1', 'A1']);
    await mounted.unmount();
  });
});
