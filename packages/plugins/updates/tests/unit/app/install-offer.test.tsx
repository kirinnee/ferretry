/**
 * THE INSTALL OFFER, in its two places: Settings › This device › Install app (a `device.settings` panel) and the
 * `background` toast. The shell holds the browser's facts (`useInstallPrompt`, S13); these views only draw the offer.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { InstallOutcome, InstallPrompt } from '@ferretry/app';
import { deviceViewHarness, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import half from '../../../app/index.ts';
import {
  InstallAppPanel,
  InstallAppRow,
  InstallToast,
  InstallToastLine,
  InstallToastWhenDue,
} from '../../../app/views/install-offer.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** The shell's install prompt as a view reads it, with a prompt that answers `outcome` and counts its calls. */
const offered = (
  platform: InstallPrompt['platform'],
  canPrompt: boolean,
  outcome: InstallOutcome = 'accepted',
): InstallPrompt & { readonly calls: { prompted: number } } => {
  const calls = { prompted: 0 };
  return {
    platform,
    canPrompt,
    prompt: async () => {
      calls.prompted += 1;
      return outcome;
    },
    calls,
  };
};

const toastOf = (view: Mounted): HTMLElement | null => view.container.querySelector('[data-install-toast]');
const button = (view: Mounted, attribute: string): HTMLElement =>
  must(view.container.querySelector<HTMLElement>(`button[${attribute}]`), attribute);
const rowOf = (view: Mounted): HTMLElement => must(view.container.querySelector('[data-install-setting]'), 'the row');
const opened = async (view: Mounted): Promise<void> => {
  await interact(() => must(view.container.querySelector<HTMLElement>('[data-setting-info]'), 'the (i)').click());
};

describe('the toast line', () => {
  it('mounts its live region empty, so the words are announced when they arrive', () => {
    const first = renderToStaticMarkup(<InstallToastLine kind="prompt" onDismiss={() => {}} onInstall={() => {}} />);
    expect(first).toContain('role="status"');
    expect(first).not.toContain('Install Ferretry');
  });

  it('offers the browser’s install with a button, and iOS the Share steps without one', async () => {
    const calls: string[] = [];
    mounted = await mount(
      <InstallToastLine
        kind="prompt"
        onDismiss={() => calls.push('dismiss')}
        onInstall={() => calls.push('install')}
      />,
    );
    expect(toastOf(mounted)?.textContent).toContain('Install Ferretry as an app');
    // An overlay, never a row of the page: the shell's `.fy-status-overlay` takes it out of the layout's height (O9-3).
    expect(toastOf(mounted)?.classList.contains('fy-status-overlay')).toBe(true);
    await interact(() => button(mounted as Mounted, 'data-install-accept').click());
    await interact(() => button(mounted as Mounted, 'data-install-dismiss').click());
    expect(calls).toEqual(['install', 'dismiss']);
    await mounted.unmount();

    mounted = await mount(<InstallToastLine kind="ios-hint" onDismiss={() => {}} onInstall={() => {}} />);
    expect(toastOf(mounted)?.textContent).toContain('tap Share');
    expect(toastOf(mounted)?.textContent).toContain('Add to Home Screen');
    expect(mounted.container.querySelector('[data-install-accept]')).toBeNull();
  });
});

describe('the toast, when one is due', () => {
  const due = (prompt: InstallPrompt, over: { dismissed?: boolean; phone?: boolean; speaks?: boolean } = {}) => (
    <InstallToastWhenDue
      dismiss={() => {}}
      dismissed={over.dismissed ?? false}
      phone={over.phone ?? true}
      prompt={prompt}
      speaksForDevice={over.speaks ?? true}
    />
  );

  it('draws the offer on a phone, and opens the browser’s dialog from its button', async () => {
    const prompt = offered('browser', true);
    mounted = await mount(due(prompt));
    expect(toastOf(mounted)?.getAttribute('data-install-toast')).toBe('prompt');
    await interact(() => button(mounted as Mounted, 'data-install-accept').click());
    expect(prompt.calls.prompted).toBe(1);
  });

  it('says where to tap on iOS, and "not now" goes to the dismissal', async () => {
    let dismissed = 0;
    mounted = await mount(
      <InstallToastWhenDue
        dismiss={() => {
          dismissed += 1;
        }}
        dismissed={false}
        phone
        prompt={offered('ios', false)}
        speaksForDevice
      />,
    );
    expect(toastOf(mounted)?.getAttribute('data-install-toast')).toBe('ios-hint');
    await interact(() => button(mounted as Mounted, 'data-install-dismiss').click());
    expect(dismissed).toBe(1);
  });

  it('draws nothing off a phone, for a second machine, once dismissed, once installed or with nothing to offer', async () => {
    for (const element of [
      due(offered('browser', true), { phone: false }),
      due(offered('browser', true), { speaks: false }),
      due(offered('browser', true), { dismissed: true }),
      due(offered('installed', true)),
      due(offered('browser', false)),
    ]) {
      mounted = await mount(element);
      expect(toastOf(mounted)).toBeNull();
      await mounted.unmount();
    }
  });
});

describe('the Install app row', () => {
  it('says where the browser keeps it when it has not offered, and the Share steps on iOS', async () => {
    mounted = await mount(<InstallAppRow prompt={offered('browser', false)} />);
    expect(rowOf(mounted).getAttribute('data-install-setting')).toBe('manual');
    await opened(mounted);
    expect(mounted.container.textContent).toContain('Install app');
    expect(mounted.container.textContent).toContain('This browser has not offered to install Ferretry');
    await mounted.unmount();

    mounted = await mount(<InstallAppRow prompt={offered('ios', false)} />);
    expect(rowOf(mounted).getAttribute('data-install-setting')).toBe('ios');
    await opened(mounted);
    expect(mounted.container.textContent).toContain('Add to Home Screen');
    await mounted.unmount();

    mounted = await mount(<InstallAppRow prompt={offered('installed', false)} />);
    expect(rowOf(mounted).getAttribute('data-install-setting')).toBe('installed');
    await opened(mounted);
    expect(mounted.container.textContent).toContain('is installed on this device');
  });

  it('installs from Settings, whatever the toast was told, and an accepted install needs no words of its own', async () => {
    const prompt = offered('browser', true, 'accepted');
    mounted = await mount(<InstallAppRow prompt={prompt} />);
    expect(rowOf(mounted).getAttribute('data-install-setting')).toBe('prompt');
    await interact(() => button(mounted as Mounted, 'data-install-accept').click());
    expect(prompt.calls.prompted).toBe(1);
    expect(mounted.container.querySelector('[role="status"]')).toBeNull();
  });

  it('says so when the reader declines the browser’s dialog, or the browser withdrew its offer', async () => {
    mounted = await mount(<InstallAppRow prompt={offered('browser', true, 'dismissed')} />);
    await interact(() => button(mounted as Mounted, 'data-install-accept').click());
    expect(mounted.container.querySelector('[role="status"]')?.textContent).toContain('Not installed.');
    await mounted.unmount();

    mounted = await mount(<InstallAppRow prompt={offered('browser', true, 'unavailable')} />);
    await interact(() => button(mounted as Mounted, 'data-install-accept').click());
    expect(mounted.container.querySelector('[role="status"]')?.textContent).toContain('withdrew its offer');
  });
});

describe('the views as the shell mounts them', () => {
  const { Harness, setPaired } = deviceViewHarness({ plugin: 'updates', fragments: [] });

  it('draws the panel from the shell’s install prompt: a browser that was never offered says where its menu is', async () => {
    mounted = await mount(
      <Harness>
        <InstallAppPanel />
      </Harness>,
    );
    expect(rowOf(mounted).getAttribute('data-install-setting')).toBe('manual');
  });

  it('draws no toast for a browser that was never offered an install, on a machine that speaks for the device', async () => {
    setPaired(['fy_daemon_a', 'fy_daemon_b']);
    mounted = await mount(
      <Harness>
        <InstallToast client={undefined as never} daemon="fy_daemon_a" />
      </Harness>,
    );
    expect(toastOf(mounted)).toBeNull();
  });

  it('declares both places to the shell: a device.settings panel and a background toast', () => {
    const shell = (
      half as unknown as {
        readonly shell?: {
          readonly deviceSettings?: Record<string, unknown>;
          readonly background?: Record<string, unknown>;
        };
      }
    ).shell;
    expect(typeof shell?.deviceSettings?.['install-app']).toBe('function');
    expect(typeof shell?.background?.['install-offer']).toBe('function');
  });
});
