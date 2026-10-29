import { describe, expect, it } from 'bun:test';
import {
  AttentionInboxPage,
  type AttentionInboxPageProps,
} from '../../../src/features/attention/attention-inbox-page.tsx';
import {
  attentionKeyDirection,
  dragOffset,
  swipeKeyHint,
} from '../../../src/features/attention/attention-swipe-deck.tsx';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import { AttentionUndoToast } from '../../../src/features/attention/attention-undo-toast.tsx';
import { AttentionSwipeDeck } from '../../../src/features/attention/attention-swipe-deck.tsx';
import { type InboxCard, swipeIntent, swipeMap } from '../../../src/lib/attention-inbox.ts';
import { swipeTargets } from '../../../src/lib/attention-answers.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import {
  attentionItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const threeWay = inboxCard(
  attentionItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Skip') }),
);
const twoWay = inboxCard(
  attentionItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
  'Laptop',
  daemonId('laptop'),
);
const bare = inboxCard(
  attentionItem('A1', { subject: 'Have a look', waitingSince: '2026-08-01T09:00:00.000Z' }),
  sessionView('sess-3', { config: { teammate: 'moe', name: undefined } }),
);

const page = (fake: FakeInbox, cards: readonly InboxCard[], props: Partial<AttentionInboxPageProps> = {}) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={false}
    render={inbox => (
      <AttentionInboxPage
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

/** The deck with the real card in it: the detail, the answer bar and the reply box on each card. */
const deckPage = (fake: FakeInbox, cards: readonly InboxCard[], props: { reducedMotion?: boolean } = {}) => (
  <InboxHarness
    cards={cards}
    fake={fake}
    reading={false}
    render={inbox => (
      <>
        <AttentionSwipeDeck
          cards={inbox.cards}
          onAct={(card, action) => inbox.deferred.schedule(card, action)}
          reducedMotion={props.reducedMotion ?? true}
          renderCard={(card, act) => <AttentionCard item={card.item} onAct={act} swipeHints />}
        />
        <AttentionUndoToast clock={fake.clock.now} inbox={inbox} />
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
  deckTop(mounted).querySelector('[data-attention-frame]')?.getAttribute('data-attention-frame') ?? null;

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

const stamp = (mounted: Mounted): HTMLElement | null => mounted.container.querySelector('[data-attention-stamp]');
const toast = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('[data-attention-undo]'), 'the undo toast');
const undoButton = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-undo-button]'), 'Undo');
const frame = (mounted: Mounted, id: string): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>(`[data-attention-frame="${id}"]`), `card ${id}`);
const pending = (fake: FakeInbox): string[] => fake.deferred.getSnapshot().pending.map(entry => entry.action.label);

const review = inboxCard(
  attentionItem('A4', { subject: 'Is the fix right?', ask: { kind: 'answer-review' } as never }),
  sessionView('sess-4', { config: { teammate: 'kai', name: 'Review it' } }),
);

const typeReply = async (mounted: Mounted, text: string): Promise<HTMLTextAreaElement> => {
  const box = must(
    deckTop(mounted).querySelector<HTMLTextAreaElement>('textarea[data-attention-reply]'),
    'the reply box',
  );
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, text);
  await interact(() => box.dispatchEvent(new Event('input', { bubbles: true })));
  return box;
};

/** A tap: the press first (which clears a swallowed drag-click), then the click. */
const openReply = async (mounted: Mounted): Promise<void> => {
  const toggle = must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-reply-toggle]'), 'Reply…');
  await interact(() => toggle.dispatchEvent(pointer('pointerdown', 10, 10)));
  await interact(() => toggle.click());
};

const pendingActions = (fake: FakeInbox) => fake.deferred.getSnapshot().pending.map(entry => entry.action);

describe('attention swipe helpers', () => {
  it('maps only the three arrow keys to a direction', () => {
    expect(attentionKeyDirection('ArrowRight')).toBe('right');
    expect(attentionKeyDirection('ArrowLeft')).toBe('left');
    expect(attentionKeyDirection('ArrowUp')).toBe('up');
    expect(attentionKeyDirection('ArrowDown')).toBeNull();
    expect(attentionKeyDirection('Enter')).toBeNull();
  });

  it('says what each arrow does, in words, in the order the swipes point', () => {
    expect(swipeKeyHint(swipeTargets(bare.item))).toBe('Arrow right: Got it.');
    expect(swipeKeyHint(swipeTargets(twoWay.item))).toBe('Arrow left: Hold. Arrow right: Ship.');
    expect(swipeKeyHint(swipeTargets(threeWay.item))).toBe(
      'Arrow left: Skip. Arrow up: Wait. Arrow right: Rebase now.',
    );
  });

  it('follows the finger sideways, up only where up means something, and never down', () => {
    const three = swipeTargets(threeWay.item);
    expect(dragOffset(40, 30, three)).toEqual({ dx: 40, dy: 0 });
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

describe('AttentionInboxPage on a phone: the swipe deck', () => {
  it('deals the newest card on top with the next ones peeking, inert, behind it', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    expect(topId(mounted)).toBe('A3');
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
    expect(stamp(mounted)?.getAttribute('data-attention-stamp')).toBe('right');
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
    expect(stamp(mounted)?.getAttribute('data-attention-stamp')).toBe('up');
    expect(stamp(mounted)?.textContent).toBe('Wait');
    await release(target, 0, -200);
    expect(pending(fake)).toEqual(['Wait']);
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('never commits a direction with no answer, says so, and reads a drag down as nothing', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [twoWay]));
    expect(deckTop(mounted).style.touchAction).toBe('pan-y');
    const target = await dragBy(mounted, 0, -300);
    expect(stamp(mounted)?.getAttribute('data-attention-stamp')).toBe('up');
    expect(stamp(mounted)?.hasAttribute('data-empty')).toBe(true);
    expect(stamp(mounted)?.textContent).toBe('Nothing this way');
    expect(stamp(mounted)?.hasAttribute('data-committed')).toBe(false);
    await release(target, 0, -300);

    await swipe(mounted, 0, 300);
    expect(pending(fake)).toEqual([]);
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('has no Dismiss swipe: a card with only a right answer sends nothing to the left', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [bare]));
    const target = await dragBy(mounted, -200, 0);
    expect(stamp(mounted)?.getAttribute('data-attention-stamp')).toBe('left');
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

  it('swallows the click a drag ends in, so swiping across a button does not also press it', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay]));
    const right = must(
      deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-answer="right"]'),
      'Rebase now',
    );
    await dragBy(mounted, 40, 0, right);
    await release(right, 40, 0);
    await interact(() => right.click());
    expect(pending(fake)).toEqual([]);
    await interact(() => right.click());
    expect(pending(fake)).toEqual(['Rebase now']);
    await mounted.unmount();
  });

  it('flies a committed card off with motion, and simply removes it with reduced motion', async () => {
    const moving = await mount(deckPage(fakeInbox(), [threeWay, twoWay], { reducedMotion: false }));
    await swipe(moving, 200, 0);
    const leaving = moving.container.querySelector('.fy-attn-deck__leaving');
    expect(leaving?.getAttribute('data-direction')).toBe('right');
    expect(moving.container.querySelector('[data-attention-deck]')?.hasAttribute('data-reduced-motion')).toBe(false);
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
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-answer="right"]'), 'Rebase now').click(),
    );
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-answer="left"]'), 'Hold').click(),
    );
    expect(pending(fake)).toEqual(['Rebase now', 'Hold']);
    expect(topId(mounted)).toBe('A1');
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('keeps Dismiss in the ⋯ menu, since it is no longer a swipe', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [twoWay]));
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-more]'), 'the ⋯ button').click(),
    );
    await interact(() =>
      must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-dismiss]'), 'Dismiss').click(),
    );
    expect(pendingActions(fake).map(action => action.kind)).toEqual(['dismiss']);
    await mounted.unmount();
  });

  it('sends the reply typed on the card as the note of whichever answer is swiped', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    await openReply(mounted);
    await typeReply(mounted, 'after lunch');
    await swipe(mounted, 200, 0);
    expect(pendingActions(fake)).toEqual([
      {
        kind: 'respond',
        label: 'Rebase now',
        response: { kind: 'multiple-choice', choice: 'Rebase now' },
        note: 'after lunch',
      },
    ]);
    // The next card starts with an empty box: the reply never carries over.
    await openReply(mounted);
    expect(
      must(deckTop(mounted).querySelector<HTMLTextAreaElement>('textarea[data-attention-reply]'), 'box').value,
    ).toBe('');
    await mounted.unmount();
  });

  it('opens and focuses the reply box instead of sending a "Needs changes" with no text, in a swipe or a key', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [review]));
    expect(deckTop(mounted).querySelector('textarea[data-attention-reply]')).toBeNull();
    await swipe(mounted, -200, 0);
    expect(pending(fake)).toEqual([]);
    const box = must(deckTop(mounted).querySelector<HTMLTextAreaElement>('textarea[data-attention-reply]'), 'the box');
    expect(document.activeElement).toBe(box);

    await typeReply(mounted, 'rename the helper');
    await swipe(mounted, -200, 0);
    expect(pendingActions(fake)).toEqual([
      {
        kind: 'respond',
        label: 'Needs changes',
        response: { kind: 'answer-review', verdict: 'clarify', clarification: 'rename the helper' },
      },
    ]);
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
    expect(document.activeElement?.getAttribute('data-attention-frame')).toBe('A2');

    const inside = must(frame(mounted, 'A2').querySelector('button'), 'a button');
    await interact(() => pressKey(inside, 'ArrowLeft'));
    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowUp'));
    expect(pending(fake)).toEqual(['Rebase now']);
    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowLeft'));
    expect(pending(fake)).toEqual(['Rebase now', 'Hold']);
    await mounted.unmount();
  });

  it('answers ArrowUp on a card that has an up answer, and leaves the arrows to the reply box', async () => {
    const fake = fakeInbox();
    const mounted = await mount(deckPage(fake, [threeWay, twoWay]));
    await openReply(mounted);
    const box = await typeReply(mounted, 'note');
    box.focus();
    await interact(() => pressKey(box, 'ArrowLeft'));
    await interact(() => pressKey(box, 'ArrowUp'));
    expect(pending(fake)).toEqual([]);
    const card = frame(mounted, 'A3');
    card.focus();
    await interact(() => pressKey(card, 'ArrowUp'));
    expect(pendingActions(fake)).toMatchObject([{ label: 'Wait', note: 'note' }]);
    await mounted.unmount();
  });
});
