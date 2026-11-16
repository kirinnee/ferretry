/**
 * THE FACTS AGENDA'S `!A3`, `:agent` AND `@file` PROOFS READ (`lib/agenda-references.ts`), for one machine: its fleet (the
 * half's own store, kept live by Ferrets' changes), its client, and Ferrets' `ferrets.file-open` narrowed — a missing hook,
 * a second provider or a value of another shape is no opener. A ferret's own page adds that ferret (`ferret`); the
 * machine-wide Inbox adds none, so it proves only `:agent`.
 */

import { FERRETS_FILE_OPEN_HOOK, FERRETS_PLUGIN, isFerretsFileOpen } from '@ferretry/core-ferrets/contract';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { type AgendaFerretReferences, type AgendaReferenceFacts, referenceFleetKey } from '../lib/agenda-references.ts';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import type { FerretView } from '../lib/ferret-view.ts';
import { useAppHook } from '../shell.ts';

/**
 * The fleet, with the identity it had until a fact the proof reads changes (`referenceFleetKey`). The sessions snapshot
 * changes identity on every fleet update, so facts built on it would rebuild every reader's surface on a working <->
 * idle tick, and each reader would re-run its proof.
 */
const useStableFleet = (
  fleet: readonly FerretView[] | null | undefined,
  ferretId: string | undefined,
): readonly FerretView[] | null | undefined => {
  const key = referenceFleetKey(fleet, ferretId);
  const [held, setHeld] = useState({ key, fleet });
  if (held.key === key) return held.fleet;
  setHeld({ key, fleet });
  return fleet;
};

export const useAgendaReferenceFacts = (
  runtime: AgendaRuntime,
  onNavigate: (to: string) => void,
  ferret?: AgendaFerretReferences,
): AgendaReferenceFacts => {
  const daemonId = runtime.connection.daemonId;
  const fleet = useStableFleet(
    useSyncExternalStore(runtime.ferrets.subscribe, runtime.ferrets.getSnapshot).daemons.get(daemonId)?.sessions,
    ferret?.id,
  );
  const provided = useAppHook(daemonId, FERRETS_FILE_OPEN_HOOK, FERRETS_PLUGIN);
  const fileOpen = isFerretsFileOpen(provided) ? provided : undefined;
  return useMemo(
    () => ({
      daemonId,
      fleet: fleet ?? null,
      client: runtime.client,
      fileOpen,
      onNavigate,
      ...(ferret === undefined ? {} : { ferret }),
    }),
    [daemonId, fleet, runtime.client, fileOpen, onNavigate, ferret],
  );
};
