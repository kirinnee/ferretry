/**
 * COMPACT MEMORY AT IN A FERRET'S ACTIONS MENU: one "Compact memory at…" row, contributed to the session action
 * registry, that opens {@link CompactAtForm} (docs/compact-at.md).
 *
 * The value is a launch setting, so a change reaches a running ferret at its next launch; the daemon's own `note`
 * says so and is shown in a toast. The form opens on what a launch would use now (the daemon's answer), so a ferret
 * that follows its login's default shows that default rather than a guess.
 */

import type { CompactAt, SessionCompactAt, SessionView } from '@ferretry/protocol';
import { describeCompactAt } from '@ferretry/protocol';
import { Gauge } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getSessionCompactAt, patchSessionCompactAt } from '../../lib/compact-at-api.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import { CompactAtForm } from './compact-at-form.tsx';
import type { SessionActionContribution, SessionActionFormHost } from './registry.ts';

/** What the entry needs to know about the ferret the menu is for. */
interface CompactAtActionContext {
  readonly view: SessionView;
  readonly canControl: boolean;
}

const COMPACT_AT_ACTION_ID = 'compact-at';

export interface CompactAtSessionActions {
  readonly contributions: readonly SessionActionContribution<CompactAtActionContext>[];
}

export function useCompactAtSessionActions({
  connection,
  fetcher,
}: {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
}): CompactAtSessionActions {
  const [answered, setAnswered] = useState<ReadonlyMap<string, CompactAt>>(new Map());

  const contributions = useMemo<readonly SessionActionContribution<CompactAtActionContext>[]>(
    () => [
      {
        group: 'tools',
        order: 110,
        build: context => {
          if (!context.canControl) return null;
          const own = answered.get(context.view.config.id) ?? context.view.config.compactAt;
          const sessionId = context.view.config.id;
          return {
            kind: 'form',
            id: COMPACT_AT_ACTION_ID,
            label: 'Compact memory at…',
            title: 'Compact memory at',
            icon: Gauge,
            detail: own === undefined ? 'Default' : describeCompactAt(own),
            render: host => (
              <CompactAtLoader
                connection={connection}
                fetcher={fetcher}
                host={host}
                own={own}
                onSaved={value => setAnswered(current => new Map(current).set(sessionId, value))}
                sessionId={sessionId}
              />
            ),
          };
        },
      },
    ],
    [answered, connection, fetcher],
  );

  return { contributions };
}

/** Reads what a launch would use now, then draws the form on it; if the read fails the form still works. */
function CompactAtLoader({
  connection,
  fetcher,
  host,
  own,
  onSaved,
  sessionId,
}: {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
  readonly host: SessionActionFormHost;
  readonly own: CompactAt | undefined;
  readonly onSaved: (value: CompactAt) => void;
  readonly sessionId: string;
}) {
  const [reading, setReading] = useState<SessionCompactAt | 'pending' | 'unavailable'>('pending');
  useEffect(() => {
    let live = true;
    getSessionCompactAt(connection, sessionId, fetcher).then(
      read => live && setReading(read),
      () => live && setReading('unavailable'),
    );
    return () => {
      live = false;
    };
  }, [connection, fetcher, sessionId]);

  if (reading === 'pending')
    return (
      <p className="fy-action-form__note" role="status">
        Reading the current setting…
      </p>
    );
  return (
    <CompactAtForm
      current={reading === 'unavailable' ? own : reading.own}
      following={reading === 'unavailable' ? 'auto' : reading.effective}
      host={host}
      save={async wanted => {
        const result = await patchSessionCompactAt(connection, sessionId, wanted, fetcher);
        onSaved(wanted);
        return { note: result.note };
      }}
      window={reading === 'unavailable' ? undefined : reading.window}
    />
  );
}
