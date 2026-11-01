import { afterEach, describe, expect, it } from 'bun:test';
import { AgendaInboxPage, type AgendaInboxPageProps } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import type { ToTestHost } from '../../../src/features/agenda/to-test-rows.tsx';
import { toTestCards } from '../../../src/lib/to-test-inbox.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card, flush, laptop } from '../board-support.ts';
import { fakeActions, fill, submit } from './board-detail-support.tsx';

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
    ]),
  );

const owner = inboxCard(agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait') }));

const open = async (
  options: { readonly agendaCards?: readonly (typeof owner)[]; readonly page?: Partial<AgendaInboxPageProps> } = {},
) => {
  const fake = fakeInbox();
  const rows = await rowsOf();
  const actions = fakeActions({});
  const host: ToTestHost = { actions, ports: {}, connectionOf: () => laptop };
  view = await mount(
    <InboxHarness
      cards={options.agendaCards ?? [owner]}
      fake={fake}
      reading={false}
      toTest={rows}
      render={inbox => (
        <AgendaInboxPage
          clock={fake.clock.now}
          inbox={inbox}
          now={NOW}
          onNavigate={() => undefined}
          phone
          reducedMotion
          toTestHost={host}
          {...options.page}
        />
      )}
    />,
  );
  await interact(() => flush());
  return { root: view.container, actions };
};

const quick = (root: HTMLElement): HTMLElement =>
  must(root.querySelector<HTMLElement>('[data-agenda-quick]'), 'Answer quickly');
const where = (root: HTMLElement): string | null | undefined => root.querySelector('[data-agenda-where]')?.textContent;
const step = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('[data-inbox-open-to-test]');
const next = (root: HTMLElement): HTMLElement => must(root.querySelector<HTMLElement>('[aria-label^="Next"]'), 'Next');
const previous = (root: HTMLElement): HTMLElement =>
  must(root.querySelector<HTMLElement>('[aria-label^="Previous"]'), 'Previous');

describe('Answer quickly — with the cards waiting for a try', () => {
  it('counts the cards to test with the agenda items', async () => {
    const { root } = await open();
    expect(quick(root).querySelector('.fy-inbox-quick__count')?.textContent).toBe('3');
  });

  it('is offered when only cards to test are waiting', async () => {
    const { root } = await open({ agendaCards: [] });
    expect(quick(root).querySelector('.fy-inbox-quick__count')?.textContent).toBe('2');
  });

  it('deals the agenda items first, then each card to test, numbered through the whole run', async () => {
    const { root } = await open();
    await interact(() => quick(root).click());
    expect(step(root)).toBeNull();
    expect(where(root)).toBe('1/3');
    await interact(() => must(root.querySelector<HTMLElement>('[aria-label^="Next"]'), 'Next').click());
    const second = must(step(root), 'the first card to test');
    expect(where(root)).toBe('2/3');
    expect(second.textContent).toContain('Try the board');
    expect(second.textContent).toContain('Shipped in v1.2.0');
    expect(second.textContent).toContain('How to test');
    expect(second.textContent).toContain('Open the Board');
  });

  it('opens on the first card to test when no agenda item waits', async () => {
    const { root } = await open({ agendaCards: [] });
    await interact(() => quick(root).click());
    expect(step(root)?.textContent).toContain('Try the board');
    expect(where(root)).toBe('1/2');
  });

  it('steps back to the agenda item and forward to the next card to test', async () => {
    const { root } = await open();
    await interact(() => quick(root).click());
    await interact(() => next(root).click());
    await interact(() => next(root).click());
    expect(step(root)?.textContent).toContain('Second try');
    expect(where(root)).toBe('3/3');
    await interact(() => previous(root).click());
    expect(step(root)?.textContent).toContain('Try the board');
    await interact(() => previous(root).click());
    expect(step(root)).toBeNull();
    expect(where(root)).toBe('1/3');
  });

  it('ends the run after the last card to test, offering the skipped ones', async () => {
    const { root } = await open({ agendaCards: [] });
    await interact(() => quick(root).click());
    await interact(() => next(root).click());
    await interact(() => next(root).click());
    expect(root.querySelector('[data-agenda-queue-end]')).not.toBeNull();
  });

  it('Done on a card to test moves it to the Done lane at once', async () => {
    const { root, actions } = await open({ agendaCards: [] });
    await interact(() => quick(root).click());
    await interact(() => must(step(root)?.querySelector<HTMLElement>('[data-to-test-done]'), 'Done').click());
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
  });

  it('Not good asks for a reason, then reopens the card with it', async () => {
    const { root, actions } = await open({ agendaCards: [] });
    await interact(() => quick(root).click());
    await interact(() => must(step(root)?.querySelector<HTMLElement>('[data-to-test-not-good]'), 'Not good').click());
    const dialog = must(document.body.querySelector('[role="dialog"]'), 'the reason box');
    expect(actions.calls).toEqual([]);
    const form = dialog.closest('form') ?? dialog;
    await fill(must(form.querySelector('textarea, input'), 'the reason field') as HTMLTextAreaElement, 'It crashes');
    await submit(form as HTMLElement);
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["implement","It crashes"]']);
  });

  it('answers by swipe on a phone: right is Done, with the same row as the Inbox list', async () => {
    const { root, actions } = await open({ agendaCards: [] });
    await interact(() => quick(root).click());
    const row = must(root.querySelector<HTMLElement>('[data-to-test]'), 'the row');
    const grip = must(row.querySelector<HTMLElement>('.fy-totest__meta'), 'grip');
    const touch = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 300,
        pointerId: 4,
        pointerType: 'touch',
      });
    await interact(() => grip.dispatchEvent(touch('pointerdown', 100)));
    await interact(() => grip.dispatchEvent(touch('pointermove', 200)));
    await interact(() => grip.dispatchEvent(touch('pointermove', 400)));
    expect(row.getAttribute('data-swipe-answer')).toBe('Done');
    await interact(() => grip.dispatchEvent(touch('pointerup', 400)));
    await interact(() => flush());
    expect(actions.calls).toEqual(['moveTask:["closed"]']);
  });

  it('shows no run when nothing at all is waiting', async () => {
    const fake = fakeInbox();
    view = await mount(
      <InboxHarness
        cards={[]}
        fake={fake}
        reading={false}
        render={inbox => (
          <AgendaInboxPage clock={fake.clock.now} inbox={inbox} now={NOW} onNavigate={() => undefined} phone />
        )}
      />,
    );
    await interact(() => flush());
    expect(view.container.querySelector('[data-agenda-quick]')).toBeNull();
  });
});
