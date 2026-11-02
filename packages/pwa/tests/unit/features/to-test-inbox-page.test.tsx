import { afterEach, describe, expect, it } from 'bun:test';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { ToTestHost } from '../../../src/features/agenda/to-test-rows.tsx';
import { splitSnoozed, toTestCards, withProjectName, withTaskName } from '../../../src/lib/to-test-inbox.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { chooseFromMenu, openFind } from '../../support/inbox-menus.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card, flush, laptop, PROJECT } from '../board-support.ts';
import { fakeActions, fill, refusal, submit } from './board-detail-support.tsx';

const NOW = Date.parse('2026-08-02T12:00:00.000Z');

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const shipped = { version: '1.2.0', tag: 'v1.2.0', at: '2026-08-01T09:00:00.000Z' };

const LEAD_TASKS = new Map([['mvuc7tsf-0c3d50df', 'Credentials Build Lead']]);
const PROJECT_NAMES = new Map([[PROJECT, 'ferretry']]);

const rowsOf = () =>
  boardModelOf([
    card('F22', {
      laneId: 'tested',
      title: 'Try the board',
      shippedIn: shipped,
      howToTest: '1. Open the Board\n2. Press Done',
    }),
    card('F23', {
      laneId: 'tested',
      title: 'Second try',
      shippedIn: { ...shipped, version: '1.1.0' },
      owner: 'mvudnuly-ec442385',
    }),
    card('F24', { laneId: 'implement', title: 'Still building' }),
    card('F26', { laneId: 'tested', title: 'Ferret follow-up', askedBy: 'agent' }),
  ])
    .then(toTestCards)
    .then(rows => rows.map(row => withProjectName(withTaskName(row, LEAD_TASKS), PROJECT_NAMES)));

const PARKED_UNTIL = '2026-08-02T16:00:00.000Z';

const snoozedRows = () =>
  boardModelOf([
    card('F25', { laneId: 'tested', title: 'Parked try', snoozed: { until: PARKED_UNTIL, laneId: 'tested' } }),
  ])
    .then(toTestCards)
    .then(rows => splitSnoozed(rows, NOW).snoozed);

const owner = inboxCard(agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait') }));

const open = async (
  options: {
    readonly phone?: boolean;
    readonly agendaCards?: readonly (typeof owner)[];
    readonly moveTask?: (...args: never[]) => Promise<unknown>;
    readonly snoozeTask?: (...args: never[]) => Promise<unknown>;
    readonly snoozed?: boolean;
    readonly noHost?: boolean;
    readonly page?: Partial<AgendaInboxPageProps>;
  } = {},
) => {
  const fake = fakeInbox();
  const rows = await rowsOf();
  const parked = options.snoozed === true ? await snoozedRows() : [];
  const actions = fakeActions({
    ...(options.moveTask === undefined ? {} : { moveTask: options.moveTask }),
    ...(options.snoozeTask === undefined ? {} : { snoozeTask: options.snoozeTask }),
  });
  const navigated: string[] = [];
  const host: ToTestHost = {
    actions,
    ports: {},
    connectionOf: () => laptop,
  };
  view = await mount(
    <InboxHarness
      cards={options.agendaCards ?? [owner]}
      fake={fake}
      toTest={rows}
      toTestSnoozed={parked}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={inbox}
          now={NOW}
          onNavigate={to => navigated.push(to)}
          phone={options.phone ?? false}
          reducedMotion
          {...(options.noHost === true ? {} : { toTestHost: host })}
          {...options.page}
        />
      )}
    />,
  );
  await interact(() => flush());
  return { root: view.container, actions, navigated, inbox: rows };
};

const TITLES: Record<string, string> = { F22: 'Try the board', F23: 'Second try' };
const openInfo = async (row: HTMLElement): Promise<void> => {
  await interact(() => must(row.querySelector<HTMLElement>('[data-agenda-info-toggle]'), 'the (i) button').click());
};
const rowOf = (root: HTMLElement, id: string): HTMLElement =>
  must(
    [...root.querySelectorAll<HTMLElement>('[data-to-test]')].find(
      row => row.querySelector('[data-to-test-title]')?.textContent === TITLES[id],
    ),
    `the ${id} row`,
  );

describe('Inbox — cards waiting for a try', () => {
  it('draws them in a To test section of their own, after Needs you, so they can be batched', async () => {
    const { root } = await open();
    const sections = [...root.querySelectorAll<HTMLElement>('[data-agenda-section]')].map(section =>
      section.getAttribute('data-agenda-section'),
    );
    expect(sections).toEqual(['needs-you', 'to-test']);
    const section = must(root.querySelector<HTMLElement>('[data-agenda-section="to-test"]'), 'the To test section');
    expect(section.querySelector('h2')?.textContent).toContain('To test');
    expect(section.querySelector('.fy-inbox-section__count')?.textContent).toBe('2');
    expect(section.querySelectorAll('[data-to-test]')).toHaveLength(2);
    expect(root.querySelector('[data-agenda-section="needs-you"]')?.querySelector('[data-to-test]') ?? null).toBeNull();
  });

  it('lists each to-test card with its title, release and How to test steps', async () => {
    const { root } = await open();
    const row = rowOf(root, 'F22');
    await openInfo(row);
    expect(row.querySelector('[data-to-test-title]')?.textContent).toBe('Try the board');
    expect(row.querySelector('[data-to-test-release]')?.textContent).toBe('Shipped in v1.2.0');
    expect(row.querySelector('[data-to-test-how]')?.textContent).toContain('How to test');
    expect(row.querySelector('[data-to-test-how]')?.textContent).toContain('Open the Board');
    expect(root.querySelector('[data-to-test-list]')?.children).toHaveLength(2);
    expect(root.textContent).not.toContain('Still building');
  });

  it('names the project on each card, and its machine under ⓘ', async () => {
    const { root } = await open();
    const meta = rowOf(root, 'F22').querySelector('[data-to-test-who]');
    expect(meta?.querySelector('[data-to-test-project]')?.textContent).toBe('ferretry');
    expect(meta?.querySelector('[data-to-test-machine]')).toBeNull();
    expect(meta?.textContent).toContain('ferretry');
    await openInfo(rowOf(root, 'F22'));
    expect(rowOf(root, 'F22').querySelector('.fy-totest__meta [data-to-test-machine]')?.textContent).toBe('laptop');
  });

  it('says who and where on one line, with the way to the ferret’s chat when the ferret is known', async () => {
    const { root } = await open();
    const known = rowOf(root, 'F22').querySelector('[data-to-test-who]');
    expect(known?.children[0]?.classList.contains('fy-meta-line__facts')).toBe(true);
    expect(known?.querySelector('[data-to-test-open-chat]')?.getAttribute('href')).toContain('/session/');
    expect(rowOf(root, 'F23').querySelector('[data-to-test-open-chat]')).toBeNull();
  });

  it('leaves out a card an agent made, though it waits in the same lane', async () => {
    const { root } = await open();
    expect(root.textContent).not.toContain('Ferret follow-up');
  });

  it('names the ferret by the task it was given on each card, never by its callsign', async () => {
    const { root } = await open();
    const ferret = rowOf(root, 'F22').querySelector('[data-to-test-ferret]');
    expect(ferret?.textContent).toBe('Credentials Build Lead');
    expect(rowOf(root, 'F22').querySelector('[data-to-test-who]')?.textContent).toContain('Credentials Build Lead');
  });

  it('says nothing about the ferret when its task is unknown', async () => {
    const { root } = await open();
    expect(rowOf(root, 'F23').querySelector('[data-to-test-ferret]')).toBeNull();
  });

  it('shows no How to test box for a card that has no steps', async () => {
    const { root } = await open();
    expect(rowOf(root, 'F23').querySelector('[data-to-test-how]')).toBeNull();
  });

  it('counts them with the agenda items in the head count', async () => {
    const { root } = await open();
    expect(root.textContent).toContain('3');
  });

  it('shows the list even when no agenda item is waiting', async () => {
    const { root } = await open({ agendaCards: [] });
    expect(root.querySelector('[data-to-test-list]')).not.toBeNull();
    expect(root.textContent).not.toContain('Nothing waiting');
  });

  it('links the title to the card on the Board', async () => {
    const { root, navigated } = await open();
    await interact(() => must(rowOf(root, 'F22').querySelector<HTMLElement>('[data-to-test-title]'), 'title').click());
    expect(navigated[0]).toContain('F22');
  });

  it('hides them under a source filter, which asks for agenda items only', async () => {
    const { root } = await open({ page: { from: 'warden' } });
    expect(root.querySelector('[data-to-test-list]')).toBeNull();
  });

  it('finds a card by the name of its project', async () => {
    const { root } = await open();
    const find = await openFind(root);
    await fill(find, 'ferretry');
    expect(root.querySelectorAll('[data-to-test]')).toHaveLength(2);
    await fill(find, 'no such project');
    expect(root.querySelector('[data-to-test]')).toBeNull();
  });
});

describe('Inbox — answering a card waiting for a try', () => {
  it('Done moves the card to the project’s Done lane at once', async () => {
    const { root, actions } = await open();
    await interact(() => must(rowOf(root, 'F22').querySelector<HTMLElement>('[data-to-test-done]'), 'Done').click());
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
  });

  it('Not good opens the reason box, then reopens the card with the owner’s words', async () => {
    const { root, actions } = await open();
    await interact(() =>
      must(rowOf(root, 'F22').querySelector<HTMLElement>('[data-to-test-not-good]'), 'Not good').click(),
    );
    const dialog = must(document.body.querySelector('[role="dialog"]'), 'the reason box');
    expect(dialog.textContent).toContain('Try the board');
    expect(actions.calls).toEqual([]);
    const form = dialog.closest('form') ?? dialog;
    await fill(must(form.querySelector('textarea, input'), 'the reason field') as HTMLTextAreaElement, 'It crashes');
    await submit(form as HTMLElement);
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["implement","It crashes"]']);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says a refusal on the row, as the Board does', async () => {
    const { root } = await open({ moveTask: async () => refusal('The closed lane is owner only') });
    await interact(() => must(rowOf(root, 'F22').querySelector<HTMLElement>('[data-to-test-done]'), 'Done').click());
    await interact(() => flush());
    expect(rowOf(root, 'F22').querySelector('[data-to-test-error]')?.textContent).toBe('The closed lane is owner only');
  });
});

const clock = (row: HTMLElement): HTMLElement =>
  must(row.querySelector<HTMLElement>('[data-agenda-snooze]'), 'the clock button');

const choose = async (label: string): Promise<void> => {
  const item = must(
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label),
    label,
  );
  await interact(() => item.click());
  await interact(() => flush());
};

describe('Inbox — snoozing a card waiting for a try', () => {
  it('gives each card the agenda clock, with the same choices', async () => {
    const { root } = await open();
    const button = clock(rowOf(root, 'F22'));
    expect(button.getAttribute('aria-label')).toBe('Snooze: Try the board');
    await interact(() => button.click());
    const labels = [...document.body.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent);
    expect(labels).toEqual(['1 hour', '4 hours', 'Tomorrow 9:00', 'Custom…']);
  });

  it('1 hour parks the card on its machine until an hour from now', async () => {
    const { root, actions } = await open();
    await interact(() => clock(rowOf(root, 'F22')).click());
    await choose('1 hour');
    expect(actions.calls).toEqual(['snoozeTask:["2026-08-02T13:00:00.000Z"]']);
  });

  it('says a refusal on the page', async () => {
    const { root } = await open({ snoozeTask: async () => refusal('Only the owner can snooze') });
    await interact(() => clock(rowOf(root, 'F22')).click());
    await choose('4 hours');
    expect(root.querySelector('[data-to-test-notice]')?.textContent).toBe('Only the owner can snooze');
  });

  it('draws the buttons Not good (left) then Done (right), the order of the swipes', async () => {
    const { root } = await open();
    const names = [...rowOf(root, 'F22').querySelectorAll('.fy-totest__actions button')].map(button =>
      button.textContent?.trim(),
    );
    expect(names.slice(0, 2)).toEqual(['Not good', 'Done']);
  });

  it('leaves the swipes alone: Done and Not good name their sides, and Skip hides under (i)', async () => {
    const { root } = await open();
    const row = rowOf(root, 'F22');
    expect(row.querySelector('[data-to-test-reveal="right"]')?.textContent).toContain('Done');
    expect(row.querySelector('[data-to-test-reveal="left"]')?.textContent).toContain('Not good');
    expect(row.querySelector('[data-to-test-skip]')).toBeNull();
  });

  it('keeps a snoozed card out of the To test section and counts it under Snoozed', async () => {
    const { root } = await open({ snoozed: true });
    expect(root.querySelector('[data-agenda-section="to-test"]')?.querySelectorAll('[data-to-test]')).toHaveLength(2);
    expect(root.querySelector('[data-to-test="F25"]') ?? null).toBeNull();
    await interact(() =>
      must(
        root.querySelector<HTMLButtonElement>('[data-agenda-filter] [aria-haspopup="menu"]'),
        'the Show menu',
      ).click(),
    );
    expect(
      must(root.querySelector('[data-agenda-filter-option="snoozed"]'), 'the Snoozed filter').textContent,
    ).toContain('(1)');
  });

  it('lists it under Snoozed with when it wakes, and Unsnooze wakes it now', async () => {
    const { root, actions } = await open({ snoozed: true });
    await chooseFromMenu(root, 'filter', 'snoozed');
    const row = must(root.querySelector<HTMLElement>('[data-to-test-snoozed]'), 'the snoozed card');
    expect(row.querySelector('[data-to-test-snoozed-title]')?.textContent).toBe('Parked try');
    expect(row.querySelector('[data-to-test-wakes]')?.textContent).toMatch(/^Snoozed until /u);
    expect(row.textContent).toContain('&F25');
    await interact(() => must(row.querySelector<HTMLElement>('[data-to-test-unsnooze]'), 'Unsnooze').click());
    await interact(() => flush());
    expect(actions.calls).toEqual(['snoozeTask:[null]']);
  });

  it('says nothing matches, not that nothing is snoozed, when a filter hides the snoozed card', async () => {
    const { root } = await open({ snoozed: true, page: { from: 'warden' } });
    await chooseFromMenu(root, 'filter', 'snoozed');
    expect(root.querySelector('[data-agenda-parked-empty]') ?? null).toBeNull();
  });
});

const pointer = (type: string, x: number, init: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 300,
    pointerId: 9,
    pointerType: 'touch',
    ...init,
  });

const drag = async (row: HTMLElement, dx: number, release: boolean): Promise<void> => {
  const grip = must(row.querySelector<HTMLElement>('.fy-totest__top'), 'a place to grab');
  await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx / 2)));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx)));
  if (release) await interact(() => grip.dispatchEvent(pointer('pointerup', 100 + dx)));
};

const dragDown = async (row: HTMLElement, dy: number, release: boolean, dx = 0): Promise<void> => {
  const grip = must(row.querySelector<HTMLElement>('.fy-totest__top'), 'a place to grab');
  await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx / 2, { clientY: 300 + dy / 2 })));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx, { clientY: 300 + dy })));
  if (release) await interact(() => grip.dispatchEvent(pointer('pointerup', 100 + dx, { clientY: 300 + dy })));
};

describe('Inbox — swiping a card waiting for a try', () => {
  it('reads a right drag as Done and a left drag as Not good, mid-swipe, and names the answer in the area it uncovers', async () => {
    const { root } = await open({ phone: true });
    const row = rowOf(root, 'F22');
    await drag(row, 200, false);
    expect(row.getAttribute('data-swipe-direction')).toBe('right');
    expect(row.getAttribute('data-swipe-answer')).toBe('Done');
    expect(row.querySelector('[data-to-test-reveal="right"]')?.textContent).toBe('Done');
    await interact(() =>
      must(row.querySelector('.fy-totest__top'), 'grip').dispatchEvent(pointer('pointercancel', 300)),
    );
    await drag(row, -200, false);
    expect(row.getAttribute('data-swipe-direction')).toBe('left');
    expect(row.getAttribute('data-swipe-answer')).toBe('Not good');
    expect(row.querySelector('[data-to-test-reveal="left"]')?.textContent).toBe('Not good');
  });

  it('a right swipe past the threshold is Done', async () => {
    const { root, actions } = await open({ phone: true });
    await drag(rowOf(root, 'F22'), 300, true);
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
  });

  it('a left swipe past the threshold opens the reason box instead of moving the card', async () => {
    const { root, actions } = await open({ phone: true });
    await drag(rowOf(root, 'F22'), -300, true);
    await interact(() => flush());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(actions.calls).toEqual([]);
  });

  it('a downward drag from the head draws the compass and moves nothing when let go before a choice', async () => {
    const { root, actions } = await open({ phone: true });
    const row = rowOf(root, 'F22');
    await dragDown(row, 120, false);
    expect(row.getAttribute('data-swipe-direction')).toBe('down');
    expect(row.querySelector('[data-swipe-compass]')?.getAttribute('data-swipe-reveal')).toBe('down');
    expect(row.querySelector('[data-compass-cell="not-needed"]')).toBeNull();
    await dragDown(row, 180, true);
    await interact(() => flush());
    expect(actions.calls).toEqual([]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(row.getAttribute('data-swipe-direction')).toBeNull();
  });

  it('a pull down to ↓↓ lets go into a snooze from the shared list: Tomorrow 9:00 when straight down', async () => {
    const { root, actions } = await open({ phone: true });
    await dragDown(rowOf(root, 'F22'), 220, true);
    await interact(() => flush());
    expect(actions.calls).toEqual(['snoozeTask:["2026-08-03T09:00:00.000Z"]']);
  });

  it('asks for a time on Custom…, the card springing back, and snoozes once it is given', async () => {
    const { root, actions } = await open({ phone: true });
    const row = rowOf(root, 'F22');
    await dragDown(row, 220, true, 140);
    await interact(() => flush());
    expect(actions.calls).toEqual([]);
    const sheet = must(row.querySelector<HTMLElement>('[data-to-test-custom]'), 'the custom sheet');
    const form = must(sheet.querySelector<HTMLFormElement>('[data-snooze-custom]'), 'the custom form');
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await interact(() => flush());
    expect(actions.calls).toHaveLength(1);
    expect(actions.calls[0]).toStartWith('snoozeTask:');
    expect(row.querySelector('[data-to-test-custom]')).toBeNull();
  });

  it('drops the Custom… sheet on Cancel and changes nothing', async () => {
    const { root, actions } = await open({ phone: true });
    const row = rowOf(root, 'F22');
    await dragDown(row, 220, true, 140);
    await interact(() => flush());
    const cancel = must(row.querySelector<HTMLButtonElement>('.fy-attn-deck__custom-cancel'), 'Cancel');
    await interact(() => cancel.click());
    expect(row.querySelector('[data-to-test-custom]')).toBeNull();
    expect(actions.calls).toEqual([]);
  });

  it('a pull down is never a dismiss: the compass has no Not needed', async () => {
    const { root, actions } = await open({ phone: true });
    const row = rowOf(root, 'F22');
    const grip = must(row.querySelector<HTMLElement>('.fy-totest__top'), 'a place to grab');
    await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + 20, { clientY: 340 })));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + 120, { clientY: 430 })));
    await interact(() => grip.dispatchEvent(pointer('pointerup', 100 + 120, { clientY: 430 })));
    await interact(() => flush());
    expect(actions.calls).toEqual([]);
    expect(row.querySelector('[data-compass-cell="not-needed"]')).toBeNull();
  });

  it('keeps the browser from taking over a pull down from the head, and from a sideways drag or no drag', async () => {
    const { root } = await open({ phone: true });
    const row = rowOf(root, 'F22');
    const grip = must(row.querySelector<HTMLElement>('.fy-totest__top'), 'a place to grab');
    const surface = must(row.querySelector<HTMLElement>('.fy-totest__surface'), 'the card');
    const move = (x: number, y: number): Event => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
      return event;
    };
    const idle = move(100, 340);
    await interact(() => surface.dispatchEvent(idle));
    expect(idle.defaultPrevented).toBe(false);
    await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
    const down = move(100, 340);
    await interact(() => surface.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    const sideways = move(220, 305);
    await interact(() => surface.dispatchEvent(sideways));
    expect(sideways.defaultPrevented).toBe(false);
    const bare = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(bare, 'touches', { value: [] });
    await interact(() => surface.dispatchEvent(bare));
    expect(bare.defaultPrevented).toBe(false);
  });

  it('a drag down that starts in the steps does nothing here: the list scrolls with the page', async () => {
    const { root, actions } = await open({ phone: true });
    const row = rowOf(root, 'F22');
    const steps = must(row.querySelector<HTMLElement>('.fy-totest__how-title'), 'the steps');
    await interact(() => steps.dispatchEvent(pointer('pointerdown', 100)));
    await interact(() => steps.dispatchEvent(pointer('pointermove', 100, { clientY: 340 })));
    await interact(() => steps.dispatchEvent(pointer('pointermove', 100, { clientY: 600 })));
    await interact(() => steps.dispatchEvent(pointer('pointerup', 100, { clientY: 600 })));
    await interact(() => flush());
    expect(actions.calls).toEqual([]);
    expect(row.getAttribute('data-swipe-direction')).toBeNull();
  });

  it('a downward swipe in the list brings the next card into view', async () => {
    const { root } = await open({ phone: true });
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute('data-to-test') ?? '');
    };
    try {
      await dragDown(rowOf(root, 'F22'), 120, true);
      expect(scrolled).toEqual([rowOf(root, 'F23').getAttribute('data-to-test') ?? 'missing']);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('a short swipe does nothing', async () => {
    const { root, actions } = await open({ phone: true });
    await drag(rowOf(root, 'F22'), 40, true);
    await interact(() => flush());
    expect(actions.calls).toEqual([]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not take a drag that starts on a button', async () => {
    const { root, actions } = await open({ phone: true });
    const button = must(rowOf(root, 'F22').querySelector<HTMLElement>('[data-to-test-done]'), 'Done');
    await interact(() => button.dispatchEvent(pointer('pointerdown', 100)));
    await interact(() => button.dispatchEvent(pointer('pointermove', 400)));
    await interact(() => button.dispatchEvent(pointer('pointerup', 400)));
    expect(actions.calls).toEqual([]);
  });

  it('lets a mostly vertical drag that starts in the steps scroll the page instead of answering or skipping', async () => {
    const { root, actions } = await open({ phone: true });
    const grip = must(rowOf(root, 'F22').querySelector<HTMLElement>('.fy-totest__how-title'), 'the steps');
    await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 110, { clientY: 420 })));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 400, { clientY: 430 })));
    await interact(() => grip.dispatchEvent(pointer('pointerup', 400, { clientY: 430 })));
    await interact(() => flush());
    expect(rowOf(root, 'F22').getAttribute('data-swipe-direction')).toBeNull();
    expect(rowOf(root, 'F22').getAttribute('style') ?? '').not.toContain('translate');
    expect(actions.calls).toEqual([]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('still reads the drag when the browser will not capture the pointer', async () => {
    const original = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = () => {
      throw new Error('the pointer is already released');
    };
    try {
      const { root, actions } = await open({ phone: true });
      await drag(rowOf(root, 'F22'), 300, true);
      await interact(() => flush());
      expect(actions.calls).toEqual(['moveTask:["closed"]']);
    } finally {
      HTMLElement.prototype.setPointerCapture = original;
    }
  });

  it('says how long a card has waited, in days once it is past two', async () => {
    const { root } = await open({ page: { now: NOW + 3 * 24 * 60 * 60 * 1000 } });
    expect(rowOf(root, 'F22').querySelector('.fy-totest__age')?.textContent).toBe('4d');
  });

  it('does not follow the title link on the click that ends a swipe', async () => {
    const { root, navigated } = await open({ phone: true });
    await drag(rowOf(root, 'F22'), 40, true);
    const title = must(rowOf(root, 'F22').querySelector<HTMLElement>('[data-to-test-title]'), 'title');
    await interact(() => title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(navigated).toEqual([]);
  });

  it('ignores a mouse drag: swipes are touch only', async () => {
    const { root, actions } = await open();
    const grip = must(rowOf(root, 'F22').querySelector<HTMLElement>('.fy-totest__top'), 'grip');
    await interact(() => grip.dispatchEvent(pointer('pointerdown', 100, { pointerType: 'mouse' })));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 400, { pointerType: 'mouse' })));
    await interact(() => grip.dispatchEvent(pointer('pointerup', 400, { pointerType: 'mouse' })));
    expect(actions.calls).toEqual([]);
  });
});
