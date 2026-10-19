/**
 * This machine's Pack mode (`GET /v1/pack`): the settings in effect, the models guide in effect and
 * every model the fleet knows — read once per machine and again whenever `pack.yaml`,
 * `models-guide.yaml` or a model catalog moves (the `pack` change kind).
 *
 * Writes go through the configuration-file routes against the etag just read, exactly as Voice cleanup
 * writes `voice.yaml`. An edit that LOOSENS what a ferret may do or spend — Pack on, Jev decides, a
 * limit or Jev's cap raised — is held by the daemon until the owner confirms it; the answer says so
 * rather than pretending it applied.
 */

import {
  type ConfigFileAddress,
  configFilePath,
  type GuideUseCase,
  PACK_PATH,
  type PackView,
  PackViewSchema,
} from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type PackConfigPatch, withModelsGuide, withPackConfig } from '../../lib/pack/pack-files.ts';
import { useConfigChangeCounter, useDaemonClient } from '../../lib/store.tsx';
import { readConfigFile, writeConfigFile } from '../config-files/config-files-api.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';

export type PackSave =
  | { readonly kind: 'applied' }
  | { readonly kind: 'pending'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

export type PackRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: PackView }
  | { readonly kind: 'failed'; readonly message: string };

export interface MachinePack {
  readonly read: PackRead;
  saveConfig(patch: PackConfigPatch): Promise<PackSave>;
  /** Write the whole guide; `null` removes `useCases`, which puts the built-in guide back. */
  saveGuide(useCases: readonly GuideUseCase[] | null): Promise<PackSave>;
}

const PACK_FILE: ConfigFileAddress = { kind: 'pack' };
const GUIDE_FILE: ConfigFileAddress = { kind: 'modelsGuide' };

export function useMachinePack(daemon: DaemonConnection | undefined): MachinePack {
  const createClient = useDaemonClient();
  const [state, setState] = useState<{ readonly daemonId: string; readonly read: PackRead } | null>(null);
  const [reread, setReread] = useState(0);
  const latest = useRef(daemon);
  latest.current = daemon;
  const daemonId = daemon?.daemonId;
  const moved = useConfigChangeCounter(daemonId ?? ('' as DaemonConnection['daemonId']), ['pack']);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `moved` and `reread` are the re-read triggers
  useEffect(() => {
    const target = latest.current;
    if (daemonId === undefined || target === undefined) return;
    let live = true;
    void createClient(target)
      .then(async client => await client.request(PACK_PATH, PackViewSchema))
      .then(
        (view): PackRead => ({ kind: 'ready', view }),
        (cause: unknown): PackRead => ({ kind: 'failed', message: changeRefusalSentence(cause) }),
      )
      .then(read => {
        if (live) setState({ daemonId, read });
      });
    return () => {
      live = false;
    };
  }, [createClient, daemonId, moved, reread]);

  const write = useCallback(
    async (address: ConfigFileAddress, edit: (text: string) => string | null): Promise<PackSave> => {
      const target = latest.current;
      if (target === undefined) return { kind: 'refused', message: 'No machine is selected.' };
      const path = configFilePath(address);
      try {
        const client = await createClient(target);
        const file = await readConfigFile(client, path);
        const text = edit(file.text);
        if (text === null) {
          return { kind: 'refused', message: `${path} has a problem; fix it in the Files panel first.` };
        }
        const written = await writeConfigFile(client, path, text, file.etag);
        // What is in effect is the daemon's to say, so the view is read again rather than guessed.
        setReread(count => count + 1);
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

  const saveConfig = useCallback(
    async (patch: PackConfigPatch) => await write(PACK_FILE, text => withPackConfig(text, patch)),
    [write],
  );
  const saveGuide = useCallback(
    async (useCases: readonly GuideUseCase[] | null) =>
      await write(GUIDE_FILE, text => withModelsGuide(text, useCases)),
    [write],
  );

  const read: PackRead =
    daemonId === undefined
      ? { kind: 'failed', message: 'No machine is selected.' }
      : state !== null && state.daemonId === daemonId
        ? state.read
        : { kind: 'loading' };
  return { read, saveConfig, saveGuide };
}
