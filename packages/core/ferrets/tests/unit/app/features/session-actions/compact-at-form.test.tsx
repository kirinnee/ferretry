import { afterEach, describe, expect, it } from 'bun:test';
import { COMPACT_AT_TRADE_OFF, type CompactAt } from '@ferretry/protocol';
import { CompactAtForm, choiceFor } from '../../../../../app/features/session-actions/compact-at-form.tsx';
import type { SessionActionFormHost } from '../../../../../app/features/session-actions/registry.ts';
import { interact, mount, must, type Mounted } from '@ferretry/app/testing';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Harness {
  readonly root: HTMLElement;
  readonly saved: CompactAt[];
  readonly notes: string[];
  readonly closes: number[];
  readonly submit: HTMLButtonElement;
}

const open = async (
  props: { current?: CompactAt | undefined; following?: CompactAt; window?: number | undefined } = {},
  save?: (wanted: CompactAt) => Promise<{ note: string }>,
): Promise<Harness> => {
  const saved: CompactAt[] = [];
  const notes: string[] = [];
  const closes: number[] = [];
  const host: SessionActionFormHost = {
    close: () => closes.push(1),
    open: () => undefined,
    notify: note => notes.push(note),
    compact: false,
  };
  mounted = await mount(
    <CompactAtForm
      current={props.current}
      following={props.following ?? 'auto'}
      host={host}
      save={
        save ??
        (async wanted => {
          saved.push(wanted);
          return { note: 'Saved for the next restart.' };
        })
      }
      window={props.window}
    />,
  );
  const root = mounted.container;
  return {
    root,
    saved,
    notes,
    closes,
    submit: must(root.querySelector('[data-action-submit]'), 'submit button') as HTMLButtonElement,
  };
};

const radio = (root: HTMLElement, value: string): HTMLInputElement =>
  must(root.querySelector(`input[type="radio"][value="${value}"]`), `the ${value} choice`) as HTMLInputElement;

const choose = async (root: HTMLElement, value: string): Promise<void> => {
  await interact(() => radio(root, value).click());
};

const type = async (field: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const submitForm = async (root: HTMLElement): Promise<void> => {
  const form = must(root.querySelector('form'), 'the form');
  await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};

describe('choiceFor', () => {
  it('lands a value on its radio: a preset, Auto, or Custom', () => {
    expect(choiceFor(undefined)).toBe('auto');
    expect(choiceFor('auto')).toBe('auto');
    expect(choiceFor(250_000)).toBe('250000');
    expect(choiceFor(300_000)).toBe('custom');
  });
});

describe('CompactAtForm', () => {
  it('offers Auto, 200k, 250k, 400k and Custom with the trade-off line', async () => {
    const h = await open();
    const labels = [...h.root.querySelectorAll('.fy-segmented__option')].map(option => option.textContent);
    expect(labels).toEqual(['Auto', '200k', '250k', '400k', 'Custom']);
    expect(h.root.textContent).toContain(COMPACT_AT_TRADE_OFF);
    expect(h.root.textContent).toContain('Takes effect when the ferret restarts.');
  });

  it('starts on the ferret’s own value and keeps Save off until something changes', async () => {
    const h = await open({ current: 250_000 });
    expect(radio(h.root, '250000').checked).toBe(true);
    expect(h.submit.disabled).toBe(true);
    await choose(h.root, '400000');
    expect(h.submit.disabled).toBe(false);
  });

  it('says it follows the login’s default when the ferret has none of its own', async () => {
    const h = await open({ current: undefined, following: 400_000 });
    expect(radio(h.root, '400000').checked).toBe(true);
    expect(h.root.textContent).toContain('Following this login’s default (400k).');
  });

  it('saves a preset, closes and tells the owner what the daemon said', async () => {
    const h = await open();
    await choose(h.root, '200000');
    await submitForm(h.root);
    expect(h.saved).toEqual([200_000]);
    expect(h.closes).toEqual([1]);
    expect(h.notes).toEqual(['Saved for the next restart.']);
  });

  it('parses a custom size and refuses one below the floor in plain words, saving nothing', async () => {
    const h = await open({ window: 1_000_000 });
    await choose(h.root, 'custom');
    expect(h.root.textContent).toContain('Tokens, 100k up to 1m.');
    const box = must(h.root.querySelector('input.kt-input'), 'the custom box') as HTMLInputElement;
    await type(box, '50k');
    await submitForm(h.root);
    expect(h.root.textContent).toContain('50k is too small: the lowest is 100k.');
    expect(h.saved).toEqual([]);
    await type(box, '300k');
    await submitForm(h.root);
    expect(h.saved).toEqual([300_000]);
  });

  it('hints at the floor alone when the model’s window is not known', async () => {
    const h = await open();
    await choose(h.root, 'custom');
    expect(h.root.textContent).toContain('Tokens, at least 100k — for example 300k.');
  });

  it('shows the daemon’s refusal and stays open', async () => {
    const h = await open({}, async () => {
      throw new Error('400k is larger than this model’s 200k window, so it could never trigger.');
    });
    await choose(h.root, '400000');
    await submitForm(h.root);
    expect(h.root.textContent).toContain('larger than this model’s 200k window');
    expect(h.closes).toEqual([]);
  });
});
