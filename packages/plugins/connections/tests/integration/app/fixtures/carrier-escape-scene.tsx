/**
 * Two things on one fake machine: the Connection preference refusing to SAVE "Tunnel only" while the machine publishes no
 * tunnel (`?scene=select`), and the way out for a device already stuck on a carrier it cannot reach over
 * (`?scene=stuck`). Fake data throughout (a made-up machine); nothing here talks to a machine.
 */
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import { carrierEscapeView } from '../../../../app/features/carrier/carrier-escape.tsx';
import { CarrierPreferenceSelector } from '../../../../app/features/carrier/carrier-preference-selector.tsx';
import { CarrierPreferenceStore, settingOf } from '../../../../app/lib/carrier-preference.ts';
import { browserConnectionHealthEnvironment, DaemonConnectionHealth } from '../../../../app/lib/connection-health.ts';

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

/**
 * THE SHELL'S REAL SHAPE: the view is a device view, drawn with NO shell around it as `WithoutShell` draws it (the shell's own list of paired
 * machines answers nothing there), and the outage is the one the router reports on a COLD START with "Tunnel only" and no
 * tunnel known — zero legs dialled, so zero failures — through the real connection-health model.
 */
function Stuck() {
  const store = new CarrierPreferenceStore(
    memory({ 'fy-carrier-preference-v1': JSON.stringify({ [DAEMON]: 'tunnel' }) }),
  );
  (window as unknown as { __store: CarrierPreferenceStore }).__store = store;
  const health = new DaemonConnectionHealth(
    browserConnectionHealthEnvironment({
      now: Date.now,
      schedule: (run, delay) => {
        const handle = setTimeout(run, delay);
        return () => clearTimeout(handle);
      },
    }),
    () => new Promise(() => undefined),
  );
  health.outage(DAEMON, { failures: [], daemonAbsent: false, relaysNeverOpened: false });
  const held = {
    daemons: [
      {
        daemon: DAEMON,
        machine: 'Studio laptop',
        deviceId: 'device-1',
        address: 'http://127.0.0.1:1',
        carriers: [],
        pairedAt: 1,
        lastSelectedAt: 1,
      },
    ],
    selected: DAEMON,
  };
  const daemons = { snapshot: () => held, subscribe: () => () => undefined } as never;
  const Escape = carrierEscapeView(() => ({ preferences: store, health, daemons }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      {/* What the shell draws in place of a machine it cannot reach, and the strip above it where device views draw. */}
      <div data-slot="status">
        <Escape />
      </div>
      <p className="fy-shell-line" data-whole-daemon="">
        This device cannot reach this daemon yet.
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(params.get('scene') === 'stuck' ? <Stuck /> : <Select />);
