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
import { useEffect, useMemo, useState } from 'react';
import { SettingGroup, SettingRow } from '@ferretry/app';
import { cn } from '@ferretry/app/ui';
import type { LessonsConnection } from './api.ts';
import { fetchLessonsConfig, lessonsErrorMessage, patchLessonsConfig } from './api.ts';
import { Badge, Button, Loading } from '@ferretry/app/ui';
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
    <div className="flex min-w-0 flex-col" data-lessons-settings="">
      <SettingGroup label="New ferrets">
        <SettingRow
          name="Passive lessons for new ferrets"
          hint="Only controls whether new ferrets are INSTRUCTED to learn."
          explanation={
            <>
              Their fixed instructions include <span className="mono">fy lesson suggest "…" --scope global|repo</span>.
              The ferret picks Global or Repo; you can change it in the Lessons hub. Change a running ferret from its
              Actions › Passive lessons, which re-instructs it.
            </>
          }
          control={labelId => (
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-labelledby={labelId}
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
          )}
        >
          {held.length === 0 && error === null ? null : (
            <div className="flex flex-col gap-1 pb-3 pl-panel pr-1">
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
            </div>
          )}
        </SettingRow>
      </SettingGroup>
      <SettingGroup label="Ferrets right now">
        {note === null ? null : (
          <li className="py-2 pl-panel pr-1">
            <p role="status" className="m-0 rounded-control bg-surface-2 px-3 py-2 text-meta text-fg-soft">
              {note}
            </p>
          </li>
        )}
        {lessons.records === null ? (
          <li className="py-3 pl-panel pr-1">
            {lessons.unavailable ? (
              <p className="m-0 text-meta text-muted" data-lessons-ferrets-unavailable="">
                Which ferrets learn isn’t available on this machine.
              </p>
            ) : (
              <Loading kind="bar" label="Reading which ferrets learn…" />
            )}
          </li>
        ) : rows.length === 0 ? (
          <li className="py-3 pl-panel pr-1">
            <p className="m-0 text-meta text-muted">No ferrets on this machine yet.</p>
          </li>
        ) : (
          rows.map(entry => {
            const cwd = byId.get(entry.ferretId)?.folder;
            return (
              <SettingRow
                key={entry.ferretId}
                name={sessionName(entry.ferretId, byId)}
                {...(cwd === undefined ? {} : { hint: basename(cwd) })}
                dataAttributes={{ 'data-lessons-ferret': entry.ferretId }}
                control={() => (
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={entry.passive ? 'ok' : 'pend'}>{entry.passive ? 'On' : 'Off'}</Badge>
                    <Button
                      size="sm"
                      className="min-h-[44px]"
                      disabled={switching !== null}
                      onClick={() => void toggleFerret(entry.ferretId, !entry.passive)}
                    >
                      {entry.passive ? 'Turn off' : 'Turn on'}
                    </Button>
                  </span>
                )}
              />
            );
          })
        )}
      </SettingGroup>
      <GlobalLessonsEditor connection={connection} />
    </div>
  );
}
