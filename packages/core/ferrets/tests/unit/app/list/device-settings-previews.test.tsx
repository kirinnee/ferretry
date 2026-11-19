/** The ferret list previews beside Settings › This device › Ferret list: wired to the two rows, one frame per value. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deviceControls } from '@ferretry/app';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { DensityPreview, NeedsYouPreview } from '../../../../app/views/device-settings-previews.tsx';
import { deviceSettingsPanels } from '../../../../app/views/device-settings.tsx';

let mounted: Mounted | undefined;
beforeEach(() => {
  localStorage.clear();
  deviceControls().setDeviceControls({ groupNeedsYou: true, density: null });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  delete document.documentElement.dataset.motion;
});

const attrs = (name: string): string[] =>
  [...(mounted?.container.querySelectorAll(`[${name}]`) ?? [])].map(node => node.getAttribute(name) ?? '');

describe('the rows carry their previews', () => {
  it('draws one preview in each row slot and follows the device controls', async () => {
    const Panel = deviceSettingsPanels['needs-you'];
    mounted = await mount(<Panel />);
    const rows = [...mounted.container.querySelectorAll('[data-setting-row]')];
    expect(rows.map(row => row.querySelectorAll('[data-setting-preview-slot] [data-setting-preview]').length)).toEqual([
      1, 1,
    ]);
    const needsYou = must(rows[0] ?? null, 'the needs-you row');
    expect(needsYou.querySelector('[data-setting-preview]')?.getAttribute('data-sp-value')).toBe('on');
    await interact(() => must(needsYou.querySelector<HTMLElement>('[role="switch"]'), 'the switch').click());
    expect(needsYou.querySelector('[data-setting-preview]')?.getAttribute('data-sp-value')).toBe('off');
    const density = must(rows[1] ?? null, 'the density row');
    expect(density.querySelector('[data-setting-preview]')?.getAttribute('data-sp-value')).toBe('full');
  });
});

describe('NeedsYouPreview', () => {
  it('shows the grouped list against the ungrouped one, and only the chosen one under reduced motion', async () => {
    mounted = await mount(<NeedsYouPreview grouped />);
    expect(attrs('data-dsp-grouped')).toEqual(['off', 'on']);
    expect(mounted.container.textContent).toContain('Needs you');
    await mounted.unmount();
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<NeedsYouPreview grouped={false} />);
    expect(attrs('data-dsp-grouped')).toEqual(['off']);
    expect(mounted.container.textContent).not.toContain('Needs you');
  });

  it('lifts the asking ferret to the top only when grouped', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<NeedsYouPreview grouped />);
    expect(mounted.container.querySelectorAll('[data-lifted]')).toHaveLength(1);
  });
});

describe('DensityPreview', () => {
  it('loops from the density it is most unlike, with a row shape per density', async () => {
    mounted = await mount(<DensityPreview density="compact" />);
    expect(attrs('data-dsp-density')).toEqual(['full', 'compact']);
    await mounted.unmount();
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<DensityPreview density="minimal" />);
    expect(attrs('data-dsp-density')).toEqual(['minimal']);
    // Minimal is one line: no sub-line and no marks under any row.
    expect(mounted.container.querySelectorAll('.fy-dsp-sub, .fy-dsp-mark')).toHaveLength(0);
  });
});
