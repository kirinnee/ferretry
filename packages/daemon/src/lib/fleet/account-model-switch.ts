/**
 * The one switch every account-model WRITE asks first (docs/design/account-model.md §13.3).
 *
 * A version-2 `config.yaml` cannot be read by anything in a release that still reads version 1, so
 * until those readers are retired a machine writes the new model only when its operator has said so,
 * with `"accountModel": { "enabled": true }` in `config/daemon.json`. Reads never ask: the catalogue
 * of a version-1 machine is read through the in-memory conversion either way.
 *
 * Every writer — reviewed changes, first-run setup, clone, migration — calls
 * {@link accountModelWritesRefusal} and refuses with the sentence it returns, so the words a person
 * reads are the same whichever door they tried. Pure.
 */
import type { DaemonAccountModelConfig } from '../runtime/config.ts';

/** What every account-model write says while the switch is off. */
export const ACCOUNT_MODEL_DISABLED_SENTENCE = 'The new account model is not switched on for this machine yet.';

/** The part of the daemon configuration this reads. */
export interface AccountModelSwitchConfig {
  readonly accountModel: DaemonAccountModelConfig;
}

/** Why an account-model write is refused right now, or `undefined` when it may go ahead. */
export function accountModelWritesRefusal(config: AccountModelSwitchConfig): string | undefined {
  return config.accountModel.enabled ? undefined : ACCOUNT_MODEL_DISABLED_SENTENCE;
}
