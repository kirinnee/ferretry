/**
 * ONE MACHINE'S MUTE, drawn on its row: this browser shows nothing from the machine while it is muted. Which machines
 * a browser silences is the reader's notification filter, which Agenda keeps and provides through the
 * `access.machine-mute` hook (`contract/app-hooks.ts`); with no provider there is nothing to draw.
 */
import { useAppHook } from '@ferretry/app';
import { useSyncExternalStore } from 'react';
import { type AccessMachineMute, ACCESS_MACHINE_MUTE_HOOK, isAccessMachineMute } from '../../../contract/index.ts';

function MuteButton({ mute }: { readonly mute: AccessMachineMute }) {
  const muted = useSyncExternalStore(mute.subscribe, mute.muted, mute.muted);
  return (
    <button
      type="button"
      className="min-h-0 shrink-0 text-meta text-muted underline"
      data-machine-mute=""
      aria-pressed={muted}
      onClick={() => mute.setMuted(!muted)}
    >
      {muted ? 'Unmute' : 'Mute'}
    </button>
  );
}

/** The Mute of the machine `daemon`, or nothing when no half provides one there. */
export function MachineMute({ daemon }: { readonly daemon: string }) {
  const provided = useAppHook(daemon, ACCESS_MACHINE_MUTE_HOOK);
  return isAccessMachineMute(provided) ? <MuteButton mute={provided} /> : null;
}
