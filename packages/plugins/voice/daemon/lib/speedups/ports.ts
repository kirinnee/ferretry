import type { SecretName } from '@ferretry/core-vault/contract';
import type { Instant } from '@ferretry/std';

/**
 * Every boundary the speed-up keys cross from Voice's side.
 *
 * The Vault has a closed set of holders and the whole "no route returns a secret" property depends on that set staying
 * closed. Voice adds none: its Test, the dictation clean-up and the Jev probe all ask the Vault's ONE outbound holder
 * (`authorizeFetch`) to make a call on their behalf. None of them is ever handed a value.
 */

/** Names and change instants of what the store holds — `VaultApi.names()` satisfies it. */
export interface SecretNameSource {
  list(): Promise<readonly { readonly name: SecretName; readonly updatedAt: Instant }[]>;
}

/**
 * The last Test of each provider, as it rests. `read` hands back raw parsed JSON (or `undefined`), and the domain
 * decides what a damaged document means — here, simply "never tested".
 */
export interface SpeedupTestLedgerPort {
  read(): Promise<unknown>;
  write(document: unknown): Promise<void>;
}

/** Monotonic milliseconds for latency, and the wall-clock instant a result is stamped with. */
export interface SpeedupClockPort {
  monotonicMs(): number;
  now(): Instant;
}
