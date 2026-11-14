/** Settings › This device › "Group Needs you at the top" (S-0486): a switch on this device, on until turned off. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deviceControls } from '@ferretry/app';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { deviceSettingsPanels } from '../../../../app/views/device-settings.tsx';
import ferretsApp from '../../../../app/index.ts';

let mounted: Mounted | undefined;
beforeEach(() => {
  localStorage.clear();
  deviceControls().setDeviceControls({ groupNeedsYou: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the Group Needs you row', () => {
  it('S-0486 is on by default, with v4’s words, and turning it off is saved on this device', async () => {
    const Panel = deviceSettingsPanels['needs-you'];
    mounted = await mount(<Panel />);
    const row = must(mounted.container.querySelector('[data-setting-row="Group Needs you at the top"]'), 'the row');
    expect(row.textContent).toContain('Sessions with open Inbox items go first');
    const toggle = must(row.querySelector<HTMLElement>('[role="switch"]'), 'the switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await interact(() => toggle.click());
    expect(deviceControls().snapshot().device.groupNeedsYou).toBe(false);
  });

  it('S-0486 is drawn from the half’s device settings (no machine), not from a machine’s panels', () => {
    const half = ferretsApp as unknown as { readonly shell?: { readonly deviceSettings?: Record<string, unknown> } };
    expect(typeof half.shell?.deviceSettings?.['needs-you']).toBe('function');
  });
});
