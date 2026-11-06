import { afterEach, describe, expect, it } from 'bun:test';
import { QuestionReadingBar, questionReadingKeyAction } from '../../src/components/question-reading-bar.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

/** The retained question reader's own controls (F137 slice 5, fix round 3): words, Stop, Repeat, and guarded keys. */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('questionReadingKeyAction', () => {
  const act = (key: string, init: KeyboardEventInit = {}, target?: Element): string | null => {
    let result: string | null = 'unset';
    const probe = (event: KeyboardEvent): void => {
      result = questionReadingKeyAction(event);
    };
    document.addEventListener('keydown', probe, { once: true });
    (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    document.removeEventListener('keydown', probe);
    return result;
  };

  it('maps Escape, S and Space to stop, and R to repeat (either case)', () => {
    expect(act('Escape')).toBe('stop');
    expect(act('s')).toBe('stop');
    expect(act('S')).toBe('stop');
    expect(act(' ')).toBe('stop');
    expect(act('Spacebar')).toBe('stop');
    expect(act('r')).toBe('repeat');
    expect(act('R')).toBe('repeat');
    expect(act('x')).toBeNull();
    expect(act('Enter')).toBeNull();
  });

  it("ignores modifiers, auto-repeat, text fields and a focused button's own Space", () => {
    expect(act('Escape', { ctrlKey: true })).toBeNull();
    expect(act('Escape', { metaKey: true })).toBeNull();
    expect(act('Escape', { altKey: true })).toBeNull();
    expect(act('Escape', { repeat: true })).toBeNull();
    const field = document.createElement('textarea');
    const button = document.createElement('button');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(field, button, editable);
    expect(act('Escape', {}, field)).toBeNull();
    expect(act('r', {}, editable)).toBeNull();
    expect(act(' ', {}, button)).toBeNull();
    expect(act('Escape', {}, button)).toBe('stop');
    field.remove();
    button.remove();
    editable.remove();
  });

  it('ignores a key something already handled', () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    expect(questionReadingKeyAction(event)).toBeNull();
  });
});

describe('QuestionReadingBar', () => {
  const rig = async (layout: 'phone' | 'desktop') => {
    const calls: string[] = [];
    mounted = await mount(
      <QuestionReadingBar layout={layout} onRepeat={() => calls.push('repeat')} onStop={() => calls.push('stop')} />,
    );
    return { calls, root: mounted.container };
  };

  it('desktop: states the reading in words, writes the keys on the buttons, and has no microphone control', async () => {
    const { root } = await rig('desktop');
    const bar = must(root.querySelector('[data-question-reading]'), 'bar');
    expect(bar.getAttribute('aria-label')).toBe('Reading the question');
    expect(must(root.querySelector('[data-question-reading-state]'), 'state').textContent).toBe(
      'Reading the question aloud',
    );
    expect([...root.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Stop readingSpace', 'RepeatR']);
    expect(root.querySelectorAll('kbd')).toHaveLength(2);
    expect(root.textContent).toContain('Nothing is listening');
  });

  it('phone: the same two buttons without key labels', async () => {
    const { root } = await rig('phone');
    expect([...root.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Stop reading', 'Repeat']);
    expect(root.querySelector('kbd')).toBeNull();
    expect(root.textContent).not.toContain('press Space');
  });

  it('the buttons and the page keys call the right handler once each; other keys do nothing', async () => {
    const { calls, root } = await rig('desktop');
    const [stop, repeat] = [...root.querySelectorAll('button')];
    await interact(() => (stop as HTMLButtonElement).click());
    await interact(() => (repeat as HTMLButtonElement).click());
    expect(calls).toEqual(['stop', 'repeat']);
    await interact(() => press('Escape'));
    expect(press('r').defaultPrevented).toBe(true);
    expect(press('x').defaultPrevented).toBe(false);
    expect(calls).toEqual(['stop', 'repeat', 'stop', 'repeat']);
  });

  it('stops listening for keys when it goes away', async () => {
    const { calls } = await rig('desktop');
    await mounted?.unmount();
    mounted = null;
    press('Escape');
    expect(calls).toEqual([]);
  });
});
