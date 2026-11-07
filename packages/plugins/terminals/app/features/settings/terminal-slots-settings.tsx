/**
 * SETTINGS › TERMINALS: who holds the machine's terminal slots, and one button to free the ones left
 * behind by ferrets that are done.
 *
 * Every terminal counts against one machine-wide limit, and a finished ferret's terminals used to
 * outlive it until the limit refused the next one. The daemon now closes them itself; this panel is the
 * owner's way to see where the slots are and to do it on the spot. Only terminals whose owner has
 * completed, stopped or been removed are ever closed — a running ferret's are never touched.
 */

import type { CloseFinishedTerminalsResponse, TerminalHolder, TerminalHoldersView } from '@ferretry/protocol';
import { CircleAlert, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Badge, Button } from '../../shell/primitives.tsx';
import { closeFinishedTerminals, readTerminalHolders, type TerminalSlotsClient } from './terminal-slots-api.ts';

export type TerminalSlotsClientFactory = (connection: DaemonConnection) => Promise<TerminalSlotsClient>;

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly view: TerminalHoldersView; readonly closed: number | null }
  | { readonly status: 'failed'; readonly reason: string };

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : '');
const terminals = (count: number): string => `${count} terminal${count === 1 ? '' : 's'}`;
const isFinished = (holder: TerminalHolder): boolean => holder.standing !== 'live';

export function TerminalSlotsSettings({
  connection,
  createClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: TerminalSlotsClientFactory;
}) {
  const [state, setState] = useState<{ readonly daemonId: string; readonly load: Load }>({
    daemonId: connection.daemonId,
    load: { status: 'loading' },
  });
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let current = true;
    setState({ daemonId: connection.daemonId, load: { status: 'loading' } });
    void createClient(connection)
      .then(async client => await readTerminalHolders(client))
      .then(view => {
        if (current) setState({ daemonId: connection.daemonId, load: { status: 'loaded', view, closed: null } });
      })
      .catch((cause: unknown) => {
        if (current) setState({ daemonId: connection.daemonId, load: { status: 'failed', reason: reasonOf(cause) } });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const closeFinished = useCallback(() => {
    const daemonId = connection.daemonId;
    setClosing(true);
    void createClient(connection)
      .then(async client => {
        const result: CloseFinishedTerminalsResponse = await closeFinishedTerminals(client);
        const view = await readTerminalHolders(client);
        return { result, view };
      })
      .then(({ result, view }) => setState({ daemonId, load: { status: 'loaded', view, closed: result.closed } }))
      .catch((cause: unknown) => setState({ daemonId, load: { status: 'failed', reason: reasonOf(cause) } }))
      .finally(() => setClosing(false));
  }, [connection, createClient]);

  const load: Load = state.daemonId === connection.daemonId ? state.load : { status: 'loading' };
  if (load.status === 'failed')
    return (
      <section
        className="kt-panel p-panel"
        role="alert"
        aria-label="Terminals unavailable"
        data-terminal-slots-failed=""
      >
        <h3 className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
          <CircleAlert size={16} aria-hidden="true" className="text-err" />
          The terminals could not be read
        </h3>
        <p className="mb-0 mt-1 text-cell leading-base text-muted">
          {load.reason === '' ? 'This machine did not say why.' : load.reason}
        </p>
      </section>
    );
  if (load.status === 'loading')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading the terminals">
        <p className="m-0 text-cell leading-base text-muted">Reading this machine’s terminals…</p>
      </section>
    );

  const { view } = load;
  const finished = view.holders.filter(isFinished);
  return (
    <section className="kt-panel p-panel" aria-labelledby="terminal-slots-heading" data-terminal-slots="">
      <div className="flex items-center gap-2">
        <SquareTerminal size={17} className="text-accent" aria-hidden="true" />
        <h3 id="terminal-slots-heading" className="m-0 text-row font-semibold text-fg">
          Terminals
        </h3>
      </div>
      <p className="mb-3 mt-1 text-cell leading-base text-muted" data-terminal-slots-summary="">
        {terminals(view.open)} open of {view.limit}.
        {finished.length === 0 ? '' : ' Some belong to ferrets that are done; closing them frees the slots.'}
      </p>
      {view.holders.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Who holds the terminals">
          {view.holders.map(holder => (
            <li
              key={holder.sessionId}
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-border-strong bg-surface-2 px-3 py-2 text-ui"
              data-terminal-holder={holder.sessionId}
            >
              <span className="min-w-0 break-words font-semibold text-fg">{holder.label}</span>
              <Badge tone={isFinished(holder) ? 'warn' : 'ok'}>{holder.status}</Badge>
              <span className="ml-auto text-meta text-muted">{terminals(holder.count)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          disabled={closing || finished.length === 0}
          onClick={closeFinished}
          data-terminal-slots-close=""
        >
          Close finished ferrets’ terminals
        </Button>
        {load.closed === null ? null : (
          <span role="status" className="text-cell text-muted" data-terminal-slots-closed="">
            Closed {terminals(load.closed)}.
          </span>
        )}
      </div>
    </section>
  );
}

/** The Settings tab, for the composition root's `daemonSettingsTabs`, bound to the app's client pool. */
export const terminalSlotsSettingsTab = (createClient: TerminalSlotsClientFactory) =>
  ({
    id: 'terminals',
    label: 'Terminals',
    description: 'Who holds the machine’s terminal slots, and closing the ones finished ferrets left behind.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <TerminalSlotsSettings connection={connection} createClient={createClient} />
    ),
  }) as const;
