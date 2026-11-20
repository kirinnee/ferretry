/**
 * A tunnel switch that waits for the owner is a pending approval, not a failure: the Connection screen's offer says so
 * in plain words and names exactly how to approve it, then checks again when asked.
 */
import { expect, test } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { createElement } from 'react';
import {
  CarrierPreferenceSelector,
  tunnelSwitchOffer,
} from '../../../app/features/carrier/carrier-preference-selector.tsx';
import type { TunnelSetResult, TunnelSwitchState } from '../../../app/lib/tunnel-switch.ts';
import {
  TUNNEL_APPROVE_AT_MACHINE,
  TUNNEL_APPROVE_COMMAND,
  TUNNEL_APPROVE_IN_APP,
  TUNNEL_HELD_DETAIL,
  TUNNEL_HELD_TITLE,
  TUNNEL_OFF_SENTENCE,
  type TunnelStatusView,
} from '../../../contract/index.ts';

const OFF: TunnelStatusView = {
  enabled: false,
  explicit: false,
  state: 'off',
  tunnelUrl: null,
  sentence: TUNNEL_OFF_SENTENCE,
};
const known = (view: TunnelStatusView): TunnelSwitchState => ({ kind: 'known', view });

const click = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
};
const button = (mounted: Mounted, label: string): HTMLElement =>
  must(
    [...mounted.container.querySelectorAll<HTMLElement>('button')].find(each => each.textContent?.includes(label)),
    `button ${label}`,
  );

function card(options: { turnOn: () => Promise<TunnelSetResult>; recheck: () => Promise<TunnelSwitchState> }) {
  return createElement(CarrierPreferenceSelector, {
    legend: 'Connection preference',
    value: 'tunnel',
    onChange: () => undefined,
    availability: {
      webrtc: true,
      tunnel: tunnelSwitchOffer(known(OFF), options.turnOn, options.recheck),
    },
  });
}

test('a held "Turn on" says the change waits for the owner and exactly how to approve it, and is not an error', async () => {
  const mounted = await mount(
    card({
      turnOn: async () => ({ kind: 'held', view: OFF, sentences: ['the tunnel is turned on'] }),
      recheck: async () => known(OFF),
    }),
  );
  await click(button(mounted, 'Turn on'));

  const text = mounted.container.textContent ?? '';
  expect(text).toContain(TUNNEL_HELD_TITLE);
  expect(text).toContain(TUNNEL_HELD_DETAIL);
  expect(text).toContain(TUNNEL_APPROVE_IN_APP);
  expect(text).toContain(TUNNEL_APPROVE_AT_MACHINE);
  // The exact approval path: the screen and the command, the command in code.
  expect(TUNNEL_APPROVE_IN_APP).toContain('Settings › Files');
  expect(mounted.container.querySelector('code')?.textContent).toBe('fy config confirm connections.yaml');
  expect(TUNNEL_APPROVE_COMMAND).toBe('fy config confirm connections.yaml');
  expect(mounted.container.querySelector('[data-tunnel-held]')).not.toBeNull();
  expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
  expect(text).not.toContain('failed to handle');
  await mounted.unmount();
});

test('checking before the owner approved says it is still waiting; checking after finds the tunnel on', async () => {
  let answer: TunnelStatusView = OFF;
  const mounted = await mount(
    card({
      turnOn: async () => ({ kind: 'held', view: OFF, sentences: ['x'] }),
      recheck: async () => known(answer),
    }),
  );
  await click(button(mounted, 'Turn on'));
  await click(button(mounted, 'Check again'));
  expect(mounted.container.querySelector('[data-tunnel-still-waiting]')).not.toBeNull();

  answer = { ...OFF, enabled: true, explicit: true, state: 'provisioning', sentence: 'Tunnel: on' };
  await click(button(mounted, 'Check again'));
  expect(mounted.container.querySelector('[data-tunnel-still-waiting]')).toBeNull();
  await mounted.unmount();
});
