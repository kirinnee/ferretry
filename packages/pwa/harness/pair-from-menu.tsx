/**
 * "Pair a phone" from the machine menu, on a page of its own (`?pair-from-menu`): the real sessions bar
 * (a column on a desktop, the open drawer on a phone) whose machine switcher opens the real pairing
 * sheet, answered locally, so the whole journey — menu, sheet, minted QR — is walkable without a daemon.
 *
 * A page rather than a gallery card because the menu, the drawer and the sheet are all fixed to the
 * viewport. Its own module rather than more lines in `main.tsx`: two units appending to the same object
 * is the conflict that file keeps teaching.
 *
 * THE CODE IS FAKE, AND IT HAS TO BE (`docs/pairing.md`). A committed PNG of a real minted code would be
 * a real credential in the repository. The client below never mints: the code, the ids and the
 * fingerprint are invented, the address is `example.test`, and the clock is frozen so the countdown
 * reads the same in every capture. These are the same frozen values the settings gallery uses.
 */

import {
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type PairedDevicesView,
  type PairingCodeMintResponse,
} from '@ferretry/protocol';
import { useState } from 'react';
import type { PairingClientFactory } from '../src/features/settings/add-device-settings.tsx';
import { PairPhoneSheet } from '../src/features/settings/pair-phone.tsx';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { useLayoutMode } from '../src/hooks/use-layout-mode.ts';
import { type DaemonId, daemonConnection } from '../src/lib/daemon-connection.ts';
import { SessionsBar } from '../src/shell/sessions-bar.tsx';

/** `?pair-from-menu` names this page. */
export const isPairFromMenuPage = (search: string): boolean => new URLSearchParams(search).has('pair-from-menu');

const MACHINE = 'studio';
const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
const DAEMON_ID = `fy_daemon_${'Hh'.repeat(21)}A`;
const CONNECTION = daemonConnection({
  daemonId: DAEMON_ID,
  baseUrl: 'https://workstation.example.test',
  deviceId: 'harness',
});

const INVITE: PairingCodeMintResponse = {
  pairingId: `fy_pair_${'Pp'.repeat(11)}`,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: '2026-01-01T00:01:34.000Z',
  daemonId: DAEMON_ID,
  daemonName: MACHINE,
  daemonUrl: 'https://workstation.example.test',
  pairUrl: `https://ferretry.pages.dev/pair#v1;url=${encodeURIComponent('https://workstation.example.test')};code=7F3K-Q2ND;fp=${encodeURIComponent(DAEMON_ID)}`,
  reach: 'any-device',
};

/** This browser holds fleet use and nothing else: the default a freshly paired device gets. */
const NOTHING = Object.fromEntries(
  DAEMON_CAPABILITIES.map(capability => [capability, { use: capability === 'fleet', configure: false }]),
) as CapabilityGrants;

const DEVICES: PairedDevicesView = {
  devices: [
    {
      id: `fy_device_id_${'Dd'.repeat(11)}`,
      name: 'This laptop',
      platform: 'browser',
      createdAt: '2025-12-20T18:22:00.000Z',
      lastSeenAt: '2025-12-31T22:04:00.000Z',
      idleExpiresAt: '2026-12-31T00:00:00.000Z',
      grants: NOTHING,
    },
  ],
  hostLocal: false,
  thisDeviceId: `fy_device_id_${'Dd'.repeat(11)}`,
  mayWiden: NOTHING,
};

/** Answers the two reads the surface makes, and "mints" the frozen fake. It never reaches a daemon. */
const PAIRING_CLIENT: PairingClientFactory = async () => ({
  request: (async (path: string) => {
    if (path === '/v1/pair/devices') return DEVICES;
    if (path === '/v1/pair/code') return INVITE;
    throw new Error('the harness changes nothing');
  }) as never,
});

const MACHINES = [
  { daemonId: DAEMON_ID as DaemonId, name: MACHINE },
  { daemonId: `fy_daemon_${'Ll'.repeat(21)}A` as DaemonId, name: 'laptop' },
];

export function PairFromMenuHarness() {
  useAppViewport();
  const phone = useLayoutMode() === 'drawer';
  const [open, setOpen] = useState(false);
  return (
    <div className={`kt-shell flex overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`} id="harness-pair-from-menu">
      <SessionsBar
        active={null}
        activeSessionId={null}
        daemonId={CONNECTION.daemonId}
        machineName={MACHINE}
        machines={MACHINES}
        onAddMachine={() => {}}
        onClose={() => {}}
        onCollapse={() => {}}
        onNavigate={() => {}}
        onOpenPalette={() => {}}
        onPairPhone={() => setOpen(true)}
        presentation={phone ? 'drawer' : 'column'}
        projects={[]}
        sessions={[]}
      />
      {phone ? null : <main className="min-h-0 flex-1 p-panel text-cell text-muted">The page goes here.</main>}
      <PairPhoneSheet
        connection={CONNECTION}
        createClient={PAIRING_CLIENT}
        machineName={MACHINE}
        now={() => NOW_MS}
        onClose={() => setOpen(false)}
        open={open}
        presentation={phone ? 'sheet' : 'dialog'}
      />
    </div>
  );
}
