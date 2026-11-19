/**
 * The setting preview: the final frame under reduced motion (the OS query and Settings › Motion), a loop that
 * pauses while the tab is hidden or the frame is off-screen, a replay on a new value, and the row's slot for it.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { SettingPreview } from '../../../src/compose/setting-preview.tsx';
import { SettingRow } from '../../../src/compose/setting-row.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

const scene = (name: string) => <span data-scene={name}>{name}</span>;

const frameOf = (container: HTMLElement): HTMLElement =>
  must(container.querySelector('[data-setting-preview]'), 'the frame');
const scenesIn = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-scene]')].map(node => node.getAttribute('data-scene') ?? '');

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

  const preview = (value = 'right') => (
    <SettingPreview label="The menu on the right" value={value} before={scene('left')} after={scene(value)} />
  );

  it('should be a labelled image that plays before then after', async () => {
    mounted = await mount(preview());
    const frame = frameOf(mounted.container);
    expect(frame.getAttribute('role')).toBe('img');
    expect(frame.getAttribute('aria-label')).toBe('The menu on the right');
    expect(frame.getAttribute('data-sp-state')).toBe('playing');
    expect(scenesIn(mounted.container)).toEqual(['left', 'right']);
  });

  it('should show only the final state when Settings asks for reduced motion', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(preview());
    expect(frameOf(mounted.container).getAttribute('data-sp-state')).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['right']);
  });

  it('should drop to the final state when motion is turned off while it plays', async () => {
    mounted = await mount(preview());
    expect(scenesIn(mounted.container)).toEqual(['left', 'right']);
    await interact(() => {
      document.documentElement.dataset.motion = 'reduced';
    });
    await interact(() => undefined);
    expect(frameOf(mounted.container).getAttribute('data-sp-state')).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['right']);
  });

  it('should show only the final state when there is no before', async () => {
    mounted = await mount(<SettingPreview label="Right" value="right" after={scene('right')} />);
    expect(frameOf(mounted.container).getAttribute('data-sp-state')).toBe('still');
    expect(scenesIn(mounted.container)).toEqual(['right']);
  });

  it('should pause while the tab is hidden and play again when it returns', async () => {
    mounted = await mount(preview());
    await setVisibility('hidden');
    expect(frameOf(mounted.container).getAttribute('data-sp-state')).toBe('paused');
    // Paused keeps both layers mounted: the loop holds where it is instead of redrawing.
    expect(scenesIn(mounted.container)).toEqual(['left', 'right']);
    await setVisibility('visible');
    expect(frameOf(mounted.container).getAttribute('data-sp-state')).toBe('playing');
  });

  it('should replay from the start when the value changes', async () => {
    mounted = await mount(preview('right'));
    const first = must(mounted.container.querySelector('.fy-sp__stage'), 'the stage');
    await mounted.render(preview('left-rail'));
    const second = must(mounted.container.querySelector('.fy-sp__stage'), 'the stage');
    expect(second).not.toBe(first);
    expect(frameOf(mounted.container).getAttribute('data-sp-value')).toBe('left-rail');
    expect(scenesIn(mounted.container)).toEqual(['left', 'left-rail']);
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
});

function rowPreview() {
  return <SettingPreview label="Right" value="right" before={scene('left')} after={scene('right')} />;
}
