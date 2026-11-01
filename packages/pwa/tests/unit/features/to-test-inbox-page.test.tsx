import { afterEach, describe, expect, it } from 'bun:test';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { ToTestHost } from '../../../src/features/agenda/to-test-rows.tsx';
import { toTestCards } from '../../../src/lib/to-test-inbox.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card, flush, laptop } from '../board-support.ts';
import { fakeActions, fill, refusal, submit } from './board-detail-support.tsx';

const NOW = Date.parse('2026-08-02T12:00:00.000Z');

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const shipped = { version: '1.2.0', tag: 'v1.2.0', at: '2026-08-01T09:00:00.000Z' };

const rowsOf = async () =>
  toTestCards(
    await boardModelOf([
      card('F22', {
        laneId: 'tested',
        title: 'Try the board',
        shippedIn: shipped,
        howToTest: '1. Open the Board\n2. Press Done',
      }),
      card('F23', { laneId: 'tested', title: 'Second try', shippedIn: { ...shipped, version: '1.1.0' } }),
      card('F24', { laneId: 'implement', title: 'Still building' }),
    ]),
  );

const owner = inboxCard(agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait') }));

const open = async (
  options: {
    readonly phone?: boolean;
    readonly agendaCards?: readonly (typeof owner)[];
    readonly moveTask?: (...args: never[]) => Promise<unknown>;
    readonly noHost?: boolean;
    readonly page?: Partial<AgendaInboxPageProps>;
  } = {},
) => {
  const fake = fakeInbox();
  const rows = await rowsOf();
  const actions = fakeActions(options.moveTask === undefined ? {} : { moveTask: options.moveTask });
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
    expect(row.querySelector('[data-to-test-title]')?.textContent).toBe('Try the board');
    expect(row.querySelector('[data-to-test-release]')?.textContent).toBe('Shipped in v1.2.0');
    expect(row.querySelector('[data-to-test-how]')?.textContent).toContain('How to test');
    expect(row.querySelector('[data-to-test-how]')?.textContent).toContain('Open the Board');
    expect(root.querySelector('[data-to-test-list]')?.children).toHaveLength(2);
    expect(root.textContent).not.toContain('Still building');
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
  const grip = must(row.querySelector<HTMLElement>('.fy-totest__meta'), 'a place to grab');
  await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx / 2)));
  await interact(() => grip.dispatchEvent(pointer('pointermove', 100 + dx)));
  if (release) await interact(() => grip.dispatchEvent(pointer('pointerup', 100 + dx)));
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
      must(row.querySelector('.fy-totest__meta'), 'grip').dispatchEvent(pointer('pointercancel', 300)),
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

  it('lets a mostly vertical drag scroll the page instead of answering', async () => {
    const { root, actions } = await open({ phone: true });
    const grip = must(rowOf(root, 'F22').querySelector<HTMLElement>('.fy-totest__meta'), 'grip');
    await interact(() => grip.dispatchEvent(pointer('pointerdown', 100)));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 110, { clientY: 420 })));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 400, { clientY: 430 })));
    await interact(() => grip.dispatchEvent(pointer('pointerup', 400, { clientY: 430 })));
    await interact(() => flush());
    expect(rowOf(root, 'F22').getAttribute('data-swipe-direction')).toBeNull();
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
    const grip = must(rowOf(root, 'F22').querySelector<HTMLElement>('.fy-totest__meta'), 'grip');
    await interact(() => grip.dispatchEvent(pointer('pointerdown', 100, { pointerType: 'mouse' })));
    await interact(() => grip.dispatchEvent(pointer('pointermove', 400, { pointerType: 'mouse' })));
    await interact(() => grip.dispatchEvent(pointer('pointerup', 400, { pointerType: 'mouse' })));
    expect(actions.calls).toEqual([]);
  });
});
