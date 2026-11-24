/**
 * The browser entry for the Security settings block over FAKE data (no daemon): the REAL `SecuritySettingsBlock` inside a
 * scroll area like the shell's, so its sticky Save bar behaves as it does in Settings.
 *
 *   ?theme=<family>-<mode>
 */
import type { SecuritySettingsView } from '@ferretry/core-gate/contract';
import { createRoot } from 'react-dom/client';
import { SecuritySettingsBlock } from '../../../../app/features/settings/security-settings-block.tsx';
import type { SecuritySettingsClient } from '../../../../app/lib/security-settings-client.ts';
import { daemonConnection } from '../../../../app/shell-grants.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const connection = daemonConnection({
  daemonId: 'fy_daemon_scene',
  baseUrl: 'https://scene.example.test',
  deviceId: 'device-scene',
});

const view: SecuritySettingsView = {
  settings: {
    stepUpWindowMinutes: 15,
    deviceKeyRotationDays: 30,
    unlockOnOpen: true,
    unlockValidityHours: 8,
    stepUpOnActions: false,
    idleExpiryDays: 30,
  },
  source: 'document',
  mayWiden: false,
  widenCommand: 'fy daemon security set',
};

const client = { request: async () => view } as unknown as SecuritySettingsClient;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-scroll="" style={{ height: '100dvh', overflowY: 'auto' }} data-scene-ready="">
      <div className="mx-auto max-w-[720px] p-4">
        <SecuritySettingsBlock connection={connection} createClient={async () => client} />
      </div>
    </div>,
  );
