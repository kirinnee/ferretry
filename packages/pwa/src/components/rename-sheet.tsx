import type { IFyApiClient, SessionView } from '@ferretry/protocol';
import { AlertTriangle, LoaderCircle, Pencil } from 'lucide-react';
import { type FormEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { daemonApiClient } from '../lib/api-client.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../lib/daemon-scope.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';
import { Button } from '../shell/primitives.tsx';

export interface RenameSessionPatch {
  readonly name?: string;
  readonly teammate?: string;
  readonly clearParent?: boolean;
}

interface RenameFieldErrors {
  readonly title?: string;
  readonly teammate?: string;
  readonly form?: string;
}

type RenameClient = Pick<IFyApiClient, 'rename'>;
export type RenameClientFactory = (connection: DaemonConnection) => Promise<RenameClient>;

export interface RenameSheetProps {
  readonly connection: DaemonConnection;
  readonly view: SessionView;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRenamed?: (view: SessionView) => void;
  readonly createClient?: RenameClientFactory;
}

/** Builds the narrow daemon patch, normalising the two human-editable identifiers exactly once. */
export const renamePatch = (
  view: SessionView,
  title: string,
  teammate: string,
  detach: boolean,
): RenameSessionPatch => {
  const patch: { name?: string; teammate?: string; clearParent?: boolean } = {};
  const normalizedTitle = title.trim();
  const normalizedTeammate = teammate.trim().toLowerCase();
  if (normalizedTitle !== view.config.name.trim()) patch.name = normalizedTitle;
  if (normalizedTeammate !== (view.config.teammate ?? '').trim().toLowerCase()) patch.teammate = normalizedTeammate;
  if (view.config.parent && detach) patch.clearParent = true;
  return patch;
};

/** Places a daemon refusal beside the field it names; unknown failures stay at form level. */
export const renameErrorsFor = (error: unknown): RenameFieldErrors => {
  const message = error instanceof Error ? error.message : String(error);
  if (/teammate|callsign/i.test(message)) return { teammate: message };
  if (/\bname\b|title/i.test(message)) return { title: message };
  return { form: message };
};

/**
 * Edits one session through its explicit paired daemon. The sheet keeps no
 * daemon-global client or response cache: changing connections resets the form,
 * and a late response from the previous daemon is ignored by scope identity.
 */
export function RenameSheet({
  connection,
  view,
  open,
  onClose,
  onRenamed,
  createClient = daemonApiClient,
}: RenameSheetProps) {
  const { config } = view;
  const headingId = useId();
  const titleHelpId = useId();
  const teammateHelpId = useId();
  const [title, setTitle] = useState(config.name);
  const [teammate, setTeammate] = useState(config.teammate ?? '');
  const [detach, setDetach] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<RenameFieldErrors>({});
  const submitLock = useRef(false);
  const scopeKey = daemonSessionKey(daemonSessionScope(connection, config.id));
  const liveScope = useRef(scopeKey);
  liveScope.current = scopeKey;

  // Scope identity is the reset trigger. A colliding session id on another
  // daemon must never inherit edits, errors or an in-flight lock from this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger, see above
  useLayoutEffect(() => {
    if (!open) return;
    setTitle(config.name);
    setTeammate(config.teammate ?? '');
    setDetach(false);
    setSubmitting(false);
    setErrors({});
    submitLock.current = false;
  }, [open, connection.daemonId, config.id]);

  const patch = useMemo(() => renamePatch(view, title, teammate, detach), [detach, teammate, title, view]);
  const changed = Object.keys(patch).length > 0;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!changed || submitLock.current) return;
    if (!title.trim()) {
      setErrors({ title: 'Task title cannot be empty.' });
      return;
    }
    if (!teammate.trim()) {
      setErrors({ teammate: 'Callsign cannot be empty.' });
      return;
    }

    const submittedScope = scopeKey;
    submitLock.current = true;
    setSubmitting(true);
    setErrors({});
    try {
      const client = await createClient(connection);
      const renamed = await client.rename(config.id, patch.name, patch.teammate, patch.clearParent);
      if (liveScope.current !== submittedScope) return;
      onRenamed?.(renamed);
      onClose();
    } catch (error) {
      if (liveScope.current === submittedScope) setErrors(renameErrorsFor(error));
    } finally {
      if (liveScope.current === submittedScope) {
        submitLock.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <BottomSheet
      id={`rename-${config.id}`}
      open={open}
      onClose={submitting ? () => undefined : onClose}
      labelledBy={headingId}
      closeLabel="Close rename session"
      panelClassName="kt-details bg-surface"
      maxHeight="min(86dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y" data-daemon-id={connection.daemonId}>
        <div className="flex items-center gap-sm">
          <Pencil aria-hidden="true" className="text-accent" size={15} />
          <h1 id={headingId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Rename session
          </h1>
        </div>
        <p className="mt-1 text-ui leading-base text-muted">
          Change its task title, callsign, or place in the session tree.
        </p>
      </div>

      <form className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4" noValidate onSubmit={submit}>
        <div className="mx-auto grid w-full max-w-2xl gap-4 py-3">
          <label className="grid gap-1.5 text-ui text-fg" htmlFor={`${headingId}-task`}>
            <span className="font-semibold">Task title</span>
            <input
              id={`${headingId}-task`}
              aria-describedby={`${titleHelpId}${errors.title ? ` ${titleHelpId}-error` : ''}`}
              aria-invalid={errors.title ? true : undefined}
              className="kt-input !min-h-[44px] w-full"
              disabled={submitting}
              maxLength={120}
              onChange={event => {
                setTitle(event.target.value);
                setErrors(current => ({ ...current, title: undefined, form: undefined }));
              }}
              required
              value={title}
            />
            <span id={titleHelpId} className="text-meta leading-base text-muted">
              Convention: plain Title Case, up to 5 words.
            </span>
            {errors.title ? (
              <span id={`${titleHelpId}-error`} className="text-ui leading-base text-err" role="alert">
                {errors.title}
              </span>
            ) : null}
          </label>

          <label className="grid gap-1.5 text-ui text-fg" htmlFor={`${headingId}-teammate`}>
            <span className="font-semibold">Callsign</span>
            <input
              id={`${headingId}-teammate`}
              aria-describedby={`${teammateHelpId}${errors.teammate ? ` ${teammateHelpId}-error` : ''}`}
              aria-invalid={errors.teammate ? true : undefined}
              autoCapitalize="none"
              autoCorrect="off"
              className="kt-input !min-h-[44px] w-full mono"
              disabled={submitting}
              maxLength={32}
              onChange={event => {
                setTeammate(event.target.value.toLowerCase());
                setErrors(current => ({ ...current, teammate: undefined, form: undefined }));
              }}
              pattern="[a-z][a-z0-9-]*"
              required
              spellCheck={false}
              value={teammate}
            />
            <span id={teammateHelpId} className="text-meta leading-base text-muted">
              Lowercase letters, digits, and hyphens; must not clash with a live teammate.
            </span>
            {errors.teammate ? (
              <span id={`${teammateHelpId}-error`} className="text-ui leading-base text-err" role="alert">
                {errors.teammate}
              </span>
            ) : null}
          </label>

          {config.parent ? (
            <label className="flex min-h-[44px] items-start gap-sm rounded-control border border-border bg-surface-2 px-control-x py-2 text-ui text-fg">
              <input
                checked={detach}
                className="mt-0.5 h-4 w-4 shrink-0"
                disabled={submitting}
                onChange={event => setDetach(event.target.checked)}
                type="checkbox"
              />
              <span>
                <span className="block font-semibold">Detach from parent</span>
                <span className="mt-0.5 block text-meta leading-base text-muted">
                  Re-roots this session in the list; nothing else changes.
                </span>
              </span>
            </label>
          ) : null}

          {errors.form ? (
            <div
              className="flex items-start gap-sm rounded-control border border-err p-3 text-ui text-err"
              role="alert"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
              <span>{errors.form}</span>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
            <Button className="min-h-[44px]" disabled={submitting} onClick={onClose} type="button">
              Cancel
            </Button>
            <Button className="min-h-[44px]" disabled={!changed || submitting} type="submit" variant="primary">
              {submitting ? (
                <span className="inline-flex items-center gap-sm">
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={15} />
                  Saving changes…
                </span>
              ) : (
                'Save changes'
              )}
            </Button>
          </div>
        </div>
      </form>
    </BottomSheet>
  );
}
