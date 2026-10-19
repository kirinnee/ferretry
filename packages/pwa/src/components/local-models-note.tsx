/**
 * What sits under a model picker when the machine's Ollama is not simply "has models": the daemon's own
 * sentence for the state, and — when a person has something to type — the exact command, selectable and
 * copyable. A picker whose server answered with models shows no note: its options already say
 * "installed here".
 */

import type { LocalModels } from '@ferretry/protocol';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../features/onboarding/copy-button.tsx';
import { localNote } from '../lib/local-models.ts';

export interface LocalModelsNoteProps {
  readonly id: string;
  readonly local: LocalModels | null | undefined;
  readonly write?: ClipboardWriter;
}

export function LocalModelsNote({ id, local, write = browserClipboardWriter() }: LocalModelsNoteProps) {
  const note = localNote(local);
  if (note === null) return null;
  const tone = note.state === 'disabled' ? 'border-border-strong bg-surface-2' : 'border-warn-border bg-warn-bg';
  return (
    <div
      className={`mt-2 flex min-w-0 flex-col gap-1 rounded-control border px-control-x py-row-y ${tone}`}
      data-local-models-note={note.state}
      id={id}
      role="status"
    >
      <p className="m-0 text-cell leading-base text-fg">{note.message}</p>
      {note.command === null ? null : (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-meta text-muted">Install a model with</span>
          <span className="flex min-w-0 items-center gap-1">
            <code
              className="min-w-0 flex-1 select-all break-all rounded-control bg-code-bg px-2 py-1 font-mono text-cell text-code-fg"
              data-local-models-command=""
            >
              {note.command}
            </code>
            <CopyButton label={`Copy ${note.command}`} text={note.command} touch write={write} />
          </span>
        </span>
      )}
    </div>
  );
}
