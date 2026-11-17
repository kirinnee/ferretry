import { describe, expect, it } from 'bun:test';
import { type ReactElement, useState } from 'react';
import { SecretInput, SecretTextarea, useSecretField, useSecretTextarea } from '../../../src/ui/secret-field.tsx';
import { interact, mount, must } from '../../support/dom.ts';

/** A made-up value: no real credential is ever typed in a test. */
const FAKE = 'fake-secret-value-0123456789';

const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'a value setter');
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const hide = async (hidden: boolean): Promise<void> => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  await interact(() => document.dispatchEvent(new Event('visibilitychange')));
};

interface Probe {
  read?: () => string;
  clear?: () => void;
}

function Form({ probe, open = true }: { readonly probe: Probe; readonly open?: boolean }): ReactElement {
  const field = useSecretField();
  probe.read = field.read;
  probe.clear = field.clear;
  return (
    <div>
      {open ? <SecretInput field={field} data-test-field="" /> : null}
      <output data-test-length="">{field.length}</output>
      <output data-test-filled="">{String(field.filled)}</output>
    </div>
  );
}

const length = (container: Element): string | null =>
  container.querySelector('[data-test-length]')?.textContent ?? null;

describe('useSecretField / SecretInput', () => {
  it('draws a password input with no value attribute, and never shows what was typed in the markup', async () => {
    const probe: Probe = {};
    const mounted = await mount(<Form probe={probe} />);
    try {
      const input = must(mounted.container.querySelector<HTMLInputElement>('input'), 'the field');
      expect(input.type).toBe('password');
      expect(input.getAttribute('autocomplete')).toBe('new-password');
      await typeInto(input, FAKE);
      expect(input.value).toBe(FAKE);
      expect(input.getAttribute('value')).toBeNull();
      expect(input.outerHTML).not.toContain(FAKE);
      expect(mounted.container.innerHTML).not.toContain(FAKE);
      // The state knows how much, not what.
      expect(length(mounted.container)).toBe(String(FAKE.length));
      expect(probe.read?.()).toBe(FAKE);
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the markup clean across a re-render caused by something else', async () => {
    function Wrapper(): ReactElement {
      const field = useSecretField();
      const [other, setOther] = useState('a');
      return (
        <div>
          <SecretInput field={field} />
          <button data-test-bump="" onClick={() => setOther(`${other}b`)} type="button">
            {other}
          </button>
        </div>
      );
    }
    const mounted = await mount(<Wrapper />);
    try {
      const input = must(mounted.container.querySelector<HTMLInputElement>('input'), 'the field');
      await typeInto(input, FAKE);
      await interact(() =>
        must(mounted.container.querySelector<HTMLButtonElement>('[data-test-bump]'), 'bump').click(),
      );
      expect(input.value).toBe(FAKE);
      expect(input.getAttribute('value')).toBeNull();
      expect(mounted.container.innerHTML).not.toContain(FAKE);
    } finally {
      await mounted.unmount();
    }
  });

  it('clear() empties the input node itself and the length', async () => {
    const probe: Probe = {};
    const mounted = await mount(<Form probe={probe} />);
    try {
      const input = must(mounted.container.querySelector<HTMLInputElement>('input'), 'the field');
      await typeInto(input, FAKE);
      await interact(() => probe.clear?.());
      expect(input.value).toBe('');
      expect(length(mounted.container)).toBe('0');
      expect(probe.read?.()).toBe('');
    } finally {
      await mounted.unmount();
    }
  });

  it('empties the input when the page is hidden, and not when it is shown again', async () => {
    const probe: Probe = {};
    const mounted = await mount(<Form probe={probe} />);
    try {
      const input = must(mounted.container.querySelector<HTMLInputElement>('input'), 'the field');
      await typeInto(input, FAKE);
      await hide(false);
      expect(input.value).toBe(FAKE);
      await hide(true);
      expect(input.value).toBe('');
      expect(length(mounted.container)).toBe('0');
    } finally {
      await hide(false);
      await mounted.unmount();
    }
  });

  it('empties the node and forgets the length when the input leaves the screen', async () => {
    const probe: Probe = {};
    function Toggle(): ReactElement {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button data-test-toggle="" onClick={() => setOpen(shown => !shown)} type="button">
            toggle
          </button>
          <Form open={open} probe={probe} />
        </div>
      );
    }
    const mounted = await mount(<Toggle />);
    try {
      const input = must(mounted.container.querySelector<HTMLInputElement>('input'), 'the field');
      await typeInto(input, FAKE);
      await interact(() => must(mounted.container.querySelector<HTMLButtonElement>('[data-test-toggle]'), 't').click());
      expect(mounted.container.querySelector('input')).toBeNull();
      expect(input.value).toBe('');
      expect(length(mounted.container)).toBe('0');
      expect(probe.read?.()).toBe('');
      // A new input starts empty.
      await interact(() => must(mounted.container.querySelector<HTMLButtonElement>('[data-test-toggle]'), 't').click());
      expect(must(mounted.container.querySelector<HTMLInputElement>('input'), 'again').value).toBe('');
    } finally {
      await mounted.unmount();
    }
  });

  it('counts with the measure it was given (a field that ignores surrounding spaces)', async () => {
    function Trimmed(): ReactElement {
      const field = useSecretField(typed => typed.trim().length);
      return (
        <div>
          <SecretInput field={field} />
          <output data-test-length="">{field.length}</output>
        </div>
      );
    }
    const mounted = await mount(<Trimmed />);
    try {
      await typeInto(must(mounted.container.querySelector<HTMLInputElement>('input'), 'the field'), '  abc  ');
      expect(length(mounted.container)).toBe('3');
    } finally {
      await mounted.unmount();
    }
  });

  it('tells onTyped the length only', async () => {
    const seen: number[] = [];
    function Told(): ReactElement {
      const field = useSecretField();
      return <SecretInput field={field} onTyped={count => seen.push(count)} />;
    }
    const mounted = await mount(<Told />);
    try {
      await typeInto(must(mounted.container.querySelector<HTMLInputElement>('input'), 'the field'), FAKE);
      expect(seen).toEqual([FAKE.length]);
    } finally {
      await mounted.unmount();
    }
  });
});

const typeIntoTextarea = async (area: HTMLTextAreaElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = must(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set, 'a value setter');
    setter.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** A made-up pasted block: no real credential is ever typed in a test. */
const BLOCK = 'export FAKE_NAME=fake-secret-value-0123456789\nexport OTHER=another-fake-value';

interface AreaProbe {
  read?: () => string;
  clear?: () => void;
}

function AreaForm({ probe, open = true }: { readonly probe: AreaProbe; readonly open?: boolean }): ReactElement {
  const field = useSecretTextarea(typed => typed.trim().length);
  probe.read = field.read;
  probe.clear = field.clear;
  return (
    <div>
      {open ? <SecretTextarea field={field} /> : null}
      <output data-test-length="">{field.length}</output>
      <output data-test-filled="">{String(field.filled)}</output>
    </div>
  );
}

describe('useSecretTextarea / SecretTextarea', () => {
  it('never puts what was pasted into the markup (a controlled textarea would, as its text content)', async () => {
    const probe: AreaProbe = {};
    const mounted = await mount(<AreaForm probe={probe} />);
    try {
      const area = must(mounted.container.querySelector<HTMLTextAreaElement>('textarea'), 'the field');
      expect(area.getAttribute('autocomplete')).toBe('off');
      await typeIntoTextarea(area, BLOCK);
      expect(area.value).toBe(BLOCK);
      expect(area.textContent).toBe('');
      expect(area.outerHTML).not.toContain('fake-secret-value');
      expect(mounted.container.innerHTML).not.toContain('fake-secret-value');
      expect(mounted.container.innerHTML).not.toContain('another-fake-value');
      expect(length(mounted.container)).toBe(String(BLOCK.length));
      expect(probe.read?.()).toBe(BLOCK);
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the markup clean across a re-render caused by something else', async () => {
    function Wrapper(): ReactElement {
      const field = useSecretTextarea();
      const [other, setOther] = useState('a');
      return (
        <div>
          <SecretTextarea field={field} />
          <button data-test-bump="" onClick={() => setOther(`${other}b`)} type="button">
            {other}
          </button>
        </div>
      );
    }
    const mounted = await mount(<Wrapper />);
    try {
      const area = must(mounted.container.querySelector<HTMLTextAreaElement>('textarea'), 'the field');
      await typeIntoTextarea(area, BLOCK);
      await interact(() =>
        must(mounted.container.querySelector<HTMLButtonElement>('[data-test-bump]'), 'bump').click(),
      );
      expect(area.value).toBe(BLOCK);
      expect(mounted.container.innerHTML).not.toContain('fake-secret-value');
    } finally {
      await mounted.unmount();
    }
  });

  it('counts with its measure, and clear() empties the node itself', async () => {
    const probe: AreaProbe = {};
    const mounted = await mount(<AreaForm probe={probe} />);
    try {
      const area = must(mounted.container.querySelector<HTMLTextAreaElement>('textarea'), 'the field');
      await typeIntoTextarea(area, '  abc  \n');
      expect(length(mounted.container)).toBe('3');
      await interact(() => probe.clear?.());
      expect(area.value).toBe('');
      expect(length(mounted.container)).toBe('0');
      expect(probe.read?.()).toBe('');
    } finally {
      await mounted.unmount();
    }
  });

  it('empties the node when the page is hidden, and when the field leaves the screen', async () => {
    const probe: AreaProbe = {};
    const mounted = await mount(<AreaForm probe={probe} />);
    try {
      const area = must(mounted.container.querySelector<HTMLTextAreaElement>('textarea'), 'the field');
      await typeIntoTextarea(area, BLOCK);
      await hide(true);
      expect(area.value).toBe('');
      expect(length(mounted.container)).toBe('0');
      await hide(false);
      await typeIntoTextarea(area, BLOCK);
      await mounted.render(<AreaForm probe={probe} open={false} />);
      expect(mounted.container.querySelector('textarea')).toBeNull();
      expect(area.value).toBe('');
      expect(probe.read?.()).toBe('');
    } finally {
      await hide(false);
      await mounted.unmount();
    }
  });

  it('tells onTyped the measured length only, for the input and the textarea alike', async () => {
    const seen: number[] = [];
    function Told(): ReactElement {
      const input = useSecretField(typed => typed.trim().length);
      const area = useSecretTextarea(typed => typed.trim().length);
      return (
        <div>
          <SecretInput field={input} onTyped={count => seen.push(count)} />
          <SecretTextarea field={area} onTyped={count => seen.push(count)} />
        </div>
      );
    }
    const mounted = await mount(<Told />);
    try {
      await typeInto(must(mounted.container.querySelector<HTMLInputElement>('input'), 'the input'), '  abc  ');
      await typeIntoTextarea(must(mounted.container.querySelector<HTMLTextAreaElement>('textarea'), 'area'), ' de ');
      expect(seen).toEqual([3, 2]);
    } finally {
      await mounted.unmount();
    }
  });
});
