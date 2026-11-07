/**
 * This machine's Pack mode (`GET /v1/pack`): the settings in effect, the routing prompt in effect, every model the fleet
 * knows and the models usable now — read once per machine and again after every write.
 *
 * Writes go through the configuration-file routes against the digest just read, exactly as Voice cleanup writes
 * `voice.yaml` (`lib/pack-config.ts`). An edit that LOOSENS what a ferret may do or spend — Pack on, Jev decides, a limit or
 * Jev's cap raised — is held by the daemon until the owner confirms it; the answer says so rather than pretending it
 * applied. Clean up, its accept and its undo go through their own routes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type PackCleanUpJob,
  type PackCleanUpJobResult,
  type PackCleanUpRequest,
  type PackRoutingAcceptRequest,
  type PackRoutingWriteResult,
  type PackView,
  PackViewSchema,
} from '../../../contract/index.ts';
import { type PacksClient, refusalSentence } from '../../lib/client.ts';
import { type ConfigFiles, readPacksText, writePacksText } from '../../lib/pack-config.ts';
import { type PackConfigPatch, packFiles } from '../../lib/pack/pack-files.ts';
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
type CleanUpStart =
  | { readonly kind: 'started'; readonly job: PackCleanUpJob }
  | { readonly kind: 'refused'; readonly message: string };

/** Reading one clean-up run: its state (and rewrite), or why it could not be read. */
type CleanUpJobRead =
  | { readonly kind: 'read'; readonly result: PackCleanUpJobResult }
  | { readonly kind: 'failed'; readonly message: string };

/** An accept or an undo: what the daemon did, or why it did not. */
type RoutingWrite =
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

export function useMachinePack(client: PacksClient, configFiles: ConfigFiles): MachinePack {
  const [read, setRead] = useState<PackRead>({ kind: 'loading' });
  const [reread, setReread] = useState(0);
  const files = useRef(packFiles(configFiles.text));
  files.current = packFiles(configFiles.text);
  const store = useRef(configFiles);
  store.current = configFiles;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reread` is the re-read trigger
  useEffect(() => {
    let live = true;
    void client
      .call('GET /v1/pack')
      .then(
        (answer): PackRead => ({ kind: 'ready', view: PackViewSchema.parse(answer) }),
        (cause: unknown): PackRead => ({ kind: 'failed', message: refusalSentence(cause) }),
      )
      .then(next => {
        if (live) setRead(next);
      });
    return () => {
      live = false;
    };
  }, [client, reread]);

  const write = useCallback(
    async (edit: (text: string) => string | null): Promise<PackSave> => {
      try {
        const file = await readPacksText(store.current);
        const text = edit(file.text);
        if (text === null) return { kind: 'refused', message: 'packs.yaml has a problem; fix it in the Files panel first.' };
        const written = await writePacksText(store.current, text, file.etag);
        // What is in effect is the daemon's to say, so the view is read again rather than guessed.
        setReread(count => count + 1);
        return written.outcome === 'pending'
          ? {
              kind: 'pending',
              message: `Saved, but not in effect until you confirm it: ${(written.changes ?? []).join('; ')}.`,
            }
          : { kind: 'applied' };
      } catch (cause) {
        return { kind: 'refused', message: refusalSentence(cause) };
      }
    },
    [],
  );

  const saveConfig = useCallback(
    async (patch: PackConfigPatch) => await write(text => files.current.withPackConfig(text, patch)),
    [write],
  );
  const savePrompt = useCallback(
    async (prompt: string | null) => await write(text => files.current.withRoutingPrompt(text, prompt)),
    [write],
  );

  const cleanUp = useCallback(
    async (request: PackCleanUpRequest): Promise<CleanUpStart> => {
      try {
        const started = await startCleanUp(client, request);
        // A started run is shown on the view as `cleanUp.job`, so the view is read again.
        setReread(count => count + 1);
        return started.outcome === 'started'
          ? { kind: 'started', job: started.job }
          : { kind: 'refused', message: started.message };
      } catch (cause) {
        return { kind: 'refused', message: refusalSentence(cause) };
      }
    },
    [client],
  );
  const readJob = useCallback(
    async (jobId: string): Promise<CleanUpJobRead> => {
      try {
        return { kind: 'read', result: await readCleanUpJob(client, jobId) };
      } catch (cause) {
        return { kind: 'failed', message: refusalSentence(cause) };
      }
    },
    [client],
  );
  const routingWrite = useCallback(
    async (run: () => Promise<PackRoutingWriteResult>): Promise<RoutingWrite> => {
      try {
        const done = await run();
        setReread(count => count + 1);
        return { kind: done.outcome, message: done.message };
      } catch (cause) {
        return { kind: 'refused', message: refusalSentence(cause) };
      }
    },
    [],
  );
  const accept = useCallback(
    async (request: PackRoutingAcceptRequest) => await routingWrite(async () => await acceptRouting(client, request)),
    [client, routingWrite],
  );
  const undo = useCallback(async () => await routingWrite(async () => await undoRouting(client)), [client, routingWrite]);

  return { read, saveConfig, savePrompt, cleanUp, readJob, accept, undo };
}
