/**
 * Settings › This device › MUTE (v4's per-machine "shown" toggle, `onToggleShown`): one row per machine this browser
 * reaches, each with a Mute / Unmute that decides whether this browser shows anything from that machine. Which
 * machines a browser silences is the reader's notification filter, which is this half's store, so the control is this
 * half's own `device.settings` panel, drawn right after Access's Notifications panel (its enrol switches).
 *
 * A device panel is drawn once, under no shell and with no machine and no client (shell contract S4): the machines
 * come from `useEveryDaemon`, and each row flips only ITS machine's entry of the filter (`lib/machine-mute.ts`), the
 * same document the worker reads, so a mute here is the one the closed app honours. The panel reads no other plugin's
 * hook: a hook is read through a shell, which a device panel does not have.
 */

import { SettingGroup, SettingRow, useEveryDaemon } from '@ferretry/app';
import { useSyncExternalStore } from 'react';
import { type MachineMute, machineMute } from '../lib/machine-mute.ts';

function MuteButton({ mute, machine }: { readonly mute: MachineMute; readonly machine: string }) {
  const muted = useSyncExternalStore(mute.subscribe, mute.muted, mute.muted);
  return (
    <button
      type="button"
      className="min-h-0 shrink-0 text-meta text-muted underline"
      data-machine-mute=""
      aria-label={`${muted ? 'Unmute' : 'Mute'} ${machine}`}
      aria-pressed={muted}
      onClick={() => mute.setMuted(!muted)}
    >
      {muted ? 'Unmute' : 'Mute'}
    </button>
  );
}

/** `muteOf` builds a machine's mute; the filter store is this browser's one by default. */
export function NotificationMutePanel({
  muteOf = machineMute,
}: {
  readonly muteOf?: (daemon: string) => MachineMute;
} = {}) {
  const rows = useEveryDaemon();
  if (rows.length === 0) return null;
  return (
    <SettingGroup label="Mute">
      {rows.map(row => (
        <SettingRow
          key={row.daemon}
          name={row.machine}
          hint="Show nothing from this machine on this browser"
          dataAttributes={{ 'data-mute-machine': row.daemon }}
          control={() => <MuteButton mute={muteOf(row.daemon)} machine={row.machine} />}
        />
      ))}
    </SettingGroup>
  );
}
