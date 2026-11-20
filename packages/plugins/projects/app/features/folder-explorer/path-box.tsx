/**
 * THE PATH BOX: the open folder's path as editable text, above the breadcrumbs. Type a path and press Enter (or Go) to
 * open it; Escape puts the open folder's path back. `~` is the home folder, as it is in the breadcrumbs.
 *
 * The box only ASKS. The daemon decides whether the path may be opened (the fence stays there), so a refusal comes back
 * as the daemon's own sentence, drawn under the field while the old listing stays where it is.
 */
import { useId, useState } from 'react';

export interface PathBoxProps {
  /** The open folder, spelled the way the box shows it (`~`, `~/work`). */
  readonly current: string;
  /** The daemon's sentence when the last typed path was refused, else `null`. */
  readonly refusal: string | null;
  readonly onGo: (typed: string) => void;
  /** Escape: the box goes back to `current`, and a refusal is cleared by the caller. */
  readonly onRestore: () => void;
}

export function PathBox({ current, refusal, onGo, onRestore }: PathBoxProps) {
  const errorId = useId();
  // An edit belongs to the folder it was typed in: once another folder is open the box shows that one instead.
  const [edit, setEdit] = useState<{ readonly base: string; readonly text: string } | null>(null);
  const text = edit !== null && edit.base === current ? edit.text : current;

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
      <div className="flex items-start gap-xs">
        <input
          type="text"
          className="kt-input mono min-h-control min-w-0 flex-1"
          aria-label="Folder path"
          aria-invalid={refusal === null ? undefined : true}
          aria-describedby={refusal === null ? undefined : errorId}
          value={text}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={event => setEdit({ base: current, text: event.target.value })}
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
        <button type="submit" className="kt-btn min-h-control min-w-[4.5rem] shrink-0">
          Go
        </button>
      </div>
      {refusal !== null && (
        <p id={errorId} className="m-0 text-meta text-err" role="alert" data-explorer-path-error="">
          {refusal}
        </p>
      )}
    </form>
  );
}
