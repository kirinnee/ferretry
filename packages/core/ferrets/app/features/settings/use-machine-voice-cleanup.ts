/**
 * This machine's dictation cleanup settings (`voice.yaml` › `postProcessing`), read once per machine and
 * again whenever the file moves, and written back through the configuration-file routes against the
 * etag just read. An edit that loosens what leaves the machine (turning on the conversation context)
 * is HELD by the daemon until the owner confirms it; the answer says so rather than pretending it applied.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useConfigChangeCounter, useDaemonClient } from '../../lib/store.tsx';
import {
  DEFAULT_VOICE_CLEANUP,
  readVoiceCleanup,
  type VoiceCleanup,
  type VoiceCleanupPatch,
  withVoiceCleanup,
} from '../../lib/stt/voice-cleanup.ts';
import { readConfigFile, writeConfigFile } from '../config-files/config-files-api.ts';
import { VOICE_FILE } from '../fleet/setup/voice-default.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';

export type VoiceCleanupSave =
  | { readonly kind: 'applied' }
  | { readonly kind: 'pending'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

export interface MachineVoiceCleanup {
  /** What the machine has, or the defaults while unread or unreadable. */
  readonly cleanup: VoiceCleanup;
  /** True once the file has been read for this machine. */
  readonly loaded: boolean;
  save(patch: VoiceCleanupPatch): Promise<VoiceCleanupSave>;
}

export function useMachineVoiceCleanup(daemon: DaemonConnection | undefined): MachineVoiceCleanup {
  const createClient = useDaemonClient();
  const [state, setState] = useState<{ readonly daemonId: string; readonly cleanup: VoiceCleanup | null } | null>(null);
  const latest = useRef(daemon);
  latest.current = daemon;
  const daemonId = daemon?.daemonId;
  const moved = useConfigChangeCounter(daemonId ?? ('' as DaemonConnection['daemonId']), ['voice']);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` is the re-read trigger
  useEffect(() => {
    const target = latest.current;
    if (daemonId === undefined || target === undefined) return;
    let live = true;
    void createClient(target)
      .then(async client => readVoiceCleanup((await readConfigFile(client, VOICE_FILE)).text))
      .catch(() => null)
      .then(found => {
        if (live) setState({ daemonId, cleanup: found });
      });
    return () => {
      live = false;
    };
  }, [createClient, daemonId, moved]);

  const save = useCallback(
    async (patch: VoiceCleanupPatch): Promise<VoiceCleanupSave> => {
      const target = latest.current;
      if (target === undefined) return { kind: 'refused', message: 'No machine is selected.' };
      try {
        const client = await createClient(target);
        const file = await readConfigFile(client, VOICE_FILE);
        const text = withVoiceCleanup(file.text, patch);
        if (text === null) {
          return { kind: 'refused', message: 'voice.yaml has a problem; fix it in the Files panel first.' };
        }
        const written = await writeConfigFile(client, VOICE_FILE, text, file.etag);
        setState({ daemonId: target.daemonId, cleanup: readVoiceCleanup(text) });
        return written.outcome === 'pending'
          ? {
              kind: 'pending',
              message: `Saved, but not in effect until you confirm it: ${(written.pending?.changes ?? []).join('; ')}.`,
            }
          : { kind: 'applied' };
      } catch (cause) {
        return { kind: 'refused', message: changeRefusalSentence(cause) };
      }
    },
    [createClient],
  );

  const current = state !== null && state.daemonId === daemonId ? state.cleanup : null;
  return { cleanup: current ?? DEFAULT_VOICE_CLEANUP, loaded: current !== null, save };
}
