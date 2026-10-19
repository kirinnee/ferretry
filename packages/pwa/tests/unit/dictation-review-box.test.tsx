import { describe, expect, it } from 'bun:test';
import { DictationReviewBox, reviewKeyAction } from '../../src/components/dictation-review-box.tsx';
import type { DictationReview } from '../../src/hooks/use-dictation.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';
import { typeInto } from '../support/learning-dom.ts';

const cleanedTake: DictationReview = { id: 1, raw: 'um fix the bug', cleaned: 'Fix the bug.' };
const plainTake: DictationReview = { id: 2, raw: 'ship it', cleaned: 'ship it' };

interface Calls {
  inserted: string[];
  discarded: number;
  retried: number;
}

const harness = (review: DictationReview): { calls: Calls; element: React.ReactElement } => {
  const calls: Calls = { inserted: [], discarded: 0, retried: 0 };
  return {
    calls,
    element: (
      <DictationReviewBox
        review={review}
        onInsert={text => calls.inserted.push(text)}
        onDiscard={() => {
          calls.discarded += 1;
        }}
        onRetry={() => {
          calls.retried += 1;
        }}
      />
    ),
  };
};

const field = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector('textarea'), 'the review text') as HTMLTextAreaElement;
const button = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(container.querySelector(`button[aria-label="${label}"]`), label) as HTMLButtonElement;
const segment = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label),
    `the ${label} segment`,
  ) as HTMLButtonElement;

describe('reviewKeyAction', () => {
  const key = (name: string, extra: Partial<{ shiftKey: boolean; isComposing: boolean }> = {}) =>
    reviewKeyAction({ key: name, shiftKey: false, isComposing: false, ...extra });

  it('inserts on Enter and discards on Escape', () => {
    expect(key('Enter')).toBe('insert');
    expect(key('Escape')).toBe('discard');
  });

  it('keeps Shift+Enter as a newline and ignores every other key', () => {
    expect(key('Enter', { shiftKey: true })).toBeNull();
    expect(key('a')).toBeNull();
  });

  it('leaves a key alone while an input method is composing', () => {
    expect(key('Enter', { isComposing: true })).toBeNull();
    expect(key('Escape', { isComposing: true })).toBeNull();
  });
});

describe('<DictationReviewBox>', () => {
  it('shows the cleaned text first, editable, and takes no focus by itself', async () => {
    const { element } = harness(cleanedTake);
    const view = await mount(element);
    expect(field(view.container).value).toBe('Fix the bug.');
    expect(field(view.container).getAttribute('data-review-text')).toBe('cleaned');
    expect(document.activeElement).toBe(document.body);
    await view.unmount();
  });

  it('inserts the text as edited, through the Insert button', async () => {
    const { calls, element } = harness(cleanedTake);
    const view = await mount(element);
    await typeInto(field(view.container), 'Fix the bug today.');
    await interact(() => button(view.container, 'Insert at the cursor').click());
    expect(calls.inserted).toEqual(['Fix the bug today.']);
    await view.unmount();
  });

  it('discards and retries from their own buttons, inserting nothing', async () => {
    const { calls, element } = harness(cleanedTake);
    const view = await mount(element);
    await interact(() => button(view.container, 'Discard dictation').click());
    await interact(() => button(view.container, 'Record again').click());
    expect(calls).toEqual({ inserted: [], discarded: 1, retried: 1 });
    await view.unmount();
  });

  it('offers the raw transcript when cleanup changed the words, and keeps each side’s edits', async () => {
    const { calls, element } = harness(cleanedTake);
    const view = await mount(element);
    expect(segment(view.container, 'Cleaned').getAttribute('aria-pressed')).toBe('true');
    expect(segment(view.container, 'Raw').getAttribute('aria-pressed')).toBe('false');

    await typeInto(field(view.container), 'Fix the bug!');
    await interact(() => segment(view.container, 'Raw').click());
    expect(field(view.container).value).toBe('um fix the bug');
    expect(field(view.container).getAttribute('data-review-text')).toBe('raw');
    expect(segment(view.container, 'Raw').getAttribute('aria-pressed')).toBe('true');

    await interact(() => button(view.container, 'Insert at the cursor').click());
    expect(calls.inserted).toEqual(['um fix the bug']);

    await interact(() => segment(view.container, 'Cleaned').click());
    expect(field(view.container).value).toBe('Fix the bug!');
    await view.unmount();
  });

  it('has no switch when cleanup changed nothing', async () => {
    const { element } = harness(plainTake);
    const view = await mount(element);
    expect(view.container.querySelector('fieldset')).toBeNull();
    expect(view.container.querySelector('[data-review-notice]')).toBeNull();
    await view.unmount();
  });

  it('says cleanup failed, with the reason, and offers only the raw words', async () => {
    const { element } = harness({
      ...plainTake,
      enhancementError: { code: 'enhancement-timeout', message: 'Groq timed out.' },
    });
    const view = await mount(element);
    const notice = must(view.container.querySelector('[data-review-notice="cleanup-failed"]'), 'the notice');
    expect(notice.textContent).toContain('Cleanup failed, so this is the raw transcript.');
    expect(notice.textContent).toContain('Groq timed out.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(view.container.querySelector('fieldset')).toBeNull();
    await view.unmount();
  });

  it('inserts on Enter and discards on Escape from the text, and stops the event', async () => {
    const { calls, element } = harness(cleanedTake);
    const view = await mount(element);
    const text = field(view.container);
    let reached = 0;
    document.addEventListener('keydown', () => (reached += 1), { once: true });

    await interact(() => pressKey(text, 'Enter'));
    expect(calls.inserted).toEqual(['Fix the bug.']);
    expect(reached).toBe(0);

    await interact(() => pressKey(text, 'Enter', { metaKey: true }));
    expect(calls.inserted).toEqual(['Fix the bug.', 'Fix the bug.']);

    await interact(() => pressKey(text, 'Escape'));
    expect(calls.discarded).toBe(1);

    await interact(() => pressKey(text, 'Enter', { shiftKey: true }));
    await interact(() => pressKey(text, 'a'));
    expect(calls.inserted).toHaveLength(2);
    expect(calls.discarded).toBe(1);
    await view.unmount();
  });

  it('will not insert an emptied text, by button or by key', async () => {
    const { calls, element } = harness(cleanedTake);
    const view = await mount(element);
    await typeInto(field(view.container), '   ');
    expect(button(view.container, 'Insert at the cursor').disabled).toBe(true);
    await interact(() => pressKey(field(view.container), 'Enter'));
    expect(calls.inserted).toEqual([]);
    await view.unmount();
  });

  it('starts clean for the next take: a new id remounts the box', async () => {
    const { element } = harness(cleanedTake);
    const view = await mount(<div key="take-1">{element}</div>);
    await interact(() => segment(view.container, 'Raw').click());
    const next = harness({ ...cleanedTake, id: 9, cleaned: 'Ship it.', raw: 'ship it' });
    await view.render(<div key="take-2">{next.element}</div>);
    expect(field(view.container).value).toBe('Ship it.');
    await view.unmount();
  });
});
