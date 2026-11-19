/**
 * The setup import's door into a login's own environment (r9 A8): Runtimes finds a harness's `env` in the host's settings,
 * moves each secret-looking value into the Vault (create-only), and hands Logins the variables as plain text and
 * `${secret:NAME}` references. Logins writes its OWN `config/logins/<id>.yaml`, so the schema check, the refusal of a raw
 * secret and the hold on a loosening still apply, and a ferret's launch resolves each reference into that one child.
 *
 * Nothing here carries a secret VALUE: a request holds references and plain text, and an outcome holds names and words.
 */
import { definePort } from '@ferretry/kernel/contract';
import type { LoginFile } from './wire.ts';

/** Variables that carry a GitHub account's token. They come in unticked: see {@link GITHUB_TOKEN_SENTENCE}. */
export const GITHUB_TOKEN_NAMES: readonly string[] = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];

/** Why a GitHub token is left out unless the person ticks it (it is their choice, so ticking still works). */
export const GITHUB_TOKEN_SENTENCE =
  "Not imported by default: ferrets' `gh` uses your connected GitHub account, and a token in a login's environment can be read by every ferret on that login.";

/** One variable that was not taken, and why, in a sentence that holds no value. */
export interface SkippedVariable {
  readonly name: string;
  readonly because: string;
}

export interface LoginEnvImportRequest {
  /** The login the imported runtime launches on. */
  readonly login: string;
  /** The harness the variables come from: only a login of that harness takes them. */
  readonly harness: LoginFile['harness'];
  /** The host's variables after each secret moved to the Vault: plain text and `${secret:NAME}` references. */
  readonly env: Readonly<Record<string, string>>;
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
 * Adds an imported harness environment to a login. It only adds: a variable the login already has is kept, so an import
 * never replaces what a person set. A port of its own, needed only by Runtimes' setup import.
 */
export interface LoginEnvImportApi {
  import(request: LoginEnvImportRequest): Promise<LoginEnvImportOutcome>;
}
export const LoginEnvImportPort = definePort<LoginEnvImportApi>('logins.env-import');
