import { describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { ModelSelect } from '../../src/components/model-select.tsx';
import type { PickerModel } from '../../src/lib/account-picker-catalog.ts';
import { interact, mount, must } from '../support/dom.ts';

const MODELS: readonly PickerModel[] = [
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', tier: 'fast', available: true, efforts: [] },
  { id: 'glm-5.3', label: 'GLM-5.3', tier: 'best', context: 1_000_000, available: true, efforts: ['low'] },
  { id: 'glm-old', label: 'GLM old', tier: 'balanced', available: false },
];

function Host({ customIds, initial = '', seen }: { customIds: boolean; initial?: string; seen: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <ModelSelect
      customIds={customIds}
      defaultModel="glm-5.3"
      id="model"
      models={MODELS}
      onChange={next => {
        seen.push(next);
        setValue(next);
      }}
      value={value}
    />
  );
}

const choose = (select: HTMLSelectElement, value: string) =>
  interact(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const typeInto = (field: HTMLInputElement, value: string) =>
  interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('ModelSelect', () => {
  test('lists the catalog by tier, names the default first, and disables what the login cannot use', async () => {
    const screen = await mount(<Host customIds={false} seen={[]} />);
    const select = must(screen.container.querySelector('select'), 'the select');
    expect([...select.querySelectorAll('optgroup')].map(group => group.label)).toEqual([
      'Most capable',
      'Balanced',
      'Fast',
    ]);
    expect(select.options[0]?.textContent).toBe('Login default (GLM-5.3)');
    expect(select.options[1]?.textContent).toBe('GLM-5.3 · default · 1M context');
    expect([...select.options].find(option => option.value === 'glm-old')?.disabled).toBe(true);
    expect([...select.options].some(option => option.textContent === 'Custom id…')).toBe(false);
    await screen.unmount();
  });

  test('offers a custom id box for a provider that takes any id, and goes back to the list', async () => {
    const seen: string[] = [];
    const screen = await mount(<Host customIds={true} seen={seen} />);
    const select = must(screen.container.querySelector('select'), 'the select');
    await choose(select, ' custom');
    const field = must(screen.container.querySelector<HTMLInputElement>('input'), 'the custom box');
    await typeInto(field, 'bad id');
    expect(screen.container.textContent).toContain('One word');
    await typeInto(field, 'glm-next');
    await choose(select, 'glm-5.3-flash');
    expect(screen.container.querySelector('input')).toBeNull();
    expect(seen).toEqual(['', 'bad id', 'glm-next', 'glm-5.3-flash']);
    await screen.unmount();
  });

  test('opens on the custom box for a value the list does not have, and lists an untiered one flat', async () => {
    const screen = await mount(<Host customIds={true} initial="glm-next" seen={[]} />);
    expect(must(screen.container.querySelector<HTMLInputElement>('input'), 'the custom box').value).toBe('glm-next');
    await screen.unmount();
    const flat = await mount(
      <ModelSelect
        customIds={false}
        defaultModel={null}
        id="m"
        models={[{ id: 'a', available: true }]}
        onChange={() => undefined}
        value=""
      />,
    );
    expect(flat.container.querySelectorAll('optgroup')).toHaveLength(0);
    expect(must(flat.container.querySelector('select'), 'select').options[0]?.textContent).toBe('Login default');
    await flat.unmount();
  });
});
