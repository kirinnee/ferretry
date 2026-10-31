import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import {
  AgendaQuickReplies,
  type AgendaQuickRepliesProps,
} from '../../../src/features/agenda/agenda-quick-replies.tsx';
import { cardModel } from '../../../src/lib/agenda-card-model.ts';
import { type InboxAction, swipeMap } from '../../../src/lib/agenda-inbox.ts';
import { itemOptions } from '../../../src/lib/agenda-options.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

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
      onDown={() => {
        spy.skipped += 1;
      }}
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
    expect(answer('SQLite').dataset.agendaAnswer).toBe('left');
    expect(answer('Postgres').dataset.agendaAnswer).toBe('right');
    expect(answer('SQLite').hasAttribute('data-recommended')).toBe(true);
    expect(answer('SQLite').getAttribute('aria-label')).toBe('SQLite, recommended, or swipe left');
    expect(answer('SQLite').querySelector('.lucide-check')).toBeNull();
    expect(answer('Postgres').getAttribute('aria-label')).toBe('Postgres, or swipe right');
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

  test('keeps the recommended option in its place in the list: the last of three is →', async () => {
    const spy = await draw(
      agendaItem('A9', {
        ask: choices('Yes', 'No', 'Later'),
        recommendation: { decision: 'Later' },
      } as Partial<AgendaItem>),
    );
    expect(answer('Later').dataset.agendaAnswer).toBe('right');
    expect(answer('Later').hasAttribute('data-recommended')).toBe(true);
    await interact(() => answer('Later').click());
    expect(spy.acted).toHaveLength(1);
  });

  test('lays the buttons out by direction in the list’s order: ← first, ↑ second, → third; two take ← and →', async () => {
    await draw(chosen);
    expect(one('fieldset').hasAttribute('data-slots')).toBe(true);
    expect([...root().querySelectorAll<HTMLElement>('.fy-qr__chip')].map(chip => chip.dataset.agendaAnswer)).toEqual([
      'left',
      'right',
    ]);
    expect(root().querySelector('[data-agenda-answer="up"]')).toBeNull();
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
    expect(answer('Now').dataset.agendaAnswer).toBe('left');
    expect(answer('Later').dataset.agendaAnswer).toBe('up');
    expect(answer('Never').dataset.agendaAnswer).toBe('right');
  });

  test('draws three answers at most, in ONE row: the options past them are chosen from the card’s list', async () => {
    const many = agendaItem('A8', {
      ask: choices('Now', 'Later', 'Never', 'Maybe', 'Soon'),
      recommendation: { decision: 'Maybe' },
    } as Partial<AgendaItem>);
    await draw(many);
    expect(root().querySelectorAll('[data-agenda-answer]')).toHaveLength(3);
    expect(answer('Maybe').hasAttribute('data-recommended')).toBe(true);
    expect(root().querySelectorAll('fieldset')).toHaveLength(1);
    expect(root().querySelector('[data-agenda-more-row]')).toBeNull();
    expect(root().querySelector('[aria-haspopup="menu"]')).toBeNull();
  });

  test('has no Not needed of its own: that is the card’s top-bar pill and the ↓ swipe', async () => {
    await draw(agendaItem('A9', { ask: choices('Now', 'Later', 'Never') } as Partial<AgendaItem>));
    expect(root().querySelector('[data-agenda-dismiss]')).toBeNull();
  });

  test('lays the answers out ← ↑ → with their arrows, and no hole for an empty slot', async () => {
    await draw(agendaItem('A10', { ask: choices('Now', 'Later') } as Partial<AgendaItem>));
    const kids = [...one('fieldset.fy-qr__row').children] as HTMLElement[];
    expect(kids.map(kid => kid.dataset.agendaAnswer)).toEqual(['left', 'right']);
    expect(kids.map(kid => kid.querySelector('.fy-qr__arrow')?.textContent)).toEqual(['←', '→']);
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

  test('says an item with its ferret is being waited on, and offers Got it for a notice', async () => {
    await draw(agendaItem('A2', { ask: { kind: 'permission' }, waitingOn: 'ferret' } as Partial<AgendaItem>), {
      waitingOn: 'Zoe',
    });
    expect(root().textContent).toContain('With Zoe — it will update this.');
    const notice = agendaItem('A3', { notice: true } as Partial<AgendaItem>);
    const spy = await draw(notice);
    expect(one('[data-agenda-clear]').textContent).toBe('Got it');
    await interact(() => one<HTMLButtonElement>('[data-agenda-clear]').click());
    expect(spy.acted[0]).toMatchObject({ kind: 'resolve', label: 'Clear' });
  });
});

describe('Request changes', () => {
  const review = agendaItem('A5', { kind: 'review', ask: { kind: 'answer-review' } } as Partial<AgendaItem>);
  const requestChanges = (calls: string[]) => ({
    requestChanges: {
      answer: { direction: 'left' as const, does: 'clarify' as const, label: 'Request changes' },
      onTap: () => calls.push('request'),
    },
  });

  test('is a button on the left beside Approve, tapped only: it hands over to the host, never sends by itself', async () => {
    const calls: string[] = [];
    const spy = await draw(review, requestChanges(calls));
    const labels = [...root().querySelectorAll('.fy-qr__chip')].map(each => each.textContent);
    expect(labels).toEqual(['Request changes', '→Approve']);
    await interact(() => answer('Request changes').click());
    expect(calls).toEqual(['request']);
    expect(spy.acted).toEqual([]);
    // The swipe left gives nothing: its words are the composer's.
    await drag({ x: 0, y: 200 });
    expect(spy.acted).toEqual([]);
  });

  test('is not drawn where the host cannot take the owner to the composer, and does nothing while busy', async () => {
    await draw(review);
    expect(root().querySelector('[data-agenda-option="Request changes"]')).toBeNull();
    const calls: string[] = [];
    await draw(review, { ...requestChanges(calls), busy: true });
    await interact(() => answer('Request changes').click());
    expect(calls).toEqual([]);
  });
});

describe('a card answered in words', () => {
  test('draws no buttons for an open question or for several questions', async () => {
    await draw(agendaItem('A6', { ask: { kind: 'open-question' } } as Partial<AgendaItem>));
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    await draw(
      agendaItem('A7', {
        ask: { kind: 'open-question' },
        questions: [
          { question: 'Which day?', options: [{ label: 'Monday' }, { label: 'Friday' }] },
          { question: 'Who?', options: [{ label: 'Zoe' }, { label: 'Kit' }] },
        ],
      } as Partial<AgendaItem>),
    );
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
  });
});

describe('the swipe over the chips', () => {
  test('a long drag up sends the middle answer — the second option', async () => {
    const spy = await draw(agendaItem('A12', { ask: choices('Now', 'Later', 'Never') } as Partial<AgendaItem>));
    await drag({ x: 200, y: 0 });
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]).toMatchObject({ response: { choice: 'Later' } });
  });

  test('a long drag to the right sends the right answer when there is one', async () => {
    const spy = await draw(
      agendaItem('A12', {
        ask: choices('Now', 'Later', 'Never'),
        recommendation: { decision: 'Never' },
      } as Partial<AgendaItem>),
    );
    await drag({ x: 400, y: 200 });
    expect(spy.acted[0]).toMatchObject({ response: { choice: 'Never' } });
  });

  test('a long drag to the left sends the left answer', async () => {
    const spy = await draw(chosen);
    await drag({ x: 0, y: 200 });
    expect(spy.acted[0]).toMatchObject({ response: { choice: 'SQLite' } });
  });

  test('a short drag, or one toward nothing, sends nothing, and the click after it is swallowed', async () => {
    const spy = await draw(chosen);
    await drag({ x: 240, y: 200 });
    await drag({ x: 200, y: 0 });
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

  test('names nothing while a drag goes, and a cancelled drag sends nothing', async () => {
    const spy = await draw(chosen);
    await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointermove', 200, 0)));
    expect(root().querySelector('.fy-qr__stamp')).toBeNull();
    await interact(() => lane().dispatchEvent(pointer('pointercancel', 400, 200)));
    expect(spy.acted).toEqual([]);
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

describe('the pull down over the chips: Not needed', () => {
  test('a clear pull down is Not needed, and does nothing where the host offers none', async () => {
    await draw(chosen, { onDown: undefined });
    await drag({ x: 200, y: 400 });
    expect(root().querySelector('[role="alert"]')).toBeNull();
  });

  test('a clear pull down calls onDown', async () => {
    const spy = await draw(chosen);
    await drag({ x: 200, y: 400 });
    expect(spy.skipped).toBe(1);
    expect(spy.acted).toEqual([]);
  });

  test('a short pull down, or one more sideways than down, calls nothing', async () => {
    const spy = await draw(chosen);
    await drag({ x: 200, y: 240 });
    await drag({ x: 300, y: 260 });
    expect(spy.skipped).toBe(0);
  });

  test('a pull down shows no floating label, and commits past the threshold', async () => {
    const spy = await draw(chosen);
    await interact(() => lane().dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane().dispatchEvent(pointer('pointermove', 200, 260)));
    expect(root().querySelector('.fy-qr__stamp')).toBeNull();
    await interact(() => lane().dispatchEvent(pointer('pointermove', 200, 420)));
    await interact(() => lane().dispatchEvent(pointer('pointerup', 200, 420)));
    expect(spy.skipped).toBe(1);
  });

  test('a row that does not swipe, or a mouse, does not call onDown on a pull down', async () => {
    const still = await draw(chosen, { swipeable: false });
    await drag({ x: 200, y: 400 });
    expect(still.skipped).toBe(0);
    const mouse = await draw(chosen);
    await drag({ x: 200, y: 400 }, { pointerType: 'mouse' });
    expect(mouse.skipped).toBe(0);
  });
});
