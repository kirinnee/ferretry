/**
 * The machine's DEFAULT speech engine (`voice.yaml`'s `defaultEngine`): what New machine setup's Voice
 * step chooses, and what every device paired to the machine dictates with until that device picks its
 * own in Settings › Dictation. Transcription always runs on the device; the machine only names a default.
 *
 * The file is read and written as TEXT through the configuration-file routes, so the owner's comments
 * survive and the daemon validates what is written. Only the one top-level line is ever touched.
 */

import { type VoiceEngine, VoiceEngineSchema } from '@ferretry/protocol';
import { useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../../lib/store.tsx';
import { readConfigFile } from '../../config-files/config-files-api.ts';

export const VOICE_FILE = 'voice.yaml';

const DEFAULT_ENGINE_LINE = /^defaultEngine:[^\n]*$/mu;

/** The engine `voice.yaml` names, or `null` when it names none (or names one this app does not know). */
export const machineVoiceEngine = (text: string): VoiceEngine | null => {
  const value = /^defaultEngine:\s*["']?([\w-]+)["']?\s*(?:#.*)?$/mu.exec(text)?.[1];
  const parsed = VoiceEngineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** `voice.yaml` with its default engine set: the line replaced where it is, or added at the end. */
export const withMachineVoiceEngine = (text: string, engine: VoiceEngine): string => {
  const line = `defaultEngine: ${engine}`;
  if (DEFAULT_ENGINE_LINE.test(text)) return text.replace(DEFAULT_ENGINE_LINE, line);
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
};

/**
 * The machine default for one paired machine, read once per machine; `null` while unread, when the file
 * names none, or when it could not be read — a device then simply has no default, as before.
 */
export function useMachineVoiceEngine(daemon: DaemonConnection | undefined): VoiceEngine | null {
  const createClient = useDaemonClient();
  const [engine, setEngine] = useState<{ readonly daemonId: string; readonly engine: VoiceEngine | null } | null>(null);
  // Keyed by the machine's id, not the connection object, which can be re-created for the same machine.
  const latest = useRef(daemon);
  latest.current = daemon;
  const daemonId = daemon?.daemonId;
  useEffect(() => {
    const target = latest.current;
    if (daemonId === undefined || target === undefined) return;
    let live = true;
    void createClient(target)
      .then(async client => machineVoiceEngine((await readConfigFile(client, VOICE_FILE)).text))
      .catch(() => null)
      .then(found => {
        if (live) setEngine({ daemonId, engine: found });
      });
    return () => {
      live = false;
    };
  }, [createClient, daemonId]);
  return engine !== null && engine.daemonId === daemonId ? engine.engine : null;
}
