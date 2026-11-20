/**
 * SETTINGS › TERMINALS: who holds the machine's terminal slots, and one button to free the ones left
 * behind by ferrets that are done.
 *
 * Every terminal counts against one machine-wide limit, and a finished ferret's terminals used to
 * outlive it until the limit refused the next one. The daemon now closes them itself; this panel is the
 * owner's way to see where the slots are and to do it on the spot. Only terminals whose owner has
 * completed, stopped or been removed are ever closed — a running ferret's are never touched.
 */

import type { CloseFinishedTerminalsResponse, TerminalHolder, TerminalHoldersView } from '../../../contract/index.ts';
import { CircleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, SettingGroup } from '@ferretry/app';
import { ConfirmToSee, isStepUpRefusal, Loading } from '@ferretry/app/ui';
import type { DaemonConnection } from '../../shell.ts';
import { closeFinishedTerminals, readTerminalHolders, type TerminalSlotsClient } from './terminal-slots-api.ts';

export type TerminalSlotsClientFactory = (connection: DaemonConnection) => Promise<TerminalSlotsClient>;

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly view: TerminalHoldersView; readonly closed: number | null }
  | { readonly status: 'failed'; readonly reason: string }
  /** The read was refused for want of the passkey step-up (a cancelled prompt): offer to ask again. */
  | { readonly status: 'step-up' };

/** A schema failure's text is a JSON dump of issues ("[ { "code": "invalid_type" …"): never a sentence a person reads. */
const looksLikeParseDump = (text: string): boolean => /^\s*[[{]/.test(text) || /"code"\s*:\s*"/.test(text);
const UNREADABLE_ANSWER =
  'This machine answered in a form this app could not read. Try again; if it keeps happening, update this app and the machine to the same version.';
const reasonOf = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : '';
  return looksLikeParseDump(text) ? UNREADABLE_ANSWER : text;
};
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
  /** How many times the owner pressed "Confirm it's you to see this"; the read after a press is theirs. */
  const [reads, setReads] = useState(0);
  /** Bumped by "Try again": reads once more, as the quiet read it was (never the person's passkey press). */
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the "Try again" press: it re-runs this read
  useEffect(() => {
    let current = true;
    setState({ daemonId: connection.daemonId, load: { status: 'loading' } });
    void createClient(connection)
      .then(async client => await readTerminalHolders(client, reads > 0))
      .then(view => {
        if (current) setState({ daemonId: connection.daemonId, load: { status: 'loaded', view, closed: null } });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        const load: Load = isStepUpRefusal(cause)
          ? { status: 'step-up' }
          : { status: 'failed', reason: reasonOf(cause) };
        setState({ daemonId: connection.daemonId, load });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, reads, attempt]);

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
  if (load.status === 'step-up')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Terminals need your passkey">
        <div className="mt-2">
          <ConfirmToSee
            line="This machine wants your passkey before it shows its terminals."
            onConfirm={() => setReads(n => n + 1)}
          />
        </div>
      </section>
    );
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
        <p className="mb-0 mt-1 break-words text-cell leading-base text-muted">
          {load.reason === '' ? 'This machine did not say why.' : load.reason}
        </p>
        <div className="mt-3">
          <Button type="button" size="sm" onClick={() => setAttempt(n => n + 1)} data-terminal-slots-retry="">
            Try again
          </Button>
        </div>
      </section>
    );
  if (load.status === 'loading') return <Loading kind="page" label="Reading this machine’s terminals…" />;

  const { view } = load;
  const finished = view.holders.filter(isFinished);
  return (
    <section className="min-w-0" aria-label="Terminals" data-terminal-slots="">
      <p className="mb-8 mt-1 px-1 text-cell leading-base text-muted" data-terminal-slots-summary="">
        {terminals(view.open)} open of {view.limit}.
        {finished.length === 0 ? '' : ' Some belong to ferrets that are done; closing them frees the slots.'}
      </p>
      {view.holders.length === 0 ? null : (
        <SettingGroup label="Who holds the terminals">
          {/* The rows sit two to a line when the PANEL (not the window) has room: the `li` is the container, its list the grid. */}
          <li className="min-w-0 [container-type:inline-size]">
            <ul
              className={
                'm-0 grid min-w-0 list-none grid-cols-1 p-0 [&>li+li]:border-t [&>li+li]:border-border ' +
                '[@container(min-width:640px)]:grid-cols-2 [@container(min-width:640px)]:gap-x-8 ' +
                '[@container(min-width:640px)]:[&>li:nth-child(2)]:border-t-0'
              }
            >
              {view.holders.map(holder => (
                <li
                  key={holder.sessionId}
                  className="flex min-h-[52px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-panel pr-1 text-ui"
                  data-terminal-holder={holder.sessionId}
                >
                  <span className="min-w-0 break-words font-semibold text-fg">{holder.label}</span>
                  <Badge tone={isFinished(holder) ? 'warn' : 'ok'}>{holder.status}</Badge>
                  <span className="ml-auto text-meta text-muted">{terminals(holder.count)}</span>
                </li>
              ))}
            </ul>
          </li>
        </SettingGroup>
      )}
      <div className="flex flex-wrap items-center gap-3 px-1">
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
