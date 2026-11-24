/**
 * THE PATH BOX: the open folder's path as editable text, above the breadcrumbs. Type a path and press Enter (or Go) to
 * open it; Escape puts the open folder's path back. `~` is the home folder, as it is in the breadcrumbs.
 *
 * The box only ASKS. The daemon decides whether the path may be opened (the fence stays there), so a refusal comes back
 * as the daemon's own sentence, drawn under the field while the old listing stays where it is.
 */
import { Button } from '@ferretry/app/ui';
import { type ReactNode, useId, useState } from 'react';

export interface PathBoxProps {
  /** The open folder, spelled the way the box shows it (`~`, `~/work`). */
  readonly current: string;
  /** The daemon's sentence when the last typed path was refused, else `null`. */
  readonly refusal: string | null;
  readonly onGo: (typed: string) => void;
  /** Escape: the box goes back to `current`, and a refusal is cleared by the caller. */
  readonly onRestore: () => void;
  /** What sits before the field in the same row (the explorer's Up button). */
  readonly lead?: ReactNode;
}

export function PathBox({ current, refusal, onGo, onRestore, lead }: PathBoxProps) {
  const errorId = useId();
  // An edit belongs to the folder it was typed in: the moment another folder is open (a committed navigation) the edit
  // is dropped for good, so coming back to the first folder shows that folder, not the old typing.
  const [seen, setSeen] = useState(current);
  const [edit, setEdit] = useState<string | null>(null);
  if (seen !== current) {
    setSeen(current);
    setEdit(null);
  }
  const text = edit ?? current;

  return (
    <form
      className="grid gap-1"
      data-explorer-path-box=""
      onSubmit={event => {
        event.preventDefault();
        const typed = text.trim();
        if (typed === '') onRestore();
        else if (typed !== current || refusal !== null) onGo(typed);
      }}
    >
      <div className="flex items-center gap-xs">
        {lead}
        <div className="relative min-w-0 flex-1">
          <input
            type="text"
            className="kt-input mono min-h-control w-full min-w-0 pe-16"
            aria-label="Folder path"
            aria-invalid={refusal === null ? undefined : true}
            aria-describedby={refusal === null ? undefined : errorId}
            value={text}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={event => setEdit(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Escape') return;
              // Escape inside a dialog closes it; here it only undoes the typing.
              if (text !== current || refusal !== null) {
                event.preventDefault();
                event.stopPropagation();
                setEdit(null);
                onRestore();
              }
            }}
          />
          <Button type="submit" className="absolute end-0 top-0 !h-full rounded-s-none border-y-0 border-e-0">
            Go
          </Button>
        </div>
      </div>
      {refusal !== null && (
        <p id={errorId} className="m-0 text-meta text-err" role="alert" data-explorer-path-error="">
          {refusal}
        </p>
      )}
    </form>
  );
}
