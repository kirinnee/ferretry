/**
 * "Turn on" for a machine's tunnel, through the REAL path a held answer takes: a client that answers as the shell's does
 * (`call` is the body alone, `callWithStatus` keeps the status), the real `IntroducerRegistry` that rebuilds the answer as
 * a response, the real `TunnelSwitchStore` that reads it, and the real selector. The daemon is a fake HTTP server at
 * `/daemon` (made-up machine, fake data) that holds the switch, answering `202 { held, view }` as the real one does.
 */
import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createRoot } from 'react-dom/client';
import { useEffect, useSyncExternalStore } from 'react';
import {
  CarrierPreferenceSelector,
  tunnelSwitchOffer,
} from '../../../../app/features/carrier/carrier-preference-selector.tsx';
import { IntroducerRegistry } from '../../../../app/lib/introducers.ts';
import { TunnelSwitchStore } from '../../../../app/lib/tunnel-switch.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-dark';

const DAEMON = 'd1';

async function ask(route: string, init?: { readonly body?: unknown }) {
  const [method, path] = route.split(' ') as [string, string];
  const response = await fetch(`/daemon${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json()) as { error?: string; code?: string };
  if (response.status >= 400) throw new DaemonCallError(response.status, body.code ?? 'error', body.error ?? 'refused');
  return { status: response.status, body };
}

const client = {
  call: async (route: string, init?: { readonly body?: unknown }) => (await ask(route, init)).body,
  callWithStatus: ask,
} as unknown as PluginClient;

const registry = new IntroducerRegistry();
registry.attach(DAEMON, client);
const store = new TunnelSwitchStore({
  control: async (daemon, url, init) => {
    const request = registry.request(daemon.daemonId);
    if (request === undefined) throw new Error('no client holds this machine yet');
    return await request(url, init);
  },
});

function Scene() {
  const states = useSyncExternalStore(store.subscribe.bind(store), store.snapshot);
  useEffect(() => {
    void store.refresh({ daemonId: DAEMON });
  }, []);
  return (
    <main style={{ padding: 16 }}>
      <CarrierPreferenceSelector
        legend="Connection preference"
        value="auto"
        onChange={() => undefined}
        availability={{
          webrtc: true,
          tunnel: tunnelSwitchOffer(
            states[DAEMON],
            () => store.set({ daemonId: DAEMON }, true),
            () => store.refresh({ daemonId: DAEMON }),
          ),
        }}
      />
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
