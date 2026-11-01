import { describe, expect, it } from 'bun:test';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import {
  AgendaSwipeDeck,
  agendaKeyDirection,
  bodyTargets,
  deckRoom,
  dragOffset,
  swipeKeyHint,
} from '../../../src/features/agenda/agenda-swipe-deck.tsx';
import { AgendaUndoToast } from '../../../src/features/agenda/agenda-undo-toast.tsx';
import { swipeTargets } from '../../../src/lib/agenda-answers.ts';
import { DISMISS_ACTION, type InboxCard, snoozeAction, swipeIntent, swipeMap } from '../../../src/lib/agenda-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import {
  agendaItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const threeWay = inboxCard(
  agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Skip') }),
);
const twoWay = inboxCard(
  agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
  'Laptop',
  daemonId('laptop'),
);
const bare = inboxCard(
  agendaItem('A1', { subject: 'Have a look', waitingSince: '2026-08-01T09:00:00.000Z' }),
  sessionView('sess-3', { config: { teammate: 'moe', name: undefined } }),
);

const page = (fake: FakeInbox, cards: readonly InboxCard[], props: Partial<AgendaInboxPageProps> = {}) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={false}
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

/** The deck with the real card in it: the minimal card on each. */
const deckPage = (
  fake: FakeInbox,
  cards: readonly InboxCard[],
  props: {
    reducedMotion?: boolean;
    onSkip?: (card: InboxCard) => void;
    compass?: boolean;
    snoozes?: string[];
  } = {},
) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={false}
    render={inbox => (
      <>
        <AgendaSwipeDeck
          cards={inbox.cards}
          onAct={(card, action) => inbox.deferred.schedule(card, action)}
          reducedMotion={props.reducedMotion ?? true}
          {...(props.onSkip === undefined ? {} : { onSkip: props.onSkip })}
          {...(props.compass !== true
            ? {}
            : {
                onDismiss: (card: InboxCard) => inbox.deferred.schedule(card, DISMISS_ACTION),
                onSnooze: (card: InboxCard, until: string) => {
                  props.snoozes?.push(until);
                  inbox.deferred.schedule(card, snoozeAction(until));
                },
              })}
          renderCard={(card, act) => <AgendaCard item={card.item} onAct={act} swipeHints />}
        />
        <AgendaUndoToast clock={fake.clock.now} inbox={inbox} />
      </>
    )}
  />
);

const flush = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const advance = async (fake: FakeInbox, ms: number): Promise<void> => {
  await interact(() => fake.clock.advance(ms));
  await flush();
};

const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 7,
    pointerType: 'touch',
    ...init,
  });

const deckTop = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('.fy-attn-deck__top'), 'the top card');

const topId = (mounted: Mounted): string | null =>
  deckTop(mounted).querySelector('[data-agenda-frame]')?.getAttribute('data-agenda-frame') ?? null;

const dragBy = async (mounted: Mounted, dx: number, dy: number, target?: Element): Promise<HTMLElement> => {
  const start =
    target ?? deckTop(mounted).querySelector('.fy-attn-card__title, .fy-attn-row__title') ?? deckTop(mounted);
  await interact(() => start.dispatchEvent(pointer('pointerdown', 100, 300)));
  await interact(() => start.dispatchEvent(pointer('pointermove', 100 + dx / 2, 300 + dy / 2)));
  await interact(() => start.dispatchEvent(pointer('pointermove', 100 + dx, 300 + dy)));
  return start as HTMLElement;
};

const release = async (target: Element, dx: number, dy: number): Promise<void> => {
  await interact(() => target.dispatchEvent(pointer('pointerup', 100 + dx, 300 + dy)));
};

const swipe = async (mounted: Mounted, dx: number, dy: number): Promise<void> => {
  await release(await dragBy(mounted, dx, dy), dx, dy);
};

/** The card in the hand while a drag reads as a direction: what letting go would do is on it as `data-swipe-*`. */
const stamp = (mounted: Mounted): HTMLElement | null =>
  mounted.container.querySelector('.fy-attn-deck__top[data-swipe-direction]');
const toast = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('[data-agenda-undo]'), 'the undo toast');
const undoButton = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-undo-button]'), 'Undo');
const frame = (mounted: Mounted, id: string): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>(`[data-agenda-frame="${id}"]`), `card ${id}`);
const pending = (fake: FakeInbox): string[] => fake.deferred.getSnapshot().pending.map(entry => entry.action.label);

const review = inboxCard(
  agendaItem('A4', { subject: 'Is the fix right?', ask: { kind: 'answer-review' } as never }),
  sessionView('sess-4', { config: { teammate: 'kai', name: 'Review it' } }),
);

const ownerCard = inboxCard(
  agendaItem('A5', {
    subject: 'My own reminder',
    ask: choices('Ship', 'Hold'),
    raisedBy: 'human',
    raisedBySession: null,
    raisedByName: null,
  } as never),
);

const pendingActions = (fake: FakeInbox) => fake.deferred.getSnapshot().pending.map(entry => entry.action);

describe('attention swipe helpers', () => {
  it('maps only the three arrow keys, never down to a direction', () => {
    expect(agendaKeyDirection('ArrowRight')).toBe('right');
    expect(agendaKeyDirection('ArrowLeft')).toBe('left');
    expect(agendaKeyDirection('ArrowUp')).toBe('up');
    expect(agendaKeyDirection('ArrowDown')).toBeNull();
    expect(agendaKeyDirection('Enter')).toBeNull();
  });

  it('says what each arrow does, in words, in the order the swipes point', () => {
    expect(swipeKeyHint(swipeTargets(bare.item))).toBe('Arrow right: Got it.');
    expect(swipeKeyHint(swipeTargets(twoWay.item))).toBe('Arrow left: Ship. Arrow right: Hold.');
    expect(swipeKeyHint(swipeTargets(threeWay.item))).toBe(
      'Arrow left: Rebase now. Arrow up: Wait. Arrow right: Skip.',
    );
    expect(swipeKeyHint(swipeTargets({ ...bare.item, raisedBy: 'human' }))).toBe('Arrow right: Got it.');
  });

  it('follows the finger sideways and up only where up means something, never down', () => {
    const three = swipeTargets(threeWay.item);
    expect(dragOffset(40, 30, three)).toEqual({ dx: 40, dy: 0 });
    expect(dragOffset(40, 30, swipeTargets({ ...threeWay.item, raisedBy: 'human' }))).toEqual({ dx: 40, dy: 0 });
    expect(dragOffset(0, -100, three)).toEqual({ dx: 0, dy: -100 });
    // Two options sit on ← and →: up means nothing there.
    expect(dragOffset(0, -100, swipeTargets(twoWay.item))).toEqual({ dx: 0, dy: -20 });
    expect(dragOffset(0, -100, swipeTargets(bare.item))).toEqual({ dx: 0, dy: -20 });
  });

  it('commits up only on a card that has an up answer', () => {
    expect(swipeIntent(0, -300, 360, swipeMap(threeWay.item))).toMatchObject({ direction: 'up', committed: true });
    expect(swipeIntent(0, -300, 360, swipeMap(bare.item))).toMatchObject({ direction: 'up', committed: false });
  });

  it('commits no direction a card has no answer for', () => {
    expect(swipeIntent(-300, 0, 360, swipeMap(bare.item)).committed).toBe(false);
    expect(swipeIntent(300, 0, 360, swipeMap(review.item)).committed).toBe(true);
  });
});

describe('AgendaInboxPage on a phone: the swipe deck', () => {
  it('deals the card it starts at on top with the next ones peeking, inert, behind it', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare], { initialOpen: bare.key }));
    expect(topId(mounted)).toBe('A1');
    const peeks = [...mounted.container.querySelectorAll('.fy-attn-deck__peek')];
    expect(peeks).toHaveLength(2);
    expect(peeks.every(peek => peek.getAttribute('aria-hidden') === 'true' && peek.hasAttribute('inert'))).toBe(true);
    await mounted.unmount();
  });

  it('stamps the right-hand answer while dragging right and sends nothing short of the threshold', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const target = await dragBy(mounted, 60, 4);
    expect(stamp(mounted)?.getAttribute('data-swipe-answer')).toBe('Skip');
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('right');
    expect(stamp(mounted)?.hasAttribute('data-swipe-committed')).toBe(false);
    expect(stamp(mounted)?.hasAttribute('data-swipe-empty')).toBe(false);
    // This deck cannot skip, so the card follows the finger sideways only.
    expect(deckTop(mounted).style.transform).toContain('translate3d(60px, 0px, 0)');

    await release(target, 60, 4);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A3');
    expect(stamp(mounted)).toBeNull();
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('commits past the threshold: up is the middle answer — the second option, held for undo, posted when the window ends', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const target = await dragBy(mounted, 0, -180);
    expect(stamp(mounted)?.hasAttribute('data-swipe-committed')).toBe(true);
    await release(target, 0, -180);

    expect(pending(fake)).toEqual(['Wait']);
    expect(topId(mounted)).toBe('A2');
    expect(toast(mounted).textContent).toContain('Answered !A3: Wait');
    expect(fake.commits).toEqual([]);
    await advance(fake, 4_999);
    expect(fake.commits).toEqual([]);
    await advance(fake, 1);
    expect(fake.commits.map(commit => [commit.card.item.id, commit.action.label])).toEqual([['A3', 'Wait']]);
    await mounted.unmount();
  });

  it('swipes left to the left answer, and undo brings the card back', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [twoWay]));
    expect(stamp(mounted)).toBeNull();
    await swipe(mounted, -200, 0);
    expect(pending(fake)).toEqual(['Ship']);
    await interact(() => undoButton(mounted).click());
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('swipes up from the head to the middle answer — the second option, the card handing the body its vertical pan', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    expect(deckTop(mounted).style.touchAction).toBe('pan-y');
    const target = await dragBy(mounted, 0, -200);
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('up');
    expect(stamp(mounted)?.getAttribute('data-swipe-answer')).toBe('Wait');
    await release(target, 0, -200);
    expect(pending(fake)).toEqual(['Wait']);
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('never commits a direction with no answer, says so, and reads a drag down as nothing where the deck cannot skip', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [bare]));
    expect(deckTop(mounted).style.touchAction).toBe('pan-y');
    const target = await dragBy(mounted, 0, -300);
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('up');
    expect(stamp(mounted)?.hasAttribute('data-swipe-empty')).toBe(true);
    expect(stamp(mounted)?.getAttribute('data-swipe-answer')).toBeNull();
    expect(stamp(mounted)?.hasAttribute('data-swipe-committed')).toBe(false);
    await release(target, 0, -300);

    await swipe(mounted, 0, 300);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A1');
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('has no Dismiss swipe: a card with only a right answer sends nothing to the left', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [bare]));
    const target = await dragBy(mounted, -200, 0);
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('left');
    expect(stamp(mounted)?.getAttribute('data-swipe-answer')).toBeNull();
    await release(target, -200, 0);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A1');
    await mounted.unmount();
  });

  it('never starts a drag in a field', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));
    const field = document.createElement('textarea');
    deckTop(mounted).appendChild(field);
    await dragBy(mounted, 200, 0, field);
    expect(stamp(mounted)).toBeNull();
    expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(false);
    await mounted.unmount();
  });

  it('never swipes with a mouse or a pen, so a mouse drag stays the reader selecting text', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));
    const title = must(deckTop(mounted).querySelector('.fy-attn-card__title'), 'the title');
    for (const init of [{ pointerType: 'mouse' }, { pointerType: 'mouse', button: 2 }, { pointerType: 'pen' }]) {
      await interact(() => title.dispatchEvent(pointer('pointerdown', 100, 300, init)));
      await interact(() => title.dispatchEvent(pointer('pointermove', 300, 300)));
      expect(stamp(mounted)).toBeNull();
      expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(false);
    }
    const body = must(deckTop(mounted).querySelector('[data-agenda-scroll]'), 'the body');
    await interact(() => body.dispatchEvent(pointer('pointerdown', 100, 300, { pointerType: 'mouse' })));
    await interact(() => body.dispatchEvent(pointer('pointermove', 300, 300)));
    expect(stamp(mounted)).toBeNull();
    await mounted.unmount();
  });

  it('springs back when the browser takes the gesture', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));

    const target = await dragBy(mounted, 200, 0);
    await interact(() => target.dispatchEvent(pointer('pointercancel', 300, 300, { pointerId: 99 })));
    expect(stamp(mounted)).not.toBeNull();
    await interact(() => target.dispatchEvent(pointer('pointercancel', 300, 300)));
    expect(stamp(mounted)).toBeNull();
    expect(deckTop(mounted).style.transform).toBe('');
    await mounted.unmount();
  });

  it('keeps dragging when the browser has already released the pointer it cannot capture', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    Object.defineProperty(deckTop(mounted), 'setPointerCapture', {
      configurable: true,
      value: () => {
        throw new DOMException('The pointer is not active', 'NotFoundError');
      },
    });
    const target = await dragBy(mounted, 180, 0);
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('right');
    await release(target, 180, 0);
    expect(pending(fake)).toEqual(['Skip']);
    await mounted.unmount();
  });

  it('swallows the click a drag ends in, so a swipe that ends over a button does not also press it', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay]));
    const middle = must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-answer="up"]'), 'Wait');
    await release(await dragBy(mounted, 40, 0), 40, 0);
    await interact(() => middle.click());
    expect(pending(fake)).toEqual([]);
    await interact(() => middle.click());
    expect(pending(fake)).toEqual(['Wait']);
    await mounted.unmount();
  });

  it('never starts a swipe on an answer button: pressing it simply answers', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay]));
    const right = must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-answer="right"]'), 'Rebase now');
    await dragBy(mounted, 200, 0, right);
    expect(stamp(mounted)).toBeNull();
    await release(right, 200, 0);
    expect(pending(fake)).toEqual([]);
    await mounted.unmount();
  });

  it('flies a committed card off with motion, and simply removes it with reduced motion', async () => {
    const moving = await mount(deckPage(fakeInbox(), [threeWay, twoWay], { reducedMotion: false }));
    await swipe(moving, 200, 0);
    const leaving = moving.container.querySelector('.fy-attn-deck__leaving');
    expect(leaving?.getAttribute('data-direction')).toBe('right');
    expect(moving.container.querySelector('[data-agenda-deck]')?.hasAttribute('data-reduced-motion')).toBe(false);
    await interact(() => new Promise<void>(resolve => setTimeout(resolve, 600)));
    expect(moving.container.querySelector('.fy-attn-deck__leaving')).toBeNull();
    await moving.unmount();

    const still = await mount(deckPage(fakeInbox(), [threeWay, twoWay]));
    await swipe(still, 200, 0);
    expect(still.container.querySelector('.fy-attn-deck__leaving')).toBeNull();
    expect(topId(still)).toBe('A2');
    await still.unmount();
  });

  it('answers through the answer buttons the same way, into the undo window', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay, bare]));
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-answer="up"]'), 'Wait').click(),
    );
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-answer="left"]'), 'Ship').click(),
    );
    expect(pending(fake)).toEqual(['Wait', 'Ship']);
    expect(topId(mounted)).toBe('A1');
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('keeps Not needed… in the ⋯ menu, a button only (no swipe); it goes into the undo window and Undo brings the card back', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [twoWay]));
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-more]'), 'the ⋯ button').click(),
    );
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-dismiss]'), 'Dismiss').click(),
    );
    expect(pendingActions(fake).map(action => action.kind)).toEqual(['dismiss']);
    expect(fake.commits).toEqual([]);
    expect(mounted.container.querySelector('.fy-attn-deck__top')).toBeNull();
    await interact(() => undoButton(mounted).click());
    expect(pendingActions(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('springs back from a "Needs changes" swipe: it is written in the message box, so it has no swipe', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [review]));
    await swipe(mounted, -200, 0);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A4');
    expect(deckTop(mounted).querySelector('textarea')).toBeNull();
    await mounted.unmount();
  });

  it('answers the top card from the keyboard, described in an sr-only hint, and hands focus on', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay], { onSkip: () => undefined }));
    const card = frame(mounted, 'A3');
    expect(card.tabIndex).toBe(0);
    const hint = must(document.getElementById(must(card.getAttribute('aria-describedby'), 'hint id')), 'the hint');
    expect(hint.textContent).toBe('Arrow left: Rebase now. Arrow up: Wait. Arrow right: Skip. Arrow down: skip.');
    card.focus();
    await interact(() => pressKey(card, 'ArrowUp'));
    expect(pending(fake)).toEqual(['Wait']);
    expect(document.activeElement?.getAttribute('data-agenda-frame')).toBe('A2');

    const inside = must(frame(mounted, 'A2').querySelector('button'), 'a button');
    await interact(() => pressKey(inside, 'ArrowLeft'));
    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowUp'));
    expect(pending(fake)).toEqual(['Wait']);
    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowLeft'));
    expect(pending(fake)).toEqual(['Wait', 'Ship']);
    await mounted.unmount();
  });

  it('answers ArrowUp on a card that has an up answer, and ignores a card with none', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const card = frame(mounted, 'A3');
    card.focus();
    await interact(() => pressKey(card, 'ArrowUp'));
    expect(pendingActions(fake)).toMatchObject([{ label: 'Wait' }]);
    await mounted.unmount();
  });
});

describe('the room the top card is given', () => {
  it('is everything from the deck down to the bottom of the screen, less what sits under it', () => {
    expect(deckRoom(300, 1600, 60, 22)).toBe(1210);
    // Never so little that the head and the answer bar cannot both show.
    expect(deckRoom(900, 1000, 60, 22)).toBe(320);
  });

  it('is measured against the window when nothing around the deck scrolls, and again on a resize', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));
    const deck = must(mounted.container.querySelector<HTMLElement>('[data-agenda-deck]'), 'the deck');
    const room = Number.parseFloat(deck.style.getPropertyValue('--deck-room'));
    expect(room).toBeGreaterThanOrEqual(320);
    await interact(() => window.dispatchEvent(new Event('resize')));
    expect(Number.parseFloat(deck.style.getPropertyValue('--deck-room'))).toBe(room);
    await mounted.unmount();
  });

  it('is measured against the nearest scrolling ancestor when there is one', async () => {
    const mounted = await mount(
      <div style={{ overflowY: 'auto', height: 400 }}>{deckPage(fakeInbox(), [threeWay])}</div>,
    );
    const deck = must(mounted.container.querySelector<HTMLElement>('[data-agenda-deck]'), 'the deck');
    expect(deck.style.getPropertyValue('--deck-room')).toMatch(/^\d+px$/u);
    await mounted.unmount();
  });
});

describe('Down is Skip', () => {
  it('reads a downward drag as no direction at all, and commits nothing', () => {
    expect(swipeIntent(0, 300, 360, swipeMap(threeWay.item)).committed).toBe(false);
    expect(swipeIntent(0, 4, 360, swipeMap(threeWay.item)).direction).toBeNull();
  });

  it('skips on a long drag down: nothing is sent to the undo window, nothing committed, and the stamp says Skip', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const mounted = await mount(deckPage(fake, [threeWay, twoWay], { onSkip: card => skipped.push(card.item.id) }));
    const target = await dragBy(mounted, 0, 200);
    expect(stamp(mounted)?.getAttribute('data-swipe-answer')).toBe('Skip');
    expect(stamp(mounted)?.hasAttribute('data-swipe-committed')).toBe(true);
    await release(target, 0, 200);
    expect(skipped).toEqual(['A3']);
    expect(pendingActions(fake)).toEqual([]);
    expect(fake.commits).toEqual([]);
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('names Skip on the ground the card uncovers while it is pulled down, and only then', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay], { onSkip: () => undefined }));
    const reveal = (): HTMLElement | null => mounted.container.querySelector<HTMLElement>('[data-swipe-reveal]');
    expect(reveal()).toBeNull();
    const target = await dragBy(mounted, 0, 120);
    expect(reveal()?.getAttribute('data-swipe-reveal')).toBe('down');
    expect(reveal()?.textContent).toContain('Skip');
    expect(reveal()?.getAttribute('aria-hidden')).toBe('true');
    await release(target, 0, 120);
    expect(reveal()).toBeNull();
    await mounted.unmount();
  });

  it('draws no reveal on a sideways pull, nor where the deck cannot skip', async () => {
    const fake = fakeInbox();
    const sideways = await mount(deckPage(fake, [threeWay, twoWay], { onSkip: () => undefined }));
    await dragBy(sideways, 60, 4);
    expect(sideways.container.querySelector('[data-swipe-reveal]')).toBeNull();
    await sideways.unmount();
    const still = await mount(deckPage(fakeInbox(), [threeWay, twoWay]));
    await dragBy(still, 0, 120);
    expect(still.container.querySelector('[data-swipe-reveal]')).toBeNull();
    await still.unmount();
  });

  it('never dismisses on a drag down where the deck cannot skip, and the card does not follow it', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const target = await dragBy(mounted, 0, 200);
    expect(stamp(mounted)?.hasAttribute('data-swipe-committed') ?? false).toBe(false);
    await release(target, 0, 200);
    expect(pendingActions(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A3');
    await mounted.unmount();
  });

  it('skips a notice too: a down drag changes nothing on it', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const notice = inboxCard(agendaItem('A9', { subject: 'Shipped', notice: true, kind: 'info' } as never));
    const mounted = await mount(deckPage(fake, [notice], { onSkip: card => skipped.push(card.item.id) }));
    await swipe(mounted, 0, 200);
    expect(skipped).toEqual(['A9']);
    expect(pendingActions(fake)).toEqual([]);
    await mounted.unmount();
  });

  it('marks the card only for the up answer it has', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay, ownerCard]));
    expect(deckTop(mounted).getAttribute('data-has-up')).toBe('');
    expect(deckTop(mounted).hasAttribute('data-has-discuss')).toBe(false);
    await mounted.unmount();
  });

  it('skips on ArrowDown on the focused card, and dismisses nothing', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const mounted = await mount(deckPage(fake, [threeWay, twoWay], { onSkip: card => skipped.push(card.item.id) }));
    const card = frame(mounted, 'A3');
    card.focus();
    await interact(() => pressKey(card, 'ArrowDown'));
    expect(skipped).toEqual(['A3']);
    expect(pendingActions(fake)).toEqual([]);
    await mounted.unmount();
  });

  it('does nothing on ArrowDown where the deck cannot skip', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const card = frame(mounted, 'A3');
    card.focus();
    await interact(() => pressKey(card, 'ArrowDown'));
    expect(pendingActions(fake)).toEqual([]);
    await mounted.unmount();
  });

  it('has no Discuss button on any card', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay, twoWay]));
    expect(mounted.container.querySelector('[data-agenda-discuss]')).toBeNull();
    await mounted.unmount();
  });
});

describe('bodyTargets', () => {
  const targets = swipeTargets(threeWay.item);

  it('keeps every answer for a drag from the head', () => {
    expect(bodyTargets(targets, true)).toEqual(targets);
  });

  it('keeps only the sideways answers for a drag from the body, where up is the reader scrolling', () => {
    expect(Object.keys(bodyTargets(targets, false)).sort()).toEqual(['left', 'right']);
  });

  it('never adds a direction the card does not take', () => {
    const { up: _up, left: _left, ...rightOnly } = targets;
    expect(bodyTargets(rightOnly, false)).toEqual(rightOnly);
  });
});

describe('a swipe from anywhere on the card', () => {
  const bodyOf = (mounted: Mounted): HTMLElement =>
    must(deckTop(mounted).querySelector<HTMLElement>('[data-agenda-scroll]'), 'the card body');
  const touch = (target: Element, type: string, x: number, y: number) =>
    interact(() => target.dispatchEvent(pointer(type, x, y)));

  it('starts in the middle of the body, and a sideways swipe there answers by direction', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const body = bodyOf(mounted);
    await touch(body, 'pointerdown', 100, 300);
    await touch(body, 'pointermove', 190, 304);
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('right');
    await touch(body, 'pointermove', 300, 304);
    await touch(body, 'pointerup', 300, 304);
    expect(pending(fake)).toEqual(['Skip']);
    await mounted.unmount();
  });

  it('decides nothing before 10px of travel, then locks sideways', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));
    const body = bodyOf(mounted);
    await touch(body, 'pointerdown', 100, 300);
    await touch(body, 'pointermove', 106, 303);
    expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(false);
    await touch(body, 'pointermove', 112, 303);
    expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(true);
    await mounted.unmount();
  });

  it('hands a vertical drag from the body to the browser: the card never moves and a later sideways drift is no swipe', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const body = bodyOf(mounted);
    await touch(body, 'pointerdown', 100, 300);
    await touch(body, 'pointermove', 104, 260);
    expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(false);
    await touch(body, 'pointermove', 300, 262);
    await touch(body, 'pointerup', 300, 262);
    expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(false);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A3');
    await mounted.unmount();
  });

  it('never answers up or skips from a drag that began in the body and locked sideways', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const body = bodyOf(mounted);
    await touch(body, 'pointerdown', 100, 300);
    await touch(body, 'pointermove', 130, 300);
    await touch(body, 'pointermove', 130, 60);
    expect(stamp(mounted)?.hasAttribute('data-swipe-answer')).toBe(false);
    await touch(body, 'pointerup', 130, 60);
    expect(pending(fake)).toEqual([]);
    await mounted.unmount();
  });

  it('keeps the head’s vertical drag a swipe: the head does not scroll', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const title = must(deckTop(mounted).querySelector('.fy-attn-card__title'), 'the title');
    await touch(title, 'pointerdown', 100, 300);
    await touch(title, 'pointermove', 100, 200);
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('up');
    await touch(title, 'pointercancel', 100, 200);
    await mounted.unmount();
  });

  it('never starts on a link, a field or anything else that answers a touch itself', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));
    const body = bodyOf(mounted);
    for (const tag of ['a', 'select', 'summary']) {
      const element = document.createElement(tag);
      if (tag === 'a') element.setAttribute('href', '#x');
      body.appendChild(element);
      await touch(element, 'pointerdown', 100, 300);
      await touch(element, 'pointermove', 220, 300);
      expect(stamp(mounted)).toBeNull();
    }
    await mounted.unmount();
  });

  it('leaves a drag that begins inside a sideways-scrolling table or box to that scroller', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));
    const body = bodyOf(mounted);
    const wide = document.createElement('div');
    wide.style.overflowX = 'auto';
    for (const [key, value] of Object.entries({ scrollWidth: 900, clientWidth: 200 }))
      Object.defineProperty(wide, key, { configurable: true, value });
    const cell = document.createElement('td');
    wide.appendChild(cell);
    body.appendChild(wide);
    await touch(cell, 'pointerdown', 100, 300);
    await touch(cell, 'pointermove', 220, 300);
    expect(stamp(mounted)).toBeNull();
    expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(false);

    const fits = document.createElement('div');
    fits.style.overflowX = 'auto';
    for (const [key, value] of Object.entries({ scrollWidth: 200, clientWidth: 200 }))
      Object.defineProperty(fits, key, { configurable: true, value });
    body.appendChild(fits);
    await touch(fits, 'pointerdown', 100, 300);
    await touch(fits, 'pointermove', 220, 300);
    expect(stamp(mounted)?.getAttribute('data-swipe-direction')).toBe('right');
    await mounted.unmount();
  });
});

describe('The compass (a long pull down, the pointer kept down)', () => {
  const compassDeck = (fake: FakeInbox, skipped: string[], snoozes: string[] = []) =>
    deckPage(fake, [threeWay, twoWay], {
      onSkip: card => skipped.push(card.item.id),
      compass: true,
      snoozes,
    });
  const cell = (mounted: Mounted, name: string): HTMLElement | null =>
    mounted.container.querySelector<HTMLElement>(`[data-compass-cell="${name}"]`);

  it('draws the compass past the Skip threshold, lighting Skip at plain ↓', async () => {
    const mounted = await mount(compassDeck(fakeInbox(), []));
    expect(mounted.container.querySelector('[data-swipe-compass]')).toBeNull();
    await dragBy(mounted, 0, 120);
    expect(mounted.container.querySelector('[data-swipe-compass]')).not.toBeNull();
    expect(cell(mounted, 'skip')?.hasAttribute('data-active')).toBe(true);
    expect(cell(mounted, 'not-needed')?.hasAttribute('data-active')).toBe(false);
    await mounted.unmount();
  });

  it('shows the three snooze lengths only as the pull goes further down', async () => {
    const mounted = await mount(compassDeck(fakeInbox(), []));
    await dragBy(mounted, 0, 120);
    expect(mounted.container.querySelector('[data-compass-lengths]')).toBeNull();
    await dragBy(mounted, 0, 96 + 56 + 10);
    expect(cell(mounted, 'snooze')?.hasAttribute('data-active')).toBe(true);
    await mounted.unmount();
    const deep = await mount(compassDeck(fakeInbox(), []));
    await dragBy(deep, 0, 96 + 2 * 56 + 10);
    const lengths = [...deep.container.querySelectorAll('[data-compass-length]')].map(entry =>
      entry.getAttribute('data-compass-length'),
    );
    expect(lengths).toEqual(['1h', '4h', '1d']);
    await deep.unmount();
  });

  it('skips on ↓← and sends nothing', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const mounted = await mount(compassDeck(fake, skipped));
    const target = await dragBy(mounted, -70, 120);
    expect(stamp(mounted)?.getAttribute('data-swipe-answer')).toBe('Skip');
    await release(target, -70, 120);
    expect(skipped).toEqual(['A3']);
    expect(pendingActions(fake)).toEqual([]);
    await mounted.unmount();
  });

  it('dismisses on ↓→ into the undo window, and Undo really un-dismisses', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const mounted = await mount(compassDeck(fake, skipped));
    const target = await dragBy(mounted, 70, 120);
    expect(stamp(mounted)?.getAttribute('data-swipe-answer')).toBe('Not needed');
    await release(target, 70, 120);
    expect(skipped).toEqual([]);
    expect(pending(fake)).toEqual(['Dismiss']);
    expect(toast(mounted).textContent).toContain('Dismiss');
    await interact(() => undoButton(mounted).click());
    expect(pending(fake)).toEqual([]);
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('sends the dismiss for real once the undo window passes', async () => {
    const fake = fakeInbox();
    const mounted = await mount(compassDeck(fake, []));
    await swipe(mounted, 70, 120);
    await advance(fake, 10_000);
    expect(fake.commits.map(commit => commit.action.kind)).toEqual(['dismiss']);
    await mounted.unmount();
  });

  it('snoozes for 1 h, 4 h or 1 day at ↓↓↓, by where the finger lets go', async () => {
    for (const [dx, hours] of [
      [-70, 1],
      [0, 4],
      [70, 24],
    ] as const) {
      const fake = fakeInbox();
      const snoozes: string[] = [];
      const mounted = await mount(compassDeck(fake, [], snoozes));
      const before = Date.now();
      await swipe(mounted, dx, 96 + 2 * 56 + 10);
      expect(snoozes).toHaveLength(1);
      const wait = Date.parse(snoozes[0] as string) - before;
      expect(Math.abs(wait - hours * 3_600_000)).toBeLessThan(5_000);
      expect(pending(fake)).toEqual(['Snooze']);
      await mounted.unmount();
    }
  });

  it('changes nothing when let go at ↓↓ before a length is picked', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const mounted = await mount(compassDeck(fake, skipped));
    await swipe(mounted, 0, 96 + 56 + 10);
    expect(skipped).toEqual([]);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A3');
    await mounted.unmount();
  });

  it('never starts a compass from a sideways drag that drifts down', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const mounted = await mount(compassDeck(fake, skipped));
    const target = deckTop(mounted).querySelector('.fy-attn-card__title, .fy-attn-row__title') ?? deckTop(mounted);
    await interact(() => target.dispatchEvent(pointer('pointerdown', 100, 300)));
    await interact(() => target.dispatchEvent(pointer('pointermove', 150, 305)));
    await interact(() => target.dispatchEvent(pointer('pointermove', 160, 460)));
    await interact(() => target.dispatchEvent(pointer('pointerup', 160, 460)));
    expect(skipped).toEqual([]);
    expect(pending(fake)).toEqual([]);
    await mounted.unmount();
  });

  it('keeps plain ↓ as Skip where the host offers neither Not needed nor Snooze', async () => {
    const fake = fakeInbox();
    const skipped: string[] = [];
    const mounted = await mount(deckPage(fake, [threeWay, twoWay], { onSkip: card => skipped.push(card.item.id) }));
    await swipe(mounted, 70, 96 + 2 * 56 + 10);
    expect(skipped).toEqual(['A3']);
    expect(pending(fake)).toEqual([]);
    await mounted.unmount();
  });
});
