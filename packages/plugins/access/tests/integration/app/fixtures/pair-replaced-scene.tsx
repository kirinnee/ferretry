/** The real `/pair` page after a proved replacement, over a synthetic pairing; no daemon or code. */
import { createRoot } from 'react-dom/client';
import type { DaemonlessPorts } from '@ferretry/app';
import { pairPage } from '../../../../app/pair-page.tsx';
import { MemoryDeviceKeyStore, testDeviceKeyCrypto } from '../../../support/app/device-keys.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.style = params.get('style') ?? 'studio';
document.documentElement.dataset.motion = 'reduced';
const machine = {
  daemon: 'fy_daemon_synthetic',
  machine: 'workstation',
  deviceId: 'synthetic-device',
  address: 'https://workstation.example.test',
  pairedAt: 1,
  lastSelectedAt: 1,
};
const snapshot = { daemons: [machine], selected: machine.daemon };
const daemons = { snapshot: () => snapshot, subscribe: () => () => undefined };
const Page = pairPage(
  {
    crypto: testDeviceKeyCrypto,
    indexedDB: null,
    daemons,
    pair: async () => {
      throw new Error('this scene never pairs');
    },
  } as unknown as DaemonlessPorts,
  { store: new MemoryDeviceKeyStore(), scanHost: () => null },
);
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <Page
      params={{}}
      location={() => `${window.location.origin}/pair?replaced=fy_daemon_synthetic`}
      navigate={() => undefined}
      chooseDaemon={async () => undefined}
    />,
  );
