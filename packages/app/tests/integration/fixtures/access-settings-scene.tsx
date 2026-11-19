/**
 * Settings › Devices / What devices may do / Security / Audit log, in the REAL Settings shell (real `App`, real nav, real
 * panel width) over ONE FAKE machine and a fake transport. Access's own app half is the real one; every answer below is fixed
 * fake data (a fake machine, fake devices, a fake pairing code), never a real home, login or code.
 *
 *   /d/ws/settings/access/<tab>      devices | grants | security | audit
 *   ?theme=<style>-<mode>            ?state=<variant>   (default | empty | refused | long)
 */

import { createRoot } from 'react-dom/client';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';
import {
  audit,
  grantsView,
  minted,
  pairedView,
  passkeys,
  security,
  stateOf,
  THIS_DEVICE,
} from './access-settings-data.ts';

const params = new URLSearchParams(window.location.search);
const state = stateOf(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const answer = (request: TransportRequest): TransportAnswer => {
  const path = request.path.split('?')[0];
  if (path === '/v1/plugins') return json(inventoryOf(surfaces));
  if (path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
  if (path === '/v1/grants') return json(grantsView);
  if (path === '/v1/pair/devices') return json(pairedView);
  if (path === '/v1/pair/code') return json(minted);
  if (path === '/v1/passkeys') return json(passkeys);
  if (path === '/v1/security') return json(security);
  if (path === '/v1/audit') {
    if (state === 'refused')
      return json({ error: { code: 'not-granted', message: 'pairing is off for devices' } }, 403);
    return json(audit);
  }
  return json({ ok: true });
};

const accessEntry = generated.surfaces.find(entry => entry.id === 'access');
if (accessEntry === undefined) throw new Error('the access plugin is not registered');
const gateEntry = generated.surfaces.find(entry => entry.id === 'gate');
if (gateEntry === undefined) throw new Error('the gate is not registered');
// The real gate and access: Settings › Security, Audit and What devices may do read the gate's own routes.
const surfaces = [...CORE.filter(entry => entry.id !== 'gate'), gateEntry, accessEntry];
const transport = new FakeTransport(answer);
const handler: PasskeyHandler = {
  need: () => undefined,
  confirm: async () => true,
  ask: async () => false,
  focus: () => undefined,
  locked: () => [],
  subscribe: () => () => undefined,
};
const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
list.add({ daemon: 'ws', machine: 'workshop-host', deviceId: THIS_DEVICE, address: 'http://127.0.0.1:40245' });
const runtime = new ShellRuntime({
  appVersion: '5.0.0',
  surfaces,
  daemons: list,
  connect: async () => transport,
  passkey: () => provision,
  daemonless: {
    views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
    location: () => window.location.href,
  },
});
const storage = memoryStore();
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={window}
      scroll={new ScrollMemory(null)}
    />,
  );
