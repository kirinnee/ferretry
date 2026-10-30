import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import {
  AgendaQuickReplies,
  type AgendaQuickRepliesProps,
} from '../../../src/features/agenda/agenda-quick-replies.tsx';
import { itemOptions } from '../../../src/lib/agenda-options.ts';
import { cardModel } from '../../../src/lib/agenda-card-model.ts';
import { type InboxAction, swipeMap } from '../../../src/lib/agenda-inbox.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const chosen = agendaItem('A47', {
  ask: choices('SQLite', 'Postgres'),
  recommendation: { decision: 'SQLite' },
} as Partial<AgendaItem>);

interface Spy {
  readonly acted: InboxAction[];
  skipped: number;
}

const draw = async (item: AgendaItem, extra: Partial<AgendaQuickRepliesProps> = {}): Promise<Spy> => {
  const spy: Spy = { acted: [], skipped: 0 };
  await view?.unmount();
  view = await mount(
    <AgendaQuickReplies
      busy={false}
      error={null}
      map={swipeMap(item)}
      model={cardModel(item)}
      onAct={action => spy.acted.push(action)}
      options={itemOptions(item)}
      onSkip={() => {
        spy.skipped += 1;
      }}
      skipLabel="Skip"
      swipeable
      {...extra}
    />,
  );
  return spy;
};

const root = (): HTMLElement => must(view?.container, 'the row');
const one = <T extends Element>(selector: string): T => must(root().querySelector<T>(selector), selector);
const answer = (label: string) =>
  must(
    [...root().querySelectorAll<HTMLButtonElement>('[data-agenda-option]')].find(
      button => button.dataset.agendaOption === label,
    ),
    label,
  );

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
const lane = (): HTMLElement => one<HTMLElement>('.fy-qr');
const drag = async (to: { x: number; y: number }, init: PointerEventInit = {}): Promise<void> => {
  await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200, init)));
  await interact(() => lane().dispatchEvent(pointer('pointermove', to.x, to.y, init)));
  await interact(() => lane().dispatchEvent(pointer('pointerup', to.x, to.y, init)));
};

describe('the quick replies', () => {
  test('are a row of chips directly above the composer, the recommended one tagged', async () => {
    await draw(chosen);
    expect(one('[data-agenda-quick-replies]')).toBeDefined();
    expect(one('fieldset').getAttribute('aria-label')).toBe('Quick replies');
    expect(root().querySelector('textarea, input')).toBeNull();
    expect(answer('SQLite').dataset.agendaAnswer).toBe('up');
    expect(answer('Postgres').dataset.agendaAnswer).toBe('left');
    expect(answer('SQLite').hasAttribute('data-recommended')).toBe(true);
    expect(answer('SQLite').getAttribute('aria-label')).toBe('SQLite, recommended, or swipe up');
    expect(answer('SQLite').querySelector('.lucide-check')).toBeNull();
    expect(answer('Postgres').getAttribute('aria-label')).toBe('Postgres, or swipe left');
    expect(answer('Postgres').hasAttribute('data-recommended')).toBe(false);
  });

  test('a tap answers at once, with an empty note for the host to fill from the composer', async () => {
    const spy = await draw(chosen);
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]).toMatchObject({ kind: 'respond', response: { choice: 'SQLite' } });
  });

  test('a busy item answers nothing', async () => {
    const spy = await draw(chosen, { busy: true });
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toEqual([]);
  });

  test('puts the recommended option on ↑ even when it is the last of three', async () => {
    const spy = await draw(
      agendaItem('A9', {
        ask: choices('Yes', 'No', 'Later'),
        recommendation: { decision: 'Later' },
      } as Partial<AgendaItem>),
    );
    expect(answer('Later').dataset.agendaAnswer).toBe('up');
    expect(answer('Later').hasAttribute('data-recommended')).toBe(true);
    await interact(() => answer('Later').click());
    expect(spy.acted).toHaveLength(1);
  });

  test('lays the buttons out by direction: ← left, ↑ middle, → right, the slot left blank when there is no answer', async () => {
    await draw(chosen);
    expect(one('fieldset').hasAttribute('data-slots')).toBe(true);
    expect([...root().querySelectorAll<HTMLElement>('.fy-qr__chip')].map(chip => chip.dataset.agendaAnswer)).toEqual([
      'left',
      'up',
    ]);
    expect(root().querySelector('[data-agenda-answer="right"]')).toBeNull();
    await draw(
      agendaItem('A12', {
        ask: choices('Now', 'Later', 'Never'),
        recommendation: { decision: 'Never' },
      } as Partial<AgendaItem>),
    );
    expect([...root().querySelectorAll<HTMLElement>('.fy-qr__chip')].map(chip => chip.dataset.agendaAnswer)).toEqual([
      'left',
      'up',
      'right',
    ]);
    expect(answer('Never').dataset.agendaAnswer).toBe('up');
    expect(answer('Now').dataset.agendaAnswer).toBe('left');
    expect(answer('Later').dataset.agendaAnswer).toBe('right');
  });

  test('draws three buttons at most; the options past them are in the "…" menu as "D — label", and answer too', async () => {
    const many = agendaItem('A8', {
      ask: choices('Now', 'Later', 'Never', 'Maybe', 'Soon'),
      recommendation: { decision: 'Maybe' },
    } as Partial<AgendaItem>);
    const spy = await draw(many);
    expect(root().querySelectorAll('[data-agenda-option]')).toHaveLength(3);
    expect(answer('Maybe').dataset.agendaAnswer).toBe('up');
    expect(root().querySelector('[data-agenda-extra]')).toBeNull();
    await interact(() => one<HTMLButtonElement>('[aria-label="More"], [aria-haspopup="menu"]').click());
    const extras = [...root().querySelectorAll<HTMLElement>('[data-agenda-extra]')];
    expect(extras.map(item => item.textContent)).toEqual(['C — Never', 'E — Soon']);
    await interact(() => must(extras[0], 'an extra item').click());
    expect(spy.acted[0]).toMatchObject({ kind: 'respond', response: { choice: 'Never' } });
  });

  test('the "…" menu moves between its items with ↓ and ↑, and wraps', async () => {
    await draw(
      agendaItem('A8', {
        ask: choices('Now', 'Later', 'Never', 'Maybe', 'Soon'),
        recommendation: { decision: 'Now' },
      } as Partial<AgendaItem>),
    );
    await interact(() => one<HTMLButtonElement>('[data-agenda-more]').click());
    const items = [...root().querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(document.activeElement).toBe(must(items[0], 'first'));
    await interact(() => pressKey(must(items[0], 'first'), 'ArrowDown'));
    expect(document.activeElement).toBe(must(items[1], 'second'));
    await interact(() => pressKey(must(items[1], 'second'), 'ArrowUp'));
    expect(document.activeElement).toBe(must(items[0], 'first'));
    await interact(() => pressKey(must(items[0], 'first'), 'ArrowUp'));
    expect(document.activeElement).toBe(must(items.at(-1), 'last'));
  });

  test('has no arrows on a mouse', async () => {
    await draw(chosen, { swipeable: false });
    expect(root().querySelector('.lucide-arrow-right')).toBeNull();
    expect(one('.fy-qr').hasAttribute('data-swipeable')).toBe(false);
  });

  test('says what the machine refused', async () => {
    await draw(chosen, { error: 'The machine said no.' });
    expect(one('[role="alert"]').textContent).toBe('Not sent: The machine said no.');
  });

  test('draws nothing when there is nothing to say', async () => {
    await draw(chosen, { model: { ...cardModel(chosen), notice: false, answers: [], extras: [] } });
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
  });

  test('says an item with its ferret is being waited on, and offers Clear for a notice', async () => {
    await draw(agendaItem('A2', { ask: { kind: 'permission' }, waitingOn: 'ferret' } as Partial<AgendaItem>), {
      waitingOn: 'Zoe',
    });
    expect(root().textContent).toContain('With Zoe — it will update this.');
    const notice = agendaItem('A3', { notice: true } as Partial<AgendaItem>);
    const spy = await draw(notice);
    await interact(() => one<HTMLButtonElement>('[data-agenda-clear]').click());
    expect(spy.acted[0]).toMatchObject({ kind: 'resolve', label: 'Clear' });
  });
});

describe('several questions', () => {
  const sendingProps = (calls: string[], extra: { ready?: boolean; canUseRecommended?: boolean } = {}) => ({
    sending: {
      ready: extra.ready ?? true,
      canUseRecommended: extra.canUseRecommended ?? true,
      onSend: () => calls.push('send'),
      onUseRecommended: () => calls.push('recommended'),
    },
  });
  const several = agendaItem('A5', {
    questions: [{ question: 'Which day?' }, { question: 'Who?' }],
  } as Partial<AgendaItem>);

  test('"Send answers" and "All recommended" are the row’s chips', async () => {
    const calls: string[] = [];
    await draw(several, sendingProps(calls));
    await interact(() => one<HTMLButtonElement>('[data-agenda-use-recommended]').click());
    await interact(() => one<HTMLButtonElement>('[data-agenda-send-answers]').click());
    expect(calls).toEqual(['recommended', 'send']);
  });

  test('"Send answers" waits for a pick for each question, and "All recommended" only shows when each has one', async () => {
    const calls: string[] = [];
    await draw(several, sendingProps(calls, { ready: false, canUseRecommended: false }));
    expect(one<HTMLButtonElement>('[data-agenda-send-answers]').disabled).toBe(true);
    expect(root().querySelector('[data-agenda-use-recommended]')).toBeNull();
  });

  test('a busy item sends nothing', async () => {
    const calls: string[] = [];
    await draw(several, { ...sendingProps(calls), busy: true });
    expect(one<HTMLButtonElement>('[data-agenda-send-answers]').disabled).toBe(true);
    expect(one<HTMLButtonElement>('[data-agenda-use-recommended]').disabled).toBe(true);
  });
});

describe('the swipe over the chips', () => {
  test('a long drag up sends the middle (recommended) answer', async () => {
    const spy = await draw(chosen);
    await drag({ x: 200, y: 0 });
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]).toMatchObject({ response: { choice: 'SQLite' } });
  });

  test('a long drag to the right sends the right answer when there is one', async () => {
    const spy = await draw(
      agendaItem('A12', {
        ask: choices('Now', 'Later', 'Never'),
        recommendation: { decision: 'Never' },
      } as Partial<AgendaItem>),
    );
    await drag({ x: 400, y: 200 });
    expect(spy.acted[0]).toMatchObject({ response: { choice: 'Later' } });
  });

  test('a long drag to the left sends the left answer', async () => {
    const spy = await draw(chosen);
    await drag({ x: 0, y: 200 });
    expect(spy.acted[0]).toMatchObject({ response: { choice: 'Postgres' } });
  });

  test('a short drag, or one toward nothing, sends nothing, and the click after it is swallowed', async () => {
    const spy = await draw(chosen);
    await drag({ x: 240, y: 200 });
    await drag({ x: 400, y: 200 });
    expect(spy.acted).toEqual([]);
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toEqual([]);
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toHaveLength(1);
  });

  test('a tap that never moved is just a tap', async () => {
    const spy = await draw(chosen);
    await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointermove', 203, 201)));
    await interact(() => lane().dispatchEvent(pointer('pointerup', 203, 201)));
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toHaveLength(1);
  });

  test('shows what the drag would send while it goes, and drops it when cancelled', async () => {
    await draw(chosen);
    await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointermove', 200, 140)));
    expect(one('.fy-qr__stamp').textContent).toContain('SQLite');
    expect(one('.fy-qr__stamp').hasAttribute('data-committed')).toBe(false);
    await interact(() => lane().dispatchEvent(pointer('pointermove', 200, 0)));
    expect(one('.fy-qr__stamp').hasAttribute('data-committed')).toBe(true);
    await interact(() => lane().dispatchEvent(pointer('pointercancel', 400, 200)));
    expect(root().querySelector('.fy-qr__stamp')).toBeNull();
  });

  test('says nothing of a drag toward a direction without an answer', async () => {
    await draw(chosen);
    await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointermove', 400, 200)));
    expect(root().querySelector('.fy-qr__stamp')).toBeNull();
  });

  test('ignores a mouse, a busy item, a row that does not swipe and a pointer it never saw', async () => {
    const spy = await draw(chosen);
    await drag({ x: 0, y: 200 }, { pointerType: 'mouse' });
    await interact(() => lane().dispatchEvent(pointer('pointermove', 0, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointerup', 0, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointermove', 0, 200, { pointerId: 99 })));
    await interact(() => lane().dispatchEvent(pointer('pointerup', 0, 200, { pointerId: 99 })));
    expect(spy.acted).toEqual([]);
    const busy = await draw(chosen, { busy: true });
    await drag({ x: 0, y: 200 });
    const still = await draw(chosen, { swipeable: false });
    await drag({ x: 0, y: 200 });
    expect(busy.acted).toEqual([]);
    expect(still.acted).toEqual([]);
  });
});

describe('the pull down over the chips', () => {
  test('a clear pull down skips', async () => {
    const spy = await draw(chosen);
    await drag({ x: 200, y: 400 });
    expect(spy.skipped).toBe(1);
    expect(spy.acted).toEqual([]);
  });

  test('a short pull down, or one more sideways than down, skips nothing', async () => {
    const spy = await draw(chosen);
    await drag({ x: 200, y: 240 });
    await drag({ x: 300, y: 260 });
    expect(spy.skipped).toBe(0);
  });

  test('says where a pull down goes while it is dragged, and commits it past the threshold', async () => {
    await draw(chosen, { skipLabel: 'Back to the chat' });
    await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointermove', 200, 260)));
    expect(one<HTMLElement>('.fy-qr__stamp').dataset.swipe).toBe('down');
    expect(one('.fy-qr__stamp').textContent).toBe('↓ Back to the chat');
    expect(one('.fy-qr__stamp').hasAttribute('data-committed')).toBe(false);
    await interact(() => lane().dispatchEvent(pointer('pointermove', 200, 420)));
    expect(one('.fy-qr__stamp').hasAttribute('data-committed')).toBe(true);
  });

  test('a row that does not swipe, or a mouse, does not skip on a pull down', async () => {
    const still = await draw(chosen, { swipeable: false });
    await drag({ x: 200, y: 400 });
    expect(still.skipped).toBe(0);
    const mouse = await draw(chosen);
    await drag({ x: 200, y: 400 }, { pointerType: 'mouse' });
    expect(mouse.skipped).toBe(0);
  });
});
