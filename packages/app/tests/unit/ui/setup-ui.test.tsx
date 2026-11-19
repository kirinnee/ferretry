import { describe, expect, it } from 'bun:test';
import { RadioChoices, SetupNote, SetupSection } from '../../../src/ui/setup-ui.tsx';
import { interact, mount } from '../../support/dom.ts';

describe('the settings pieces', () => {
  it('draws a section under its title, and a note that is spoken only when asked to be', async () => {
    const view = await mount(
      <SetupSection title="Browser mode" name="browser-mode">
        <SetupNote live tone="warn" name="held" title="Held">
          Saved, but not in effect until you confirm it.
        </SetupNote>
        <SetupNote name="quiet">Nothing to say.</SetupNote>
      </SetupSection>,
    );
    expect(view.container.querySelector('[data-setup-section="browser-mode"] h4')?.textContent).toBe('Browser mode');
    const held = view.container.querySelector('[data-setup-note="held"]');
    expect(held?.getAttribute('role')).toBe('status');
    expect(held?.getAttribute('data-tone')).toBe('warn');
    expect(view.container.querySelector('[data-setup-note="quiet"]')?.getAttribute('role')).toBeNull();
    await view.unmount();
  });

  it('chooses one radio card at a time, and does not offer a disabled one', async () => {
    const chosen: string[] = [];
    const view = await mount(
      <RadioChoices
        legend="Mode"
        name="mode"
        value="headless"
        onChoose={value => chosen.push(value)}
        options={[
          { id: 'headless', title: 'Headless' },
          { id: 'window', title: 'Real window' },
          { id: 'locked', title: 'Locked', disabled: true },
        ]}
      />,
    );
    const inputs = [...view.container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(inputs.map(input => input.checked)).toEqual([true, false, false]);
    expect(inputs[2]?.disabled).toBe(true);
    await interact(() => inputs[1]?.click());
    expect(chosen).toEqual(['window']);
    await view.unmount();
  });

  it('lays the cards in a wrapping row (not a full-width stack) and settles only the card that was picked', async () => {
    const chosen: string[] = [];
    const choices = (value: string) => (
      <RadioChoices
        legend="Mode"
        name="mode"
        value={value}
        onChoose={next => chosen.push(next)}
        options={[
          { id: 'headless', title: 'Headless' },
          { id: 'window', title: 'Real window' },
        ]}
      />
    );
    const view = await mount(choices('headless'));
    const fieldset = view.container.querySelector('fieldset');
    expect(fieldset?.className).toContain('flex-wrap');
    expect(fieldset?.className).not.toContain('flex-col');
    const cards = [...view.container.querySelectorAll<HTMLElement>('[data-setup-choice]')];
    expect(cards.every(card => card.classList.contains('fy-choice-card'))).toBe(true);
    // Resting on the saved value plays nothing.
    expect(cards.map(card => card.dataset.picked)).toEqual(['false', 'false']);
    const radios = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    await interact(() => radios[1]?.click());
    expect(chosen).toEqual(['window']);
    await view.render(choices('window'));
    const window = view.container.querySelector<HTMLElement>('[data-setup-choice="window"]');
    expect(window?.dataset.picked).toBe('true');
    expect(window?.dataset.checked).toBe('true');
    expect(view.container.querySelector<HTMLElement>('[data-setup-choice="headless"]')?.dataset.picked).toBe('false');
    await view.unmount();
  });
});
