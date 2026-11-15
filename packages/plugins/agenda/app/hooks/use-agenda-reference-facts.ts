/**
 * THE FACTS AGENDA'S `!A3`, `:agent` AND `@file` PROOFS READ (`lib/agenda-references.ts`), for one machine: its fleet (the
 * half's own store, kept live by Ferrets' changes), its client, and Ferrets' `ferrets.file-open` narrowed — a missing hook,
 * a second provider or a value of another shape is no opener. A ferret's own page adds that ferret (`ferret`); the
 * machine-wide Inbox adds none, so it proves only `:agent`.
 */

import { FERRETS_FILE_OPEN_HOOK, isFerretsFileOpen } from '@ferretry/core-ferrets/contract';
import { useMemo, useSyncExternalStore } from 'react';
import type { AgendaFerretReferences, AgendaReferenceFacts } from '../lib/agenda-references.ts';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { useAppHook } from '../shell.ts';

export const useAgendaReferenceFacts = (
  runtime: AgendaRuntime,
  onNavigate: (to: string) => void,
  ferret?: AgendaFerretReferences,
): AgendaReferenceFacts => {
  const daemonId = runtime.connection.daemonId;
  const fleet = useSyncExternalStore(runtime.ferrets.subscribe, runtime.ferrets.getSnapshot).daemons.get(
    daemonId,
  )?.sessions;
  const provided = useAppHook(daemonId, FERRETS_FILE_OPEN_HOOK);
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
