/**
 * "USE THE BOARD": whether this project's ferrets keep cards (docs/board.md § The board is opt-in).
 *
 * Off, a ferret makes no card unless the owner asks for one or its lead hands it one, a start makes none, and
 * the turn-end check is silent. Only the owner throws it — this page is the owner's — and a machine from
 * before the switch answers 404, which says the machine needs an update rather than guessing a state.
 */

import { type BoardSwitch, BoardSwitchSchema, type IFyApiClient } from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';

type SwitchClient = Pick<IFyApiClient, 'request'>;

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly state: BoardSwitch }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

const switchPath = (projectId: string): string => `/v1/board/projects/${encodeURIComponent(projectId)}/switch`;

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isMissingRoute = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { readonly status?: unknown }).status === 404;

/** Who decided, in the owner's words. */
export const switchProvenance = (state: BoardSwitch): string => {
  if (state.setBy === 'owner') return 'You set this.';
  if (state.setBy === 'migration')
    return state.on
      ? 'Switched on when the board became opt-in, because you sent a card back (Not good) in the last 14 days.'
      : 'Switched off when the board became opt-in. Turn it on to track work here.';
  return 'Off by default.';
};

/** The switch as drawn: pure, so every state can be shown and tested without a machine. */
export function BoardSwitchView({
  loaded,
  busy,
  refusal,
  onChange,
}: {
  readonly loaded: Loaded;
  readonly busy: boolean;
  readonly refusal: string | null;
  readonly onChange: (on: boolean) => void;
}) {
  if (loaded.kind === 'loading')
    return (
      <p className="m-0 text-meta text-muted" aria-busy="true" data-project-board-switch="loading">
        Reading whether this project uses the board…
      </p>
    );
  if (loaded.kind === 'missing')
    return (
      <p className="m-0 text-meta text-muted" role="status" data-project-board-switch="missing">
        This machine’s board has no on/off switch yet. Update it (fy daemon update) to choose whether this project uses
        the board.
      </p>
    );
  if (loaded.kind === 'failed')
    return (
      <p className="m-0 text-meta text-warn" role="status" data-project-board-switch="failed">
        Could not read whether this project uses the board: {loaded.reason}.
      </p>
    );
  const on = loaded.state.on;
  return (
    <div className="grid gap-xs" data-project-board-switch={on ? 'on' : 'off'}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={() => onChange(!on)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-control-x py-2 text-left hover:border-accent disabled:opacity-60"
      >
        <span className="min-w-0">
          <span className="block text-ui font-semibold text-fg">Use the board</span>
          <span className="mt-0.5 block text-meta leading-base text-muted">
            {on
              ? 'Ferrets here keep a card for their work, and are reminded when they forget.'
              : 'Ferrets here make no card unless you ask for one, or their lead hands them one.'}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full border transition-colors',
            on ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-fg transition-transform',
              on ? 'translate-x-[20px]' : 'translate-x-0.5',
            )}
          />
        </span>
      </button>
      <p className="m-0 text-2xs text-faint">{switchProvenance(loaded.state)}</p>
      {refusal !== null && (
        <p className="m-0 text-meta text-warn" role="alert">
          The switch did not change: {refusal}
        </p>
      )}
    </div>
  );
}

/** The switch bound to one project on one machine: reads it, and puts the owner's change. */
export function ProjectBoardSwitch({
  connection,
  projectId,
  createClient: injected,
}: {
  readonly connection: DaemonConnection;
  readonly projectId: string;
  readonly createClient?: (daemon: DaemonConnection) => Promise<SwitchClient>;
}) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const [client, setClient] = useState<SwitchClient | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setLoaded({ kind: 'loading' });
    void createClient(connection)
      .then(async next => {
        const state = await next.request(switchPath(projectId), BoardSwitchSchema);
        if (!current) return;
        setClient(next);
        setLoaded({ kind: 'read', state });
      })
      .catch((cause: unknown) => {
        if (current)
          setLoaded(isMissingRoute(cause) ? { kind: 'missing' } : { kind: 'failed', reason: reasonOf(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient, projectId]);

  const change = useCallback(
    async (on: boolean) => {
      if (client === null) return;
      setBusy(true);
      setRefusal(null);
      try {
        const state = await client.request(switchPath(projectId), BoardSwitchSchema, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ on }),
        });
        setLoaded({ kind: 'read', state });
      } catch (cause) {
        setRefusal(reasonOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, projectId],
  );

  return <BoardSwitchView loaded={loaded} busy={busy} refusal={refusal} onChange={on => void change(on)} />;
}
