import type { AgendaActionRequest, AgendaListSnapshot, AgendaReadItem } from '@ferretry/core-asks/contract';

/**
 * Presentation port for the agenda commands. Failures travel as thrown errors; the verb table turns those into stderr
 * and a non-zero exit code.
 */
export interface IAgendaOutput {
  success(message: string): void;
  /** A line for stderr: said to whoever runs the command, never mixed into its output. */
  diagnostic(message: string): void;
}

/** The daemon calls the agenda commands need; the controller never sees a route key or a status code. */
export interface IAgendaGateway {
  /** Read the target ferret's board, active items and resolutions together. */
  snapshot(ferretId: string): Promise<AgendaListSnapshot>;
  /** The complete document of a listed entry that came as a header only. */
  readItem(ferretId: string, id: string): Promise<AgendaReadItem>;
  /** Raise, resolve or dismiss an item and return the board as the daemon left it. */
  apply(ferretId: string, request: AgendaActionRequest): Promise<AgendaListSnapshot>;
  /** Deliver the answers held for the ferret now, skipping the settle window; the board as it was left. */
  sendReplies(ferretId: string): Promise<AgendaListSnapshot>;
}

/** Asking the person at the terminal; `interactive` is false when nobody can answer. */
export interface IAgendaPrompt {
  interactive(): boolean;
  ask(message: string): Promise<string>;
}

/** Reads the file a flag names (`--json-file`, `--body-file`, `--tab-file`, `patch --file`); `-` is standard input. */
export interface IAgendaBriefInput {
  read(path: string): Promise<string>;
}
