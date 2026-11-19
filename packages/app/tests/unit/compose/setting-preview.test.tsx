/**
 * The setting preview: it RESTS on the selected value (never blank, never a loop), plays ONE movement when the value
 * changes and goes back to rest when its own timer (not an `animationend`) runs out, shows the final frame under reduced motion, pauses a movement in a
 * hidden tab, draws a skeleton for a lazy scene, and has a slot in the row.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { lazy } from 'react';
import { SETTING_PREVIEW_PLAY_MS, SettingPreview } from '../../../src/compose/setting-preview.tsx';
import { SettingGroup, SettingRow, SettingRowGrid } from '../../../src/compose/setting-row.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

const scene = (name: string) => <span data-scene={name}>{name}</span>;

const frameOf = (container: HTMLElement): HTMLElement =>
  must(container.querySelector('[data-setting-preview]'), 'the frame');
const stateOf = (container: HTMLElement): string | null => frameOf(container).getAttribute('data-sp-state');
const scenesIn = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-scene]')].map(node => node.getAttribute('data-scene') ?? '');
/** Let the movement's own timer run out (real time: the primitive owns the clock, whatever a scene does to its layers). */
const waitForRest = async (): Promise<void> => {
  await interact(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, SETTING_PREVIEW_PLAY_MS + 150));
  });
};

const setVisibility = async (state: 'visible' | 'hidden'): Promise<void> => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  await interact(() => document.dispatchEvent(new Event('visibilitychange')));
};

describe('SettingPreview', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    delete document.documentElement.dataset.motion;
    Reflect.deleteProperty(document, 'visibilityState');
  });

  const preview = (value = 'right', before: string | null = 'left') => (
    <SettingPreview
      label="The menu on the right"
      value={value}
      {...(before === null ? {} : { before: scene(before) })}
      after={scene(value)}
    />
  );

  it('should be decorative (hidden, no role, no name) and rest on the selected value at first draw', async () => {
    mounted = await mount(preview());
    const frame = frameOf(mounted.container);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.hasAttribute('role')).toBe(false);
    expect(frame.hasAttribute('aria-label')).toBe(false);
    expect(frame.getAttribute('data-sp-label')).toBe('The menu on the right');
    // Never blank, never moving on first draw: the selected value only.
    expect(stateOf(mounted.container)).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['right']);
  });

  it('should play before then after ONCE when the value changes, then rest when its timer runs out', async () => {
    mounted = await mount(preview('right'));
    await mounted.render(preview('left-rail'));
    expect(stateOf(mounted.container)).toBe('playing');
    expect(scenesIn(mounted.container)).toEqual(['left', 'left-rail']);
    expect(stateOf(mounted.container)).toBe('playing');
    await waitForRest();
    expect(stateOf(mounted.container)).toBe('still');
    // It rests on the selected value and does not start again by itself: it does not loop.
    expect(scenesIn(mounted.container)).toEqual(['left-rail']);
    await waitForRest();
    expect(stateOf(mounted.container)).toBe('still');
  });

  it('should rest on its timer even when the scene never animates its layers (no animationend ever fires)', async () => {
    mounted = await mount(preview('right'));
    await mounted.render(preview('left-rail'));
    // No stylesheet is loaded here and no animationend is dispatched: only the primitive's own clock can end the play.
    expect(stateOf(mounted.container)).toBe('playing');
    await waitForRest();
    expect(stateOf(mounted.container)).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['left-rail']);
  });

  it('should hold its timer while paused and restart it for a new value', async () => {
    mounted = await mount(preview('right'));
    await mounted.render(preview('left-rail'));
    await setVisibility('hidden');
    // A hidden tab holds the movement however long it stays hidden.
    await interact(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, SETTING_PREVIEW_PLAY_MS + 150));
    });
    expect(stateOf(mounted.container)).toBe('paused');
    await setVisibility('visible');
    expect(stateOf(mounted.container)).toBe('playing');
    await waitForRest();
    expect(stateOf(mounted.container)).toBe('still');
  });

  it('should play again when the value goes back to the one it just left', async () => {
    mounted = await mount(preview('right'));
    await mounted.render(preview('left-rail'));
    await mounted.render(preview('right'));
    expect(stateOf(mounted.container)).toBe('playing');
  });

  it('should start the new stage from the start (a new stage per value)', async () => {
    mounted = await mount(preview('right'));
    const first = must(mounted.container.querySelector('.fy-sp__stage'), 'the stage');
    await mounted.render(preview('left-rail'));
    const second = must(mounted.container.querySelector('.fy-sp__stage'), 'the stage');
    expect(second).not.toBe(first);
    expect(frameOf(mounted.container).getAttribute('data-sp-value')).toBe('left-rail');
  });

  it('should show only the final state when Settings asks for reduced motion', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(preview('right'));
    await mounted.render(preview('left-rail'));
    expect(stateOf(mounted.container)).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['left-rail']);
  });

  it('should drop to the final state when motion is turned off while it plays', async () => {
    mounted = await mount(preview('right'));
    await mounted.render(preview('left-rail'));
    expect(scenesIn(mounted.container)).toEqual(['left', 'left-rail']);
    await interact(() => {
      document.documentElement.dataset.motion = 'reduced';
    });
    await interact(() => undefined);
    expect(stateOf(mounted.container)).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['left-rail']);
  });

  it('should show only the final state when there is no before', async () => {
    mounted = await mount(preview('right', null));
    await mounted.render(preview('left-rail', null));
    expect(stateOf(mounted.container)).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['left-rail']);
  });

  it('should hold a movement while the tab is hidden and play it again when it returns', async () => {
    mounted = await mount(preview('right'));
    await mounted.render(preview('left-rail'));
    await setVisibility('hidden');
    expect(stateOf(mounted.container)).toBe('paused');
    // Paused keeps both layers mounted: the movement holds where it is instead of redrawing.
    expect(scenesIn(mounted.container)).toEqual(['left', 'left-rail']);
    await setVisibility('visible');
    expect(stateOf(mounted.container)).toBe('playing');
  });

  it('should draw a same-size skeleton, never an empty box, while a lazy scene has not mounted', async () => {
    const Never = lazy(() => new Promise<{ default: () => null }>(() => undefined));
    mounted = await mount(<SettingPreview label="Lazy" value="a" before={scene('b')} after={<Never />} />);
    const frame = frameOf(mounted.container);
    expect(frame.querySelector('[data-sp-skeleton]')).not.toBeNull();
  });

  it('should size a contain-fit scene at its own size and mark the fit', async () => {
    mounted = await mount(
      <SettingPreview label="Fit" value="a" after={scene('a')} fit="contain" sceneSize={{ width: 320, height: 200 }} />,
    );
    expect(frameOf(mounted.container).getAttribute('data-sp-fit')).toBe('contain');
    const stage = must(mounted.container.querySelector<HTMLElement>('.fy-sp__stage'), 'the stage');
    expect(stage.classList.contains('fy-sp__stage--fit')).toBe(true);
    expect(stage.style.width).toBe('320px');
    expect(stage.style.height).toBe('200px');
  });
});

describe('SettingRow preview slot', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it('should draw the preview between the name and the control, and nothing when there is none', async () => {
    mounted = await mount(
      <ul>
        <SettingRow name="Side" preview={rowPreview()} control={() => <button type="button">Right</button>} />
        <SettingRow name="Density" control={() => <button type="button">Compact</button>} />
      </ul>,
    );
    const rows = [...mounted.container.querySelectorAll('[data-setting-row]')];
    const [side, density] = rows;
    const slot = must(side?.querySelector('[data-setting-preview-slot]'), 'the slot');
    expect(slot.querySelector('[data-setting-preview]')).not.toBeNull();
    expect(slot.nextElementSibling?.hasAttribute('data-setting-controls')).toBe(true);
    expect(density?.querySelector('[data-setting-preview-slot]')).toBeNull();
  });

  it('should keep the preview out of the accessibility tree and the switch labelled', async () => {
    mounted = await mount(
      <ul>
        <SettingRow
          name="Side"
          preview={rowPreview()}
          control={labelId => <button type="button" role="switch" aria-checked="true" aria-labelledby={labelId} />}
        />
      </ul>,
    );
    const slot = must(mounted.container.querySelector('[data-setting-preview-slot]'), 'the slot');
    // The slot is hidden from assistive tech, and nothing inside it is an image or carries a name.
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.querySelector('[role="img"], [aria-label], img[alt]')).toBeNull();
    const visible = [...mounted.container.querySelectorAll('[role="img"], [aria-label]')].filter(
      node => node.closest('[aria-hidden="true"]') === null,
    );
    expect(visible).toEqual([]);
    // The switch keeps its label, read from the row's name.
    const control = must(mounted.container.querySelector('[role="switch"]'), 'the switch');
    const labelId = control.getAttribute('aria-labelledby') ?? '';
    expect(mounted.container.querySelector(`[id="${labelId}"]`)?.textContent).toBe('Side');
  });
});

function rowPreview() {
  return <SettingPreview label="Right" value="right" before={scene('left')} after={scene('right')} />;
}

describe('SettingGroup and SettingRow layout', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it('should be a flat group (no box) with a 32 px gap and rows split only by hairlines', async () => {
    mounted = await mount(
      <SettingGroup label="Group">
        <SettingRow name="One" control={() => <button type="button">a</button>} />
        <SettingRow name="Two" control={() => <button type="button">b</button>} />
      </SettingGroup>,
    );
    const group = must(mounted.container.querySelector('[data-setting-group]'), 'the group');
    expect(group.classList.contains('mb-8')).toBe(true);
    const list = must(group.querySelector('ul'), 'the list');
    // `kt-groupcard--flat` is the stylesheet's "no inner border" mark: the box is dropped, the hairlines stay.
    expect(list.classList.contains('kt-groupcard')).toBe(true);
    expect(list.classList.contains('kt-groupcard--flat')).toBe(true);
    expect(list.querySelectorAll('li[data-setting-row]').length).toBe(2);
  });

  it('should put the control right after a 40 % label column, with the (i) last', async () => {
    mounted = await mount(
      <ul>
        <SettingRow
          name="Side"
          hint="Where the menu goes"
          explanation="Long text"
          control={() => <button type="button">Right</button>}
        />
      </ul>,
    );
    const row = must(mounted.container.querySelector('[data-setting-row]'), 'the row');
    const label = must(row.querySelector('[data-setting-hint]')?.parentElement, 'the label column');
    expect(label.className).toContain('min-[900px]:basis-[40%]');
    expect(label.className).toContain('min-w-[min(220px,100%)]');
    const controls = must(row.querySelector('[data-setting-controls]'), 'the controls');
    expect(label.nextElementSibling).toBe(controls);
    expect(controls.lastElementChild?.hasAttribute('data-setting-info')).toBe(true);
    // The hint is one line on a desktop; the title keeps the whole text reachable.
    expect(row.querySelector('[data-setting-hint]')?.getAttribute('title')).toBe('Where the menu goes');
  });

  it('should hold short rows in one list item that is two columns from 1,200 px', async () => {
    mounted = await mount(
      <SettingGroup label="Grid">
        <SettingRowGrid>
          <SettingRow name="A" control={() => <button type="button">a</button>} />
          <SettingRow name="B" control={() => <button type="button">b</button>} />
        </SettingRowGrid>
      </SettingGroup>,
    );
    const grid = must(mounted.container.querySelector('[data-setting-row-grid]'), 'the grid item');
    expect(grid.tagName).toBe('LI');
    const inner = must(grid.querySelector('ul'), 'the inner list');
    expect(inner.className).toContain('min-[1200px]:grid-cols-2');
    expect(inner.querySelectorAll('[data-setting-row]').length).toBe(2);
  });
});
