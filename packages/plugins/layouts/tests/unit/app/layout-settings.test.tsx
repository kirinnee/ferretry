import { interact, mount, must } from '@ferretry/app/testing';
import type { DeviceLayout } from '@ferretry/app';
import { describe, expect, test } from 'bun:test';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT } from '../../../contract/index.ts';
import { LayoutSettings } from '../../../app/features/layout/layout-settings.tsx';
import { compactRead, listOf, readOf, refusal, scriptedLayouts } from '../../support/layouts-app.ts';

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

/** Types into a React-controlled input the way a browser does: through the native setter, then an input event. */
const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await interact(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const choose = async (select: HTMLSelectElement, value: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await interact(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const press = (root: HTMLElement, name: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll('button')].find(
      button => button.textContent === name || button.getAttribute('aria-label') === name,
    ),
    `the ${name} button`,
  );

const group = (root: HTMLElement, label: string, scope = 0): HTMLElement =>
  must(root.querySelectorAll<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`)[scope], `the ${label} choice`);

const pick = async (root: HTMLElement, label: string, word: string, scope = 0): Promise<void> => {
  const radio = must(group(root, label, scope).querySelector<HTMLInputElement>(`input[value="${word}"]`), word);
  await interact(() => radio.click());
};

const fakeDevice = (over: Partial<DeviceLayout> = {}): DeviceLayout & { readonly calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    overrides: {},
    base: DEFAULT_LAYOUT,
    inForce: DEFAULT_LAYOUT,
    set: (path, value) => {
      calls.push(`set ${path} ${value}`);
      return undefined;
    },
    reset: () => {
      calls.push('reset');
    },
    ...over,
  };
};

describe('the Layout tab', () => {
  test('it shows the layout in use, the theme, and a row for every key it edits', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const text = view.container.textContent ?? '';
    for (const name of [
      'Layout',
      'Theme',
      'Navigation side',
      'Navigation style',
      'Second column',
      'Density',
      'Navigation items',
      'Top bar',
      'Ferret side panels',
    ])
      expect(text).toContain(name);
    expect(text).toContain('the layout in use, with your changes applied');
    expect(group(view.container, 'Navigation side').querySelector<HTMLInputElement>('input:checked')?.value).toBe(
      'left',
    );
    expect(view.container.textContent).not.toContain('this device only');
    await view.unmount();
  });

  test('a read that fails says so, and a read that fails after one worked keeps the screen', async () => {
    const script = scriptedLayouts();
    script.client.read = async () => {
      throw new Error('the daemon did not answer');
    };
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('the daemon did not answer');
    await view.unmount();

    const working = scriptedLayouts();
    const kept = await mount(<LayoutSettings client={working.client} />);
    await settle();
    working.client.read = async () => {
      throw new Error('gone');
    };
    await interact(() => working.push());
    await settle();
    expect(kept.container.textContent).toContain('Navigation side');
    await kept.unmount();
  });

  test('choosing a word saves that one key through Layouts, then reads again', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const before = script.reads();
    script.held = readOf({ layout: { ...DEFAULT_LAYOUT, nav: { ...DEFAULT_LAYOUT.nav, side: 'right' } } });
    await pick(view.container, 'Navigation side', 'right');
    await settle();
    expect(script.calls).toEqual(['set nav.side right']);
    expect(script.reads()).toBeGreaterThan(before);
    expect(group(view.container, 'Navigation side').querySelector<HTMLInputElement>('input:checked')?.value).toBe(
      'right',
    );
    await view.unmount();
  });

  test('a list is saved as typed, only once it differs from what the daemon holds', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const box = must(view.container.querySelector<HTMLInputElement>('input[aria-labelledby]'), 'a list box');
    expect(box.value).toBe('ferrets, agenda, board, insights, settings');
    const save = press(view.container, 'Save');
    expect(save.disabled).toBe(true);
    await type(box, 'agenda, board');
    expect(press(view.container, 'Save').disabled).toBe(false);
    await interact(() => press(view.container, 'Save').click());
    await settle();
    expect(script.calls).toEqual(['set nav.items agenda, board']);
    await view.unmount();
  });

  test('a refusal is the daemon’s sentence and its first reason, beside the row it came from', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const box = must(view.container.querySelector<HTMLInputElement>('input[aria-labelledby]'), 'a list box');
    await type(box, 'agenda, ghost');
    script.refuseWith = refusal('"ghost" is not an installed screen');
    await interact(() => press(view.container, 'Save').click());
    await settle();
    const alerts = [...view.container.querySelectorAll('[role="alert"]')].map(alert => alert.textContent);
    expect(alerts).toContain('that layout cannot be used: "ghost" is not an installed screen');
    expect(
      must(view.container.querySelector<HTMLInputElement>('input[aria-labelledby]'), 'the box').getAttribute(
        'aria-invalid',
      ),
    ).toBe('true');
    await view.unmount();
  });

  test('switching layout and theme are the verbs `fy layout use` and `fy theme use`', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('select[aria-label="Layout"]'), 'layout'),
      'compact',
    );
    await settle();
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('select[aria-label="Theme"]'), 'theme'),
      'default',
    );
    await settle();
    expect(script.calls).toEqual(['use compact', 'theme default']);
    await view.unmount();
  });

  test('reset asks first, and keeping it sends nothing', async () => {
    const script = scriptedLayouts(compactRead());
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    await interact(() => press(view.container, 'Reset').click());
    expect(script.calls).toEqual([]);
    await interact(() => press(view.container, 'Keep').click());
    expect(script.calls).toEqual([]);
    await interact(() => press(view.container, 'Reset').click());
    await interact(() => press(view.container, 'Confirm reset').click());
    await settle();
    expect(script.calls).toEqual(['reset']);
    await view.unmount();
  });

  test('a layout is saved under a name Layouts accepts, and a saved one can be removed; a built-in cannot', async () => {
    const script = scriptedLayouts(
      readOf(
        {},
        listOf({
          layouts: [
            { id: 'default', origin: 'built-in' },
            { id: 'mine', origin: 'saved' },
          ],
        }),
      ),
    );
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const name = must(view.container.querySelector<HTMLInputElement>('input[placeholder="mine"]'), 'the name box');
    await type(name, 'My Layout');
    expect(press(view.container, 'Save layout').disabled).toBe(true);
    await type(name, 'work');
    await interact(() => press(view.container, 'Save layout').click());
    await settle();
    await interact(() => press(view.container, 'Remove mine').click());
    await settle();
    expect(script.calls).toEqual(['save work', 'remove mine']);
    expect(view.container.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(1);
    await view.unmount();
  });

  test('another writer’s change is read at once', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    script.held = compactRead();
    await interact(() => script.push());
    await settle();
    expect(group(view.container, 'Density').querySelector<HTMLInputElement>('input:checked')?.value).toBe('compact');
    await view.unmount();
    expect(script.listeners()).toBe(0);
  });

  test('this device’s own choice is a second group, saved in the app and sent nowhere', async () => {
    const script = scriptedLayouts();
    const device = fakeDevice({ inForce: COMPACT_LAYOUT, overrides: { density: 'compact' } });
    const view = await mount(<LayoutSettings client={script.client} device={device} />);
    await settle();
    expect(view.container.textContent).toContain('Layout — this device only');
    expect(group(view.container, 'Density', 1).querySelector<HTMLInputElement>('input:checked')?.value).toBe('compact');
    await pick(view.container, 'Navigation side', 'bottom', 1);
    await interact(() => press(view.container, 'Follow again').click());
    expect(device.calls).toEqual(['set nav.side bottom', 'reset']);
    expect(script.calls).toEqual([]);
    await view.unmount();
  });

  test('a device with no changes of its own has nothing to follow again', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} device={fakeDevice()} />);
    await settle();
    expect(press(view.container, 'Follow again').disabled).toBe(true);
    expect(view.container.textContent).toContain('This device has no changes of its own');
    await view.unmount();
  });

  test('a layout the shell refused is named under In use with the first reason', async () => {
    const script = scriptedLayouts();
    const device = fakeDevice({
      refused: {
        layout: 'default',
        issues: [{ at: 'panels.ferret.side', message: '"sitrep" is not a panel of ferret.side' }],
      },
    });
    const view = await mount(<LayoutSettings client={script.client} device={device} />);
    await settle();
    expect(view.container.textContent).toContain(
      'The layout "default" cannot be used here: "sitrep" is not a panel of ferret.side.',
    );
    await view.unmount();
  });
});
