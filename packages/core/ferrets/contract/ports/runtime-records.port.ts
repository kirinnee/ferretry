import type { FerretId } from '@ferretry/kernel/contract';
import type { FerretState } from '../ids.ts';

/** One ferret as a runtime removal or rename sees it (see {@link FerretsApi.runtimeRecords}). */
export interface FerretRuntimeRecord {
  readonly id: FerretId;
  /** What the person calls it: its callsign. */
  readonly name: string;
  readonly harness: 'claude' | 'codex';
  /** The runtime it launched as (in an old record, the wrapper path). */
  readonly agent: string;
  /** The wrapper it launched (`command[0]`), when the session config has one. */
  readonly executable?: string;
  readonly state: FerretState;
}

/** A runtime rename as a ferret's records see it: the two names and the two wrapper paths. */
export interface FerretRuntimeRename {
  readonly from: string;
  readonly to: string;
  readonly fromWrapper: string;
  readonly toWrapper: string;
}

/** The runtime each ferret launched as, and the re-point a runtime rename does. */
export interface RuntimeRecordsApi {
  /**
   * Additive (Runtimes reads it, c58-28b): every ferret this daemon keeps — stopped ones included — as a runtime change
   * needs it: the runtime it launched as (the session config's `agent`, else the record's `runtime`) and the wrapper it
   * launched (`command[0]`). A ferret whose documents do not say which runtime it runs on is left out, and one whose
   * session config cannot be read still answers from its record. Read only; names and paths, never a credential.
   */
  runtimeRecords?(): Promise<readonly FerretRuntimeRecord[]>;
  /**
   * Additive (Runtimes' alone, c58-28b): re-point every ferret that names the old runtime at the new one, as v4's rename
   * did. Ferrets does the locked read-modify-write: each ferret on its own mutation lane, the record's `runtime` and the
   * session config's `agent` and `command[0]` only, every other field kept. A running ferret is re-pointed too (v4 did not
   * skip one): its pane keeps running and the next relaunch finds the new name. Answers how many ferrets moved; a ferret
   * that could not be rewritten is skipped and still resolves through the runtime's former names.
   */
  repointRuntime?(rename: FerretRuntimeRename): Promise<number>;
}
