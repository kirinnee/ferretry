/**
 * The words under a model picker when the machine's Ollama is not simply "has models" — the pure half.
 * The runtime catalog carries the daemon's last read of Ollama (a state, a ready sentence and the exact
 * command that installs a model); this file only turns that answer into the note a picker shows.
 * Reading and refreshing it is Logins' (`POST /v1/models/local/refresh`); nothing here reads a clock or a
 * network.
 */

import type { LocalModels } from '../../contract/index.ts';

export type LocalModelsState = LocalModels['state'];

/** The states in which a person is told what to type. */
const SHOWS_COMMAND: ReadonlySet<LocalModelsState> = new Set(['not-running', 'none-pulled']);

/** What sits under a picker when the answer is not simply "found": the sentence and, if useful, the command. */
export interface LocalNote {
  readonly state: LocalModelsState;
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

export const localNote = (snapshot: LocalModels | null | undefined): LocalNote | null => {
  if (snapshot === null || snapshot === undefined || snapshot.state === 'found') return null;
  const command = SHOWS_COMMAND.has(snapshot.state) ? snapshot.pullCommand : null;
  return {
    state: snapshot.state,
    message: command === null ? snapshot.message : withoutTrailingCommand(snapshot.message, command),
    command,
  };
};
