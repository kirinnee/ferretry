import { afterEach, describe, expect, it } from 'bun:test';
import { modelVocabulary, type PackFleetModel } from '@ferretry/protocol';
import { useState } from 'react';
import { completionKey, ModelMentionField } from '../../../../src/features/pack/model-mention-field.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../../support/dom.ts';
import { textOf, typeInto } from '../../../support/learning-dom.ts';
import { FLEET_MODELS, OPUS } from '../../../support/pack.ts';

const VOCABULARY = modelVocabulary(FLEET_MODELS);
let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

function Field({
  initial,
  multiline = true,
  picked = [],
  disabled = false,
  problem = null,
}: {
  readonly initial: string;
  readonly multiline?: boolean;
  readonly picked?: PackFleetModel[];
  readonly disabled?: boolean;
  readonly problem?: string | null;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ModelMentionField
      id="why"
      label="Why"
      value={value}
      onChange={setValue}
      vocabulary={VOCABULARY}
      multiline={multiline}
      disabled={disabled}
      problem={problem}
      {...(multiline ? {} : { onPick: (model: PackFleetModel) => picked.push(model) })}
    />
  );
}

const field = (root: HTMLElement) => must(root.querySelector<HTMLTextAreaElement & HTMLInputElement>('#why'), 'field');
const options = (root: HTMLElement) => [...root.querySelectorAll('[role="option"]')];
const key = async (target: Element, name: string) => interact(() => pressKey(target, name));

describe('completionKey', () => {
  const open = { open: true, count: 3, active: 0, moved: false, multiline: true };
  it('moves round the list, takes with Tab, and lets Enter be a new line until the reader moved', () => {
    expect(completionKey('ArrowDown', open)).toEqual({ type: 'move', index: 1 });
    expect(completionKey('ArrowUp', open)).toEqual({ type: 'move', index: 2 });
    expect(completionKey('Tab', open)).toEqual({ type: 'accept', index: 0 });
    expect(completionKey('Enter', open)).toEqual({ type: 'ignore' });
    expect(completionKey('Enter', { ...open, moved: true })).toEqual({ type: 'accept', index: 0 });
    expect(completionKey('Enter', { ...open, multiline: false })).toEqual({ type: 'accept', index: 0 });
    expect(completionKey('Escape', open)).toEqual({ type: 'close' });
    expect(completionKey('a', open)).toEqual({ type: 'ignore' });
    expect(completionKey('ArrowDown', { ...open, open: false })).toEqual({ type: 'ignore' });
    expect(completionKey('ArrowDown', { ...open, count: 0 })).toEqual({ type: 'ignore' });
  });
});

describe('ModelMentionField', () => {
  it('marks a known model, one not on this machine, and an unknown one, and names them under the field', async () => {
    shown = await mount(<Field initial={'Use claude-opus-5-5, glm-5.3 or gpt-9-turbo.\n'} />);
    const root = shown.container;
    const marks = [...root.querySelectorAll('[data-model-mark]')].map(mark => [
      mark.getAttribute('data-model-mark'),
      mark.textContent,
    ]);
    expect(marks).toEqual([
      ['known', 'claude-opus-5-5'],
      ['absent', 'glm-5.3'],
      ['unknown', 'gpt-9-turbo'],
    ]);
    const mirror = must(root.querySelector('[data-model-mirror]'), 'mirror');
    expect(mirror.getAttribute('aria-hidden')).toBe('true');
    const line = must(root.querySelector('[data-model-mentions]'), 'mentions');
    expect(textOf(line)).toContain('GLM-5.3 (not on this machine)');
    expect(textOf(line)).toContain('gpt-9-turbo (no catalog lists this model)');
    expect(line.querySelector('[data-model-mention="known"]')?.getAttribute('title')).toBe('runs here on claude-main');
    expect(field(root).getAttribute('aria-describedby')).toBe('why-mentions');
    expect(field(root).getAttribute('role')).toBe('combobox');
  });

  it('suggests every model as a word is typed, moves with the arrows and takes one with Tab', async () => {
    shown = await mount(<Field initial="" />);
    const root = shown.container;
    const input = field(root);
    await interact(() => input.focus());
    await typeInto(input, 'Prefer cla');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(options(root).map(option => option.getAttribute('data-model-option'))).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      '~anthropic/claude-opus-latest',
    ]);
    expect(textOf(root)).toContain('4 model suggestions');
    expect(input.getAttribute('aria-activedescendant')).toBe('why-models-0');
    await key(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('why-models-1');
    await key(input, 'Tab');
    expect(input.value).toBe('Prefer claude-sonnet-5');
    expect(root.querySelector('[role="listbox"]') === null).toBe(true);
  });

  it('closes on Escape until the word changes, and closes when the field loses focus', async () => {
    shown = await mount(<Field initial="" />);
    const root = shown.container;
    const input = field(root);
    await typeInto(input, 'gpt');
    expect(options(root)).toHaveLength(2);
    await key(input, 'Escape');
    expect(root.querySelector('[role="listbox"]') === null).toBe(true);
    await typeInto(input, 'gpt-');
    expect(options(root)).toHaveLength(2);
    await key(input, 'x');
    await interact(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(root.querySelector('[role="listbox"]') === null).toBe(true);
  });

  it('takes a suggestion by pointer, and with Enter once the reader moved into the list', async () => {
    shown = await mount(<Field initial="" />);
    const root = shown.container;
    const input = field(root);
    await typeInto(input, 'deep');
    const option = must(options(root)[0], 'option');
    expect(textOf(option)).toContain('not on this machine');
    await interact(() => option.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })));
    await interact(() => option.dispatchEvent(new Event('pointerup', { bubbles: true })));
    expect(input.value).toBe('deepseek-flash[1m]');

    await typeInto(input, 'a gp');
    await key(input, 'Enter');
    expect(input.value).toBe('a gp');
    await key(input, 'ArrowUp');
    await key(input, 'Enter');
    expect(input.value).toBe('a gpt-oss:20b');
  });

  it('is a single-line model picker that tells its host which model was taken', async () => {
    const picked: PackFleetModel[] = [];
    shown = await mount(<Field initial="" multiline={false} picked={picked} />);
    const root = shown.container;
    const input = field(root);
    expect(input.tagName).toBe('INPUT');
    expect(root.querySelector('[data-model-mirror]') === null).toBe(true);
    await typeInto(input, 'claude-opus');
    await key(input, 'Enter');
    expect(input.value).toBe('claude-opus-5-5');
    expect(picked).toEqual([OPUS]);
    await key(input, 'Enter');
    expect(picked).toHaveLength(1);
  });

  it('offers nothing while disabled, and says a field problem through aria-describedby', async () => {
    shown = await mount(<Field initial="" disabled problem="Too long." />);
    const root = shown.container;
    const input = field(root);
    await typeInto(input, 'claude');
    expect(root.querySelector('[role="listbox"]') === null).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = must(input.getAttribute('aria-describedby'), 'describedby');
    expect(textOf(must(root.querySelector(`[id="${described}"]`), 'problem'))).toBe('Too long.');
    await interact(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, isComposing: true })),
    );
  });

  it('grows with its text, so it never scrolls inside itself', async () => {
    const prototype = HTMLTextAreaElement.prototype;
    Object.defineProperty(prototype, 'scrollHeight', { configurable: true, get: () => 80 });
    try {
      shown = await mount(<Field initial="a" />);
      expect(field(shown.container).style.height).toBe('80px');
    } finally {
      Reflect.deleteProperty(prototype, 'scrollHeight');
    }
  });

  it('keeps the mirror scrolled with the field', async () => {
    shown = await mount(<Field initial="a" />);
    const root = shown.container;
    const input = field(root);
    input.scrollTop = 12;
    await interact(() => input.dispatchEvent(new Event('scroll')));
    expect(must(root.querySelector<HTMLElement>('[data-model-mirror]'), 'mirror').scrollTop).toBe(input.scrollTop);
  });
});
