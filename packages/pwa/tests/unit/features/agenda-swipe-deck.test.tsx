import { describe, expect, it } from 'bun:test';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import {
  AgendaSwipeDeck,
  agendaKeyDirection,
  deckRoom,
  dragOffset,
  scrollStartOf,
  swipeKeyHint,
  verticalTargets,
} from '../../../src/features/agenda/agenda-swipe-deck.tsx';
import { AgendaUndoToast } from '../../../src/features/agenda/agenda-undo-toast.tsx';
import { swipeTargets } from '../../../src/lib/agenda-answers.ts';
import { type InboxCard, swipeIntent, swipeMap } from '../../../src/lib/agenda-inbox.ts';
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
const deckPage = (fake: FakeInbox, cards: readonly InboxCard[], props: { reducedMotion?: boolean } = {}) => (
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

const stamp = (mounted: Mounted): HTMLElement | null => mounted.container.querySelector('[data-agenda-stamp]');
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
    expect(swipeKeyHint(swipeTargets(twoWay.item))).toBe('Arrow left: Hold. Arrow right: Ship.');
    expect(swipeKeyHint(swipeTargets(threeWay.item))).toBe(
      'Arrow left: Skip. Arrow up: Wait. Arrow right: Rebase now.',
    );
    expect(swipeKeyHint(swipeTargets({ ...bare.item, raisedBy: 'human' }))).toBe('Arrow right: Got it.');
  });

  it('follows the finger sideways and up only where up means something, never down', () => {
    const three = swipeTargets(threeWay.item);
    expect(dragOffset(40, 30, three)).toEqual({ dx: 40, dy: 0 });
    expect(dragOffset(40, 30, swipeTargets({ ...threeWay.item, raisedBy: 'human' }))).toEqual({ dx: 40, dy: 0 });
    expect(dragOffset(0, -100, three)).toEqual({ dx: 0, dy: -100 });
    expect(dragOffset(0, -100, swipeTargets(twoWay.item))).toEqual({ dx: 0, dy: -20 });
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
    expect(mounted.container.textContent).toContain('2 more after this one');
    await mounted.unmount();
  });

  it('stamps the right answer while dragging right and sends nothing short of the threshold', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const target = await dragBy(mounted, 60, 4);
    expect(stamp(mounted)?.textContent).toBe('Rebase now');
    expect(stamp(mounted)?.getAttribute('data-agenda-stamp')).toBe('right');
    expect(stamp(mounted)?.hasAttribute('data-committed')).toBe(false);
    expect(stamp(mounted)?.hasAttribute('data-empty')).toBe(false);
    expect(deckTop(mounted).style.transform).toContain('translate3d(60px, 0px, 0)');

    await release(target, 60, 4);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A3');
    expect(stamp(mounted)).toBeNull();
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('commits past the threshold: right is the recommended answer, held for undo, posted when the window ends', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const target = await dragBy(mounted, 180, 0);
    expect(stamp(mounted)?.hasAttribute('data-committed')).toBe(true);
    await release(target, 180, 0);

    expect(pending(fake)).toEqual(['Rebase now']);
    expect(topId(mounted)).toBe('A2');
    expect(toast(mounted).textContent).toContain('Answered !A3: Rebase now');
    expect(fake.commits).toEqual([]);
    await advance(fake, 4_999);
    expect(fake.commits).toEqual([]);
    await advance(fake, 1);
    expect(fake.commits.map(commit => [commit.card.item.id, commit.action.label])).toEqual([['A3', 'Rebase now']]);
    await mounted.unmount();
  });

  it('swipes left to the left answer, and undo brings the card back', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [twoWay]));
    expect(stamp(mounted)).toBeNull();
    await swipe(mounted, -200, 0);
    expect(pending(fake)).toEqual(['Hold']);
    await interact(() => undoButton(mounted).click());
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('swipes up to the up answer of a three-way card, with a pan-down touch-action so up is the card’s', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    expect(deckTop(mounted).style.touchAction).toBe('pan-down');
    const target = await dragBy(mounted, 0, -200);
    expect(stamp(mounted)?.getAttribute('data-agenda-stamp')).toBe('up');
    expect(stamp(mounted)?.textContent).toBe('Wait');
    await release(target, 0, -200);
    expect(pending(fake)).toEqual(['Wait']);
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('never commits a direction with no answer, says so, and reads a drag down as nothing', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [ownerCard]));
    expect(deckTop(mounted).style.touchAction).toBe('pan-y');
    const target = await dragBy(mounted, 0, -300);
    expect(stamp(mounted)?.getAttribute('data-agenda-stamp')).toBe('up');
    expect(stamp(mounted)?.hasAttribute('data-empty')).toBe(true);
    expect(stamp(mounted)?.textContent).toBe('Nothing this way');
    expect(stamp(mounted)?.hasAttribute('data-committed')).toBe(false);
    await release(target, 0, -300);

    await swipe(mounted, 0, 300);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A5');
    await mounted.unmount();
  });

  it('has no Dismiss swipe: a card with only a right answer sends nothing to the left', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [bare]));
    const target = await dragBy(mounted, -200, 0);
    expect(stamp(mounted)?.getAttribute('data-agenda-stamp')).toBe('left');
    expect(stamp(mounted)?.textContent).toBe('Nothing this way');
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

  it('ignores a right-click drag and springs back when the browser takes the gesture', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay]));
    const title = must(deckTop(mounted).querySelector('.fy-attn-card__title'), 'the title');
    await interact(() => title.dispatchEvent(pointer('pointerdown', 100, 300, { pointerType: 'mouse', button: 2 })));
    await interact(() => title.dispatchEvent(pointer('pointermove', 300, 300)));
    expect(stamp(mounted)).toBeNull();

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
    expect(stamp(mounted)?.getAttribute('data-agenda-stamp')).toBe('right');
    await release(target, 180, 0);
    expect(pending(fake)).toEqual(['Rebase now']);
    await mounted.unmount();
  });

  it('swallows the click a drag ends in, so a swipe that ends over a button does not also press it', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay]));
    const right = must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-answer="right"]'), 'Rebase now');
    await release(await dragBy(mounted, 40, 0), 40, 0);
    await interact(() => right.click());
    expect(pending(fake)).toEqual([]);
    await interact(() => right.click());
    expect(pending(fake)).toEqual(['Rebase now']);
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
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-answer="right"]'), 'Rebase now').click(),
    );
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-answer="left"]'), 'Hold').click(),
    );
    expect(pending(fake)).toEqual(['Rebase now', 'Hold']);
    expect(topId(mounted)).toBe('A1');
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('keeps Not needed… in the ⋯ menu, since it is no longer a swipe', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [twoWay]));
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-more]'), 'the ⋯ button').click(),
    );
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-agenda-dismiss]'), 'Dismiss').click(),
    );
    expect(pendingActions(fake).map(action => action.kind)).toEqual(['dismiss']);
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
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const card = frame(mounted, 'A3');
    expect(card.tabIndex).toBe(0);
    const hint = must(document.getElementById(must(card.getAttribute('aria-describedby'), 'hint id')), 'the hint');
    expect(hint.textContent).toBe('Arrow left: Skip. Arrow up: Wait. Arrow right: Rebase now.');
    card.focus();
    await interact(() => pressKey(card, 'ArrowRight'));
    expect(pending(fake)).toEqual(['Rebase now']);
    expect(document.activeElement?.getAttribute('data-agenda-frame')).toBe('A2');

    const inside = must(frame(mounted, 'A2').querySelector('button'), 'a button');
    await interact(() => pressKey(inside, 'ArrowLeft'));
    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowUp'));
    expect(pending(fake)).toEqual(['Rebase now']);
    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowLeft'));
    expect(pending(fake)).toEqual(['Rebase now', 'Hold']);
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

describe('Down is nothing', () => {
  it('reads a downward drag as no direction at all, and commits nothing', () => {
    expect(swipeIntent(0, 300, 360, swipeMap(threeWay.item)).committed).toBe(false);
    expect(swipeIntent(0, 4, 360, swipeMap(threeWay.item)).direction).toBeNull();
  });

  it('sends nothing for a long drag down, draws no stamp and leaves the card where it was', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    const target = await dragBy(mounted, 0, 200);
    expect(stamp(mounted)?.hasAttribute('data-committed') ?? false).toBe(false);
    await release(target, 0, 200);
    expect(pendingActions(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A3');
    await mounted.unmount();
  });

  it('marks the card only for the up answer it has', async () => {
    const mounted = await mount(deckPage(fakeInbox(), [threeWay, ownerCard]));
    expect(deckTop(mounted).getAttribute('data-has-up')).toBe('');
    expect(deckTop(mounted).hasAttribute('data-has-discuss')).toBe(false);
    await mounted.unmount();
  });

  it('ignores ArrowDown on the focused card', async () => {
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

describe('verticalTargets', () => {
  const targets = swipeTargets(threeWay.item);

  it('keeps every answer for a drag from the header, the title or the answer bar', () => {
    expect(verticalTargets(targets, null)).toEqual(targets);
  });

  it('keeps only the sideways answers mid-way through a scrolling detail, and up at its bottom edge', () => {
    expect(Object.keys(verticalTargets(targets, { atTop: false, atBottom: false })).sort()).toEqual(['left', 'right']);
    expect(Object.keys(verticalTargets(targets, { atTop: true, atBottom: false })).sort()).toEqual(['left', 'right']);
    expect(Object.keys(verticalTargets(targets, { atTop: false, atBottom: true })).sort()).toEqual([
      'left',
      'right',
      'up',
    ]);
  });

  it('never adds a direction the card does not take', () => {
    const { up: _up, ...sideways } = targets;
    expect(verticalTargets(sideways, { atTop: true, atBottom: true })).toEqual(sideways);
  });
});

describe('scrollStartOf', () => {
  const detail = (scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement => {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-agenda-scroll', '');
    for (const [key, value] of Object.entries({ scrollHeight, clientHeight, scrollTop }))
      Object.defineProperty(scroller, key, { configurable: true, value });
    const inside = document.createElement('p');
    scroller.append(inside);
    return inside;
  };

  it('is null outside a detail, and for a detail that fits whole', () => {
    expect(scrollStartOf(document.createElement('p'))).toBeNull();
    expect(scrollStartOf(null)).toBeNull();
    expect(scrollStartOf(detail(200, 200, 0))).toBeNull();
  });

  it('says whether an overflowing detail sat at its top or its bottom', () => {
    expect(scrollStartOf(detail(900, 200, 0))).toEqual({ atTop: true, atBottom: false });
    expect(scrollStartOf(detail(900, 200, 300))).toEqual({ atTop: false, atBottom: false });
    expect(scrollStartOf(detail(900, 200, 700))).toEqual({ atTop: false, atBottom: true });
  });
});
