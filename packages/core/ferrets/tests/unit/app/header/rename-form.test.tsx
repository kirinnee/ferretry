import { afterEach, describe, expect, it } from 'bun:test';
import type { FerretSummary } from '../../../../contract/index.ts';
import { RenameForm } from '../../../../app/features/header/rename-form.tsx';
import type { FerretActionFormHost } from '../../../../app/features/header/registry.ts';
import { interact, mount, must, type Mounted } from '../support/dom.ts';
import { ferretSummary } from './support.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const VIEW: FerretSummary = ferretSummary('session-12345678', {
  name: 'hadi',
  title: 'Fix the gate',
});

interface Harness {
  readonly root: HTMLElement;
  readonly teammateInput: HTMLInputElement;
  readonly titleInput: HTMLInputElement;
  readonly submit: HTMLButtonElement;
  readonly closes: number[];
}

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

const open = async (
  rename: (patch: unknown) => Promise<FerretSummary>,
  overrides: Partial<FerretActionFormHost> = {},
): Promise<Harness> => {
  const closes: number[] = [];
  const host: FerretActionFormHost = {
    close: () => closes.push(1),
    open: () => undefined,
    notify: () => undefined,
    compact: false,
    ...overrides,
  };
  mounted = await mount(<RenameForm host={host} rename={rename as never} ferret={VIEW} />);
  const root = mounted.container;
  const fields = [...root.querySelectorAll('.fy-action-form__field input')] as HTMLInputElement[];
  return {
    root,
    teammateInput: must(fields[0], 'teammate input'),
    titleInput: must(fields[1], 'title input'),
    submit: must(root.querySelector('[data-action-submit]'), 'submit button') as HTMLButtonElement,
    closes,
  };
};

describe('RenameForm', () => {
  it('starts from the ferret’s current name and task title', async () => {
    const h = await open(async () => VIEW);
    expect(h.teammateInput.value).toBe('hadi');
    expect(h.titleInput.value).toBe('Fix the gate');
  });

  it('says the ferret id never changes, by its first eight characters', async () => {
    const h = await open(async () => VIEW);
    expect(h.root.textContent).toContain('session-…');
  });

  it('disables Save until something actually changed', async () => {
    const h = await open(async () => VIEW);
    expect(h.submit.disabled).toBe(true);
    await type(h.titleInput, 'Fix the other gate');
    expect(h.submit.disabled).toBe(false);
  });

  it('does nothing on submit when nothing changed', async () => {
    const calls: unknown[] = [];
    const h = await open(async patch => {
      calls.push(patch);
      return VIEW;
    });
    await submitForm(h.root);
    expect(calls).toEqual([]);
    expect(h.closes).toEqual([]);
  });

  it('sends only the changed fields, and closes the form on success', async () => {
    const calls: unknown[] = [];
    const h = await open(async patch => {
      calls.push(patch);
      return VIEW;
    });
    await type(h.titleInput, 'Fix the other gate');
    await submitForm(h.root);
    expect(calls).toEqual([{ title: 'Fix the other gate' }]);
    expect(h.closes).toEqual([1]);
  });

  it('refuses to submit an emptied name, without calling rename', async () => {
    const calls: unknown[] = [];
    const h = await open(async patch => {
      calls.push(patch);
      return VIEW;
    });
    await type(h.teammateInput, '');
    await submitForm(h.root);
    expect(calls).toEqual([]);
    expect(h.root.textContent).toContain('A ferret needs a name.');
  });

  it('refuses to submit an emptied task title, without calling rename', async () => {
    const calls: unknown[] = [];
    const h = await open(async patch => {
      calls.push(patch);
      return VIEW;
    });
    await type(h.titleInput, '');
    await submitForm(h.root);
    expect(calls).toEqual([]);
    expect(h.root.textContent).toContain('The task title cannot be empty.');
  });

  it('places a daemon refusal about the name beside the name field', async () => {
    const h = await open(async () => {
      throw new Error('That callsign is already taken.');
    });
    await type(h.teammateInput, 'nero');
    await submitForm(h.root);
    expect(h.root.textContent).toContain('That callsign is already taken.');
    expect(h.closes).toEqual([]);
  });

  it('places a daemon refusal about the title beside the title field', async () => {
    const h = await open(async () => {
      throw new Error('That name is too long.');
    });
    await type(h.titleInput, 'Something new');
    await submitForm(h.root);
    expect(h.root.textContent).toContain('That name is too long.');
  });

  it('shows an unrecognised refusal at form level', async () => {
    const h = await open(async () => {
      throw new Error('The daemon is unreachable.');
    });
    await type(h.titleInput, 'Something new');
    await submitForm(h.root);
    expect(h.root.textContent).toContain('The daemon is unreachable.');
  });

  it('lets Cancel close the form without saving', async () => {
    const h = await open(async () => VIEW);
    const cancel = must(
      [...h.root.querySelectorAll('button')].find(button => button.textContent === 'Cancel'),
      'Cancel button',
    );
    await interact(() => cancel.click());
    expect(h.closes).toEqual([1]);
  });

  it('ignores a resubmit while the first submit is still in flight', async () => {
    let resolve: ((view: FerretSummary) => void) | undefined;
    const calls: unknown[] = [];
    const h = await open(
      () =>
        new Promise<FerretSummary>(res => {
          resolve = res;
          calls.push('called');
        }),
    );
    await type(h.titleInput, 'First edit');
    const form = must(h.root.querySelector('form'), 'the form');
    await interact(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls).toEqual(['called']);
    resolve?.(VIEW);
    await interact(() => undefined);
  });
});
