import {
  type AgendaItem,
  type AgendaListRecord,
  type AgendaReadItem,
  isAgendaHeader,
} from '@ferretry/core-asks/contract';
import { useEffect, useState } from 'react';
import { fetchAgendaItem } from '../../lib/agenda-item-client.ts';
import type { DaemonConnection } from '../../shell.ts';
import type { DaemonSessionScope } from '../../shell.ts';
import { useAgendaCall } from '../../lib/agenda-client-context.tsx';

/** A list header never enters the document renderer. Closing or switching items fences an unfinished read. */
export const useAgendaItem = (
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  candidate: AgendaItem | AgendaListRecord | undefined,
) => {
  const agendaClient = useAgendaCall();
  const header = candidate !== undefined && isAgendaHeader(candidate) ? candidate : undefined;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([connection.daemonId, scope.sessionId, header?.id, header?.resolvedAt, attempt]);
  const [read, setRead] = useState<{ key: string; item?: AgendaReadItem; error?: string } | null>(null);
  const id = header?.id;
  useEffect(() => {
    if (id === undefined) return;
    let live = true;
    setRead(null);
    void fetchAgendaItem(connection, scope, id, agendaClient).then(
      item => {
        if (live) setRead({ key, item });
      },
      error => {
        if (live) setRead({ key, error: error instanceof Error ? error.message : 'Could not read this item.' });
      },
    );
    return () => {
      live = false;
    };
  }, [connection, scope, id, key, agendaClient]);
  const current = read?.key === key ? read : null;
  return {
    item: candidate === undefined || isAgendaHeader(candidate) ? current?.item : candidate,
    loading: header !== undefined && current === null,
    error: header === undefined ? undefined : current?.error,
    retry: () => setAttempt(value => value + 1),
  };
};
