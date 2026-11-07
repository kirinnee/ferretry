/**
 * The seam between the two halves of the Vault port. vault-a (this file's author) owns the store, `run`,
 * `authorizeFetch`, the redaction and the output guard; vault-b owns input requests, holds, typing through a tool's
 * `input.targets` adapter and hold evidence.
 *
 * `daemon/index.ts` makes ONE call, `inputs(core)`, and wires what it answers into the half. Until vault-b lands it
 * is {@link inputsNotBuilt}: no input can be raised (`raiseInput` refuses), so no hold can exist, and `InputHolds`
 * answers `allow` for every act because there is nothing to hold. vault-b replaces the body of `inputs` and nothing
 * else in the composition.
 */

import type { FerretId, InputHolds } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { err } from '@ferretry/std';
import type { AskSourceSpec } from '@ferretry/core-asks/contract';
import {
  InputAskRefSchema,
  type InputRaise,
  type InputRequestId,
  type InputRequestState,
} from '../../contract/index.ts';
import type { HoldRegistry } from './secrets/output-guard.ts';
import type { RedactionValueSource } from './secrets/redaction.ts';
import type { SecretDirectory } from './secrets/vault.ts';

/** What vault-a hands the input half: the parts it builds on, nothing that opens a value it does not need. */
export interface VaultCore {
  /** Write-only store: a "Save as" files a login's value here and never reads one back. */
  readonly directory: SecretDirectory;
  /** The registry the output guard reads; every hold change calls `moved(target)` on it, in order. */
  readonly holds: HoldRegistry;
}

/** What the input half answers. */
export interface VaultInputs {
  readonly inputHolds: InputHolds;
  /** Extra values to mask, composed into the one redactor (the input redaction window, I102). */
  readonly maskSources: readonly RedactionValueSource[];
  readonly askSource: AskSourceSpec;
  raiseInput(ferret: FerretId, raise: InputRaise): Promise<Result<InputRequestId, string>>;
  cancelInput(ferret: FerretId, id: InputRequestId): Promise<void>;
  inputState(id: InputRequestId): Promise<InputRequestState | undefined>;
}

const NOT_BUILT = 'Input requests are not built yet in this version of Ferretry.';

/** Before vault-b: nothing can be raised, so nothing is held. */
export function inputsNotBuilt(_core: VaultCore): VaultInputs {
  return {
    inputHolds: { decide: () => 'allow' },
    maskSources: [],
    askSource: { schema: InputAskRefSchema, title: 'Input', form: true },
    raiseInput: async () => err(NOT_BUILT),
    cancelInput: async () => undefined,
    inputState: async () => undefined,
  };
}

/** vault-b: replace this one binding with the real input half. */
export const inputs: (core: VaultCore) => VaultInputs = inputsNotBuilt;
