/**
 * AGENDA MODE FOR ONE FERRET: the "Agenda mode" switch and the polite status line that says what the switch did
 * (docs/agenda.md). Today it was one row of the shell's ferret Actions menu; that registry is gone, and a plugin draws its
 * own control in the ferret's toolbar (`ferret.toolbar`, as Lessons draws "Passive lessons"), so this is that control.
 *
 * The switch decides only what the ferret is TOLD — whether it keeps an agenda the owner can see. Its instructions were
 * fixed when it started, so a change takes effect at its next launch and nothing is sent to it; the daemon's own `note`
 * says so, and the status line shows it.
 *
 * The state is Agenda's own (`GET /v1/ferrets/:ferretId/agenda-mode`), read when the switch is drawn. Once switched, the
 * answer the daemon gave is what the switch shows, so it never flips back under the reader.
 */

import { ListTodo, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { AgendaCall } from '../../lib/agenda-call.ts';
import { patchSessionAgenda, readSessionAgenda } from '../../lib/agenda-api.ts';

export interface AgendaSessionActions {
  /** The switch's status line; render it beside the page. */
  readonly host: ReactNode;
  /** Whether one ferret is told to keep an agenda; `undefined` until it was read. */
  readonly onFor: (ferret: string) => boolean | undefined;
  /** Reads one ferret's switch (once; an answer already given wins). */
  readonly read: (ferret: string) => Promise<void>;
  /** Switches one ferret; a refusal throws. */
  readonly toggle: (ferret: string, next: boolean) => Promise<void>;
  /**
   * Switches one ferret from a control with no place of its own to report in (a header mark): a refusal is said in
   * the same status line as the answer.
   */
  readonly tap: (ferret: string, next: boolean) => Promise<void>;
}

const refusalSentence = (reason: unknown): string =>
  `Agenda mode could not be switched: ${reason instanceof Error ? reason.message : String(reason)}`;

export function useAgendaSessionActions({ client }: { readonly client: AgendaCall }): AgendaSessionActions {
  const [note, setNote] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlyMap<string, boolean>>(new Map());

  const onFor = useCallback((ferret: string) => answered.get(ferret), [answered]);

  const read = useCallback(
    async (ferret: string) => {
      const mode = await readSessionAgenda(client, ferret);
      setAnswered(current => (current.has(ferret) ? current : new Map(current).set(ferret, mode.enabled)));
    },
    [client],
  );

  const toggle = useCallback(
    async (ferret: string, next: boolean) => {
      setNote(null);
      const result = await patchSessionAgenda(client, ferret, next);
      setAnswered(current => new Map(current).set(ferret, result.enabled));
      setNote(result.note);
    },
    [client],
  );

  const tap = useCallback(
    async (ferret: string, next: boolean) => {
      try {
        await toggle(ferret, next);
      } catch (reason) {
        setNote(refusalSentence(reason));
      }
    },
    [toggle],
  );

  const host =
    note === null ? null : (
      <div
        role="status"
        aria-live="polite"
        data-agenda-action-note=""
        className="fixed inset-x-4 top-[calc(env(safe-area-inset-top,0px)+3.5rem)] z-[55] mx-auto flex max-w-[480px] items-center gap-2 rounded-control border border-accent-border bg-surface px-3 py-1 text-ui text-fg shadow-popover"
      >
        <span className="min-w-0 flex-1">{note}</span>
        <button
          type="button"
          className="kt-btn h-11 w-11 shrink-0 p-0"
          aria-label="Dismiss"
          onClick={() => setNote(null)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    );

  return { host, onFor, read, toggle, tap };
}

/**
 * The "Agenda mode" switch for one ferret, for its toolbar. Nothing is offered to a reader who cannot control the
 * ferret; a refusal is handed to `onFailure` (the toolbar's own failure line), or said in the status line without one.
 */
export function AgendaModeSwitch({
  actions,
  ferret,
  canControl,
  onFailure,
}: {
  readonly actions: AgendaSessionActions;
  readonly ferret: string;
  readonly canControl: boolean;
  readonly onFailure?: (sentence: string) => void;
}) {
  const { read, onFor, toggle, tap } = actions;
  useEffect(() => {
    if (canControl) read(ferret).catch(() => undefined);
  }, [canControl, ferret, read]);
  if (!canControl) return null;
  const on = onFor(ferret);
  const known = on !== undefined;
  const flip = (next: boolean): void => {
    if (onFailure === undefined) {
      void tap(ferret, next);
      return;
    }
    toggle(ferret, next).catch((reason: unknown) => onFailure(refusalSentence(reason)));
  };
  return (
    <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-ui" data-session-action-item="agenda">
      <input
        type="checkbox"
        role="switch"
        aria-checked={on === true}
        checked={on === true}
        disabled={!known}
        onChange={event => flip(event.target.checked)}
      />
      <ListTodo size={15} aria-hidden="true" />
      Agenda mode
      <span className="text-meta text-muted">{known ? (on ? 'On' : 'Off') : ''}</span>
    </label>
  );
}
