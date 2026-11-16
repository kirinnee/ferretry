/**
 * SETTINGS › LEARNING, on one machine: whether NEW ferrets are instructed to learn, and each current
 * ferret's own switch.
 *
 * The machine default is `lessons.yaml`'s `passiveDefault`, written by the daemon through the kernel's config
 * writer; the switch shows the settings in effect afterwards, what waits for the owner when the write was held, and any
 * refusal (a save while another edit of `lessons.yaml` waits for the owner is refused, and says so). It only decides what a new ferret's fixed instructions say; a running ferret is switched on its own,
 * which re-instructs it.
 */

import type { LessonsConfig, LessonsFerret } from '../../contract/index.ts';
import { useEffect, useId, useMemo, useState } from 'react';
import { cn } from '@ferretry/app/ui';
import type { LessonsConnection } from './api.ts';
import { fetchLessonsConfig, lessonsErrorMessage, patchLessonsConfig } from './api.ts';
import { Badge, Button } from '@ferretry/app/ui';
import { basename, sessionName } from './model.ts';
import { usePassiveLessons } from './passive.tsx';
import { GlobalLessonsEditor } from './global-lessons.tsx';

export interface LessonsSettingsSurfaceProps {
  readonly connection: LessonsConnection;
  /** This machine's ferrets, to name the rows; ids are shown when absent. */
  readonly ferrets?: readonly LessonsFerret[] | null;
}

export function LessonsSettingsSurface({ connection, ferrets = null }: LessonsSettingsSurfaceProps) {
  const [config, setConfig] = useState<LessonsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [held, setHeld] = useState<readonly string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const lessons = usePassiveLessons(connection);
  const defaultTitle = useId();
  const ferretsTitle = useId();
  const byId = useMemo(() => new Map((ferrets ?? []).map(view => [view.ferretId, view])), [ferrets]);

  // The default is read when the tab opens.
  useEffect(() => {
    let current = true;
    fetchLessonsConfig(connection).then(
      next => {
        if (current) setConfig(next);
      },
      (reason: unknown) => {
        if (current) setError(lessonsErrorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [connection]);

  const toggleDefault = async (passiveDefault: boolean) => {
    setSaving(true);
    setError(null);
    setHeld([]);
    try {
      const { held: waiting = [], ...inEffect } = await patchLessonsConfig(connection, { passiveDefault });
      setConfig(inEffect);
      setHeld(waiting);
    } catch (reason) {
      setError(lessonsErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const toggleFerret = async (ferretId: string, passive: boolean) => {
    setSwitching(ferretId);
    setNote(null);
    try {
      setNote((await lessons.set(ferretId, passive)).note);
    } catch (reason) {
      setNote(lessonsErrorMessage(reason));
    } finally {
      setSwitching(null);
    }
  };

  const on = config?.passiveDefault === true;
  const rows = lessons.records ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-lessons-settings="">
      <section className="kt-panel flex flex-col gap-2 p-4" aria-labelledby={defaultTitle}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 id={defaultTitle} className="m-0 text-ui font-semibold">
              Passive lessons for new ferrets
            </h3>
            <p className="m-0 mt-1 text-meta leading-base text-muted">
              Only controls whether new ferrets are INSTRUCTED to learn: their fixed instructions include{' '}
              <span className="mono">fy lesson suggest "…" --scope global|repo</span>. The ferret picks Global or Repo;
              you can change it in the Lessons hub.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby={defaultTitle}
            disabled={config === null || saving}
            onClick={() => void toggleDefault(!on)}
            className={cn(
              'flex min-h-[44px] shrink-0 items-center gap-2 rounded-control border px-3 text-ui font-semibold disabled:opacity-60',
              on ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-muted',
            )}
          >
            <span
              aria-hidden="true"
              className={cn('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-surface-3')}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-[left]',
                  on ? 'left-[18px]' : 'left-0.5',
                )}
              />
            </span>
            {config === null ? '…' : on ? 'On' : 'Off'}
          </button>
        </div>
        <p className="m-0 text-meta text-faint">
          Change a running ferret from its Actions › Passive lessons, which re-instructs it.
        </p>
        {held.map(sentence => (
          <p key={sentence} role="status" className="m-0 text-meta text-warn" data-lessons-held="">
            Waiting for your approval: {sentence}
          </p>
        ))}
        {error !== null && (
          <p role="alert" className="m-0 text-meta text-err">
            {error}
          </p>
        )}
      </section>
      <section className="kt-panel flex flex-col gap-2 p-4" aria-labelledby={ferretsTitle}>
        <h3 id={ferretsTitle} className="m-0 text-ui font-semibold">
          Ferrets right now
        </h3>
        {note !== null && (
          <p role="status" className="m-0 rounded-control bg-surface-2 px-3 py-2 text-meta text-fg-soft">
            {note}
          </p>
        )}
        {lessons.records === null ? (
          <p className="m-0 text-meta text-muted">Reading which ferrets learn…</p>
        ) : rows.length === 0 ? (
          <p className="m-0 text-meta text-muted">No ferrets on this machine yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map(entry => {
              const cwd = byId.get(entry.ferretId)?.folder;
              return (
                <li
                  key={entry.ferretId}
                  className="flex min-h-[44px] flex-wrap items-center gap-2 border-b border-border-soft py-1 last:border-b-0"
                  data-lessons-ferret={entry.ferretId}
                >
                  <span className="min-w-0 flex-1 truncate text-ui">
                    {sessionName(entry.ferretId, byId)}
                    {cwd === undefined ? null : <span className="ml-2 text-meta text-faint">{basename(cwd)}</span>}
                  </span>
                  <Badge tone={entry.passive ? 'ok' : 'pend'}>{entry.passive ? 'On' : 'Off'}</Badge>
                  <Button
                    size="sm"
                    className="min-h-[44px]"
                    disabled={switching !== null}
                    onClick={() => void toggleFerret(entry.ferretId, !entry.passive)}
                  >
                    {entry.passive ? 'Turn off' : 'Turn on'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <GlobalLessonsEditor connection={connection} />
    </div>
  );
}
