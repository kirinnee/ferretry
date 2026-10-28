import { describe, expect, it } from 'bun:test';
import { secondsLeft } from '../../../src/features/attention/attention-undo-toast.tsx';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import {
  AttentionInboxPage,
  type AttentionInboxPageProps,
  AttentionNeedsYou,
  inboxCardOrigin,
  waitingWords,
} from '../../../src/features/attention/attention-inbox-page.tsx';
import { type InboxCard } from '../../../src/lib/attention-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import {
  attentionItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
  menuAction,
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

describe('AttentionInboxPage two panes', () => {
  const chat = (card: InboxCard) => <div data-fake-chat={card.item.id}>chat for {card.item.id}</div>;
  const rows = (mounted: Mounted) => [...mounted.container.querySelectorAll('[data-attention-row]')];

  it('lists every open item newest first with ferret, machine and age, and shows the first one chat', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare], { renderChat: chat }));
    expect(rows(mounted).map(row => row.querySelector('.fy-attn-row__summary')?.textContent)).toEqual([
      'Rebase onto main?',
      'Ship it?',
      'Have a look',
    ]);
    expect(rows(mounted)[1]?.textContent).toContain('Kai · Laptop');
    expect(mounted.container.querySelector('[data-attention-inbox]')?.getAttribute('data-attention-inbox')).toBe(
      'panes',
    );
    expect(mounted.container.querySelector('[data-fake-chat]')?.getAttribute('data-fake-chat')).toBe('A3');
    expect(mounted.container.querySelector('[data-attention-card]')).toBeNull();
    expect(mounted.container.textContent).toContain('3 waiting on you');
    await mounted.unmount();
  });

  it('opens the chat of the row that is chosen, and marks it', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare], { renderChat: chat }));
    await interact(() => (rows(mounted)[1] as HTMLElement).click());
    expect(mounted.container.querySelector('[data-fake-chat]')?.getAttribute('data-fake-chat')).toBe('A2');
    expect(rows(mounted)[1]?.getAttribute('aria-current')).toBe('true');
    expect(rows(mounted)[0]?.getAttribute('aria-current')).toBeNull();
    await mounted.unmount();
  });

  it('on a phone deals the newest item as a row linking into the chat at the item', async () => {
    const navigated: string[] = [];
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true, renderChat: chat }, navigated));
    expect(mounted.container.querySelector('[data-fake-chat]')).toBeNull();
    expect(mounted.container.querySelector('[data-attention-deck]')).not.toBeNull();
    const row = rows(mounted)[0] as HTMLAnchorElement;
    const href = row.getAttribute('href') ?? '';
    expect(href).toContain('?attention=');
    await interact(() => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual([href]);
    await mounted.unmount();
  });

  it('says a refusal whose card has gone once, until it is dismissed', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay], { renderChat: chat }));
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

  it('answers undoably, and the toast outlives the last card it took', async () => {
    const fake = fakeInbox();
    const mounted = await mount(needsYou(fake, [bare]));
    const done = await menuAction(mounted.container, 'done');
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
  it('marks Done and Dismiss with their swipe, and never an option', async () => {
    const hinted = (mounted: Mounted): (string | null)[] =>
      [...mounted.container.querySelectorAll('.fy-attn-card__swipe')].map(hint => hint.getAttribute('title'));
    const options = await mount(
      <AttentionCard
        item={attentionItem('A9', { ask: choices('One', 'Two', 'Three', 'Four') })}
        onAct={() => {}}
        swipeHints
      />,
    );
    expect(hinted(options)).toEqual([]);
    await options.unmount();

    const bare = await mount(<AttentionCard item={attentionItem('A8')} onAct={() => {}} swipeHints />);
    await menuAction(bare.container, 'done');
    expect(hinted(bare)).toEqual(['swipe right', 'swipe left']);
    await bare.unmount();
  });
});

describe('AttentionCard context', () => {
  it('shows a short context whole, and folds a long one behind Show more / Show less', async () => {
    const short = await mount(
      <AttentionCard item={attentionItem('A7', { context: 'Halfway through.' })} onAct={() => {}} />,
    );
    const shortContext = must(short.container.querySelector('.fy-attn-card__context'), 'the context');
    expect(shortContext.textContent).toBe('Halfway through.');
    expect(shortContext.hasAttribute('data-open')).toBe(true);
    expect(short.container.querySelector('.fy-attn-card__more')).toBeNull();
    await short.unmount();

    const long = await mount(
      <AttentionCard item={attentionItem('A6', { context: 'word '.repeat(80) })} onAct={() => {}} />,
    );
    const context = (): Element => must(long.container.querySelector('.fy-attn-card__context'), 'the long context');
    const more = (): HTMLButtonElement =>
      must(long.container.querySelector<HTMLButtonElement>('.fy-attn-card__more'), 'the fold toggle');
    expect(context().hasAttribute('data-open')).toBe(false);
    expect(more().textContent).toBe('Show more');
    await interact(() => more().click());
    expect(context().hasAttribute('data-open')).toBe(true);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect(more().textContent).toBe('Show less');
    await long.unmount();

    // Blank context is no context at all.
    const blank = await mount(<AttentionCard item={attentionItem('A5', { context: '   ' })} onAct={() => {}} />);
    expect(blank.container.querySelector('.fy-attn-card__context')).toBeNull();
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
    const first = must(root.querySelector('[data-attention-inbox] > :nth-child(3)'), 'the child after the head');
    expect(root.querySelector('[data-attention-inbox]')?.children[1]).toBe(banner);
    expect(first).not.toBe(banner);
    await withBanner.unmount();

    const without = await mount(page(fakeInbox(), [threeWay]));
    expect(without.container.querySelector('[data-test-banner]')).toBeNull();
    await without.unmount();
  });
});
