/** Settings › This device › "Open links in" (S-0519): three choices, saved on this device, and Browsers provides the behaviour. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deviceControls } from '@ferretry/app';
import { ensureDom, interact, mount, type Mounted, must } from '@ferretry/app/testing';
import { OpenLinksInPanel } from '../../../../app/features/settings/open-links-in-panel.tsx';

ensureDom();

let mounted: Mounted | undefined;
beforeEach(() => {
  localStorage.clear();
  deviceControls().setDeviceControls({ openLinksIn: 'browser' });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('the Open links in row', () => {
  it('S-0519 offers the three homes by their v4 names, on "Your browser" until chosen otherwise', async () => {
    mounted = await mount(<OpenLinksInPanel />);
    const group = must(
      mounted.container.querySelector('[role="radiogroup"][aria-label="Open links in"]'),
      'the choices',
    );
    expect([...group.querySelectorAll('label')].map(label => label.textContent)).toEqual([
      'Your browser',
      'Ferretry side panel',
      "Your computer's default browser",
    ]);
    expect(group.querySelector<HTMLInputElement>('input[value="browser"]')?.checked).toBe(true);
    expect(mounted.container.textContent).toContain('Cmd/Ctrl-click always opens a new tab');
  });

  it('S-0519 saves the choice on this device', async () => {
    mounted = await mount(<OpenLinksInPanel />);
    await interact(() => mounted?.container.querySelector<HTMLInputElement>('input[value="panel"]')?.click());
    expect(deviceControls().snapshot().device.openLinksIn).toBe('panel');
  });
});

describe('the half', () => {
  it('S-0519 provides `shell.links` and the device panel, which is what the shell reads as the link provider', async () => {
    const half = (await import('../../../../app/index.ts')).default as unknown as {
      readonly shell?: { readonly links?: unknown; readonly deviceSettings?: Record<string, unknown> };
    };
    expect(typeof half.shell?.links).toBe('function');
    expect(typeof half.shell?.deviceSettings?.['open-links-in']).toBe('function');
  });
});
