import { describe, expect, it } from 'bun:test';
import { LANE_PROPOSAL_ANSWERS, laneProposalReference, type ResolvedAgendaItem } from '@ferretry/protocol';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import { AgendaDetail } from '../../../src/features/agenda/agenda-detail.tsx';
import {
  AgendaInboxPage,
  type AgendaInboxPageProps,
  AgendaNeedsYou,
  inboxCardOrigin,
  waitingWords,
} from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { secondsLeft } from '../../../src/features/agenda/agenda-undo-toast.tsx';
import { type InboxCard, type InboxResolved, inboxCardKey } from '../../../src/lib/agenda-inbox.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
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

const threeWay = inboxCard(
  agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Skip') }),
);
const twoWay = inboxCard(
  agendaItem('A2', {
    subject: 'Ship it?',
    ask: choices('Ship', 'Hold'),
    waitingSince: '2026-08-01T10:00:00.000Z',
  }),
  sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } }),
  'Laptop',
  daemonId('laptop'),
);
const bare = inboxCard(
  agendaItem('A1', { subject: 'Have a look', waitingSince: '2026-08-01T09:00:00.000Z' }),
  sessionView('sess-3', { config: { teammate: 'moe', name: undefined } }),
);

const page = (
  fake: FakeInbox,
  cards: readonly InboxCard[],
  props: Partial<AgendaInboxPageProps> & { reading?: boolean } = {},
  navigated: string[] = [],
) => {
  const { reading = false, ...rest } = props;
  return (
    <InboxHarness
      cards={cards}
      fake={fake}
      reading={reading}
      render={inbox => (
        <AgendaInboxPage
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
  must(mounted.container.querySelector<HTMLElement>('[data-agenda-undo]'), 'the undo toast');
const undoButton = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-undo-button]'), 'Undo');

describe('agenda inbox helpers', () => {
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
    expect(origin.href).toBe('/d/laptop/session/sess-2?agenda=A2');
    expect(inboxCardOrigin(bare, () => undefined).ferret).toBe('Moe');
  });
});

const notice = inboxCard(
  agendaItem('N1', { notice: true, subject: 'The build finished', why: 'All green.' } as never),
  sessionView('sess-5', { config: { teammate: 'ottilie', name: 'Nightly build' } }),
);
const stopped = inboxCard(
  agendaItem('S1', { subject: 'Pick a database', ask: choices('Postgres', 'SQLite') }),
  sessionView('sess-6', {
    config: { teammate: 'piper', name: undefined },
    state: { attention: { open: 1, first: 'S1', ask: 'Pick', latestAt: '2026-08-01T11:00:00.000Z', stopped: true } },
  } as never),
);
const withFerret = inboxCard(
  agendaItem('F1', { subject: 'Draft the plan', waitingOn: 'ferret', waitingFor: 'info' } as never),
  sessionView('sess-7', { config: { teammate: 'hadi', name: undefined } }),
);
const wardenAsk = inboxCard(
  agendaItem('W1', {
    notice: true,
    subject: 'Spend is over budget',
    raisedBy: 'daemon',
    sourceRef: 'warden:ask:fleet:spend:laptop',
  } as never),
  sessionView('sess-8', { config: { teammate: 'warden', name: undefined } }),
  'Laptop',
  daemonId('laptop'),
);
const wardenWorkshop = inboxCard(
  agendaItem('W2', { subject: 'Review the verdict', raisedBy: 'daemon', sourceRef: 'warden:ask:verdict' } as never),
  sessionView('sess-9', { config: { teammate: 'warden', name: undefined } }),
);

const rows = (mounted: Mounted) => [...mounted.container.querySelectorAll('[data-agenda-row]')];
const sectionIds = (mounted: Mounted) =>
  [...mounted.container.querySelectorAll('[data-agenda-section]')].map(section =>
    section.getAttribute('data-agenda-section'),
  );
const sectionTitles = (mounted: Mounted) =>
  [...mounted.container.querySelectorAll('[data-agenda-section] h2')].map(title =>
    title.textContent?.replace(/\d+$/u, ''),
  );
const groupFerrets = (mounted: Mounted, section: string) =>
  [...(mounted.container.querySelectorAll(`[data-agenda-section="${section}"] .fy-inbox-group__ferret`) ?? [])].map(
    name => name.textContent,
  );
const press = async (key: string): Promise<void> => {
  await interact(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

describe('AgendaInboxPage states', () => {
  it('is calm when nothing needs the reader, and never says "Attention"', async () => {
    const mounted = await mount(page(fakeInbox(), []));
    expect(mounted.container.querySelector('[data-agenda-empty]')?.textContent).toContain('Nothing needs you');
    expect(mounted.container.querySelector('h1')?.textContent).toBe('Inbox');
    expect(mounted.container.textContent).not.toContain('Attention');
    expect(mounted.container.querySelector('[aria-label="Find in Inbox"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('says it is reading while the boards have not answered', async () => {
    const mounted = await mount(page(fakeInbox(), [], { reading: true }));
    expect(mounted.container.querySelector('[data-agenda-reading]')?.getAttribute('role')).toBe('status');
    expect(mounted.container.querySelector('[data-agenda-empty]')).toBeNull();
    await mounted.unmount();
  });
});

describe('AgendaInboxPage sections', () => {
  it('draws Stopped on you, then Needs you, then With ferrets, each only when it has something', async () => {
    const mounted = await mount(page(fakeInbox(), [withFerret, threeWay, stopped]));
    expect(sectionIds(mounted)).toEqual(['stopped', 'needs-you', 'with-ferrets']);
    expect(sectionTitles(mounted)).toEqual(['Stopped on you', 'Needs you', 'With ferrets']);
    expect(groupFerrets(mounted, 'stopped')).toEqual(['Piper']);
    expect(groupFerrets(mounted, 'needs-you')).toEqual(['Zoe']);
    await mounted.unmount();
    const plain = await mount(page(fakeInbox(), [threeWay]));
    expect(sectionIds(plain)).toEqual(['needs-you']);
    await plain.unmount();
  });

  it('groups by ferret across machines and leads with the most urgent, saying ferret, task and machine', async () => {
    const mounted = await mount(page(fakeInbox(), [bare, twoWay, threeWay]));
    expect(groupFerrets(mounted, 'needs-you')).toHaveLength(3);
    const heads = [...mounted.container.querySelectorAll('.fy-inbox-group__head')].map(head => head.textContent);
    expect(heads.some(head => head?.includes('Kai') && head.includes('Release train') && head.includes('Laptop'))).toBe(
      true,
    );
    await mounted.unmount();
  });

  it('separates the ferret, its task and its machine with real dots, never a collapsed space', async () => {
    const mounted = await mount(page(fakeInbox(), [twoWay]));
    const head = must(mounted.container.querySelector('.fy-inbox-group__head'), 'the group head');
    const dots = [...head.querySelectorAll('.fy-inbox-group__dot')];
    expect(dots.length).toBeGreaterThanOrEqual(1);
    expect(dots.every(dot => dot.textContent === '·' && dot.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(head.querySelector('.fy-inbox-group__machine')?.textContent).not.toContain('·');
    await mounted.unmount();
  });

  it('puts the chevron after the With ferrets title and count', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, withFerret]));
    const toggle = must(
      mounted.container.querySelector('[data-agenda-section-toggle="with-ferrets"]'),
      'the With ferrets toggle',
    );
    const last = toggle.lastElementChild;
    expect(last?.classList.contains('fy-attn-group__chevron')).toBe(true);
    expect(toggle.firstChild?.textContent).toBe('With ferrets');
    await mounted.unmount();
  });

  it('shows no "Needs you" pill on a plain needs-you row', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay]));
    expect(rows(mounted)).toHaveLength(1);
    const tones = [...mounted.container.querySelectorAll('[data-agenda-status]')].map(pill =>
      pill.getAttribute('data-tone'),
    );
    expect(tones).not.toContain('needs-you');
    expect(mounted.container.textContent).not.toContain('Needs you ·');
    await mounted.unmount();
  });

  it('keeps With ferrets collapsed until it is asked for, and folds it away again', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, withFerret]));
    const toggle = () =>
      must(
        mounted.container.querySelector<HTMLButtonElement>('[data-agenda-section-toggle="with-ferrets"]'),
        'the With ferrets toggle',
      );
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(mounted.container.textContent).not.toContain('Draft the plan');
    expect(rows(mounted)).toHaveLength(1);
    await interact(() => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(mounted.container.textContent).toContain('Draft the plan');
    expect(rows(mounted)).toHaveLength(2);
    await interact(() => toggle().click());
    expect(rows(mounted)).toHaveLength(1);
    await mounted.unmount();
  });

  it('says nothing needs the reader when only ferrets hold items, and still offers With ferrets', async () => {
    const mounted = await mount(page(fakeInbox(), [withFerret]));
    expect(mounted.container.textContent).toContain('Nothing needs you right now.');
    expect(sectionIds(mounted)).toEqual(['with-ferrets']);
    await mounted.unmount();
  });

  it('counts items on the reader’s turn plus unread notices in the head badge, not what is with ferrets', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, notice, withFerret]));
    expect(mounted.container.querySelector('h1')?.textContent).toContain('3');
    await mounted.unmount();
  });
});

describe('AgendaInboxPage rows', () => {
  it('links every item to its ferret’s chat at the item, and opens it HERE on a plain tap', async () => {
    const navigated: string[] = [];
    const mounted = await mount(page(fakeInbox(), [twoWay], {}, navigated));
    const link = must(mounted.container.querySelector<HTMLAnchorElement>('[data-agenda-row]'), 'the item row');
    expect(link.getAttribute('href')).toBe('/d/laptop/session/sess-2?agenda=A2');
    expect(link.textContent).toContain('Ship it?');
    expect(link.textContent).toContain('!A2');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual([]);
    expect(mounted.container.querySelector('[data-agenda-inbox]')?.getAttribute('data-agenda-inbox')).toBe('card');
    expect(
      mounted.container.querySelector('.fy-attn-deck__top [data-agenda-view]')?.getAttribute('data-agenda-view'),
    ).toBe('A2');
    await mounted.unmount();
  });

  it('says who raised an item when it is not the ferret whose group it sits in', async () => {
    const raised = inboxCard(
      agendaItem('W3', { subject: 'Drop the cache?', raisedBy: 'daemon', sourceRef: 'warden:ask:cache' } as never),
      sessionView('sess-10', { config: { teammate: 'kai', name: undefined } }),
    );
    const mounted = await mount(page(fakeInbox(), [raised, twoWay]));
    const authors = [...mounted.container.querySelectorAll('[data-agenda-row-author]')].map(node => node.textContent);
    expect(authors).toEqual(['From Warden']);
    await mounted.unmount();
  });

  it('clears the Find box with Escape, and leaves an empty box alone', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay]));
    const find = must(mounted.container.querySelector<HTMLInputElement>('[data-agenda-find]'), 'Find');
    const pressEscape = () =>
      interact(() => {
        find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
    await pressEscape();
    expect(rows(mounted)).toHaveLength(2);
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(find, 'nothing like this');
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows(mounted)).toHaveLength(0);
    await pressEscape();
    expect(find.value).toBe('');
    expect(rows(mounted)).toHaveLength(2);
    await mounted.unmount();
  });

  it('links a ferret’s header to its chat', async () => {
    const mounted = await mount(page(fakeInbox(), [twoWay]));
    const head = must(mounted.container.querySelector<HTMLAnchorElement>('.fy-inbox-group__head'), 'the group head');
    expect(head.getAttribute('href')).toBe('/d/laptop/session/sess-2');
    await mounted.unmount();
  });

  it('draws a notification as a line and a time inside its ferret’s group, below the items', async () => {
    const withItem = inboxCard(agendaItem('A9', { subject: 'Merge it?' }), notice.view);
    const mounted = await mount(page(fakeInbox(), [notice, withItem]));
    const group = must(mounted.container.querySelector('[data-agenda-group]'), 'the group');
    const lines = [...group.querySelectorAll('[data-agenda-row]')].map(row => row.getAttribute('data-agenda-row'));
    expect(lines).toEqual([withItem.key, notice.key]);
    const line = must(group.querySelector('[data-agenda-notice]'), 'the notice');
    expect(line.textContent).toContain('The build finished');
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/d/workshop/session/sess-5?agenda=N1');
    expect(line.querySelector('[data-agenda-clear]')?.textContent).toBe('Clear');
    await mounted.unmount();
  });

  it('clears a notice with Clear, undoably, through the same window', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [notice]));
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-clear]'), 'Clear').click(),
    );
    expect(mounted.container.querySelector('[data-agenda-notice]')).toBeNull();
    expect(toast(mounted).textContent).toContain('Cleared !N1');
    await advance(fake, 6_000);
    expect(fake.commits.map(commit => [commit.card.item.id, commit.action.kind])).toEqual([['N1', 'resolve']]);
    await mounted.unmount();
  });

  it('opens the chat and clears the notice when it is tapped', async () => {
    const fake = fakeInbox();
    const navigated: string[] = [];
    const mounted = await mount(page(fake, [notice], {}, navigated));
    const link = must(mounted.container.querySelector<HTMLAnchorElement>('[data-agenda-notice] a'), 'the notice');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual(['/d/workshop/session/sess-5?agenda=N1']);
    await advance(fake, 6_000);
    expect(fake.commits.map(commit => commit.card.item.id)).toEqual(['N1']);
    await mounted.unmount();
  });

  it('walks the rows with j / k and the arrows, never while the reader types', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare]));
    const selected = () => mounted.container.querySelector('[data-selected]')?.getAttribute('data-agenda-row');
    expect(selected()).toBeUndefined();
    await press('j');
    const first = selected();
    expect(first).toBeDefined();
    await press('j');
    expect(selected()).not.toBe(first);
    await press('k');
    expect(selected()).toBe(first);
    const find = must(mounted.container.querySelector<HTMLInputElement>('[data-agenda-find]'), 'Find');
    await interact(() => find.focus());
    await interact(() => {
      find.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
    });
    expect(selected()).toBe(first);
    await mounted.unmount();
  });

  it('narrows to one machine and to what Find matches, and offers the way back when nothing does', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay]));
    expect(mounted.container.querySelector('[data-agenda-machine]')).not.toBeNull();
    const machine = must(mounted.container.querySelector<HTMLSelectElement>('[data-agenda-machine]'), 'machines');
    await interact(() => {
      machine.value = 'laptop';
      machine.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(rows(mounted)).toHaveLength(1);
    const find = must(mounted.container.querySelector<HTMLInputElement>('[data-agenda-find]'), 'Find');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(find, 'nothing like this');
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows(mounted)).toHaveLength(0);
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('.fy-attn-inbox__clear'), 'Show everything').click(),
    );
    expect(rows(mounted)).toHaveLength(2);
    await mounted.unmount();
  });

  it('draws no machine filter while every item is on one machine', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, bare]));
    expect(mounted.container.querySelector('[data-agenda-machine]')).toBeNull();
    await mounted.unmount();
  });

  it('says "Updating" in the header while boards are read, instead of over the content', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay], { reading: true }));
    expect(mounted.container.querySelector('[data-agenda-updating]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-agenda-reading]')).toBeNull();
    await mounted.unmount();
  });

  it('says a refusal whose card has gone once, until it is dismissed', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, [threeWay]));
    expect(mounted.container.querySelector('[data-agenda-failures]')).toBeNull();
    await mounted.unmount();
  });
});

describe('AgendaInboxPage Warden filter', () => {
  const kept = (mounted: Mounted) => rows(mounted).map(row => row.getAttribute('data-agenda-row'));

  it('shows only what the Warden raised, across every machine, with a chip to clear it', async () => {
    const cleared: string[] = [];
    const mounted = await mount(
      page(fakeInbox(), [threeWay, wardenAsk, wardenWorkshop, notice], {
        from: 'warden',
        onClearFrom: () => cleared.push('cleared'),
      }),
    );
    expect(kept(mounted).sort()).toEqual([wardenAsk.key, wardenWorkshop.key].sort());
    const chip = must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-from-chip]'), 'the chip');
    expect(chip.textContent).toBe('From Warden');
    await interact(() => chip.click());
    expect(cleared).toEqual(['cleared']);
    await mounted.unmount();
  });

  it('draws no chip and shows everything when the filter is off', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, wardenAsk]));
    expect(mounted.container.querySelector('[data-agenda-from-chip]')).toBeNull();
    expect(rows(mounted)).toHaveLength(2);
    await mounted.unmount();
  });

  it('says nothing matches when the Warden raised nothing, and offers the way back', async () => {
    const cleared: string[] = [];
    const mounted = await mount(
      page(fakeInbox(), [threeWay], { from: 'warden', onClearFrom: () => cleared.push('cleared') }),
    );
    expect(mounted.container.querySelector('[data-agenda-no-match]')).not.toBeNull();
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('.fy-attn-inbox__clear'), 'Show everything').click(),
    );
    expect(cleared).toEqual(['cleared']);
    await mounted.unmount();
  });
});

describe('AgendaInboxPage on a phone', () => {
  const quick = (mounted: Mounted) =>
    must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-quick]'), 'Answer quickly');
  const top = (mounted: Mounted) => mounted.container.querySelector('.fy-attn-deck__top [data-agenda-view]');

  it('lists the items and offers "Answer quickly" only where something is on the reader’s turn', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true }));
    expect(mounted.container.querySelector('[data-agenda-inbox]')?.getAttribute('data-agenda-inbox')).toBe('list');
    expect(quick(mounted).textContent).toContain('Answer quickly');
    expect(top(mounted)).toBeNull();
    await mounted.unmount();
    const idle = await mount(page(fakeInbox(), [withFerret], { phone: true }));
    expect(idle.container.querySelector('[data-agenda-quick]')).toBeNull();
    await idle.unmount();
  });

  it('deals the items in the order the page lists them, stopped ferrets first, and goes back', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, stopped], { phone: true }));
    await interact(() => quick(mounted).click());
    expect(mounted.container.querySelector('[data-agenda-inbox]')?.getAttribute('data-agenda-inbox')).toBe('card');
    expect(top(mounted)?.getAttribute('data-agenda-view')).toBe('S1');
    expect(mounted.container.querySelector('[data-inbox-swipe-hint]')?.textContent).toContain('1 more after this one');
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-back]'), 'Back').click(),
    );
    expect(mounted.container.querySelector('[data-agenda-inbox]')?.getAttribute('data-agenda-inbox')).toBe('list');
    await mounted.unmount();
  });

  it('starts at the tapped card, skips forward, and ends with "You skipped N"', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay, bare], { phone: true, initialOpen: twoWay.key }));
    expect(top(mounted)?.getAttribute('data-agenda-view')).toBe('A2');
    const skip = () =>
      must(mounted.container.querySelector<HTMLButtonElement>('.fy-attn-deck__top [aria-label="Next item"]'), 'Skip');
    await interact(() => skip().click());
    expect(top(mounted)?.getAttribute('data-agenda-view')).toBe('A3');
    await interact(() => skip().click());
    expect(top(mounted)).toBeNull();
    expect(mounted.container.querySelector('[data-agenda-queue-end]')?.textContent).toContain(
      'You skipped 3 — review them now?',
    );
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-review]'), 'Review').click(),
    );
    expect(top(mounted)?.getAttribute('data-agenda-view')).toBe('A1');
    await mounted.unmount();
  });

  it('puts the primary answer on ↑ and ↓ on skip, and says so under the item', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true, initialOpen: threeWay.key }));
    expect(mounted.container.querySelector('[data-inbox-swipe-hint]')?.textContent).toBe(
      '↑ Rebase now · ← Skip · → Wait · ↓ Skip',
    );
    await mounted.unmount();
    const yesNo = await mount(page(fakeInbox(), [twoWay], { phone: true, initialOpen: twoWay.key }));
    expect(yesNo.container.querySelector('[data-inbox-swipe-hint]')?.textContent).toBe('↑ Ship · ← Hold · ↓ Skip');
    await yesNo.unmount();
  });

  it('reads the ferret’s last messages only when the fold is opened, and shows them', async () => {
    const reads: string[] = [];
    const mounted = await mount(
      page(fakeInbox(), [twoWay], {
        phone: true,
        initialOpen: twoWay.key,
        readRecent: async card => {
          reads.push(card.item.id);
          return [{ text: 'Cut the release branch.' }, { text: 'Raised !A2 about shipping.' }];
        },
      }),
    );
    const toggle = must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-recent-toggle]'), 'the fold');
    expect(toggle.textContent).toBe('Last messages from Kai');
    expect(reads).toEqual([]);
    await interact(() => toggle.click());
    await flush();
    expect(reads).toEqual(['A2']);
    expect(
      [...mounted.container.querySelectorAll('[data-agenda-recent-message]')].map(message => message.textContent),
    ).toEqual(['Cut the release branch.', 'Raised !A2 about shipping.']);
    await mounted.unmount();
  });

  it('says "Later" once the skipped cards are left waiting, and counts them', async () => {
    const mounted = await mount(page(fakeInbox(), [threeWay, twoWay], { phone: true, initialOpen: twoWay.key }));
    const skip = () =>
      must(mounted.container.querySelector<HTMLButtonElement>('.fy-attn-deck__top [aria-label="Next item"]'), 'Skip');
    await interact(() => skip().click());
    await interact(() => skip().click());
    await interact(() =>
      must(mounted.container.querySelector<HTMLButtonElement>('[data-agenda-later]'), 'Later').click(),
    );
    const end = must(mounted.container.querySelector('[data-agenda-queue-end]'), 'the end');
    expect(end.getAttribute('data-agenda-queue-end')).toBe('later');
    expect(end.textContent).toContain('All caught up for now');
    expect(end.textContent).toContain('2 are still open');
    await mounted.unmount();
  });

  it('says "Updating" in the deck header while boards are read', async () => {
    const mounted = await mount(
      page(fakeInbox(), [threeWay], { phone: true, initialOpen: threeWay.key, reading: true }),
    );
    expect(mounted.container.querySelector('[data-agenda-inbox="card"] [data-agenda-updating]')).not.toBeNull();
    await mounted.unmount();
  });

  it('says how long ago each message was written, and says so when the ferret has written nothing', async () => {
    const mounted = await mount(
      page(fakeInbox(), [twoWay], {
        phone: true,
        initialOpen: twoWay.key,
        recentOpen: true,
        readRecent: async () => [
          { text: 'Cut the release branch.', timestamp: '2026-08-01T05:00:00.000Z' },
          { text: 'Pushed it.', timestamp: '2026-08-01T12:00:00.000Z' },
          { text: 'No time on this one.' },
        ],
      }),
    );
    await flush();
    expect([...mounted.container.querySelectorAll('[data-agenda-recent-message]')].map(m => m.textContent)).toEqual([
      '7h agoCut the release branch.',
      'just nowPushed it.',
      'No time on this one.',
    ]);
    await mounted.unmount();
    const quiet = await mount(
      page(fakeInbox(), [twoWay], {
        phone: true,
        initialOpen: twoWay.key,
        recentOpen: true,
        readRecent: async () => [],
      }),
    );
    await flush();
    expect(quiet.container.querySelector('.fy-attn-recent__note')?.textContent).toBe(
      'Kai hasn’t written anything yet.',
    );
    await quiet.unmount();
  });

  it('says a failed read in the fold, and draws no fold when the host cannot read', async () => {
    const failing = await mount(
      page(fakeInbox(), [twoWay], {
        phone: true,
        initialOpen: twoWay.key,
        recentOpen: true,
        readRecent: async () => {
          throw new Error('offline');
        },
      }),
    );
    await flush();
    expect(failing.container.querySelector('[data-agenda-recent-toggle]')).not.toBeNull();
    await failing.unmount();
    const none = await mount(page(fakeInbox(), [twoWay], { phone: true, initialOpen: twoWay.key }));
    expect(none.container.querySelector('[data-agenda-recent-toggle]')).toBeNull();
    await none.unmount();
  });
});

describe('AgendaNeedsYou', () => {
  const needsYou = (fake: FakeInbox, cards: readonly InboxCard[], navigated: string[] = []) => (
    <InboxHarness
      cards={cards}
      fake={fake}
      render={inbox => (
        <AgendaNeedsYou
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
    expect(mounted.container.querySelector('[data-agenda-needs-you]')).toBeNull();
    expect(toast(mounted).className).toBe('sr-only');
    await mounted.unmount();
  });

  it('shows the newest three with "See all N" into the inbox', async () => {
    const extra = inboxCard(
      agendaItem('A0', { waitingSince: '2026-08-01T08:00:00.000Z' }),
      sessionView('sess-4', { config: { teammate: 'ola' } }),
    );
    const navigated: string[] = [];
    const mounted = await mount(needsYou(fakeInbox(), [threeWay, twoWay, bare, extra], navigated));
    const section = must(mounted.container.querySelector('[data-agenda-needs-you]'), 'the deck');
    expect(
      [...section.querySelectorAll('[data-agenda-card]')].map(card => card.getAttribute('data-agenda-card')),
    ).toEqual(['A3', 'A2', 'A1']);
    const all = must(section.querySelector<HTMLAnchorElement>('[data-agenda-see-all]'), 'See all');
    expect(all.textContent).toBe('See all 4');
    expect(all.getAttribute('href')).toBe('/d/workshop/inbox');
    await interact(() => all.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(navigated).toEqual(['/d/workshop/inbox']);
    // Buttons only: these cards do not swipe.
    expect(section.querySelector('.fy-attn-card__swipe')).toBeNull();
    await mounted.unmount();
  });

  it('keeps the answer bar on the card, with no reply box of its own', async () => {
    const long = inboxCard(agendaItem('A5', { subject: 'Point the sync at the new org' }));
    const mounted = await mount(needsYou(fakeInbox(), [long]));
    const card = must(mounted.container.querySelector<HTMLElement>('[data-agenda-card="A5"]'), 'the card');
    expect(card.querySelector('[data-agenda-answer="right"]')).not.toBeNull();
    expect(card.querySelector('textarea, [data-agenda-reply-toggle]')).toBeNull();
    await mounted.unmount();
  });

  it('answers undoably, and the toast outlives the last card it took', async () => {
    const fake = fakeInbox();
    const mounted = await mount(needsYou(fake, [bare]));
    const done = must(
      mounted.container.querySelector<HTMLButtonElement>('[data-agenda-answer="right"]'),
      'the Got it answer',
    );
    await interact(() => done.click());
    expect(mounted.container.querySelector('[data-agenda-needs-you]')).toBeNull();
    expect(toast(mounted).textContent).toContain('Marked !A1 done');
    await interact(() => undoButton(mounted).click());
    expect(mounted.container.querySelector('[data-agenda-card="A1"]')).not.toBeNull();
    await advance(fake, 10_000);
    expect(fake.commits).toEqual([]);
    await mounted.unmount();
  });
});

describe('AgendaCard swipe hints', () => {
  it('marks each swiped answer with its direction, and never an extra option', async () => {
    const hinted = (mounted: Mounted): (string | null)[] =>
      [...mounted.container.querySelectorAll('[data-agenda-answer], [data-agenda-option]')].map(
        button => /swipe (left|up|right)/.exec(button.textContent ?? '')?.[0] ?? null,
      );
    const options = await mount(
      <AgendaCard
        item={agendaItem('A9', { ask: choices('One', 'Two', 'Three', 'Four') })}
        onAct={() => {}}
        swipeHints
      />,
    );
    expect(hinted(options)).toEqual(['swipe left', 'swipe up', 'swipe right', null]);
    await options.unmount();

    const bare = await mount(<AgendaCard item={agendaItem('A8')} onAct={() => {}} swipeHints />);
    expect(hinted(bare)).toEqual(['swipe right']);
    await bare.unmount();

    const plain = await mount(<AgendaCard item={agendaItem('A7')} onAct={() => {}} />);
    expect(hinted(plain)).toEqual([null]);
    await plain.unmount();
  });
});

describe('AgendaDetail context and steps', () => {
  it('draws the context open and whole, however long, and nothing for a blank one', async () => {
    const short = await mount(<AgendaDetail item={agendaItem('A7', { context: 'Halfway through.' })} layout="panel" />);
    const shortContext = must(short.container.querySelector('[data-agenda-section="context"]'), 'the context');
    expect(shortContext.textContent).toContain('Halfway through.');
    expect(short.container.querySelector('[data-agenda-body-toggle]')).toBeNull();
    await short.unmount();

    const long = await mount(<AgendaDetail item={agendaItem('A6', { context: 'word '.repeat(80) })} layout="panel" />);
    const longContext = must(
      long.container.querySelector('[data-agenda-section="context"] .fy-attn-sec__body'),
      'the long context',
    );
    expect(longContext.textContent?.match(/word/gu)).toHaveLength(80);
    expect(long.container.querySelector('[data-agenda-body-toggle]')).toBeNull();
    await long.unmount();

    const blank = await mount(
      <AgendaDetail item={agendaItem('A5', { context: '   ', subject: 'Same', why: 'Same' })} layout="panel" />,
    );
    expect(blank.container.querySelector('[data-agenda-section="context"]')).toBeNull();
    await blank.unmount();
  });

  it('ticks a to-do step through the host', async () => {
    const ticks: [number, boolean][] = [];
    const mounted = await mount(
      <AgendaDetail
        item={agendaItem('A5', { steps: ['one', 'two'], ask: { kind: 'task' } })}
        layout="panel"
        onProgress={async (step, done) => {
          ticks.push([step, done]);
        }}
      />,
    );
    const box = must(mounted.container.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'the first step');
    await interact(() => box.click());
    await flush();
    expect(ticks).toEqual([[0, true]]);
    await mounted.unmount();
  });
});

describe('AgendaInboxPage banner slot', () => {
  it('draws the banner above the cards, and nothing when none is given', async () => {
    const withBanner = await mount(
      page(fakeInbox(), [threeWay], { banner: <p data-test-banner="">Notifications are off</p> }),
    );
    const root = withBanner.container;
    const banner = must(root.querySelector('[data-test-banner]'), 'the banner');
    const first = must(root.querySelector('[data-agenda-inbox] > :nth-child(3)'), 'the filter after the banner');
    expect(root.querySelector('[data-agenda-inbox]')?.children[1]).toBe(banner);
    expect(first).not.toBe(banner);
    await withBanner.unmount();

    const without = await mount(page(fakeInbox(), [threeWay]));
    expect(without.container.querySelector('[data-test-banner]')).toBeNull();
    await without.unmount();
  });
});

describe('AgendaInboxPage refusals whose card has gone', () => {
  it('says the refusal and clears it on Dismiss', async () => {
    const fake = fakeInbox();
    const mounted = await mount(page(fake, []));
    fake.failNext = 'machine said no';
    await interact(() => fake.deferred.schedule(threeWay, { kind: 'dismiss', label: 'Dismiss' } as never));
    await advance(fake, 10_000);
    const failures = must(mounted.container.querySelector('[data-agenda-failures]'), 'the refusals');
    expect(failures.textContent).toContain('machine said no');
    const clear = must(failures.querySelector<HTMLButtonElement>('button'), 'the clear button');
    await interact(() => clear.click());
    expect(mounted.container.querySelector('[data-agenda-failures]')).toBeNull();
    await mounted.unmount();
  });
});

describe('AgendaInboxPage Resolved filter', () => {
  const record = (id: string, resolvedAt: string): ResolvedAgendaItem =>
    ({
      ...agendaItem(id),
      resolvedAt,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: null,
      disposition: 'done',
    }) as unknown as ResolvedAgendaItem;
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
          <AgendaInboxPage
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
    must(root.querySelector<HTMLButtonElement>(`[data-agenda-filter-option="${which}"]`), which);

  it('starts on Open, and choosing Resolved reads the history and swaps the list', async () => {
    const { mounted, loads } = mountFilter({
      resolved: [row('A1', '2026-08-01T09:00:00.000Z'), row('A2', '2026-08-01T10:00:00.000Z')],
    });
    const view = await mounted;
    const root = view.container;
    expect(option(root, 'open').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-agenda-resolved-pane]')).toBeNull();
    await interact(() => option(root, 'resolved').click());
    expect(loads()).toBe(1);
    expect(option(root, 'resolved').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-agenda-resolved-pane]')).not.toBeNull();
    expect([...root.querySelectorAll('[data-agenda-record]')].map(r => r.getAttribute('data-agenda-record'))).toEqual([
      'A1',
      'A2',
    ]);
    expect(root.querySelector('[data-agenda-record-origin]')?.textContent).toContain('Workshop');
    await interact(() => option(root, 'open').click());
    expect(root.querySelector('[data-agenda-resolved-pane]')).toBeNull();
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

  it('says nothing matches when Find hides every resolved item, and Show everything brings them back', async () => {
    const { mounted } = mountFilter({ resolved: [row('A1', '2026-08-01T09:00:00.000Z')] });
    const view = await mounted;
    const root = view.container;
    await interact(() => option(root, 'resolved').click());
    expect(root.querySelectorAll('[data-agenda-record]')).toHaveLength(1);
    const find = must(root.querySelector<HTMLInputElement>('[data-agenda-find]'), 'Find');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(find, 'zzz-no-such-thing');
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(root.querySelectorAll('[data-agenda-record]')).toHaveLength(0);
    expect(root.querySelector('[data-agenda-resolved-empty]')).toBeNull();
    const back = must(root.querySelector<HTMLButtonElement>('[data-agenda-no-match] button'), 'Show everything');
    await interact(() => back.click());
    expect(root.querySelectorAll('[data-agenda-record]')).toHaveLength(1);
    await view.unmount();
  });

  it('says it is reading, then says nothing is resolved', async () => {
    const reading = await mountFilter({ resolvedReading: true }).mounted;
    await interact(() => option(reading.container, 'resolved').click());
    expect(reading.container.textContent).toContain('Reading resolved items');
    await reading.unmount();

    const none = await mountFilter().mounted;
    await interact(() => option(none.container, 'resolved').click());
    expect(none.container.querySelector('[data-agenda-resolved-empty]')?.textContent).toContain('Nothing resolved');
    await none.unmount();
  });
});

describe('a lane-proposal card', () => {
  const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
  const proposal = inboxCard(
    agendaItem('L1', {
      subject: 'Lanes for ferretry: Todo → Implement → Review → Merged',
      ask: choices(LANE_PROPOSAL_ANSWERS.accept, LANE_PROPOSAL_ANSWERS.edit),
      sourceRef: laneProposalReference(PROJECT_ID, 2),
    }),
  );
  const editPath = `/d/${proposal.daemonId}/projects/${PROJECT_ID}/lanes`;

  const answerBy = (mounted: Mounted, label: string): HTMLButtonElement =>
    must(
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-agenda-card="L1"] button')].find(
        node => (node.textContent ?? '').trim() === label,
      ),
      `the ${label} answer`,
    );

  it('opens the lane editor on Edit and still sends the answer', async () => {
    // Arrange
    const fake = fakeInbox();
    const navigated: string[] = [];
    const mounted = await mount(
      <InboxHarness
        cards={[proposal]}
        fake={fake}
        render={inbox => (
          <AgendaNeedsYou
            clock={fake.clock.now}
            daemonId={proposal.daemonId}
            inbox={inbox}
            now={NOW}
            onNavigate={to => navigated.push(to)}
          />
        )}
      />,
    );

    // Act
    await interact(() => answerBy(mounted, LANE_PROPOSAL_ANSWERS.edit).click());
    await advance(fake, 10_000);

    // Assert
    expect(navigated).toEqual([editPath]);
    expect(fake.commits.map(commit => commit.card.item.id)).toEqual(['L1']);
    await mounted.unmount();
  });

  it('answers Accept in place, without opening the editor', async () => {
    // Arrange
    const fake = fakeInbox();
    const navigated: string[] = [];
    const mounted = await mount(
      <InboxHarness
        cards={[proposal]}
        fake={fake}
        render={inbox => (
          <AgendaNeedsYou
            clock={fake.clock.now}
            daemonId={proposal.daemonId}
            inbox={inbox}
            now={NOW}
            onNavigate={to => navigated.push(to)}
          />
        )}
      />,
    );

    // Act
    await interact(() => answerBy(mounted, LANE_PROPOSAL_ANSWERS.accept).click());
    await advance(fake, 10_000);

    // Assert
    expect(navigated).toEqual([]);
    expect(fake.commits.map(commit => commit.card.item.id)).toEqual(['L1']);
    await mounted.unmount();
  });

  it('opens the lane editor on Edit from the inbox deck too', async () => {
    // Arrange
    const fake = fakeInbox();
    const navigated: string[] = [];
    const mounted = await mount(page(fake, [proposal], { phone: true, initialOpen: proposal.key }, navigated));

    // Act
    await interact(() =>
      must(
        mounted.container.querySelector<HTMLButtonElement>(
          `.fy-attn-deck__top [data-agenda-option="${LANE_PROPOSAL_ANSWERS.edit}"]`,
        ),
        'the Edit answer',
      ).click(),
    );

    // Assert
    expect(navigated).toEqual([editPath]);
    await mounted.unmount();
  });
});
