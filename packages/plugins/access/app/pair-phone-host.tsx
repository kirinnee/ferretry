/**
 * "PAIR A PHONE" FROM THE COMMAND BAR (today's machine-menu entry and finder row) AND THE SHEET IT OPENS.
 *
 * The entry is Access's contribution to the bar (`shell.commands`), built per machine over Access's own client. It is
 * offered only when that machine's own device list says this caller may mint (`mayPairPhone`); a failed read offers
 * nothing — Settings › Devices is still there and explains whatever went wrong. Choosing it asks for the sheet; the
 * sheet is drawn where Access's other overlays are (the one mount the frame gives Access, beside the passkey prompt),
 * so it opens over whatever page the person is on.
 *
 * THE CODE NEVER PASSES THROUGH HERE: the request names a machine and nothing else; the minted code is the Add-a-device
 * surface's own state and dies when the sheet is closed.
 */
import type { PasskeyPorts, PluginCommandSource } from '@ferretry/app';
import { distinctDaemonName } from '@ferretry/app';
import { useCallback, useSyncExternalStore } from 'react';
import { connectionRecord, pairingClientOf } from './daemon-scope.tsx';
import { readPairedDevices } from './features/settings/add-device-api.ts';
import { mayPairPhone, PAIR_PHONE_DESCRIPTION, PairPhoneSheet } from './features/settings/pair-phone.tsx';
import { useLayoutMode } from './shell-pairing.ts';

/** Which machine's "Pair a phone" sheet is open, if any: a machine id, never a code. */
export class PairPhoneRequests {
  #open: string | null = null;
  readonly #listeners = new Set<() => void>();

  snapshot = (): string | null => this.#open;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  open(daemon: string): void {
    this.#set(daemon);
  }

  close(): void {
    this.#set(null);
  }

  #set(next: string | null): void {
    if (next === this.#open) return;
    this.#open = next;
    for (const listener of this.#listeners) listener();
  }
}

/** The one request line between the bar's entry and the sheet's mount. */
export const pairPhoneRequests = new PairPhoneRequests();

/** `shell.commands`: "Pair a phone with this machine", on a machine whose own device list lets this caller mint. */
export const pairPhoneCommands: PluginCommandSource = ({ client, daemon, changed }) => {
  let allowed = false;
  let asked = false;
  return () => {
    if (!asked) {
      asked = true;
      void readPairedDevices(pairingClientOf(client))
        .then(view => {
          allowed = mayPairPhone(view);
        })
        .catch(() => {
          allowed = false;
        })
        .then(changed);
    }
    return allowed
      ? [
          {
            id: `access-pair-phone-${daemon}`,
            group: 'Devices',
            label: 'Pair a phone with this machine',
            description: PAIR_PHONE_DESCRIPTION,
            keywords: ['pair', 'phone', 'device', 'qr', 'add'],
            run: () => pairPhoneRequests.open(daemon),
          },
        ]
      : [];
  };
};

/** The sheet, drawn once over the app by Access's overlay mount; closed when nothing asked for it. */
export function PairPhoneHost({ ports }: { readonly ports: Pick<PasskeyPorts, 'client' | 'daemons'> }) {
  const open = useSyncExternalStore(pairPhoneRequests.subscribe, pairPhoneRequests.snapshot);
  const snapshot = useSyncExternalStore(ports.daemons.subscribe, ports.daemons.snapshot, ports.daemons.snapshot);
  const phone = useLayoutMode() === 'drawer';
  const close = useCallback(() => pairPhoneRequests.close(), []);
  const paired = open === null ? undefined : snapshot.daemons.find(candidate => candidate.daemon === open);
  const client = open === null ? undefined : ports.client(open);
  if (paired === undefined || client === undefined) return null;
  return (
    <PairPhoneSheet
      connection={connectionRecord(paired)}
      machineName={distinctDaemonName(paired, snapshot.daemons)}
      open
      presentation={phone ? 'sheet' : 'dialog'}
      onClose={close}
      createClient={async () => pairingClientOf(client)}
    />
  );
}
