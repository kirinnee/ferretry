/**
 * "USE THE BOARD": whether this project's ferrets keep cards (docs/board.md § The board is opt-in).
 *
 * Off, a ferret makes no card unless the owner asks for one or its lead hands it one, a start makes none, and the
 * turn-end check is silent. Only the owner throws it — this page is the owner's. The switch is Board's: it lives in
 * `state/board/boards/<project>.json` and is read and put through Board's routes by key. With Board off on this daemon
 * the routes are refused, which this states plainly instead of guessing a state.
 */

import { cn } from '@ferretry/app/ui';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type { ProjectsClient } from '../lib/client.ts';
import { reasonOf } from '../lib/client.ts';

/** The fields of Board's switch this view reads (`BoardSwitchSchema`, read here without importing Board's contract). */
const BoardSwitchSchema = z.looseObject({
  on: z.boolean(),
  setBy: z.enum(['default', 'owner']),
});
export type BoardSwitch = z.infer<typeof BoardSwitchSchema>;

export type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly state: BoardSwitch }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

const GET_SWITCH = 'GET /v1/board/projects/:projectId/switch';
const PUT_SWITCH = 'PUT /v1/board/projects/:projectId/switch';

/** Board off (or paused) on this daemon: its routes are not served, which says Board is off rather than a state. */
const isUnserved = (cause: unknown): boolean => {
  const status = (cause as { readonly status?: unknown } | null)?.status;
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return status === 404 || code === 'plugin_paused' || code === 'plugin_unavailable';
};

/** Who decided, in the owner's words. */
export const switchProvenance = (state: BoardSwitch): string =>
  state.setBy === 'owner' ? 'You set this.' : 'Off by default.';

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
        The board is off on this daemon, so there is no switch to set. Turn the Board plugin on to choose whether this
        project uses it.
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

/** The switch bound to one project on this daemon: reads it, and puts the owner's change. */
export function ProjectBoardSwitch({
  client,
  projectId,
}: {
  readonly client: ProjectsClient;
  readonly projectId: string;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded({ kind: 'loading' });
    void client
      .call(GET_SWITCH, { params: { projectId } })
      .then(answer => {
        if (current) setLoaded({ kind: 'read', state: BoardSwitchSchema.parse(answer) });
      })
      .catch((cause: unknown) => {
        if (current) setLoaded(isUnserved(cause) ? { kind: 'missing' } : { kind: 'failed', reason: reasonOf(cause) });
      });
    return () => {
      current = false;
    };
  }, [client, projectId]);

  const change = useCallback(
    async (on: boolean) => {
      setBusy(true);
      setRefusal(null);
      try {
        const state = BoardSwitchSchema.parse(await client.call(PUT_SWITCH, { params: { projectId }, body: { on } }));
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
