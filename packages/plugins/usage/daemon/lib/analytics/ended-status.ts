import type { FerretEndCause } from '@ferretry/core-ferrets/contract';

/** How an insights row says a finished ferret ended (v4's `completed`, `failed`, `stopped`). */
export type EndedStatus = 'completed' | 'failed' | 'stopped';

/** How the last turn of a ferret this process WATCHED end (`turn.ended`); only ever a fallback for a record with no cause. */
export type WatchedOutcome = 'completed' | 'interrupted' | 'failed';

const STATUS_OF_OUTCOME: Readonly<Record<WatchedOutcome, EndedStatus>> = {
  completed: 'completed',
  interrupted: 'stopped',
  failed: 'failed',
};

/**
 * The insights status of a stopped ferret, read from the cause its own record persists (Ferrets writes it as it ends it),
 * so a ferret this process never watched end (a daemon restart inside the settle window, a converted record) reads as it
 * ended rather than as `stopped`. An end nobody chose (the terminal vanished, a signal, a crash, a launch that never ran)
 * is `failed`; `completed` is `completed`; an end somebody decided or a clean exit is `stopped`. A record with no cause
 * (older than the field) falls back to what this process watched, and to `stopped` when it watched nothing.
 */
export function endedStatus(cause: FerretEndCause | undefined, watched: WatchedOutcome | undefined): EndedStatus {
  switch (cause?.kind) {
    case 'completed':
      return 'completed';
    case 'stopped':
    case 'clean_exit':
      return 'stopped';
    case 'tmux_crashed':
    case 'terminal_gone':
    case 'signal':
    case 'agent_crashed':
    case 'start_failed':
      return 'failed';
    case undefined:
      return STATUS_OF_OUTCOME[watched ?? 'interrupted'];
  }
}
