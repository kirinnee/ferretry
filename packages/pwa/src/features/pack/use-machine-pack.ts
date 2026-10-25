/**
 * This machine's Pack mode (`GET /v1/pack`): the settings in effect, the routing prompt in effect, every
 * model the fleet knows and the models usable now — read once per machine and again whenever `pack.yaml`,
 * `models-guide.yaml` or a model catalog moves (the `pack` change kind).
 *
 * Writes go through the configuration-file routes against the etag just read, exactly as Voice cleanup
 * writes `voice.yaml`. An edit that LOOSENS what a ferret may do or spend — Pack on, Jev decides, a
 * limit or Jev's cap raised — is held by the daemon until the owner confirms it; the answer says so
 * rather than pretending it applied. Clean up, its accept and its undo go through their own routes.
 */

import {
  type ConfigFileAddress,
  configFilePath,
  PACK_PATH,
  type PackCleanUpJob,
  type PackCleanUpJobResult,
  type PackCleanUpRequest,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  type PackView,
  PackViewSchema,
} from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { appVersion } from '../../lib/app-version.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type PackConfigPatch, withPackConfig, withRoutingPrompt } from '../../lib/pack/pack-files.ts';
import { invalidRequestWords } from '../../lib/request-refusal.ts';
import { useConfigChangeCounter, useDaemonClient } from '../../lib/store.tsx';
import { readConfigFile, writeConfigFile } from '../config-files/config-files-api.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { acceptRouting, readCleanUpJob, startCleanUp, undoRouting } from './routing-api.ts';

export type PackSave =
  | { readonly kind: 'applied' }
  | { readonly kind: 'pending'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

export type PackRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: PackView }
  | { readonly kind: 'failed'; readonly message: string };

/** Starting Clean up: a run that began, or why none did. */
export type CleanUpStart =
  | { readonly kind: 'started'; readonly job: PackCleanUpJob }
  | { readonly kind: 'refused'; readonly message: string; readonly details?: string };

/** Reading one clean-up run: its state (and rewrite), or why it could not be read. */
export type CleanUpJobRead =
  | { readonly kind: 'read'; readonly result: PackCleanUpJobResult }
  | { readonly kind: 'failed'; readonly message: string };

/** An accept or an undo: what the daemon did, or why it did not. */
export type RoutingWrite =
  | { readonly kind: PackRoutingWriteResult['outcome']; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

export interface MachinePack {
  readonly read: PackRead;
  saveConfig(patch: PackConfigPatch): Promise<PackSave>;
  /** Write the owner's routing prompt; `null` (or blank words) removes it so the default applies. */
  savePrompt(prompt: string | null): Promise<PackSave>;
  /** Start a clean-up ferret. Spends one model run, so only a person's press calls it. */
  cleanUp(request: PackCleanUpRequest): Promise<CleanUpStart>;
  /** One clean-up run and its rewrite; read only while a person watches it. */
  readJob(jobId: string): Promise<CleanUpJobRead>;
  accept(request: PackRoutingAcceptRequest): Promise<RoutingWrite>;
  undo(): Promise<RoutingWrite>;
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
  const savePrompt = useCallback(
    async (prompt: string | null) => await write(GUIDE_FILE, text => withRoutingPrompt(text, prompt)),
    [write],
  );

  const withClient = useCallback(
    async <T>(run: (client: Awaited<ReturnType<typeof createClient>>) => Promise<T>): Promise<T> => {
      const target = latest.current;
      if (target === undefined) throw new Error('No machine is selected.');
      return await run(await createClient(target));
    },
    [createClient],
  );

  const cleanUp = useCallback(
    async (request: PackCleanUpRequest): Promise<CleanUpStart> => {
      try {
        const started = await withClient(async client => await startCleanUp(client, request));
        // A started run is shown on the view as `cleanUp.job`, so the view is read again.
        setReread(count => count + 1);
        return started.outcome === 'started'
          ? { kind: 'started', job: started.job }
          : { kind: 'refused', message: started.message };
      } catch (cause) {
        // A 400 for a field the machine's version does not take reads as words, with its own text behind Details.
        const words = invalidRequestWords(cause, appVersion());
        if (words !== undefined) {
          return {
            kind: 'refused',
            message: words.sentence,
            ...(words.details === undefined ? {} : { details: words.details }),
          };
        }
        return { kind: 'refused', message: changeRefusalSentence(cause) };
      }
    },
    [withClient],
  );
  const readJob = useCallback(
    async (jobId: string): Promise<CleanUpJobRead> => {
      try {
        return { kind: 'read', result: await withClient(async client => await readCleanUpJob(client, jobId)) };
      } catch (cause) {
        return { kind: 'failed', message: changeRefusalSentence(cause) };
      }
    },
    [withClient],
  );
  const routingWrite = useCallback(
    async (
      run: (client: Awaited<ReturnType<typeof createClient>>) => Promise<PackRoutingWriteResult>,
    ): Promise<RoutingWrite> => {
      try {
        const done = await withClient(run);
        setReread(count => count + 1);
        return { kind: done.outcome, message: done.message };
      } catch (cause) {
        return { kind: 'refused', message: changeRefusalSentence(cause) };
      }
    },
    [withClient],
  );
  const accept = useCallback(
    async (request: PackRoutingAcceptRequest) =>
      await routingWrite(async client => await acceptRouting(client, request)),
    [routingWrite],
  );
  const undo = useCallback(async () => await routingWrite(async client => await undoRouting(client)), [routingWrite]);

  const read: PackRead =
    daemonId === undefined
      ? { kind: 'failed', message: 'No machine is selected.' }
      : state !== null && state.daemonId === daemonId
        ? state.read
        : { kind: 'loading' };
  return { read, saveConfig, savePrompt, cleanUp, readJob, accept, undo };
}
