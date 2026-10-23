import { describe, expect, it } from 'bun:test';
import {
  AttentionInboxPage,
  type AttentionInboxPageProps,
  AttentionNeedsYou,
  inboxCardOrigin,
  waitingWords,
} from '../../../src/features/attention/attention-inbox-page.tsx';
import {
  attentionKeyAction,
  directionOfAction,
  dragOffset,
  swipeKeyHint,
} from '../../../src/features/attention/attention-swipe-deck.tsx';
import { secondsLeft } from '../../../src/features/attention/attention-undo-toast.tsx';
import { DISMISS_ACTION, DONE_ACTION, type InboxCard, swipeMap } from '../../../src/lib/attention-inbox.ts';
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
  attentionItem('A2', {
    subject: 'Ship it?',
    ask: choices('Ship', 'Hold'),
    waitingSince: '2026-08-01T10:00:00.000Z',
  }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
  'Laptop',
  daemonId('laptop'),
);
const bare = inboxCard(
  attentionItem('A1', { subject: 'Have a look', waitingSince: '2026-08-01T09:00:00.000Z' }),
  sessionView('sess-3', { config: { teammate: 'moe', name: undefined } }),
);

const page = (
  fake: FakeInbox,
  cards: readonly InboxCard[],
  props: Partial<AttentionInboxPageProps> & { reading?: boolean } = {},
  navigated: string[] = [],
) => {
  const { reading = false, ...rest } = props;
  return (
    <InboxHarness
      cards={cards}
      fake={fake}
      reading={reading}
      render={inbox => (
        <AttentionInboxPage
          clock={fake.clock.now}
          inbox={inbox}
          now={NOW}
          onNavigate={to => navigated.push(to)}
          phone={false}
          {...rest}
        />
      )}
    />
  );
};

/** Settles the commit promise a turned clock started. */
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
  deckTop(mounted).querySelector('[data-attention-card]')?.getAttribute('data-attention-card') ?? null;

/** Drags the top card from (100, 300) by (dx, dy), without letting go. */
const dragBy = async (mounted: Mounted, dx: number, dy: number, target?: Element): Promise<HTMLElement> => {
  const top = deckTop(mounted);
  const start = target ?? top.querySelector('h3') ?? top;
  await interact(() => start.dispatchEvent(pointer('pointerdown', 100, 300)));
  await interact(() => start.dispatchEvent(pointer('pointermove', 100 + dx / 2, 300 + dy / 2)));
  await interact(() => start.dispatchEvent(pointer('pointermove', 100 + dx, 300 + dy)));
  return start as HTMLElement;
};

const release = async (target: Element, dx: number, dy: number): Promise<void> => {
  await interact(() => target.dispatchEvent(pointer('pointerup', 100 + dx, 300 + dy)));
};

const swipe = async (mounted: Mounted, dx: number, dy: number): Promise<void> => {
  const target = await dragBy(mounted, dx, dy);
  await release(target, dx, dy);
};

const stamp = (mounted: Mounted): HTMLElement | null => mounted.container.querySelector('[data-attention-stamp]');
const toast = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('[data-attention-undo]'), 'the undo toast');
const undoButton = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-undo-button]'), 'Undo');

describe('attention swipe helpers', () => {
  it('maps the arrows to the swipe map, and only those three keys', () => {
    const map = swipeMap(threeWay.item);
    expect(attentionKeyAction('ArrowRight', map)?.label).toBe('Rebase now');
    expect(attentionKeyAction('ArrowLeft', map)?.label).toBe('Wait');
    expect(attentionKeyAction('ArrowUp', map)?.label).toBe('Skip');
    expect(attentionKeyAction('ArrowDown', map)).toBeNull();
    expect(attentionKeyAction('Enter', map)).toBeNull();
    // No third option: up means nothing, never a destructive fallback.
    expect(attentionKeyAction('ArrowUp', swipeMap(twoWay.item))).toBeNull();
  });

  it('says what each arrow does, in words', () => {
    expect(swipeKeyHint(swipeMap(threeWay.item))).toBe('Arrow right: Rebase now. Arrow left: Wait. Arrow up: Skip.');
    expect(swipeKeyHint(swipeMap(bare.item))).toBe('Arrow right: Done. Arrow left: Dismiss.');
  });

  it('finds the direction an answer sits on, or none', () => {
    const map = swipeMap(bare.item);
    expect(directionOfAction(map, DONE_ACTION)).toBe('right');
    expect(directionOfAction(map, DISMISS_ACTION)).toBe('left');
    expect(directionOfAction(swipeMap(threeWay.item), DONE_ACTION)).toBeNull();
  });

  it('follows the finger sideways, up only where up means something, and never down', () => {
    expect(dragOffset(40, 30, swipeMap(threeWay.item))).toEqual({ dx: 40, dy: 0 });
    expect(dragOffset(0, -100, swipeMap(threeWay.item))).toEqual({ dx: 0, dy: -100 });
    expect(dragOffset(0, -100, swipeMap(twoWay.item))).toEqual({ dx: 0, dy: -20 });
  });

  it('counts the undo window down in whole seconds, never below zero', () => {
    expect(secondsLeft(5_000, 0)).toBe(5);
    expect(secondsLeft(5_000, 4_001)).toBe(1);
    expect(secondsLeft(5_000, 9_000)).toBe(0);
  });

  it('names the head count', () => {
    expect(waitingWords(0)).toBe('Nothing waiting');
    expect(waitingWords(2)).toBe('2 waiting on you');
  });

  it("names a card's origin as the sidebar does, linked to the conversation at the item", () => {
    const origin = inboxCardOrigin(twoWay, () => undefined);
    expect(origin.ferret).toBe('Release train');
    expect(origin.machine).toBe('Laptop');
    expect(origin.href).toBe('/d/laptop/session/sess-2?attention=A2');
    expect(inboxCardOrigin(bare, () => undefined).ferret).toBe('Moe');
  });
});

describe('AttentionInboxPage states', () => {
  it('is calm when nothing needs the reader', async () => {
    const mounted = await mount(page(fakeInbox(), []));
    expect(mounted.container.querySelector('[data-attention-empty]')?.textContent).toContain('Nothing needs you');
    expect(mounted.container.querySelector('[data-attention-reading]')).toBeNull();
    expect(mounted.container.querySelector('h1')?.textContent).toBe('Attention');
    await mounted.unmount();
  });

  it('says it is reading while the boards have not answered, not that nothing is waiting', async () => {
    const mounted = await mount(page(fakeInbox(), [], { reading: true }));
    expect(mounted.container.querySelector('[data-attention-reading]')?.getAttribute('role')).toBe('status');
    expect(mounted.container.querySelector('[data-attention-empty]')).toBeNull();
    await mounted.unmount();
  });

  it('lists every card on a wide screen, newest first, each linked to its ferret on its machine', async () => {
    const navigated: string[] = [];
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare], {}, navigated));
    const cards = [...mounted.container.querySelectorAll('[data-attention-card]')];
    expect(cards.map(card => card.getAttribute('data-attention-card'))).toEqual(['A3', 'A2', 'A1']);
    expect(mounted.container.querySelector('h1 .fy-attn-count')?.textContent).toBe('3');
    expect(mounted.container.textContent).toContain('3 waiting on you');
    expect(mounted.container.querySelector('[data-attention-deck]')).toBeNull();

    const origin = must(cards[1]?.querySelector<HTMLAnchorElement>('[data-attention-origin]'), 'the origin link');
    expect(origin.getAttribute('href')).toBe('/d/laptop/session/sess-2?attention=A2');
    expect(origin.textContent).toBe('RRelease train·Laptop');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await interact(() => origin.dispatchEvent(click));
    expect(navigated).toEqual(['/d/laptop/session/sess-2?attention=A2']);
    await mounted.unmount();
  });
});

describe('AttentionInboxPage on a phone: the swipe deck', () => {
  const phone = { phone: true, reducedMotion: true } as const;

  it('deals the newest card on top with the next ones peeking, inert, behind it', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare], phone));
    expect(topId(mounted)).toBe('A3');
    const peeks = [...mounted.container.querySelectorAll('.fy-attn-deck__peek')];
    expect(peeks).toHaveLength(2);
    expect(peeks.every(peek => peek.getAttribute('aria-hidden') === 'true' && peek.hasAttribute('inert'))).toBe(true);
    expect(mounted.container.textContent).toContain('2 more after this one');
    await mounted.unmount();
  });

  it('stamps the mapped option while dragging and sends nothing short of the threshold', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay, twoWay], phone));
    const target = await dragBy(mounted, 60, 4);

    expect(stamp(mounted)?.textContent).toBe('Rebase now');
    expect(stamp(mounted)?.getAttribute('data-attention-stamp')).toBe('right');
    expect(stamp(mounted)?.hasAttribute('data-committed')).toBe(false);
    expect(deckTop(mounted).style.transform).toContain('translate3d(60px, 0px, 0)');

    await release(target, 60, 4);
    expect(fake.deferred.getSnapshot().pending).toEqual([]);
    expect(topId(mounted)).toBe('A3');
    expect(stamp(mounted)).toBeNull();
    expect(deckTop(mounted).style.transform).toBe('');
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('commits past the threshold: right is option 1, held for undo, posted only when the window ends', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay, twoWay], phone));
    const target = await dragBy(mounted, 180, 0);
    expect(stamp(mounted)?.hasAttribute('data-committed')).toBe(true);
    await release(target, 180, 0);

    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.label)).toEqual(['Rebase now']);
    expect(topId(mounted)).toBe('A2');
    expect(toast(mounted).textContent).toContain('Answered !A3: Rebase now');
    expect(fake.commits).toEqual([]);

    await advance(fake, 4_999);
    expect(fake.commits).toEqual([]);
    await advance(fake, 1);
    expect(fake.commits.map(commit => [commit.card.item.id, commit.action.label])).toEqual([['A3', 'Rebase now']]);
    await mounted.unmount();
  });

  it('maps left to option 2 and up to option 3', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay], phone));
    await swipe(mounted, -180, 0);
    expect(fake.deferred.getSnapshot().pending.at(-1)?.action.label).toBe('Wait');
    await interact(() => undoButton(mounted).click());

    await swipe(mounted, 0, -200);
    expect(fake.deferred.getSnapshot().pending.at(-1)?.action.label).toBe('Skip');
    await mounted.unmount();
  });

  it('never commits up without a third option, and reads a drag down as nothing', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [twoWay], phone));
    expect(deckTop(mounted).style.touchAction).toBe('pan-y');

    const target = await dragBy(mounted, 0, -300);
    expect(stamp(mounted)?.getAttribute('data-attention-stamp')).toBe('up');
    expect(stamp(mounted)?.hasAttribute('data-empty')).toBe(true);
    expect(stamp(mounted)?.hasAttribute('data-committed')).toBe(false);
    await release(target, 0, -300);

    await swipe(mounted, 0, 300);
    expect(fake.deferred.getSnapshot().pending).toEqual([]);
    expect(topId(mounted)).toBe('A2');
    await mounted.unmount();
  });

  it('keeps the downward pan for the page when up is an answer', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay], phone));
    expect(deckTop(mounted).style.touchAction).toBe('pan-down');
    await mounted.unmount();
  });

  it('swipes a card with no options right to Done and left to Dismiss', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [bare], phone));
    await swipe(mounted, 200, 0);
    expect(fake.deferred.getSnapshot().pending.at(-1)?.action).toEqual(DONE_ACTION);
    expect(toast(mounted).textContent).toContain('Marked !A1 done');
    await interact(() => undoButton(mounted).click());
    await swipe(mounted, -200, 0);
    expect(fake.deferred.getSnapshot().pending.at(-1)?.action).toEqual(DISMISS_ACTION);
    await mounted.unmount();
  });

  it('swallows the click a drag ends in, so swiping across a button does not also press it', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay], phone));
    const option = must(
      deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-option="Wait"]'),
      'the Wait option',
    );
    await dragBy(mounted, 40, 0, option);
    await release(option, 40, 0);
    await interact(() => option.click());
    expect(fake.deferred.getSnapshot().pending).toEqual([]);

    // A plain tap still answers.
    await interact(() => option.click());
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.label)).toEqual(['Wait']);
    await mounted.unmount();
  });

  it('never starts a drag in the reply box', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay], phone));
    const reply = must(deckTop(mounted).querySelector('textarea'), 'the reply box');
    await dragBy(mounted, 200, 0, reply);
    expect(stamp(mounted)).toBeNull();
    expect(deckTop(mounted).hasAttribute('data-dragging')).toBe(false);
    await mounted.unmount();
  });

  it('springs back when the browser takes the gesture', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay], phone));
    const target = await dragBy(mounted, 200, 0);
    await interact(() => target.dispatchEvent(pointer('pointercancel', 300, 300)));
    expect(stamp(mounted)).toBeNull();
    expect(deckTop(mounted).style.transform).toBe('');
    await mounted.unmount();
  });

  it('flies a committed card off with motion, and simply removes it with reduced motion', async () => {
    const moving = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true, reducedMotion: false }));
    await swipe(moving, 200, 0);
    const leaving = moving.container.querySelector('.fy-attn-deck__leaving');
    expect(leaving?.getAttribute('data-direction')).toBe('right');
    expect(leaving?.getAttribute('aria-hidden')).toBe('true');
    expect(moving.container.querySelector('[data-attention-deck]')?.hasAttribute('data-reduced-motion')).toBe(false);
    await moving.unmount();

    const still = await mount(page(fakeInbox(), [threeWay, twoWay], phone));
    await swipe(still, 200, 0);
    expect(still.container.querySelector('.fy-attn-deck__leaving')).toBeNull();
    expect(still.container.querySelector('[data-attention-deck]')?.hasAttribute('data-reduced-motion')).toBe(true);
    expect(topId(still)).toBe('A2');
    await still.unmount();
  });

  it('answers through the buttons the same way, into the undo window', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay, twoWay], phone));
    const done = must(deckTop(mounted).querySelector<HTMLButtonElement>('[data-attention-done]'), 'Done');
    await interact(() => done.click());
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action)).toEqual([DONE_ACTION]);
    expect(topId(mounted)).toBe('A2');
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });
});

describe('AttentionInboxPage undo', () => {
  it('restores the card and posts nothing, ever', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay, twoWay], { phone: true, reducedMotion: true }));
    await swipe(mounted, 200, 0);
    expect(topId(mounted)).toBe('A2');

    await interact(() => undoButton(mounted).click());
    expect(topId(mounted)).toBe('A3');
    expect(toast(mounted).className).toBe('sr-only');
    await advance(fake, 30_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('shows the newest held answer with its countdown and how many more, undoing newest first', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay, twoWay, bare]));
    const live = (): HTMLElement => must(toast(mounted).querySelector<HTMLElement>('[role="status"]'), 'live region');
    // The live region is there, empty, before anything is held: a screen reader hears the first answer.
    expect(live().textContent).toBe('');

    const done = (id: string) =>
      must(
        mounted.container.querySelector<HTMLButtonElement>(`[data-attention-card="${id}"] [data-attention-done]`),
        `Done on ${id}`,
      );
    await interact(() => done('A3').click());
    await advance(fake, 2_000);
    await interact(() => done('A2').click());

    expect(live().textContent).toBe('Marked !A2 done');
    expect(toast(mounted).querySelector('[data-attention-undo-more]')?.textContent).toBe('+1 more');
    expect(toast(mounted).querySelector('[data-attention-undo-count]')?.textContent).toBe('5s');
    expect(undoButton(mounted).getAttribute('aria-label')).toBe('Undo: Marked !A2 done');

    await interact(() => undoButton(mounted).click());
    expect(live().textContent).toBe('Marked !A3 done');
    expect(toast(mounted).querySelector('[data-attention-undo-more]')).toBeNull();
    expect(toast(mounted).querySelector('[data-attention-undo-count]')?.textContent).toBe('3s');

    // The first answer keeps its own deadline: undoing the second never restarted it.
    await advance(fake, 3_000);
    expect(fake.commits.map(commit => commit.card.item.id)).toEqual(['A3']);
    await mounted.unmount();
  });

  it('routes an inline reply through the undo window too', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay]));
    const textarea = must(mounted.container.querySelector('textarea'), 'the reply box');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'after lunch');
    await interact(() => textarea.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(() => pressKey(textarea, 'Enter', { ctrlKey: true }));

    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action)).toEqual([
      { kind: 'resolve', label: 'Reply', note: 'after lunch' },
    ]);
    expect(toast(mounted).textContent).toContain('Replied to !A3');
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });

  it('brings a refused answer back on its card, and clears it when answered again', async () => {
    const fake = fakeInbox();
    fake.failNext = 'the item is already resolved';
    const mounted = await mount(page(fake, [threeWay]));
    const option = (label: string) =>
      must(mounted.container.querySelector<HTMLButtonElement>(`[data-attention-option="${label}"]`), label);
    await interact(() => option('Wait').click());
    await advance(fake, 5_000);

    const alert = must(mounted.container.querySelector('[data-attention-card="A3"] [role="alert"]'), 'the error');
    expect(alert.textContent).toBe('Not sent: the item is already resolved');

    await interact(() => option('Skip').click());
    expect(fake.deferred.getSnapshot().failed).toEqual([]);
    await mounted.unmount();
  });

  it('says a refusal whose card has gone once, until it is dismissed', async () => {
    const fake = fakeInbox();
    fake.failNext = 'machine unpaired';
    const mounted = await mount(page(fake, [twoWay]));
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-dismiss]'), 'Dismiss').click(),
    );
    await advance(fake, 5_000);
    // The board no longer lists it.
    await mounted.render(page(fake, []));
    const failures = must(mounted.container.querySelector('[data-attention-failures]'), 'the failure list');
    expect(failures.textContent).toContain('Not sent — Dismissed !A2: machine unpaired');

    await interact(() => must(failures.querySelector('button'), 'dismiss the failure').click());
    expect(mounted.container.querySelector('[data-attention-failures]')).toBeNull();
    await mounted.unmount();
  });
});

describe('AttentionInboxPage keyboard', () => {
  const frame = (mounted: Mounted, id: string): HTMLElement =>
    must(mounted.container.querySelector<HTMLElement>(`[data-attention-frame="${id}"]`), `card ${id}`);

  it('answers a focused card with its mapped arrow, described in an sr-only hint', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay, twoWay]));
    const card = frame(mounted, 'A3');
    expect(card.tabIndex).toBe(0);
    const hint = must(document.getElementById(must(card.getAttribute('aria-describedby'), 'hint id')), 'the hint');
    expect(hint.textContent).toBe('Arrow right: Rebase now. Arrow left: Wait. Arrow up: Skip.');
    expect(hint.className).toBe('sr-only');

    card.focus();
    await interact(() => pressKey(card, 'ArrowUp'));
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.label)).toEqual(['Skip']);

    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowLeft'));
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.label)).toEqual(['Skip', 'Hold']);
    await mounted.unmount();
  });

  it('leaves the arrows alone inside the card, and up alone without a third option', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [twoWay]));
    const card = frame(mounted, 'A2');
    await interact(() => pressKey(card, 'ArrowUp'));
    await interact(() => pressKey(must(card.querySelector('textarea'), 'reply'), 'ArrowRight'));
    await interact(() => pressKey(must(card.querySelector('button'), 'a button'), 'ArrowLeft'));
    expect(fake.deferred.getSnapshot().pending).toEqual([]);
    await mounted.unmount();
  });

  it('hands focus to the card that takes the answered one’s place, so the keyboard keeps going', async () => {
    const grid = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    frame(grid, 'A2').focus();
    await interact(() => pressKey(frame(grid, 'A2'), 'ArrowRight'));
    expect(document.activeElement?.getAttribute('data-attention-frame')).toBe('A1');
    await grid.unmount();

    const deck = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true, reducedMotion: true }));
    frame(deck, 'A3').focus();
    await interact(() => pressKey(frame(deck, 'A3'), 'ArrowLeft'));
    expect(document.activeElement?.getAttribute('data-attention-frame')).toBe('A2');
    await deck.unmount();
  });

  it('answers the deck’s top card from the keyboard on a phone too', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [twoWay], { phone: true, reducedMotion: true }));
    await interact(() => pressKey(frame(mounted, 'A2'), 'ArrowRight'));
    expect(fake.deferred.getSnapshot().pending.map(entry => entry.action.label)).toEqual(['Ship']);
    await mounted.unmount();
  });
});

describe('AttentionNeedsYou', () => {
  const needsYou = (fake: FakeInbox, cards: readonly InboxCard[], navigated: string[] = []) => (
    <InboxHarness
      cards={cards}
      fake={fake}
      render={inbox => (
        <AttentionNeedsYou
          clock={fake.clock.now}
          daemonId={daemonId('workshop')}
          inbox={inbox}
          now={NOW}
          onNavigate={to => navigated.push(to)}
        />
      )}
    />
  );

  it('draws nothing but the (empty) undo region when nothing is open', async () => {
    const mounted = await mount(needsYou(fakeInbox(), []));
    expect(mounted.container.querySelector('[data-attention-needs-you]')).toBeNull();
    expect(toast(mounted).className).toBe('sr-only');
    await mounted.unmount();
  });

  it('shows the newest three with "See all N" into the inbox', async () => {
    const extra = inboxCard(
      attentionItem('A0', { waitingSince: '2026-08-01T08:00:00.000Z' }),
      sessionView('sess-4', { config: { teammate: 'ola' } }),
    );
    const navigated: string[] = [];
    const mounted = await mount(needsYou(fakeInbox(), [threeWay, twoWay, bare, extra], navigated));
    const section = must(mounted.container.querySelector('[data-attention-needs-you]'), 'the deck');
    expect(
      [...section.querySelectorAll('[data-attention-card]')].map(card => card.getAttribute('data-attention-card')),
    ).toEqual(['A3', 'A2', 'A1']);
    const all = must(section.querySelector<HTMLAnchorElement>('[data-attention-see-all]'), 'See all');
    expect(all.textContent).toBe('See all 4');
    expect(all.getAttribute('href')).toBe('/d/workshop/attention');
    await interact(() => all.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual(['/d/workshop/attention']);
    // Buttons only: these cards do not swipe.
    expect(section.querySelector('.fy-attn-card__swipe')).toBeNull();
    await mounted.unmount();
  });

  it('answers undoably, and the toast outlives the last card it took', async () => {
    const fake = fakeInbox();
    const mounted = await mount(needsYou(fake, [bare]));
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-done]'), 'Done').click(),
    );
    expect(mounted.container.querySelector('[data-attention-needs-you]')).toBeNull();
    expect(toast(mounted).textContent).toContain('Marked !A1 done');
    await interact(() => undoButton(mounted).click());
    expect(mounted.container.querySelector('[data-attention-card="A1"]')).not.toBeNull();
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });
});
