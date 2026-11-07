/**
 * The ferrets of one paired daemon, as the Warden page names them: read from Ferrets (`GET /v1/ferrets`) through the
 * Warden's own client of that daemon, and read again whenever Ferrets says the set or a state moved.
 *
 * Keyed by the daemon: changing daemon resets to `null` (not read), never to the other daemon's list, and an answer
 * that arrives after a switch is dropped. A read that fails leaves `null` — the page then names a ferret by the id the
 * Warden's own answer carries — and the next change of the set tries again.
 */

import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { useEffect, useState } from 'react';
import type { FerretView } from '../lib/callsign.ts';
import type { DaemonConnection } from '../lib/machine.ts';
import { useDaemonReach } from '../lib/warden-client-context.tsx';

/** What the Warden reads of one ferret: enough to name it. Ferrets owns the rest of the row. */
interface FerretRow {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly folder: string;
}

export const FERRETS_ROUTE = 'GET /v1/ferrets' as const;

const viewOf = (row: FerretRow): FerretView => ({
  config: { id: row.id, name: row.name, task: row.title ?? null, cwd: row.folder },
});

/** The ferrets of one daemon, or `null` while they are not read. */
export function useFerretsOf(connection: DaemonConnection): readonly FerretView[] | null {
  const reach = useDaemonReach();
  const daemonId = connection.daemonId;
  const [read, setRead] = useState<{ readonly daemonId: string; readonly ferrets: readonly FerretView[] } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the daemon's id; the connection object may be re-made
  useEffect(() => {
    let live = true;
    let unsubscribe = (): void => {};
    const load = async (): Promise<void> => {
      try {
        const client = await reach(connection);
        if (!live) return;
        const rows = await client.call<readonly FerretRow[]>(FERRETS_ROUTE);
        if (live) setRead({ daemonId, ferrets: rows.map(viewOf) });
      } catch {
        // Not read: the page names a ferret by the id the Warden's own answer carries.
      }
    };
    void reach(connection).then(
      client => {
        if (live) unsubscribe = client.subscribe(FerretsChanged, () => void load());
      },
      () => undefined,
    );
    void load();
    return () => {
      live = false;
      unsubscribe();
    };
  }, [daemonId, reach]);
  return read !== null && read.daemonId === daemonId ? read.ferrets : null;
}
