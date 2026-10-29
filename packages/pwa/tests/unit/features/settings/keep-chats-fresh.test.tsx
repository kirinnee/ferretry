import { describe, expect, test } from 'bun:test';

import { KeepChatsFreshSetting } from '../../../../src/features/settings/keep-chats-fresh.tsx';
import { DEFAULT_DEVICE_CONTROLS } from '../../../../src/lib/controls.ts';
import { render, run } from '../../../support/react.ts';

type Patch = Parameters<Parameters<typeof KeepChatsFreshSetting>[0]['onChange']>[0];

describe('KeepChatsFreshSetting', () => {
  test('is on by default, with the cellular sub-option off', () => {
    expect(DEFAULT_DEVICE_CONTROLS.keepChatsFresh).toBe(true);
    expect(DEFAULT_DEVICE_CONTROLS.keepChatsFreshNotOnCellular).toBe(false);
  });

  test('offers both switches while on, and reports each change', () => {
    const patches: Patch[] = [];
    const view = render(
      <KeepChatsFreshSetting device={DEFAULT_DEVICE_CONTROLS} onChange={patch => patches.push(patch)} />,
    );
    const switches = view.root.findAllByProps({ role: 'switch' });
    expect(switches.map(node => node.props['aria-checked'])).toEqual([true, false]);
    run(() => switches[0]?.props.onClick());
    run(() => switches[1]?.props.onClick());
    expect(patches).toEqual([{ keepChatsFresh: false }, { keepChatsFreshNotOnCellular: true }]);
    run(() => view.unmount());
  });

  test('hides the cellular sub-option while the whole thing is off', () => {
    const view = render(
      <KeepChatsFreshSetting
        device={{ ...DEFAULT_DEVICE_CONTROLS, keepChatsFresh: false }}
        onChange={() => undefined}
      />,
    );
    expect(view.root.findAllByProps({ role: 'switch' })).toHaveLength(1);
    expect(view.root.findByProps({ 'data-keep-chats-fresh': 'off' })).toBeDefined();
    run(() => view.unmount());
  });
});
