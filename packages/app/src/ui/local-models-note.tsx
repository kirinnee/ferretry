/**
 * What sits under a model picker when the machine's Ollama is not simply "has models": the daemon's own
 * sentence for the state, and — when a person has something to type — the exact command, selectable and
 * copyable. A picker whose server answered with models shows no note: its options already say
 * "installed here".
 */

import { browserClipboardWriter, type ClipboardWriter, CopyButton } from './copy-button.tsx';

/**
 * What the daemon last read from a local model server, as far as a picker reads it: the state, the daemon's own
 * sentence for it and the command that installs a model. Whoever owns the answer (Runtimes) may carry more.
 */
export interface LocalModelsSnapshot {
  readonly state: 'found' | 'none-pulled' | 'not-running' | 'unreadable' | 'refused' | 'disabled';
  readonly message: string;
  readonly pullCommand: string;
}

/** The states in which a person is told what to type. */
const SHOWS_COMMAND: ReadonlySet<LocalModelsSnapshot['state']> = new Set(['not-running', 'none-pulled']);

/** What sits under a picker when the answer is not simply "found": the sentence and, if useful, the command. */
export interface LocalNote {
  readonly state: LocalModelsSnapshot['state'];
  readonly message: string;
  readonly command: string | null;
}

/**
 * The daemon words "none-pulled" as "… Run: <command>"; the command has its own line, so the sentence
 * stops before it. A message that does not end that way is shown whole.
 */
const withoutTrailingCommand = (message: string, command: string): string => {
  if (!message.endsWith(command)) return message;
  const head = message.slice(0, -command.length).replace(/\s*Run:\s*$/u, '');
  return head === '' ? message : head;
};

export const localNote = (snapshot: LocalModelsSnapshot | null | undefined): LocalNote | null => {
  if (snapshot === null || snapshot === undefined || snapshot.state === 'found') return null;
  const command = SHOWS_COMMAND.has(snapshot.state) ? snapshot.pullCommand : null;
  return {
    state: snapshot.state,
    message: command === null ? snapshot.message : withoutTrailingCommand(snapshot.message, command),
    command,
  };
};

export interface LocalModelsNoteProps {
  readonly id: string;
  readonly local: LocalModelsSnapshot | null | undefined;
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
