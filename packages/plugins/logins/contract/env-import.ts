/**
 * The setup import's door into a login's own environment (r9 A8): Runtimes finds a harness's `env` in the host's settings,
 * moves each secret-looking value into the Vault (create-only), and hands Logins the variables in TWO lists, so the source of
 * a Vault reference is never a guess. Logins writes its OWN `config/logins/<id>.yaml`, so the schema check, the refusal of a
 * raw secret and the hold on a loosening still apply, and a ferret's launch resolves each reference into that one child.
 *
 * - `plain`: host text, `{ name, value }`. A `${secret:…}` anywhere in it is refused with a sentence, because plain host text
 *   is not where a Vault reference comes from.
 * - `minted`: `{ name, secretName }`, built ONLY from the successful create-only puts of the import that is calling: this apply's own, or a
 *   key an earlier run of this same import filed that the Vault confirmed (`filedSame`) still holds this very value. Logins
 *   writes `${secret:<secretName>}` itself; the caller never hands over reference text.
 *
 * Only Runtimes may take this port (the provider answers every other plugin with a refusal), and the call carries the caller
 * so a live `fleet.configure` (and `secrets.configure` when a Vault reference is bound) is asked at the moment of the write.
 *
 * Nothing here carries a secret VALUE: a request holds host text and secret NAMES, and an outcome holds names and words.
 */
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import { definePort } from '@ferretry/kernel/contract';
import { nameLooksLikeKey } from './secret-shape.ts';
import type { LoginFile } from './wire.ts';

/** Variables that carry a GitHub account's token. They come in unticked: see {@link GITHUB_TOKEN_SENTENCE}. */
export const GITHUB_TOKEN_NAMES: readonly string[] = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];

/** Why a GitHub token is left out unless the person ticks it (it is their choice, so ticking still works). */
export const GITHUB_TOKEN_SENTENCE =
  "Not imported by default: ferrets' `gh` uses your connected GitHub account, and a token in a login's environment can be read by every ferret on that login.";

/** What a variable name that is itself shaped like a key is called instead of being repeated (in a sentence, a scan, a warning). */
export const MASKED_VARIABLE_NAME = '(a variable whose name looks like a key)';

/** A variable name as a sentence may repeat it. */
export const maskedVariableName = (name: string): string => (nameLooksLikeKey(name) ? MASKED_VARIABLE_NAME : name);

/** The only plugin whose needs may take {@link LoginEnvImportPort}: the setup import is Runtimes' apply. */
export const LOGIN_ENV_IMPORT_NEEDER = 'runtimes';

/** One variable that was not taken, and why, in a sentence that holds no value. A name that looks like a key is masked. */
export interface SkippedVariable {
  readonly name: string;
  readonly because: string;
}

/** A variable of the host's settings as written there. */
export interface PlainVariable {
  readonly name: string;
  readonly value: string;
}

/** A variable whose value this apply filed in the Vault: the secret's NAME, never its value. */
export interface MintedVariable {
  readonly name: string;
  /** A secret this import filed (a successful create-only put by this apply, or a confirmed earlier one of this import). */
  readonly secretName: string;
}

/**
 * Who asks. The caller's standing as the grant layer reads it NOW: Logins asks `fleet.configure` (and `secrets.configure`
 * when a Vault reference would be bound) at the write, not when the apply began.
 */
export interface LoginEnvCaller {
  readonly governance: CallerGovernance | undefined;
}

export interface LoginEnvImportRequest {
  readonly caller: LoginEnvCaller;
  /** The login this apply selected or created for the imported runtime. It is not looked up by name from anything outside the apply. */
  readonly login: string;
  /** The harness the variables come from: only a login of that harness takes them. */
  readonly harness: LoginFile['harness'];
  /** Host text. */
  readonly plain: readonly PlainVariable[];
  /** Variables whose secret this apply filed. */
  readonly minted: readonly MintedVariable[];
  /** GitHub token variables the person ticked; they come in unticked by default. */
  readonly ticked?: readonly string[];
}

/** What an import of variables did, in names and words only. */
export type LoginEnvImportOutcome =
  | {
      readonly outcome: 'written' | 'held';
      /** The variables now on the login from this import. */
      readonly added: readonly string[];
      /** Variables the login already had, which the import left as they were. */
      readonly kept: readonly string[];
      readonly skipped: readonly SkippedVariable[];
      /** Only when `held`: what the owner must confirm. */
      readonly sentences: readonly string[];
    }
  | { readonly outcome: 'unchanged'; readonly kept: readonly string[]; readonly skipped: readonly SkippedVariable[] }
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * Adds an imported harness environment to a login. It only adds: a variable the login already has, in the version in effect
 * or in one held for the owner, is never replaced, and a login with an edit held, or one that moved while this ran, is
 * refused rather than rewritten. A port of its own, taken only by Runtimes' setup import.
 */
export interface LoginEnvImportApi {
  import(request: LoginEnvImportRequest): Promise<LoginEnvImportOutcome>;
}
export const LoginEnvImportPort = definePort<LoginEnvImportApi>('logins.env-import');
