/**
 * Two things on one fake machine: the Connection preference refusing to SAVE "Tunnel only" while the machine publishes no
 * tunnel (`?scene=select`), and the way out for a device already stuck on a carrier it cannot reach over
 * (`?scene=stuck`). Fake data throughout (a made-up machine); nothing here talks to a machine.
 */
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import { CarrierEscapeLines } from '../../../../app/features/carrier/carrier-escape.tsx';
import { CarrierPreferenceSelector } from '../../../../app/features/carrier/carrier-preference-selector.tsx';
import { CarrierPreferenceStore, settingOf } from '../../../../app/lib/carrier-preference.ts';
import type { ConnectionHealthState } from '../../../../app/lib/connection-health.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-dark';
const DAEMON = 'd1';

const memory = (seed: Record<string, string>) => ({
  getItem: (key: string) => seed[key] ?? null,
  setItem: (key: string, value: string) => {
    seed[key] = value;
  },
});

function Select() {
  const store = new CarrierPreferenceStore();
  (window as unknown as { __store: CarrierPreferenceStore }).__store = store;
  return <SelectBody store={store} />;
}

function SelectBody({ store }: { readonly store: CarrierPreferenceStore }) {
  const chosen = useSyncExternalStore(listener => store.subscribe(() => listener()), store.snapshot, store.snapshot);
  return (
    <main style={{ padding: 16 }}>
      <CarrierPreferenceSelector
        legend="Connection preference"
        value={settingOf(chosen[DAEMON])}
        onChange={value => (value === 'default' ? store.reset(DAEMON) : store.set(DAEMON, value))}
        availability={{ webrtc: true, tunnelPublished: false, tunnelNote: 'This machine has no tunnel yet.' }}
      />
    </main>
  );
}

const reconnecting: ConnectionHealthState = {
  kind: 'reconnecting',
  since: 0,
  attempt: 3,
  nextAttemptAt: null,
  failures: [],
  cause: 'daemon-unreachable',
  stalled: true,
};

function Stuck() {
  const store = new CarrierPreferenceStore(
    memory({ 'fy-carrier-preference-v1': JSON.stringify({ [DAEMON]: 'tunnel' }) }),
  );
  (window as unknown as { __store: CarrierPreferenceStore }).__store = store;
  const daemon = {
    daemon: DAEMON,
    machine: 'Studio laptop',
    deviceId: 'device-1',
    address: 'http://127.0.0.1:1',
    carriers: [],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      {/* What the shell draws in place of a machine it cannot reach, and the strip above it where device views draw. */}
      <div data-slot="status">
        <CarrierEscapeLines
          daemons={[daemon]}
          ports={{ preferences: store, health: { state: () => reconnecting, subscribe: () => () => undefined } }}
        />
      </div>
      <p className="fy-shell-line" data-whole-daemon="">
        This device cannot reach this daemon yet.
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(params.get('scene') === 'stuck' ? <Stuck /> : <Select />);
