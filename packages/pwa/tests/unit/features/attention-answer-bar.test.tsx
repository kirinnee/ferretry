import { afterEach, describe, expect, test } from 'bun:test';
import type { AttentionItem } from '@ferretry/protocol';
import {
  AttentionAnswerBar,
  type AttentionAnswerBarProps,
} from '../../../src/features/attention/attention-answer-bar.tsx';
import { cardModel } from '../../../src/lib/attention-card-model.ts';
import { type InboxAction, swipeMap } from '../../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { typeInto } from '../../support/learning-dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const chosen = attentionItem('A47', {
  ask: choices('SQLite', 'Postgres'),
  recommendation: { decision: 'SQLite' },
} as Partial<AttentionItem>);

interface Spy {
  readonly acted: { action: InboxAction; note: string }[];
  readonly sent: string[];
  replies: number;
}

const draw = async (
  item: AttentionItem,
  extra: Partial<AttentionAnswerBarProps> = {},
  onSend?: (text: string) => Promise<void>,
): Promise<Spy> => {
  const spy: Spy = { acted: [], sent: [], replies: 0 };
  view = await mount(
    <AttentionAnswerBar
      busy={false}
      error={null}
      ferret="Zoe"
      item={item}
      map={swipeMap(item)}
      model={cardModel(item)}
      onAct={(action, note) => spy.acted.push({ action, note })}
      onReply={() => {
        spy.replies += 1;
      }}
      onSend={
        onSend ??
        (async text => {
          spy.sent.push(text);
        })
      }
      swipeable
      {...extra}
    />,
  );
  return spy;
};

const root = (): HTMLElement => must(view?.container, 'the bar');
const one = <T extends Element>(selector: string): T => must(root().querySelector<T>(selector), selector);
const field = () => one<HTMLTextAreaElement>('[data-agenda-field]');
const sendButton = () => one<HTMLButtonElement>('[data-agenda-send]');
const answer = (label: string) =>
  must(
    [...root().querySelectorAll<HTMLButtonElement>('[data-attention-answer]')].find(
      button => button.dataset.attentionOption === label,
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
const drag = async (to: { x: number; y: number }, init: PointerEventInit = {}): Promise<void> => {
  const lane = one<HTMLElement>('.fy-item-bar__answers');
  await interact(() => lane.dispatchEvent(pointer('pointerdown', 200, 200, init)));
  await interact(() => lane.dispatchEvent(pointer('pointermove', to.x, to.y, init)));
  await interact(() => lane.dispatchEvent(pointer('pointerup', to.x, to.y, init)));
};

describe('the answer bar', () => {
  test('is the bottom bar and offers the item’s answers, the recommended one on the right', async () => {
    await draw(chosen);
    expect(one('footer').getAttribute('data-agenda-bar')).toBe('');
    expect(one('footer').hasAttribute('data-safe-bottom')).toBe(true);
    expect(answer('SQLite').dataset.attentionAnswer).toBe('right');
    expect(answer('Postgres').dataset.attentionAnswer).toBe('left');
  });

  test('an answer sends the text typed in the field as its note', async () => {
    const spy = await draw(chosen);
    await typeInto(field(), 'on staging first');
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]?.note).toBe('on staging first');
    expect(spy.acted[0]?.action).toMatchObject({ kind: 'respond', response: { choice: 'SQLite' } });
  });

  test('an answer with nothing typed carries an empty note', async () => {
    const spy = await draw(chosen);
    await interact(() => answer('Postgres').click());
    expect(spy.acted[0]?.note).toBe('');
  });

  test('a busy item answers nothing', async () => {
    const spy = await draw(chosen, { busy: true });
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toEqual([]);
  });

  test('"Add to reply" asks for the item to be added to the next reply, without answering', async () => {
    const spy = await draw(chosen);
    await interact(() => one<HTMLButtonElement>('[data-agenda-add-reply]').click());
    expect(spy.replies).toBe(1);
    expect(spy.acted).toEqual([]);
  });

  test('has no arrows on a mouse', async () => {
    await draw(chosen, { swipeable: false });
    expect(root().querySelector('.lucide-arrow-right')).toBeNull();
    expect(one('.fy-item-bar__answers').hasAttribute('data-swipeable')).toBe(false);
  });

  test('says what the machine refused', async () => {
    await draw(chosen, { error: 'The machine said no.' });
    expect(one('[role="alert"]').textContent).toBe('Not sent: The machine said no.');
  });

  test('says an item with its ferret is being waited on, and offers Clear for a notice', async () => {
    await draw(attentionItem('A2', { ask: { kind: 'permission' }, waitingOn: 'ferret' } as Partial<AttentionItem>));
    expect(root().textContent).toContain('With Zoe — it will update this.');
    await view?.unmount();
    const notice = attentionItem('A3', { notice: true } as Partial<AttentionItem>);
    const spy = await draw(notice);
    await interact(() =>
      must(
        [...root().querySelectorAll('button')].find(button => button.textContent?.includes('Clear')),
        'Clear',
      ).click(),
    );
    expect(spy.acted[0]?.action).toMatchObject({ kind: 'resolve', label: 'Clear' });
  });
});

describe('the reply field', () => {
  test('sends what is typed, trimmed, on the button or on Enter, and then empties', async () => {
    const spy = await draw(chosen);
    expect(sendButton().disabled).toBe(true);
    await typeInto(field(), '  first  ');
    expect(sendButton().disabled).toBe(false);
    await interact(() => sendButton().click());
    expect(spy.sent).toEqual(['first']);
    expect(field().value).toBe('');

    await typeInto(field(), 'second');
    await interact(() => pressKey(field(), 'Enter'));
    expect(spy.sent).toEqual(['first', 'second']);
  });

  test('keeps a newline for Shift+Enter, ignores an Enter that commits a composition, sends nothing when empty', async () => {
    const spy = await draw(chosen);
    await typeInto(field(), 'line');
    await interact(() => pressKey(field(), 'Enter', { shiftKey: true }));
    await interact(() => pressKey(field(), 'Enter', { isComposing: true }));
    await interact(() => pressKey(field(), 'a'));
    expect(spy.sent).toEqual([]);
    await typeInto(field(), '   ');
    await interact(() => pressKey(field(), 'Enter'));
    expect(spy.sent).toEqual([]);
  });

  test('keeps the text and says why when the message does not go', async () => {
    await draw(chosen, {}, async () => {
      throw new Error('The connection dropped.');
    });
    await typeInto(field(), 'hello');
    await interact(() => sendButton().click());
    expect(one('[role="alert"]').textContent).toBe('Not sent: The connection dropped.');
    expect(field().value).toBe('hello');
  });

  test('has a plain sentence for a failure that is not an error, and clears it on the next try', async () => {
    let attempts = 0;
    await draw(chosen, {}, async () => {
      attempts += 1;
      if (attempts === 1) throw 'nope';
    });
    await typeInto(field(), 'hello');
    await interact(() => sendButton().click());
    expect(one('[role="alert"]').textContent).toBe('Not sent: The message did not go.');
    await interact(() => sendButton().click());
    expect(root().querySelector('[role="alert"]')).toBeNull();
    expect(field().value).toBe('');
  });

  test('sends once while a send is in flight', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    await draw(chosen, {}, () => {
      calls += 1;
      return new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await typeInto(field(), 'hello');
    await interact(() => sendButton().click());
    expect(sendButton().disabled).toBe(true);
    await interact(() => pressKey(field(), 'Enter'));
    expect(calls).toBe(1);
    await interact(() => release());
    expect(field().value).toBe('');
  });
});

describe('the swipe over the answers', () => {
  test('a long drag to the right sends the right answer, with the typed text', async () => {
    const spy = await draw(chosen);
    await typeInto(field(), 'noted');
    await drag({ x: 400, y: 200 });
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]?.action).toMatchObject({ response: { choice: 'SQLite' } });
    expect(spy.acted[0]?.note).toBe('noted');
  });

  test('a long drag to the left sends the left answer', async () => {
    const spy = await draw(chosen);
    await drag({ x: 0, y: 200 });
    expect(spy.acted[0]?.action).toMatchObject({ response: { choice: 'Postgres' } });
  });

  test('a short drag, or one toward nothing, sends nothing, and the click after it is swallowed', async () => {
    const spy = await draw(chosen);
    await drag({ x: 240, y: 200 });
    await drag({ x: 200, y: 500 });
    expect(spy.acted).toEqual([]);
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toEqual([]);
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toHaveLength(1);
  });

  test('a tap that never moved is just a tap', async () => {
    const spy = await draw(chosen);
    const lane = one<HTMLElement>('.fy-item-bar__answers');
    await interact(() => lane.dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane.dispatchEvent(pointer('pointermove', 203, 201)));
    await interact(() => lane.dispatchEvent(pointer('pointerup', 203, 201)));
    await interact(() => answer('SQLite').click());
    expect(spy.acted).toHaveLength(1);
  });

  test('shows what the drag would send while it goes, and drops it when cancelled', async () => {
    await draw(chosen);
    const lane = one<HTMLElement>('.fy-item-bar__answers');
    await interact(() => lane.dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane.dispatchEvent(pointer('pointermove', 260, 200)));
    expect(one('.fy-item-bar__stamp').textContent).toContain('SQLite');
    expect(one('.fy-item-bar__stamp').hasAttribute('data-committed')).toBe(false);
    await interact(() => lane.dispatchEvent(pointer('pointermove', 400, 200)));
    expect(one('.fy-item-bar__stamp').hasAttribute('data-committed')).toBe(true);
    await interact(() => lane.dispatchEvent(pointer('pointercancel', 400, 200)));
    expect(root().querySelector('.fy-item-bar__stamp')).toBeNull();
  });

  test('says nothing of a drag toward a direction without an answer', async () => {
    await draw(chosen);
    const lane = one<HTMLElement>('.fy-item-bar__answers');
    await interact(() => lane.dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane.dispatchEvent(pointer('pointermove', 200, 100)));
    expect(root().querySelector('.fy-item-bar__stamp')).toBeNull();
  });

  test('ignores a mouse, a busy item, a bar that does not swipe and a pointer it never saw', async () => {
    const spy = await draw(chosen);
    await drag({ x: 400, y: 200 }, { pointerType: 'mouse' });
    const lane = one<HTMLElement>('.fy-item-bar__answers');
    await interact(() => lane.dispatchEvent(pointer('pointermove', 400, 200)));
    await interact(() => lane.dispatchEvent(pointer('pointerup', 400, 200)));
    await interact(() => lane.dispatchEvent(pointer('pointerdown', 200, 200)));
    await interact(() => lane.dispatchEvent(pointer('pointermove', 400, 200, { pointerId: 99 })));
    await interact(() => lane.dispatchEvent(pointer('pointerup', 400, 200, { pointerId: 99 })));
    expect(spy.acted).toEqual([]);
    await view?.unmount();
    const busy = await draw(chosen, { busy: true });
    await drag({ x: 400, y: 200 });
    const still = await draw(chosen, { swipeable: false });
    await drag({ x: 400, y: 200 });
    expect(busy.acted).toEqual([]);
    expect(still.acted).toEqual([]);
  });
});

describe('several questions', () => {
  test('"Send answers" hands over the typed text as the note', async () => {
    const sent: string[] = [];
    const several = attentionItem('A5', {
      questions: [{ question: 'Which day?' }, { question: 'Who?' }],
    } as Partial<AttentionItem>);
    await draw(several, { sendAnswers: { ready: true, onSend: note => sent.push(note) } });
    await typeInto(field(), 'both Monday');
    await interact(() => one<HTMLButtonElement>('[data-attention-send-answers]').click());
    expect(sent).toEqual(['both Monday']);
  });
});
