/**
 * The browser entry for the full-page "cannot use this machine" screens over FAKE data (no daemon, no pairing code, no real
 * path): the REAL app shell over scripted transports, one per end state.
 *
 *   ?theme=<family>-<mode>   the mode, and the palette of the default look
 *   ?style=<style id>        another look (its own palette comes with it), so the page can be seen in every style
 *   ?state=refused       the machine closed the session with 4403 (a second machine is paired, so "Use another machine" shows)
 *   ?state=turned-away   the plugin list answered 403 with the machine's own reason
 *   ?state=no-key        the pairing is here but this browser can open no session for it
 *   ?state=unreadable    the plugin list could not be read through the carrier
 *   ?state=needs-update  the app is newer than the machine
 *   ?state=needs-reload  the machine is newer than the app
 *   ?state=not-paired    the address names a machine this browser holds no pairing for
 */
import { createRoot } from 'react-dom/client';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { RelaySessionError } from '../../../src/session/session-client.ts';
import { RELAY_CLOSE_CODES } from '../../../src/session/wire/index.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { StyleId } from '../../../src/theme/catalog.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const state = params.get('state') ?? 'refused';
const root = document.getElementById('root');

const transport = new FakeTransport(request => {
  const path = request.path.split('?')[0];
  if (state === 'refused') throw new RelaySessionError('unknown device credential', RELAY_CLOSE_CODES.authRejected);
  if (path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
  if (path !== '/v1/plugins') return json({ ok: true });
  if (state === 'turned-away')
    return json({ error: 'this device was removed by its owner', code: 'device_revoked' }, 403);
  if (state === 'unreadable')
    throw new RelaySessionError(
      'Relay only — there is no relay for this machine right now.',
      RELAY_CLOSE_CODES.daemonAbsent,
    );
  return json(inventoryOf(CORE, { gate: { contract: 'another' } }));
});

const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
if (state !== 'not-paired')
  list.add({ daemon: 'ws', machine: 'pebox', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
if (state === 'refused')
  list.add({ daemon: 'lap', machine: 'kirin-laptop', deviceId: 'dev2', address: 'http://127.0.0.1:40246' });
const runtime = new ShellRuntime({
  appVersion: state === 'needs-update' ? '5.1.0' : '5.0.0',
  surfaces: CORE,
  daemons: list,
  connect: async () => (state === 'no-key' ? undefined : transport),
});
window.history.replaceState({}, '', `${state === 'not-paired' ? '/d/nope' : '/d/ws'}${window.location.search}`);
const storage = memoryStore();
const themes = new ThemePreferenceStore(storage);
const style = params.get('style');
if (style !== null) themes.setStyle(style as StyleId);
themes.setMode(document.documentElement.dataset.theme?.endsWith('dark') ? 'dark' : 'light');
if (root !== null)
  createRoot(root).render(
    <App
      runtime={runtime}
      themes={themes}
      layouts={new DeviceLayoutStore(storage)}
      browser={window}
      scroll={new ScrollMemory(null)}
    />,
  );
