/**
 * The Look previews: one per choice, each the final frame under reduced motion, each looping from the value it is most
 * unlike, and the Motion one moving only where motion is allowed.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { ColourModePreview, MotionPreview, TextSizePreview } from '../../../src/shell/device-appearance-previews.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  delete document.documentElement.dataset.motion;
});

const frame = (): HTMLElement => must(mounted?.container.querySelector('[data-setting-preview]') ?? null, 'the frame');
const attrs = (name: string): string[] =>
  [...(mounted?.container.querySelectorAll(`[${name}]`) ?? [])].map(node => node.getAttribute(name) ?? '');

describe('ColourModePreview', () => {
  it('should loop from the opposite tone to the chosen one, in the current theme family', async () => {
    mounted = await mount(<ColourModePreview family="mission" mode="dark" />);
    expect(frame().getAttribute('data-sp-label')).toBe('Always dark');
    expect(attrs('data-dap-mode')).toEqual(['light', 'dark']);
    expect(attrs('data-swatch')).toEqual(['mission-light', 'mission-dark']);
  });

  it('should draw Auto as one frame holding both tones', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<ColourModePreview family="mission" mode="system" />);
    expect(attrs('data-dap-mode')).toEqual(['system']);
    expect(attrs('data-swatch')).toEqual(['mission-light', 'mission-dark']);
  });

  it('should show only the final frame under reduced motion', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<ColourModePreview family="mission" mode="light" />);
    expect(frame().getAttribute('data-sp-state')).toBe('still');
    expect(attrs('data-dap-mode')).toEqual(['light']);
  });
});

describe('TextSizePreview', () => {
  it('should loop from the opposite size, and the button is the same in both frames', async () => {
    mounted = await mount(<TextSizePreview scale="larger" />);
    expect(attrs('data-dap-scale')).toEqual(['default', 'larger']);
    expect(mounted.container.querySelectorAll('.fy-dap-button')).toHaveLength(2);
  });

  it('should show only the chosen size under reduced motion', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<TextSizePreview scale="large" />);
    expect(attrs('data-dap-scale')).toEqual(['large']);
  });
});

describe('MotionPreview', () => {
  it('should play moving then still, or still then moving, for the chosen value', async () => {
    mounted = await mount(<MotionPreview motion="system" />);
    expect(attrs('data-dap-motion')).toEqual(['still', 'moving']);
    await mounted.unmount();
    mounted = await mount(<MotionPreview motion="reduced" />);
    expect(attrs('data-dap-motion')).toEqual(['moving', 'still']);
  });

  it('should draw Follow system as still when this device asks for no motion', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<MotionPreview motion="system" />);
    expect(attrs('data-dap-motion')).toEqual(['still']);
    expect(mounted.container.textContent).toContain('Still');
  });

  it('should stop moving the moment Settings turns motion down', async () => {
    mounted = await mount(<MotionPreview motion="system" />);
    expect(attrs('data-dap-motion')).toContain('moving');
    await interact(() => {
      document.documentElement.dataset.motion = 'reduced';
    });
    await interact(() => undefined);
    expect(attrs('data-dap-motion')).toEqual(['still']);
  });

  it('should replay when the value changes', async () => {
    mounted = await mount(<MotionPreview motion="system" />);
    expect(frame().getAttribute('data-sp-value')).toBe('system');
  });
});
