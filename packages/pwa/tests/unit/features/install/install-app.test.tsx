import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { InstallAppSetting, InstallBanner, InstallBannerSlot } from '../../../../src/features/install/install-app.tsx';
import { InstallPromptContext } from '../../../../src/hooks/use-install-prompt.ts';
import {
  type DeferredInstallPrompt,
  type InstallPlatform,
  InstallPromptStore,
  type InstallStorage,
} from '../../../../src/lib/install-prompt.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const memory = (): InstallStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const offer = (outcome: 'accepted' | 'dismissed'): DeferredInstallPrompt => ({
  prompt: async () => undefined,
  userChoice: Promise.resolve({ outcome }),
});

const store = (platform: InstallPlatform): InstallPromptStore => new InstallPromptStore(platform, memory());

const within = (installs: InstallPromptStore, element: ReactElement): ReactTestRenderer =>
  render(<InstallPromptContext.Provider value={installs}>{element}</InstallPromptContext.Provider>);

const textOf = (node: ReactTestInstance | ReactTestRenderer): string => {
  const root = 'root' in node ? node.root : node;
  const walk = (child: ReactTestInstance | string): string =>
    typeof child === 'string' ? child : child.children.map(walk).join('');
  return walk(root);
};

const banner = (renderer: ReactTestRenderer): ReactTestInstance | undefined =>
  renderer.root.findAll(node => node.props['data-install-banner'] !== undefined && typeof node.type === 'string')[0];

describe('InstallBanner', () => {
  test('offers the browser’s install with a button, and iOS the Share steps without one', () => {
    const calls: string[] = [];
    const prompt = render(
      <InstallBanner kind="prompt" onDismiss={() => calls.push('dismiss')} onInstall={() => calls.push('install')} />,
    );
    const hint = render(<InstallBanner kind="ios-hint" onDismiss={() => calls.push('dismiss')} onInstall={() => {}} />);

    expect(textOf(prompt)).toContain('Install Ferretry as an app');
    expect(textOf(hint)).toContain('tap Share');
    expect(textOf(hint)).toContain('Add to Home Screen');
    expect(hint.root.findAll(node => node.props['data-install-accept'] !== undefined)).toHaveLength(0);

    run(() =>
      prompt.root
        .find(node => node.type === 'button' && node.props['data-install-accept'] !== undefined)
        .props.onClick(),
    );
    run(() =>
      prompt.root
        .find(node => node.type === 'button' && node.props['data-install-dismiss'] !== undefined)
        .props.onClick(),
    );
    expect(calls).toEqual(['install', 'dismiss']);
  });
});

describe('InstallBannerSlot', () => {
  test('shows nothing without a store, off a phone, or with nothing to offer', () => {
    expect(render(<InstallBannerSlot phone />).toJSON()).toBeNull();
    const ios = store('ios');
    expect(within(ios, <InstallBannerSlot phone={false} />).toJSON()).toBeNull();
    expect(within(store('browser'), <InstallBannerSlot phone />).toJSON()).toBeNull();
    expect(within(store('installed'), <InstallBannerSlot phone />).toJSON()).toBeNull();
  });

  test('follows the store: the browser’s offer appears, installs, and a dismissal hides it for good', async () => {
    const installs = store('browser');
    const view = within(installs, <InstallBannerSlot phone />);
    expect(banner(view)).toBeUndefined();

    run(() => installs.capture(offer('dismissed')));
    expect(banner(view)?.props['data-install-banner']).toBe('prompt');

    await runAsync(async () => {
      view.root.find(node => node.type === 'button' && node.props['data-install-accept'] !== undefined).props.onClick();
    });
    expect(banner(view)).toBeUndefined();

    const ios = store('ios');
    const hint = within(ios, <InstallBannerSlot phone />);
    expect(banner(hint)?.props['data-install-banner']).toBe('ios-hint');
    run(() =>
      hint.root
        .find(node => node.type === 'button' && node.props['data-install-dismiss'] !== undefined)
        .props.onClick(),
    );
    expect(banner(hint)).toBeUndefined();
    expect(ios.getSnapshot().dismissed).toBe(true);
  });
});

describe('InstallAppSetting', () => {
  const state = (renderer: ReactTestRenderer): string =>
    renderer.root.find(node => typeof node.type === 'string' && node.props['data-install-setting'] !== undefined).props[
      'data-install-setting'
    ];

  test('says where the browser keeps it when no store or no offer exists, and the Share steps on iOS', () => {
    const bare = render(<InstallAppSetting />);
    expect(state(bare)).toBe('manual');
    expect(textOf(bare)).toContain('Install app');
    expect(state(within(store('browser'), <InstallAppSetting />))).toBe('manual');
    expect(textOf(within(store('ios'), <InstallAppSetting />))).toContain('Add to Home Screen');
    expect(textOf(within(store('installed'), <InstallAppSetting />))).toContain('is installed on this device');
  });

  test('installs from Settings even after the banner was dismissed, and becomes "installed" when accepted', async () => {
    const installs = store('browser');
    installs.dismiss();
    installs.capture(offer('accepted'));
    const view = within(installs, <InstallAppSetting />);
    expect(state(view)).toBe('prompt');

    await runAsync(async () => {
      view.root.find(node => node.type === 'button' && node.props['data-install-accept'] !== undefined).props.onClick();
    });

    expect(state(view)).toBe('installed');
    expect(view.root.findAll(node => node.props.role === 'status')).toHaveLength(0);
  });

  test('says so when the reader declines the browser’s dialog', async () => {
    const installs = store('browser');
    installs.capture(offer('dismissed'));
    const view = within(installs, <InstallAppSetting />);

    await runAsync(async () => {
      view.root.find(node => node.type === 'button' && node.props['data-install-accept'] !== undefined).props.onClick();
    });

    expect(state(view)).toBe('manual');
    expect(textOf(view)).toContain('Not installed.');
  });
});
