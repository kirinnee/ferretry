import { describe, expect, it } from 'bun:test';
import type { ResolvedAttentionItem } from '@ferretry/protocol';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import {
  AttentionInboxPage,
  type AttentionInboxPageProps,
  AttentionNeedsYou,
  inboxCardOrigin,
  swipeHintFor,
  waitingWords,
} from '../../../src/features/attention/attention-inbox-page.tsx';
import { secondsLeft } from '../../../src/features/attention/attention-undo-toast.tsx';
import { type InboxCard, type InboxResolved, inboxCardKey } from '../../../src/lib/attention-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import {
  attentionItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
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

const toast = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('[data-attention-undo]'), 'the undo toast');
const undoButton = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-undo-button]'), 'Undo');

describe('attention inbox helpers', () => {
  it('counts the undo window down in whole seconds, never below zero', () => {
    expect(secondsLeft(5_000, 0)).toBe(5);
    expect(secondsLeft(5_000, 4_001)).toBe(1);
    expect(secondsLeft(5_000, 9_000)).toBe(0);
  });

  it('names the head count', () => {
    expect(waitingWords(0)).toBe('Nothing waiting');
    expect(waitingWords(2)).toBe('2 waiting on you');
  });

  it('names a card origin as the sidebar does, linked to the conversation at the item', () => {
    const origin = inboxCardOrigin(twoWay, () => undefined);
    expect(origin.ferret).toBe('Kai');
    expect(origin.task).toBe('Release train');
    expect(origin.machine).toBe('Laptop');
    expect(origin.href).toBe('/d/laptop/session/sess-2?attention=A2');
    expect(inboxCardOrigin(bare, () => undefined).ferret).toBe('Moe');
  });
});

describe('AttentionInboxPage states', () => {
  it('is calm when nothing needs the reader', async () => {
    const mounted = await mount(page(fakeInbox(), []));
    expect(mounted.container.querySelector('[data-attention-empty]')?.textContent).toContain('Nothing needs you');
    expect(mounted.container.querySelector('h1')?.textContent).toBe('Attention');
    await mounted.unmount();
  });

  it('says it is reading while the boards have not answered', async () => {
    const mounted = await mount(page(fakeInbox(), [], { reading: true }));
    expect(mounted.container.querySelector('[data-attention-reading]')?.getAttribute('role')).toBe('status');
    expect(mounted.container.querySelector('[data-attention-empty]')).toBeNull();
    await mounted.unmount();
  });
});

describe('AttentionInboxPage list and card', () => {
  const rows = (mounted: Mounted) => [...mounted.container.querySelectorAll('[data-attention-row]')];
  const rowTitles = (mounted: Mounted) =>
    [...mounted.container.querySelectorAll('[data-attention-row-title]')].map(title => title.textContent);
  const paneItem = (mounted: Mounted) =>
    mounted.container.querySelector('[data-attention-pane] [data-attention-card]')?.getAttribute('data-attention-card');
  const key = (target: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: target, bubbles: true }));

  it('groups the open items by conversation, each row headed by its item, and shows the first one’s card', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    const groups = [...mounted.container.querySelectorAll('[data-attention-group]')];
    expect(groups.map(group => group.querySelector('.fy-attn-group__name')?.textContent)).toEqual([
      'Fix the build · Zoe · Workshop',
      'Release train · Kai · Laptop',
      'Moe · Workshop',
    ]);
    expect(rowTitles(mounted)).toEqual(['Rebase onto main?', 'Ship it?', 'Have a look']);
    expect(rows(mounted)[1]?.textContent).toContain('!A2');
    expect(mounted.container.querySelector('[data-attention-inbox]')?.getAttribute('data-attention-inbox')).toBe(
      'panes',
    );
    expect(paneItem(mounted)).toBe('A3');
    // The card alone: no chat header, tabs or composer around it.
    expect(mounted.container.querySelector('[data-attention-pane] [data-attention-open]')).not.toBeNull();
    await mounted.unmount();
  });

  it('never heads two rows of one conversation with its name', async () => {
    const view = sessionView('dm', { config: { teammate: 'johnnie', label: 'diene-migrate' } });
    const cards = [
      inboxCard(attentionItem('A10', { title: 'Finish the org setup', subject: 'Owner-only settings' } as never), view),
      inboxCard(attentionItem('A9', { subject: 'Keep the CI workflow?' }), view),
    ];
    const mounted = await mount(page(fakeInbox(), cards));
    expect(rowTitles(mounted)).toEqual(['Finish the org setup', 'Keep the CI workflow?']);
    expect(mounted.container.querySelectorAll('[data-attention-group]')).toHaveLength(1);
    expect(mounted.container.querySelector('[data-attention-group-count]')?.textContent).toBe('2');
    await mounted.unmount();
  });

  it('shows the card of the row that is chosen, and marks it', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    await interact(() => (rows(mounted)[1] as HTMLElement).click());
    expect(paneItem(mounted)).toBe('A2');
    expect(rows(mounted)[1]?.getAttribute('aria-current')).toBe('true');
    expect(rows(mounted)[0]?.getAttribute('aria-current')).toBeNull();
    await mounted.unmount();
  });

  it('walks the rows with ↑ / ↓ and j / k, skipping folded groups, but not while the reader types', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    await interact(() => key('ArrowDown'));
    expect(paneItem(mounted)).toBe('A2');
    await interact(() => key('j'));
    expect(paneItem(mounted)).toBe('A1');
    await interact(() => key('j'));
    expect(paneItem(mounted)).toBe('A1');
    await interact(() => key('k'));
    expect(paneItem(mounted)).toBe('A2');
    const find = must(mounted.container.querySelector<HTMLInputElement>('[data-attention-find]'), 'Find');
    await interact(() => find.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(paneItem(mounted)).toBe('A2');
    // Fold the middle conversation: ↓ from the top goes straight past it.
    await interact(() => (rows(mounted)[0] as HTMLElement).click());
    const toggles = [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-attention-group-toggle]')];
    await interact(() => (toggles[1] as HTMLButtonElement).click());
    expect(toggles[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(rows(mounted)).toHaveLength(2);
    await interact(() => key('ArrowDown'));
    expect(paneItem(mounted)).toBe('A1');
    await mounted.unmount();
  });

  it('selects the NEXT item once the selected one is answered, and the undo brings it back', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay, twoWay, bare]));
    await interact(() => (rows(mounted)[1] as HTMLElement).click());
    const ship = must(
      mounted.container.querySelector<HTMLButtonElement>('[data-attention-pane] [data-attention-answer="right"]'),
      'Ship',
    );
    await interact(() => ship.click());
    expect(paneItem(mounted)).toBe('A1');
    expect(rowTitles(mounted)).toEqual(['Rebase onto main?', 'Have a look']);
    await interact(() => undoButton(mounted).click());
    expect(rowTitles(mounted)).toEqual(['Rebase onto main?', 'Ship it?', 'Have a look']);
    await mounted.unmount();
  });

  it('skips forward, several in a row, and past the last says "You skipped N" — Review starts over', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    const skip = () =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-pane] [data-attention-skip]'), 'Skip');
    await interact(() => skip().click());
    expect(paneItem(mounted)).toBe('A2');
    await interact(() => skip().click());
    expect(paneItem(mounted)).toBe('A1');
    await interact(() => skip().click());
    expect(paneItem(mounted)).toBeUndefined();
    const end = must(mounted.container.querySelector('[data-attention-queue-end]'), 'the end of the queue');
    expect(end.textContent).toContain('You skipped 3 items');
    expect(mounted.container.querySelector('[data-attention-row][aria-current]')).toBeNull();
    await interact(() => must(end.querySelector<HTMLButtonElement>('[data-attention-review]'), 'Review').click());
    expect(paneItem(mounted)).toBe('A3');
    await mounted.unmount();
  });

  it('answering the last item after skipping the others ends the queue instead of jumping back to the first', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    const skip = () =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-pane] [data-attention-skip]'), 'Skip');
    await interact(() => skip().click());
    await interact(() => skip().click());
    expect(paneItem(mounted)).toBe('A1');
    const done = must(
      mounted.container.querySelector<HTMLButtonElement>('[data-attention-pane] [data-attention-answer="right"]'),
      'Got it',
    );
    await interact(() => done.click());
    expect(paneItem(mounted)).toBeUndefined();
    expect(mounted.container.querySelector('[data-attention-queue-end]')?.textContent).toContain('You skipped 2 items');
    await mounted.unmount();
  });

  it('narrows to one machine and to what Find matches, and offers the way back when nothing does', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    const machine = must(mounted.container.querySelector<HTMLSelectElement>('[data-attention-machine]'), 'machines');
    expect([...machine.options].map(option => option.textContent)).toEqual(['All machines', 'Workshop', 'Laptop']);
    await interact(() => {
      machine.value = 'laptop';
      machine.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(rowTitles(mounted)).toEqual(['Ship it?']);
    expect(paneItem(mounted)).toBe('A2');
    await interact(() => {
      machine.value = '';
      machine.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const find = must(mounted.container.querySelector<HTMLInputElement>('[data-attention-find]'), 'Find');
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(find, 'zzz');
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows(mounted)).toHaveLength(0);
    const back = must(mounted.container.querySelector('[data-attention-no-match] button'), 'Show everything');
    await interact(() => (back as HTMLButtonElement).click());
    expect(rows(mounted)).toHaveLength(3);
    await mounted.unmount();
  });

  it('draws no machine filter while every item is on one machine', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, bare]));
    expect(mounted.container.querySelector('[data-attention-machine]')).toBeNull();
    await mounted.unmount();
  });

  it('says "Updating" in the header while boards are read, instead of over the content', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay], { reading: true }));
    const mark = must(mounted.container.querySelector('[data-attention-updating]'), 'the Updating mark');
    expect(mark.closest('.fy-attn-inbox__head')).not.toBeNull();
    expect(mounted.container.querySelector('[data-attention-reading]')).toBeNull();
    await mounted.unmount();
  });

  it('reads the ferret’s last messages only when the fold is opened, and shows them', async () => {
    const reads: string[] = [];
    const mounted = await mount(
      page(fakeInbox(), [twoWay], {
        readRecent: async card => {
          reads.push(card.item.id);
          return [{ text: 'Cut the release branch.' }, { text: 'Raised !A2 about shipping.' }];
        },
      }),
    );
    const toggle = must(
      mounted.container.querySelector<HTMLButtonElement>('[data-attention-pane] [data-attention-recent-toggle]'),
      'the fold',
    );
    expect(toggle.textContent).toBe('Last messages from Kai');
    expect(reads).toEqual([]);
    await interact(() => toggle.click());
    await flush();
    expect(reads).toEqual(['A2']);
    expect(
      [...mounted.container.querySelectorAll('[data-attention-recent-message]')].map(message => message.textContent),
    ).toEqual(['Cut the release branch.', 'Raised !A2 about shipping.']);
    // Inside the scrolling detail, so the answer bar stays pinned under it.
    expect(toggle.closest('[data-attention-scroll]')).not.toBeNull();
    await mounted.unmount();
  });

  it('says a failed read in the fold, and draws no fold when the host cannot read', async () => {
    const failing = await mount(
      page(fakeInbox(), [twoWay], {
        readRecent: async () => {
          throw new Error('machine offline');
        },
      }),
    );
    await interact(() =>
      must(failing.container.querySelector<HTMLButtonElement>('[data-attention-recent-toggle]'), 'fold').click(),
    );
    await flush();
    expect(failing.container.querySelector('[data-attention-recent] [role="alert"]')?.textContent).toContain(
      'machine offline',
    );
    await failing.unmount();
    const none = await mount(page(fakeInbox(), [twoWay]));
    expect(none.container.querySelector('[data-attention-recent]')).toBeNull();
    await none.unmount();
  });

  it('ticks a to-do step through the host', async () => {
    const ticks: [string, number, boolean][] = [];
    const todo = inboxCard(
      attentionItem('A5', { subject: 'Do the steps', steps: ['one', 'two'], ask: { kind: 'task' } }),
    );
    const mounted = await mount(
      page(fakeInbox(), [todo], {
        onProgress: async (card, step, done) => {
          ticks.push([card.item.id, step, done]);
        },
      }),
    );
    const box = must(
      mounted.container.querySelector<HTMLInputElement>('[data-attention-pane] input[type="checkbox"]'),
      'the first step',
    );
    await interact(() => box.click());
    await flush();
    expect(ticks).toEqual([['A5', 0, true]]);
    await mounted.unmount();
  });

  it('on a phone lists the items, opens a tapped one full screen as the whole card, and goes back', async () => {
    const navigated: string[] = [];
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true }, navigated));
    const inbox = () => mounted.container.querySelector('[data-attention-inbox]')?.getAttribute('data-attention-inbox');
    expect(inbox()).toBe('list');
    expect(mounted.container.querySelector('.fy-attn-deck__top')).toBeNull();
    await interact(() => (rows(mounted)[1] as HTMLElement).click());
    expect(inbox()).toBe('card');
    const top = mounted.container.querySelector('.fy-attn-deck__top');
    expect(top?.querySelector('[data-attention-title]')?.textContent).toBe('Ship it?');
    // Only what comes AFTER the tapped item is dealt, and it was the last one.
    expect(mounted.container.querySelector('.fy-attn-inbox__hint')?.textContent).toBe(
      'Swipe ← Hold · → Ship · ↓ Discuss',
    );
    const link = top?.querySelector<HTMLAnchorElement>('a[href*="?attention="]');
    const href = link?.getAttribute('href') ?? '';
    expect(href).toContain('?attention=A2');
    await interact(() => link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual([href]);
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-back]'), 'Back').click(),
    );
    expect(inbox()).toBe('list');
    await mounted.unmount();
  });

  it('on a phone deals only the items AFTER the tapped one, skips forward, and ends with "You skipped N"', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare], { phone: true, initialOpen: twoWay.key }));
    const top = () => mounted.container.querySelector('.fy-attn-deck__top [data-attention-card]');
    expect(top()?.getAttribute('data-attention-card')).toBe('A2');
    expect(mounted.container.querySelectorAll('.fy-attn-deck__peek')).toHaveLength(1);
    expect(mounted.container.querySelector('.fy-attn-inbox__hint')?.textContent).toContain('1 more after this one');
    const skip = () =>
      must(mounted.container.querySelector<HTMLButtonElement>('.fy-attn-deck__top [data-attention-skip]'), 'Skip');
    await interact(() => skip().click());
    expect(top()?.getAttribute('data-attention-card')).toBe('A1');
    await interact(() => skip().click());
    expect(top()).toBeNull();
    expect(mounted.container.querySelector('[data-attention-queue-end]')?.textContent).toContain('You skipped 3 items');
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-attention-review]'), 'Review').click(),
    );
    expect(top()?.getAttribute('data-attention-card')).toBe('A3');
    await mounted.unmount();
  });

  it('on a phone deals the three-way card’s answers left · up · right', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true, initialOpen: threeWay.key }));
    const top = mounted.container.querySelector('.fy-attn-deck__top');
    const answers = [...(top?.querySelectorAll('[data-attention-answer]') ?? [])].map(button =>
      button.getAttribute('data-attention-option'),
    );
    expect(answers).toEqual(['Skip', 'Wait', 'Rebase now']);
    expect(mounted.container.querySelector('.fy-attn-inbox__hint')?.textContent).toBe(
      '1 more after this one · Swipe ← Skip · ↑ Wait · → Rebase now · ↓ Discuss',
    );
    await mounted.unmount();
  });

  it('names the swipes of the card on top, and says a text-only card is answered in words', () => {
    expect(swipeHintFor(undefined)).toBe('');
    expect(swipeHintFor(twoWay)).toBe('Swipe ← Hold · → Ship · ↓ Discuss');
    const words = inboxCard(
      attentionItem('A9', { subject: 'What should the invite say?', ask: { kind: 'open-question' } }),
    );
    expect(swipeHintFor(words)).toBe('Reply in words, or open the chat · ↓ Discuss');
  });

  it('leaves ↓ Discuss out of the hint where nobody can discuss the item', () => {
    const human = inboxCard(
      attentionItem('A9', {
        subject: 'Mine',
        ask: choices('Ship', 'Hold'),
        raisedBy: 'human',
        raisedBySession: null,
        raisedByName: null,
      } as never),
    );
    expect(swipeHintFor(human)).toBe('Swipe ← Hold · → Ship');
    const humanWords = inboxCard(
      attentionItem('A8', {
        ask: { kind: 'open-question' },
        raisedBy: 'human',
        raisedBySession: null,
        raisedByName: null,
      } as never),
    );
    expect(swipeHintFor(humanWords)).toBe('Reply in words, or open the chat');
  });

  it('marks a row "In discussion" in the list, and not one that is not', async () => {
    const discussing = inboxCard(
      attentionItem('A6', {
        subject: 'Premise check',
        ask: choices('Yes', 'No'),
        waitingOn: 'ferret',
        askedAt: '2026-08-01T11:30:00.000Z',
        waitingFor: 'discussion',
      }),
    );
    const mounted = await mount(page(fakeInbox(), [discussing, twoWay]));
    const marks = [...mounted.container.querySelectorAll('[data-attention-row-discussion]')];
    expect(marks.map(mark => mark.textContent)).toEqual(['In discussion']);
    expect(marks[0]?.closest('[data-attention-row]')?.textContent).toContain('Premise check');
    await mounted.unmount();
  });

  it('on a phone says a to-do is waiting on its ferret, with no Done swipe to offer', async () => {
    const waiting = inboxCard(
      attentionItem('A8', {
        subject: 'Rotate the relay key',
        ask: { kind: 'task' },
        waitingOn: 'ferret',
        askedAt: '2026-08-01T11:00:00.000Z',
      }),
      sessionView('sess-4', { config: { teammate: 'ottilie', name: undefined } }),
    );
    const mounted = await mount(page(fakeInbox(), [waiting], { phone: true, initialOpen: waiting.key }));
    expect(mounted.container.querySelector('[data-attention-waiting]')?.textContent).toContain('Waiting on');
    await mounted.unmount();
  });

  it('says a refusal whose card has gone once, until it is dismissed', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay]));
    expect(mounted.container.querySelector('[data-attention-failures]')).toBeNull();
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

  it('keeps the answer bar outside the scrolling detail, and opens the reply box three lines tall', async () => {
    const long = inboxCard(
      attentionItem('A5', {
        subject: 'Point the sync at the new org',
        steps: ['one', 'two', 'three', 'four', 'five'],
      }),
    );
    const mounted = await mount(needsYou(fakeInbox(), [long]));
    const card = must(mounted.container.querySelector<HTMLElement>('[data-attention-card="A5"]'), 'the card');
    const scroll = must(card.querySelector<HTMLElement>('[data-attention-scroll]'), 'the detail scroller');
    expect(scroll.parentElement).toBe(card);
    expect(scroll.textContent).toContain('five');
    const bar = must(card.querySelector<HTMLElement>('[data-attention-answer="right"]'), 'the answer bar');
    expect(scroll.contains(bar)).toBe(false);
    await interact(() => must(card.querySelector<HTMLButtonElement>('[data-attention-reply-toggle]'), 'Reply').click());
    expect(
      must(card.querySelector<HTMLTextAreaElement>('[data-attention-reply]'), 'the reply box').getAttribute('rows'),
    ).toBe('3');
    await mounted.unmount();
  });

  it('answers undoably, and the toast outlives the last card it took', async () => {
    const fake = fakeInbox();
    const mounted = await mount(needsYou(fake, [bare]));
    const done = must(
      mounted.container.querySelector<HTMLButtonElement>('[data-attention-answer="right"]'),
      'the Got it answer',
    );
    await interact(() => done.click());
    expect(mounted.container.querySelector('[data-attention-needs-you]')).toBeNull();
    expect(toast(mounted).textContent).toContain('Marked !A1 done');
    await interact(() => undoButton(mounted).click());
    expect(mounted.container.querySelector('[data-attention-card="A1"]')).not.toBeNull();
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });
});

describe('AttentionCard swipe hints', () => {
  it('marks each swiped answer with its direction, and never an extra option', async () => {
    const hinted = (mounted: Mounted): (string | null)[] =>
      [...mounted.container.querySelectorAll('[data-attention-answer], [data-attention-option]')].map(
        button => /swipe (left|up|right)/.exec(button.textContent ?? '')?.[0] ?? null,
      );
    const options = await mount(
      <AttentionCard
        item={attentionItem('A9', { ask: choices('One', 'Two', 'Three', 'Four') })}
        onAct={() => {}}
        swipeHints
      />,
    );
    expect(hinted(options)).toEqual(['swipe left', 'swipe up', 'swipe right', null]);
    await options.unmount();

    const bare = await mount(<AttentionCard item={attentionItem('A8')} onAct={() => {}} swipeHints />);
    expect(hinted(bare)).toEqual(['swipe right']);
    await bare.unmount();

    const plain = await mount(<AttentionCard item={attentionItem('A7')} onAct={() => {}} />);
    expect(hinted(plain)).toEqual([null]);
    await plain.unmount();
  });
});

describe('AttentionCard context', () => {
  it('draws the context open and whole, however long, and nothing for a blank one', async () => {
    const short = await mount(
      <AttentionCard item={attentionItem('A7', { context: 'Halfway through.' })} onAct={() => {}} />,
    );
    const shortContext = must(short.container.querySelector('[data-attention-section="context"]'), 'the context');
    expect(shortContext.textContent).toContain('Halfway through.');
    expect(short.container.querySelector('[data-attention-body-toggle]')).toBeNull();
    await short.unmount();

    const long = await mount(
      <AttentionCard item={attentionItem('A6', { context: 'word '.repeat(80) })} onAct={() => {}} />,
    );
    const longContext = must(
      long.container.querySelector('[data-attention-section="context"] .fy-attn-sec__body'),
      'the long context',
    );
    expect(longContext.textContent?.match(/word/gu)).toHaveLength(80);
    expect(long.container.querySelector('[data-attention-body-toggle]')).toBeNull();
    await long.unmount();

    const blank = await mount(
      <AttentionCard item={attentionItem('A5', { context: '   ', subject: 'Same', why: 'Same' })} onAct={() => {}} />,
    );
    expect(blank.container.querySelector('[data-attention-section="context"]')).toBeNull();
    await blank.unmount();
  });
});

describe('AttentionInboxPage banner slot', () => {
  it('draws the banner above the cards, and nothing when none is given', async () => {
    const withBanner = await mount(
      page(fakeInbox(), [threeWay], { banner: <p data-test-banner="">Notifications are off</p> }),
    );
    const root = withBanner.container;
    const banner = must(root.querySelector('[data-test-banner]'), 'the banner');
    const first = must(root.querySelector('[data-attention-inbox] > :nth-child(3)'), 'the filter after the banner');
    expect(root.querySelector('[data-attention-inbox]')?.children[1]).toBe(banner);
    expect(first).not.toBe(banner);
    await withBanner.unmount();

    const without = await mount(page(fakeInbox(), [threeWay]));
    expect(without.container.querySelector('[data-test-banner]')).toBeNull();
    await without.unmount();
  });
});

describe('AttentionInboxPage refusals whose card has gone', () => {
  it('says the refusal and clears it on Dismiss', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, []));
    fake.failNext = 'machine said no';
    await interact(() => fake.deferred.schedule(threeWay, { kind: 'dismiss', label: 'Dismiss' } as never));
    await advance(fake, 10_000);
    const failures = must(mounted.container.querySelector('[data-attention-failures]'), 'the refusals');
    expect(failures.textContent).toContain('machine said no');
    const clear = must(failures.querySelector<HTMLButtonElement>('button'), 'the clear button');
    await interact(() => clear.click());
    expect(mounted.container.querySelector('[data-attention-failures]')).toBeNull();
    await mounted.unmount();
  });
});

describe('AttentionInboxPage Resolved filter', () => {
  const record = (id: string, resolvedAt: string): ResolvedAttentionItem =>
    ({
      ...attentionItem(id),
      resolvedAt,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: null,
      disposition: 'done',
    }) as unknown as ResolvedAttentionItem;
  const row = (id: string, resolvedAt: string): InboxResolved => {
    const view = sessionView('sess-1', { config: { teammate: 'zoe', name: 'Fix the build' } });
    return {
      key: inboxCardKey(daemonId('studio'), view.config.id, id),
      daemonId: daemonId('studio'),
      machineName: 'Workshop',
      view,
      record: record(id, resolvedAt),
    };
  };
  const mountFilter = (extra: { resolved?: readonly InboxResolved[]; resolvedReading?: boolean } = {}) => {
    const fake = fakeInbox();
    const navigated: string[] = [];
    let loads = 0;
    const mounted = mount(
      <InboxHarness
        cards={[threeWay]}
        fake={fake}
        loadResolved={() => {
          loads += 1;
        }}
        render={inbox => (
          <AttentionInboxPage
            clock={fake.clock.now}
            inbox={inbox}
            now={NOW}
            onNavigate={to => navigated.push(to)}
            phone={false}
          />
        )}
        {...extra}
      />,
    );
    return { mounted, navigated, loads: () => loads };
  };
  const option = (root: ParentNode, which: 'open' | 'resolved') =>
    must(root.querySelector<HTMLButtonElement>(`[data-attention-filter-option="${which}"]`), which);

  it('starts on Open, and choosing Resolved reads the history and swaps the list', async () => {
    const { mounted, loads } = mountFilter({
      resolved: [row('A1', '2026-08-01T09:00:00.000Z'), row('A2', '2026-08-01T10:00:00.000Z')],
    });
    const view = await mounted;
    const root = view.container;
    expect(option(root, 'open').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-attention-resolved-pane]')).toBeNull();
    await interact(() => option(root, 'resolved').click());
    expect(loads()).toBe(1);
    expect(option(root, 'resolved').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-attention-resolved-pane]')).not.toBeNull();
    expect(
      [...root.querySelectorAll('[data-attention-record]')].map(r => r.getAttribute('data-attention-record')),
    ).toEqual(['A1', 'A2']);
    expect(root.querySelector('[data-attention-record-origin]')?.textContent).toContain('Workshop');
    await interact(() => option(root, 'open').click());
    expect(root.querySelector('[data-attention-resolved-pane]')).toBeNull();
    await view.unmount();
  });

  it('a record links to its conversation', async () => {
    const { mounted, navigated } = mountFilter({ resolved: [row('A1', '2026-08-01T09:00:00.000Z')] });
    const view = await mounted;
    await interact(() => option(view.container, 'resolved').click());
    await interact(() =>
      must(view.container.querySelector<HTMLElement>('.fy-attn-panel__record-link'), 'link').click(),
    );
    expect(navigated).toHaveLength(1);
    expect(navigated[0]).toContain('A1');
    await view.unmount();
  });

  it('says it is reading, then says nothing is resolved', async () => {
    const reading = await mountFilter({ resolvedReading: true }).mounted;
    await interact(() => option(reading.container, 'resolved').click());
    expect(reading.container.textContent).toContain('Reading resolved items');
    await reading.unmount();

    const none = await mountFilter().mounted;
    await interact(() => option(none.container, 'resolved').click());
    expect(none.container.querySelector('[data-attention-resolved-empty]')?.textContent).toContain('Nothing resolved');
    await none.unmount();
  });
});
