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

/** Picks a row of a select box the way a person does: open the combobox, then press the option (its list is drawn in the document body). */
const choose = async (box: HTMLElement, label: string): Promise<void> => {
  await interact(() => box.click());
  const option = must(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      candidate => candidate.querySelector('[data-label]')?.textContent === label,
    ),
    `the option "${label}"`,
  );
  await interact(() => option.click());
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

/** The one switch of the page: where a change is saved. */
const pickScope = async (root: HTMLElement, scope: 'all' | 'device'): Promise<void> => {
  const radio = must(
    group(root, 'Where a change is saved').querySelector<HTMLInputElement>(`input[value="${scope}"]`),
    scope,
  );
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
      'Navigation',
      'Second column',
      'Density',
      'Navigation items',
      'Top bar',
      'Ferret side panels',
      'Phone navigation',
      'Phone second column',
      'Phone density',
      'Phone navigation items',
      'Phone top bar',
    ])
      expect(text).toContain(name);
    expect(text).toContain('the layout in use, with your changes applied');
    expect(group(view.container, 'Navigation').querySelector<HTMLInputElement>('input:checked')?.value).toBe(
      'dock-icons',
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
    expect(kept.container.textContent).toContain('Navigation');
    await kept.unmount();
  });

  test('choosing a word saves that one key through Layouts, then reads again', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const before = script.reads();
    script.held = readOf({ layout: { ...DEFAULT_LAYOUT, nav: { ...DEFAULT_LAYOUT.nav, side: 'bottom' } } });
    await pick(view.container, 'Navigation', 'bottom');
    await settle();
    expect(script.calls).toEqual(['set nav.side bottom']);
    expect(script.reads()).toBeGreaterThan(before);
    expect(group(view.container, 'Navigation').querySelector<HTMLInputElement>('input:checked')?.value).toBe('bottom');
    await view.unmount();
  });

  test('a phone row saves its `phone.*` key, in either scope, and shows what the phone holds', async () => {
    const script = scriptedLayouts();
    const device = fakeDevice();
    const view = await mount(<LayoutSettings client={script.client} device={device} />);
    await settle();
    // A phone follows the wide layout: the places are in its menu, and the bottom bar is the one switch.
    expect(group(view.container, 'Phone navigation').querySelector<HTMLInputElement>('input:checked')?.value).toBe(
      'left',
    );
    await pick(view.container, 'Phone navigation', 'bottom');
    await settle();
    expect(script.calls).toEqual(['set phone.nav.side bottom']);
    await pickScope(view.container, 'device');
    await pick(view.container, 'Phone density', 'compact');
    await settle();
    expect(device.calls).toEqual(['set phone.density compact']);
    expect(script.calls).toEqual(['set phone.nav.side bottom']);
    await view.unmount();
  });

  const list = (root: HTMLElement, path: string): HTMLElement =>
    must(root.querySelector<HTMLElement>(`[data-layout-list="${path}"]`), `the ${path} list`);
  const names = (root: HTMLElement, path: string): string[] =>
    [...list(root, path).querySelectorAll<HTMLElement>('li[data-sortable-key]')].map(
      row => row.dataset.sortableKey ?? '',
    );

  test('no list is a text box: places are chips with a handle, Earlier and Later buttons and an eye', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    // The only text input left on the tab is the name a layout is saved under.
    const texts = [...view.container.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    expect(texts.map(input => input.placeholder)).toEqual(['mine']);
    for (const path of ['nav.items', 'top', 'panels.ferret.side', 'phone.nav.items', 'phone.top']) {
      expect(list(view.container, path).querySelector('[data-sortable-grip]')).not.toBeNull();
    }
    expect(names(view.container, 'nav.items')).toEqual([
      'ferrets',
      'agenda',
      'board',
      'projects',
      'insights',
      'settings',
    ]);
    await view.unmount();
  });

  test('moving a place saves the order and the hidden list together, in one change set', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    await interact(() => press(list(view.container, 'nav.items'), 'Move Ferrets later').click());
    await settle();
    expect(script.calls).toEqual(['set nav.items agenda,ferrets,board,projects,insights,settings + set nav.hidden ']);
    await view.unmount();
  });

  test('the keyboard lifts, moves and drops a place: one save, on drop', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const grip = press(list(view.container, 'nav.items'), 'Reorder Board');
    const key = (name: string) =>
      interact(() => {
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      });
    await key(' ');
    await key('ArrowUp');
    expect(script.calls).toEqual([]);
    await key('Enter');
    await settle();
    expect(script.calls).toEqual(['set nav.items ferrets,board,agenda,projects,insights,settings + set nav.hidden ']);
    await view.unmount();
  });

  test('the eye hides a place and shows it again; Settings has no eye at all', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    await interact(() => press(list(view.container, 'nav.items'), 'Hide Board').click());
    await settle();
    expect(script.calls).toEqual([
      'set nav.items ferrets,agenda,board,projects,insights,settings + set nav.hidden board',
    ]);
    const nav = list(view.container, 'nav.items');
    expect(
      [...nav.querySelectorAll('button')].some(
        button =>
          /Settings/.test(button.getAttribute('aria-label') ?? '') &&
          /^(Hide|Show) /.test(button.getAttribute('aria-label') ?? ''),
      ),
    ).toBe(false);
    expect(script.calls).toHaveLength(1);
    await view.unmount();
  });

  test('editing the wide nav of a legacy layout keeps Daemons, and writes the phone bar its own hidden list', async () => {
    const legacy = {
      ...DEFAULT_LAYOUT,
      nav: { ...DEFAULT_LAYOUT.nav, items: ['ferrets', 'daemons', 'settings'] },
      phone: { nav: { items: ['ferrets', 'board', 'settings'] } },
    };
    const script = scriptedLayouts(readOf({ layout: legacy }));
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    await interact(() => press(list(view.container, 'nav.items'), 'Hide Ferrets').click());
    await settle();
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]).toContain('set nav.items ferrets,daemons,settings');
    expect(script.calls[0]).toContain('set nav.hidden ferrets');
    expect(script.calls[0]).toContain('set phone.nav.hidden');
    await view.unmount();
  });

  test('a hidden place shows as hidden and its eye shows it again', async () => {
    const script = scriptedLayouts(
      readOf({ layout: { ...DEFAULT_LAYOUT, nav: { ...DEFAULT_LAYOUT.nav, hidden: ['board'] } } }),
    );
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const row = must(list(view.container, 'nav.items').querySelector<HTMLElement>('[data-hidden]'), 'the hidden row');
    expect(row.textContent).toContain('Board');
    await interact(() => press(list(view.container, 'nav.items'), 'Show Board').click());
    await settle();
    expect(script.calls).toEqual(['set nav.items ferrets,agenda,board,projects,insights,settings + set nav.hidden ']);
    await view.unmount();
  });

  test('the top bar and the side panels have no hidden list: what is not named is hidden', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    expect(names(view.container, 'top')).toEqual(['daemon-picker', 'search', 'status']);
    await interact(() => press(list(view.container, 'top'), 'Show Status').click());
    await settle();
    expect(script.calls).toEqual(['set top daemon-picker,search,status']);
    await view.unmount();
  });

  test('the phone lists save their own phone keys, in either scope', async () => {
    const script = scriptedLayouts();
    const device = fakeDevice();
    const view = await mount(<LayoutSettings client={script.client} device={device} />);
    await settle();
    await interact(() => press(list(view.container, 'phone.nav.items'), 'Hide Projects').click());
    await settle();
    expect(script.calls).toEqual([
      'set phone.nav.items ferrets,agenda,board,projects,insights,settings + set phone.nav.hidden projects',
    ]);
    await pickScope(view.container, 'device');
    await interact(() => press(list(view.container, 'phone.top'), 'Move Daemon picker later').click());
    expect(device.calls).toEqual(['set phone.top search,daemon-picker']);
    await view.unmount();
  });

  test('a refusal is the daemon’s sentence and its first reason, and the row goes back to what the daemon holds', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    script.refuseWith = refusal('"board" is not an installed screen');
    await interact(() => press(list(view.container, 'nav.items'), 'Hide Board').click());
    await settle();
    const alerts = [...view.container.querySelectorAll('[role="alert"]')].map(alert => alert.textContent);
    expect(alerts).toContain('that layout cannot be used: "board" is not an installed screen');
    expect(list(view.container, 'nav.items').querySelector('[data-hidden]')).toBeNull();
    await view.unmount();
  });

  test('switching layout and theme are the verbs `fy layout use` and `fy theme use`', async () => {
    const script = scriptedLayouts(
      readOf(
        {},
        listOf({
          themes: [
            { id: 'default', origin: 'built-in' },
            { id: 'studio', origin: 'saved' },
          ],
        }),
      ),
    );
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    expect(view.container.querySelector('select')).toBeNull();
    await choose(
      must(view.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Layout"]'), 'layout'),
      'compact',
    );
    await settle();
    await choose(
      must(view.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Theme"]'), 'theme'),
      'studio (saved)',
    );
    await settle();
    expect(script.calls).toEqual(['use compact', 'theme studio']);
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

  test('one page, one switch: "Same on all my devices" or "Just this device", and one set of rows', async () => {
    const script = scriptedLayouts();
    const device = fakeDevice();
    const view = await mount(<LayoutSettings client={script.client} device={device} />);
    await settle();
    const scope = group(view.container, 'Where a change is saved');
    expect([...scope.querySelectorAll('label')].map(label => label.textContent)).toEqual([
      'Same on all my devices',
      'Just this device',
    ]);
    expect(scope.querySelector<HTMLInputElement>('input:checked')?.value).toBe('all');
    // The label is the owner's; the caption under it says honestly where "all" reaches: this computer's daemon.
    const caption = view.container.querySelector('[data-layout-scope] [data-layout-caption]')?.textContent;
    expect(caption).toBe('Saved on this computer — every phone or browser that opens it gets this layout.');
    // The page says what the switch is for once: no chip repeats the switch's words (they could only ever agree or contradict).
    expect(view.container.querySelector('.fy-lr-scope-title')?.textContent).toBe('Where a change is saved');
    expect(view.container.querySelector('[data-layout-scope-chip]')).toBeNull();
    // One set of rows in either scope: a key is never drawn twice.
    expect(view.container.querySelectorAll('[role="radiogroup"][aria-label="Navigation"]')).toHaveLength(1);
    await pickScope(view.container, 'device');
    expect(view.container.querySelectorAll('[role="radiogroup"][aria-label="Navigation"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-layout-scope-chip]')).toBeNull();
    expect(view.container.textContent).not.toContain('Layout — this device only');
    expect(view.container.querySelectorAll('h1,h2')).toHaveLength(0);
    await view.unmount();
  });

  test('Just this device is saved in the app and sent nowhere; it hides what only the shared layout has', async () => {
    const script = scriptedLayouts();
    const device = fakeDevice({ inForce: COMPACT_LAYOUT, overrides: { density: 'compact' } });
    const view = await mount(<LayoutSettings client={script.client} device={device} />);
    await settle();
    // A device that already differs opens on its own changes.
    expect(
      group(view.container, 'Where a change is saved').querySelector<HTMLInputElement>('input:checked')?.value,
    ).toBe('device');
    expect(group(view.container, 'Density').querySelector<HTMLInputElement>('input:checked')?.value).toBe('compact');
    expect(view.container.textContent).toContain('This device has 1 change of its own');
    expect(view.container.textContent).not.toContain('Save as a new layout');
    await pick(view.container, 'Navigation', 'bottom');
    await interact(() => press(view.container, 'Follow again').click());
    expect(device.calls).toEqual(['set nav.side bottom', 'reset']);
    expect(script.calls).toEqual([]);
    await pickScope(view.container, 'all');
    expect(view.container.textContent).toContain('Save as a new layout');
    await view.unmount();
  });

  test('a device with no changes of its own has nothing to follow again', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} device={fakeDevice()} />);
    await settle();
    await pickScope(view.container, 'device');
    expect(press(view.container, 'Follow again').disabled).toBe(true);
    expect(view.container.textContent).toContain('This device has no changes of its own');
    await view.unmount();
  });

  test('outside a shell there is no device, so there is no switch', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    expect(view.container.querySelector('[data-layout-scope]')).toBeNull();
    await view.unmount();
  });

  test('the keys are grouped, and every choice says in plain text what the chosen word does', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const heads = [...view.container.querySelectorAll('[data-setting-group] > h3')].map(head => head.textContent);
    expect(heads).toEqual(['In use', 'Navigation', 'The page', 'On a phone', 'Saved layouts']);
    const row = must(view.container.querySelector<HTMLElement>('[data-setting-row="Density"]'), 'the Density row');
    expect(row.querySelector('[data-layout-caption]')?.textContent).toBe('Room between rows.');
    // The caption is outside the decorative preview, so a screen reader reads it.
    expect(row.querySelector('[data-layout-caption]')?.closest('[aria-hidden="true"]')).toBeNull();
    await view.unmount();
  });

  test('each navigation chip carries a name, Earlier, Later and an eye; the chip itself is the drag handle', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const chip = must(
      list(view.container, 'nav.items').querySelector<HTMLElement>('[data-chip-key="board"]'),
      'the Board chip',
    );
    expect(chip.querySelector('[data-chip-main]')?.textContent).toContain('Board');
    for (const name of ['Move Board earlier', 'Move Board later', 'Hide Board'])
      expect(press(chip, name)).toBeDefined();
    const first = must(
      list(view.container, 'nav.items').querySelector<HTMLElement>('[data-chip-key="ferrets"]'),
      'first',
    );
    expect(press(first, 'Move Ferrets earlier').getAttribute('aria-disabled')).toBe('true');
    await view.unmount();
  });

  test('a pointer drag of the whole chip drops it in the new place, and saves once', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} />);
    await settle();
    const nav = list(view.container, 'nav.items');
    const chip = must(nav.querySelector<HTMLElement>('[data-chip-key="ferrets"]'), 'the Ferrets chip');
    // happy-dom has no layout: every chip is 100 x 40, one per row, so a chip's middle is its place down the list.
    const all = [...nav.querySelectorAll<HTMLElement>('[data-chip-key]')];
    all.forEach((element, index) => {
      Object.defineProperties(element, {
        offsetLeft: { value: 0, configurable: true },
        offsetTop: { value: index * 40, configurable: true },
        offsetWidth: { value: 100, configurable: true },
        offsetHeight: { value: 40, configurable: true },
      });
    });
    const point = (type: string, y: number) =>
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 10,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
    await interact(() => chip.dispatchEvent(point('pointerdown', 20)));
    await interact(() => document.dispatchEvent(point('pointermove', 130)));
    expect(script.calls).toEqual([]);
    await interact(() => document.dispatchEvent(point('pointerup', 130)));
    await settle();
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]).toContain('set nav.items agenda,board,ferrets,projects');
    await view.unmount();
  });

  test('moving chips writes no browser storage', async () => {
    const script = scriptedLayouts();
    const view = await mount(<LayoutSettings client={script.client} device={fakeDevice()} />);
    await settle();
    const before = [localStorage.length, sessionStorage.length];
    await interact(() => press(list(view.container, 'nav.items'), 'Hide Board').click());
    await settle();
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
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
