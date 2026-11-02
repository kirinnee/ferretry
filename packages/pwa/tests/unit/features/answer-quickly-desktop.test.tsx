import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { ToTestHost } from '../../../src/features/agenda/to-test-rows.tsx';
import { toTestCards } from '../../../src/lib/to-test-inbox.ts';
import {
  agendaItem,
  choices,
  type FakeInbox,
  fakeInbox,
  InboxHarness,
  inboxCard,
} from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { boardModelOf, card, flush, laptop } from '../board-support.ts';
import { fakeActions } from './board-detail-support.tsx';

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
      card('F22', { laneId: 'tested', title: 'Try the board', shippedIn: shipped, howToTest: '1. Open the Board' }),
      card('F23', { laneId: 'tested', title: 'Second try', shippedIn: { ...shipped, version: '1.1.0' } }),
    ]),
  );

const rebase = inboxCard(
  agendaItem('A3', {
    subject: 'Rebase onto main?',
    ask: choices('Rebase now', 'Wait'),
    waitingSince: '2026-08-01T08:00:00.000Z',
  }),
);
const threeWay = inboxCard(agendaItem('A4', { subject: 'Which way?', ask: choices('Left', 'Middle', 'Right') }));
const second = inboxCard(
  agendaItem('A2', { subject: 'Ship it?', ask: choices('Ship', 'Hold'), waitingSince: '2026-08-01T10:00:00.000Z' }),
);

interface Options {
  readonly cards?: readonly (typeof rebase)[];
  readonly toTest?: boolean;
  readonly phone?: boolean;
  readonly page?: Partial<AgendaInboxPageProps>;
}

const open = async ({ cards = [rebase, second], toTest = false, phone = false, page = {} }: Options = {}) => {
  const fake = fakeInbox();
  const rows = toTest ? await rowsOf() : [];
  const actions = fakeActions({});
  const host: ToTestHost = { actions, ports: {}, connectionOf: () => laptop };
  view = await mount(
    <InboxHarness
      cards={cards}
      fake={fake}
      reading={false}
      toTest={rows}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={inbox}
          now={NOW}
          onNavigate={() => undefined}
          phone={phone}
          reducedMotion
          toTestHost={host}
          {...page}
        />
      )}
    />,
  );
  await interact(() => flush());
  return { root: view.container, fake, actions };
};

const quick = (root: HTMLElement): HTMLElement =>
  must(root.querySelector<HTMLElement>('[data-agenda-quick]'), 'Answer quickly');
const start = async (root: HTMLElement): Promise<void> => interact(() => quick(root).click());
const where = (root: HTMLElement): string | null | undefined =>
  (root.querySelector('.fy-attn-deck__top [data-agenda-where]') ?? root.querySelector('[data-agenda-where]'))
    ?.textContent;
const keys = (root: HTMLElement): string | undefined => {
  const line = root.querySelector('[data-inbox-keys]');
  return line === null
    ? undefined
    : [...line.querySelectorAll('.fy-inbox-keys__entry')].map(e => e.textContent).join(' ');
};
const step = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('[data-inbox-open-to-test]');
const pending = (fake: FakeInbox): string[] => fake.deferred.getSnapshot().pending.map(entry => entry.action.label);
const press = async (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) =>
  interact(() => pressKey(target, key, init));

describe('Answer quickly on a wide screen — the button', () => {
  it('is offered above the list with the count of everything waiting', async () => {
    const { root } = await open({ toTest: true });
    expect(quick(root).querySelector('.fy-inbox-quick__count')?.textContent).toBe('4');
  });

  it('is offered when only cards to test are waiting', async () => {
    const { root } = await open({ cards: [], toTest: true });
    expect(quick(root).querySelector('.fy-inbox-quick__count')?.textContent).toBe('2');
  });

  it('is not offered when nothing waits', async () => {
    const { root } = await open({ cards: [] });
    expect(root.querySelector('[data-agenda-quick]')).toBeNull();
  });
});

describe('Answer quickly on a wide screen — the run', () => {
  it('opens on the first card with one quiet line saying the keys, in the card’s own words', async () => {
    const { root } = await open();
    await start(root);
    expect(where(root)).toBe('1/2');
    expect(root.querySelectorAll('[data-inbox-keys]').length).toBe(1);
    expect(keys(root)).toBe('← Rebase now → Wait ↓ Skip j k Next, previous Esc Close');
  });

  it('names the up answer too on a three-way card', async () => {
    const { root } = await open({ cards: [threeWay] });
    await start(root);
    expect(keys(root)).toBe('← Left ↑ Middle → Right ↓ Skip j k Next, previous Esc Close');
  });

  it('says only → on a card with a single answer', async () => {
    const bare = inboxCard(agendaItem('A1', { subject: 'Have a look', waitingSince: '2026-08-01T07:00:00.000Z' }));
    const { root } = await open({ cards: [bare] });
    await start(root);
    expect(keys(root)).toBe('→ Got it ↓ Skip j k Next, previous Esc Close');
  });

  it('answers with ← and → from anywhere on the page, then deals the next card', async () => {
    const { root, fake } = await open();
    await start(root);
    await press('ArrowRight');
    expect(pending(fake)).toEqual(['Wait']);
    expect(where(root)).toBe('1/1');
    await press('ArrowLeft');
    expect(pending(fake)).toEqual(['Wait', 'Ship']);
  });

  it('answers ↑ on a three-way card', async () => {
    const { root, fake } = await open({ cards: [threeWay] });
    await start(root);
    await press('ArrowUp');
    expect(pending(fake)).toEqual(['Middle']);
  });

  it('answers nothing on an arrow the card has no answer for', async () => {
    const bare = inboxCard(agendaItem('A1', { subject: 'Have a look', waitingSince: '2026-08-01T07:00:00.000Z' }));
    const { root, fake } = await open({ cards: [bare, rebase] });
    await start(root);
    await press('ArrowLeft');
    await press('ArrowUp');
    expect(pending(fake)).toEqual([]);
    expect(where(root)).toBe('1/2');
  });

  it('skips on ↓ without answering', async () => {
    const { root, fake } = await open();
    await start(root);
    await press('ArrowDown');
    expect(pending(fake)).toEqual([]);
    expect(where(root)).toBe('2/2');
  });

  it('moves on j and back on k, and answers nothing', async () => {
    const { root, fake } = await open();
    await start(root);
    await press('j');
    expect(where(root)).toBe('2/2');
    await press('k');
    expect(where(root)).toBe('1/2');
    await press('k');
    expect(where(root)).toBe('1/2');
    expect(pending(fake)).toEqual([]);
  });

  it('shows the end of the queue on j past the last card', async () => {
    const { root } = await open({ cards: [rebase] });
    await start(root);
    await press('j');
    expect(root.querySelector('[data-agenda-queue-end]')).not.toBeNull();
    await press('j');
    expect(root.querySelector('[data-agenda-queue-end]')).not.toBeNull();
  });

  it('closes on Esc, back to the list with its button', async () => {
    const { root } = await open();
    await start(root);
    await press('Escape');
    expect(root.querySelector('[data-inbox-keys]')).toBeNull();
    expect(quick(root)).not.toBeNull();
  });

  it('leaves the keys to a field, a menu, a modifier and a key already handled', async () => {
    const { root, fake } = await open();
    await start(root);
    const input = document.createElement('input');
    root.append(input);
    await press('ArrowRight', input);
    await press('j', input);
    await press('Escape', input);
    await press('ArrowRight', document.body, { ctrlKey: true });
    await press('ArrowRight', document.body, { shiftKey: true });
    await press('ArrowRight', document.body, { altKey: true });
    await press('ArrowRight', document.body, { metaKey: true });
    const handled = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    handled.preventDefault();
    await interact(() => {
      document.body.dispatchEvent(handled);
    });
    await press('a');
    await press('Enter');
    expect(pending(fake)).toEqual([]);
    expect(where(root)).toBe('1/2');
    input.remove();
  });

  it('is a fresh run each time: the keys stop with the run', async () => {
    const { root, fake } = await open();
    await start(root);
    await press('Escape');
    await press('ArrowRight');
    await press('j');
    expect(pending(fake)).toEqual([]);
    expect(root.querySelector('[data-inbox-keys]')).toBeNull();
  });
});

describe('Answer quickly on a wide screen — the card to test', () => {
  it('says its two answers by arrow, then Skip, j k and Esc', async () => {
    const { root } = await open({ cards: [], toTest: true });
    await start(root);
    expect(step(root)?.textContent).toContain('Try the board');
    expect(keys(root)).toBe('← Not good → Done ↓ Skip j k Next, previous Esc Close');
  });

  it('answers Done on → and Not good on ←', async () => {
    const { root, actions } = await open({ cards: [], toTest: true });
    await start(root);
    await press('ArrowRight');
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
    await press('ArrowLeft');
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('skips on ↓ and moves with j and k', async () => {
    const { root, actions } = await open({ cards: [], toTest: true });
    await start(root);
    await press('ArrowDown');
    expect(step(root)?.textContent).toContain('Second try');
    await press('k');
    expect(step(root)?.textContent).toContain('Try the board');
    await press('j');
    expect(step(root)?.textContent).toContain('Second try');
    expect(actions.calls).toEqual([]);
  });

  it('answers nothing on an arrow it has no answer for, and does not answer twice while one is sent', async () => {
    const fake = fakeInbox();
    const rows = await rowsOf();
    const never = new Promise<never>(() => undefined);
    const actions = fakeActions({ moveTask: () => never });
    const host: ToTestHost = { actions, ports: {}, connectionOf: () => laptop };
    view = await mount(
      <InboxHarness
        cards={[]}
        fake={fake}
        reading={false}
        toTest={rows}
        render={inbox => (
          <AgendaInboxPage
            clock={fake.clock.now}
            inbox={inbox}
            now={NOW}
            onNavigate={() => undefined}
            phone={false}
            reducedMotion
            toTestHost={host}
          />
        )}
      />,
    );
    await interact(() => flush());
    await start(view.container);
    await press('ArrowUp');
    await press('ArrowRight');
    await press('ArrowRight');
    await press('ArrowLeft');
    await press('ArrowDown');
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
    expect(step(view.container)?.textContent).toContain('Try the board');
  });
});

describe('Answer quickly on a wide screen — All done', () => {
  it('says so after the last answer, with the way back', async () => {
    const { root } = await open();
    await start(root);
    await press('ArrowRight');
    await press('ArrowRight');
    const done = must(root.querySelector<HTMLElement>('[data-agenda-run-done]'), 'All done');
    expect(done.textContent).toContain('All done');
    expect(root.querySelector('[data-inbox-keys]')).toBeNull();
    await interact(() => must(root.querySelector<HTMLElement>('[data-agenda-run-back]'), 'Back to Inbox').click());
    expect(root.querySelector('[data-agenda-run-done]')).toBeNull();
    expect(root.querySelector('[data-agenda-inbox="card"]')).toBeNull();
  });

  it('closes on Esc too', async () => {
    const { root } = await open({ cards: [rebase] });
    await start(root);
    await press('ArrowLeft');
    expect(root.querySelector('[data-agenda-run-done]')).not.toBeNull();
    await press('Escape');
    expect(root.querySelector('[data-agenda-run-done]')).toBeNull();
  });

  it('is not shown when the reader closed the run with cards still waiting', async () => {
    const { root } = await open();
    await start(root);
    await press('Escape');
    expect(root.querySelector('[data-agenda-run-done]')).toBeNull();
  });

  it('starts a new run from the list afterwards, without the old All done', async () => {
    const { root } = await open({ cards: [rebase] });
    await start(root);
    await press('ArrowLeft');
    await press('Escape');
    expect(root.querySelector('[data-agenda-run-done]')).toBeNull();
    expect(root.querySelector('[data-agenda-quick]')).toBeNull();
  });
});

describe('Answer quickly on a phone — unchanged', () => {
  it('has the button but no keys line, no run keys and no All done', async () => {
    const { root, fake } = await open({ phone: true });
    await start(root);
    expect(root.querySelector('[data-inbox-keys]')).toBeNull();
    await press('ArrowRight');
    await press('j');
    await press('Escape');
    expect(pending(fake)).toEqual([]);
    expect(where(root)).toBe('1/2');
  });

  it('goes back to the list after the last answer, with no All done', async () => {
    const { root, fake } = await open({ cards: [rebase], phone: true });
    await start(root);
    const grip = must(root.querySelector<HTMLElement>('[data-agenda-frame] .fy-card-head'), 'the head');
    const touch = (type: string, x: number): PointerEvent =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 300,
        pointerId: 3,
        pointerType: 'touch',
      });
    await interact(() => grip.dispatchEvent(touch('pointerdown', 100)));
    await interact(() => grip.dispatchEvent(touch('pointermove', 200)));
    await interact(() => grip.dispatchEvent(touch('pointermove', 450)));
    await interact(() => grip.dispatchEvent(touch('pointerup', 450)));
    expect(pending(fake)).toEqual(['Wait']);
    expect(root.querySelector('[data-agenda-run-done]')).toBeNull();
  });
});

const pointerOf =
  (pointerType: string, pointerId: number) =>
  (type: string, x: number, y = 300): PointerEvent =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId, pointerType });
const mouse = pointerOf('mouse', 9);
const touch = pointerOf('touch', 3);

const selectionSpy = () => {
  const released: number[] = [];
  const spy = spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: true,
    containsNode: () => false,
    removeAllRanges: () => released.push(1),
  } as unknown as Selection);
  return { released, restore: () => spy.mockRestore() };
};

const drag = async (
  target: HTMLElement,
  make: (type: string, x: number, y?: number) => PointerEvent,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<PointerEvent[]> => {
  const sent = [
    make('pointerdown', from[0], from[1]),
    make('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2),
    make('pointermove', to[0], to[1]),
    make('pointerup', to[0], to[1]),
  ];
  for (const event of sent) await interact(() => target.dispatchEvent(event));
  return sent;
};

describe('Answer quickly on a wide screen — a mouse or trackpad never swipes', () => {
  it('leaves a drag on an agenda card’s head to text selection: nothing answered, nothing released, nothing prevented', async () => {
    const { root, fake } = await open();
    await start(root);
    const grip = must(root.querySelector<HTMLElement>('[data-agenda-frame] .fy-card-head'), 'the head');
    const selection = selectionSpy();
    const sent = await drag(grip, mouse, [100, 300], [450, 300]);
    selection.restore();
    expect(selection.released).toEqual([]);
    expect(sent.some(event => event.defaultPrevented)).toBe(false);
    expect(root.querySelector('[data-dragging]')).toBeNull();
    expect(pending(fake)).toEqual([]);
    expect(where(root)).toBe('1/2');
  });

  it('leaves a drag on the body, down or sideways, to text selection', async () => {
    const { root, fake } = await open();
    await start(root);
    const body = must(root.querySelector<HTMLElement>('[data-agenda-frame] [data-agenda-body]'), 'the body');
    await drag(body, mouse, [100, 300], [100, 450]);
    await drag(body, mouse, [100, 300], [450, 300]);
    expect(root.querySelector('[data-dragging]')).toBeNull();
    expect(where(root)).toBe('1/2');
    expect(pending(fake)).toEqual([]);
  });

  it('leaves a card to test alone too, from its head and from its body', async () => {
    const { root, actions } = await open({ cards: [], toTest: true });
    await start(root);
    const row = must(root.querySelector<HTMLElement>('[data-to-test]'), 'the row');
    const grip = must(row.querySelector<HTMLElement>('.fy-totest__top'), 'grip');
    const body = must(row.querySelector<HTMLElement>('.fy-totest__body, .fy-totest__steps, p, li'), 'the body');
    const selection = selectionSpy();
    await drag(grip, mouse, [100, 300], [450, 300]);
    await drag(body, mouse, [100, 300], [100, 450]);
    selection.restore();
    expect(selection.released).toEqual([]);
    expect(row.getAttribute('data-swipe-answer')).toBeNull();
    expect(step(root)?.textContent).toContain('Try the board');
    expect(actions.calls).toEqual([]);
  });

  it('does nothing for a mouse on a phone either', async () => {
    const { root, fake } = await open({ phone: true });
    await start(root);
    const grip = must(root.querySelector<HTMLElement>('[data-agenda-frame] .fy-card-head'), 'the head');
    await drag(grip, mouse, [100, 300], [450, 300]);
    expect(pending(fake)).toEqual([]);
  });
});

describe('Answer quickly on a wide screen — a finger still swipes', () => {
  it('swipes an agenda card with touch, as a touchscreen laptop does', async () => {
    const { root, fake } = await open();
    await start(root);
    const grip = must(root.querySelector<HTMLElement>('[data-agenda-frame] .fy-card-head'), 'the head');
    await drag(grip, touch, [100, 300], [450, 300]);
    expect(pending(fake)).toEqual(['Wait']);
  });

  it('swipes a card to test with touch: right is Done', async () => {
    const { root, actions } = await open({ cards: [], toTest: true });
    await start(root);
    const row = must(root.querySelector<HTMLElement>('[data-to-test]'), 'the row');
    const grip = must(row.querySelector<HTMLElement>('.fy-totest__top'), 'grip');
    await interact(() => grip.dispatchEvent(touch('pointerdown', 100)));
    await interact(() => grip.dispatchEvent(touch('pointermove', 200)));
    await interact(() => grip.dispatchEvent(touch('pointermove', 450)));
    expect(row.getAttribute('data-swipe-answer')).toBe('Done');
    await interact(() => grip.dispatchEvent(touch('pointerup', 450)));
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
  });
});
