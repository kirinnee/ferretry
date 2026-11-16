/**
 * THE SURFACES THAT SAY THE DIRECT ADDRESS STANDS IN FOR AN UNREACHABLE RELAY, and the setting that makes it strict
 * (`docs/relay-protocol.md` §15): the selector's Default vs "Relay only", the status line the card and the per-machine
 * background view draw, and this device's own Connection panel — the place the whole-machine block links to.
 */
import type { PairedDaemon } from '@ferretry/app';
import { render, run } from '@ferretry/app/testing';
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RELAY_FALLBACK_LINE } from '../../../app/carriers/router.ts';
import { ActiveCarrierCard } from '../../../app/features/carrier/active-carrier-card.tsx';
import { CarrierPreferenceSelector } from '../../../app/features/carrier/carrier-preference-selector.tsx';
import { DeviceConnectionPanel } from '../../../app/features/carrier/device-connection-panel.tsx';
import { relayFallbackView, RelayFallbackNotice } from '../../../app/features/carrier/relay-fallback-notice.tsx';
import {
  CARRIER_PREFERENCE_KEY,
  type CarrierPreferenceStorage,
  CarrierPreferenceStore,
} from '../../../app/lib/carrier-preference.ts';
import { chooseConnection, type ConnectionMethod } from '../../../app/lib/connection.ts';

const direct: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://box.example' };
const availability = { webrtc: true };

test('the selector offers the unchosen Default AND a strict "Relay only" as two different settings', () => {
  const html = renderToStaticMarkup(
    createElement(CarrierPreferenceSelector, {
      legend: 'Connection preference',
      value: 'default',
      onChange: () => undefined,
      availability,
    }),
  );
  expect(html).toContain('data-carrier-preference="default"');
  expect(html).toContain('Relay (default)');
  expect(html).toContain('uses the direct connection it was paired over');
  expect(html).toContain('data-carrier-preference-option="relay"');
  expect(html).toContain('Relay only');
  expect(html).toContain('even when it can’t be reached');
  // Exactly one is selected, and it is the Default while nothing is chosen.
  expect(html.match(/checked=""/gu)).toHaveLength(1);
  expect(html).toMatch(/value="default"[^>]*checked=""|checked=""[^>]*value="default"/u);
});

test('a chosen Relay only shows as Relay only, not as the Default', () => {
  const html = renderToStaticMarkup(
    createElement(CarrierPreferenceSelector, {
      legend: 'Connection preference',
      value: 'relay',
      onChange: () => undefined,
      availability,
    }),
  );
  expect(html).toContain('data-carrier-preference="relay"');
  expect(html).toMatch(/value="relay"[^>]*checked=""|checked=""[^>]*value="relay"/u);
  expect(html).not.toMatch(/value="default"[^>]*checked=""|checked=""[^>]*value="default"/u);
});

test('the card says the direct connection stands in for the relay, only while it does', () => {
  const choice = chooseConnection([{ method: direct, reachable: true }]);
  const said = renderToStaticMarkup(
    createElement(ActiveCarrierCard, { choice, relayAdvertised: true, relayFallback: RELAY_FALLBACK_LINE }),
  );
  expect(said).toContain('data-relay-fallback=""');
  expect(said).toContain(RELAY_FALLBACK_LINE);
  const quiet = renderToStaticMarkup(createElement(ActiveCarrierCard, { choice, relayAdvertised: true }));
  expect(quiet).not.toContain('data-relay-fallback');
});

test('the notice is a status line with the sentence the ruling gave', () => {
  expect(RELAY_FALLBACK_LINE).toBe('Couldn’t reach it through the relay, using the direct connection.');
  const html = renderToStaticMarkup(createElement(RelayFallbackNotice, { line: RELAY_FALLBACK_LINE }));
  expect(html).toContain('role="status"');
  expect(html).toContain(RELAY_FALLBACK_LINE);
});

test('the background view draws the line for a daemon the router carries by the fallback, and nothing otherwise', () => {
  const router = (line: string | undefined) => ({
    subscribe: () => () => undefined,
    relayFallback: (daemon: string) => (daemon === 'fy_daemon_a' ? line : undefined),
  });
  const view = (line: string | undefined) => relayFallbackView(() => router(line));
  const props = (daemon: string) => ({ daemon, client: {} as never });
  expect(renderToStaticMarkup(createElement(view(RELAY_FALLBACK_LINE), props('fy_daemon_a')))).toContain(
    RELAY_FALLBACK_LINE,
  );
  expect(renderToStaticMarkup(createElement(view(RELAY_FALLBACK_LINE), props('fy_daemon_b')))).toBe('');
  expect(renderToStaticMarkup(createElement(view(undefined), props('fy_daemon_a')))).toBe('');
  expect(
    renderToStaticMarkup(
      createElement(
        relayFallbackView(() => undefined),
        props('fy_daemon_a'),
      ),
    ),
  ).toBe('');
});

const times = (tree: unknown): number => JSON.stringify(tree).split(RELAY_FALLBACK_LINE).length - 1;

test('on one screen the line is told ONCE: the card says it, the frame’s status line stays quiet, and returns when the card goes', () => {
  // The fallback's own choice carries the same sentence as its reason: the card must not draw it twice either.
  const choice = { ...chooseConnection([{ method: direct, reachable: true }]), reason: RELAY_FALLBACK_LINE };
  const router = { subscribe: () => () => undefined, relayFallback: () => RELAY_FALLBACK_LINE };
  const Watcher = relayFallbackView(() => router);
  const watcher = createElement(Watcher, { daemon: 'fy_daemon_a', client: {} as never });
  const card = createElement(ActiveCarrierCard, {
    choice,
    relayAdvertised: true,
    relayFallback: RELAY_FALLBACK_LINE,
    daemon: 'fy_daemon_a',
  });
  // Another screen (no card): the frame's line is the only telling.
  const alone = render(watcher);
  expect(times(alone.toJSON())).toBe(1);
  // The Connection screen: the card and the frame's line together say it once.
  const both = render(createElement('div', null, watcher, card));
  expect(times(both.toJSON())).toBe(1);
  // While that card is up, the frame's own line (a second mount) stays quiet; once the card goes, it speaks again.
  expect(times(alone.toJSON())).toBe(0);
  run(() => both.unmount());
  expect(times(alone.toJSON())).toBe(1);
  // The card of ANOTHER machine does not silence this machine's line.
  const other = render(
    createElement(
      'div',
      null,
      watcher,
      createElement(ActiveCarrierCard, {
        choice: chooseConnection([{ method: direct, reachable: true }]),
        relayAdvertised: true,
        daemon: 'fy_daemon_b',
      }),
    ),
  );
  expect(times(other.toJSON())).toBe(1);
  run(() => other.unmount());
  run(() => alone.unmount());
});

const memory = (seed: Record<string, string> = {}): CarrierPreferenceStorage => {
  const values = new Map(Object.entries(seed));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const paired = (id: string, machine: string): PairedDaemon => ({
  daemon: id,
  machine,
  deviceId: 'd',
  address: 'https://box.example',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
});

test('this device’s Connection panel lists every paired machine, each with its own setting, and needs no machine', () => {
  const list = { daemons: [paired('fy_daemon_a', 'studio'), paired('fy_daemon_b', 'laptop')], selected: null };
  const preferences = new CarrierPreferenceStore(
    memory({ [CARRIER_PREFERENCE_KEY]: JSON.stringify({ fy_daemon_b: 'relay' }) }),
  );
  const html = renderToStaticMarkup(
    createElement(DeviceConnectionPanel, {
      daemons: { snapshot: () => list, subscribe: () => () => undefined },
      preferences,
      webrtc: true,
    }),
  );
  expect(html).toContain('data-device-connection=""');
  expect(html).toContain('studio');
  expect(html).toContain('laptop');
  // studio is on the Default, laptop chose Relay only.
  expect(html.match(/data-carrier-preference="default"/gu)).toHaveLength(1);
  expect(html.match(/data-carrier-preference="relay"/gu)).toHaveLength(1);
});

test('with no machine paired the device panel draws nothing', () => {
  const html = renderToStaticMarkup(
    createElement(DeviceConnectionPanel, {
      daemons: { snapshot: () => ({ daemons: [], selected: null }), subscribe: () => () => undefined },
      preferences: new CarrierPreferenceStore(memory()),
      webrtc: false,
    }),
  );
  expect(html).toBe('');
});
