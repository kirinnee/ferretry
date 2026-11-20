/**
 * SETTINGS › LESSONS › Global lessons: the document every ferret reads at its next launch, shown whole and editable.
 * Today it is a file the owner opens in any editor; here it is the Lessons plugin's own state, so this is where an
 * applied Global lesson is reworded or removed. A save names the etag the owner read, so a write never lands over a
 * change the owner has not seen (`409 apply_conflict`, then the new text is shown).
 */

import type { LessonsGlobalDocument } from '../../contract/index.ts';
import { useEffect, useState } from 'react';
import { SettingGroup } from '@ferretry/app';
import { Button } from '@ferretry/app/ui';
import type { LessonsConnection } from './api.ts';
import { fetchGlobalLessons, lessonsErrorMessage, putGlobalLessons } from './api.ts';

export function GlobalLessonsEditor({ connection }: { readonly connection: LessonsConnection }) {
  const [document, setDocument] = useState<LessonsGlobalDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = (current: () => boolean) =>
    fetchGlobalLessons(connection).then(
      next => {
        if (!current()) return;
        setDocument(next);
        setDraft(next.text);
      },
      (reason: unknown) => {
        if (current()) setError(lessonsErrorMessage(reason));
      },
    );

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per daemon on screen
  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [connection]);

  const save = async () => {
    if (document === null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await putGlobalLessons(connection, draft, document.etag);
      setDocument(next);
      setDraft(next.text);
      setSaved(true);
    } catch (reason) {
      setError(lessonsErrorMessage(reason));
      // The document moved, or the write was refused: show what is there now.
      await load(() => true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0" data-global-lessons="">
      <SettingGroup label="Global lessons">
        <li className="flex min-w-0 flex-col gap-2 py-3 pl-panel pr-1">
          <p className="m-0 text-meta leading-base text-muted">
            Every ferret reads these rules at its next launch. Reword a rule or delete its line to change or remove an
            applied Global lesson.
          </p>
          <textarea
            aria-label="Global lessons"
            className="min-h-[160px] w-full rounded-control border border-border bg-surface-2 p-2 font-mono text-meta"
            disabled={document === null || saving}
            value={draft}
            onChange={event => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={document === null || saving || draft === document.text}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {saved && (
              <span role="status" className="text-meta text-muted">
                Saved. New ferrets read it at their next launch.
              </span>
            )}
          </div>
          {error !== null && (
            <p role="alert" className="m-0 text-meta text-err">
              {error}
            </p>
          )}
        </li>
      </SettingGroup>
    </div>
  );
}
