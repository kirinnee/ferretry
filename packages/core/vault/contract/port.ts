import { defineEvent, definePort, type FerretId, type TargetRef } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import type { InputRaise, InputRequestId, InputRequestState } from './inputs.ts';
import type {
  AuthorizedOutcome,
  CredentialPlacement,
  OutboundHttpRequest,
  SecretName,
  SecretSummary,
  SecretUseCommand,
  SecretUseRefusal,
  SecretUseResult,
} from './secrets.ts';

declare const childEnvironmentBrand: unique symbol;

/**
 * An environment whose `${secret:NAME}` references the Vault resolved for ONE child process. Opaque: no field,
 * no enumeration, no JSON (it serialises as names only). Only a runner hands it to the process it starts, so the
 * values are in that child's environment and in no plugin's data (secrets.md "use, never read").
 */
export interface ChildEnvironment {
  readonly [childEnvironmentBrand]: true;
  /** The variable names it sets, for the launch record. Never a value. */
  readonly names: readonly string[];
}

/**
 * The Vault port (§2.2, §3.7): secrets by NAME only. There is no getter, and none may be added (it would delete the
 * feature): `run` executes a command with the values in that child's environment and returns masked output;
 * `authorizeFetch` places ONE named secret on ONE request to an allowlisted host and returns only what came back.
 */
export interface VaultApi {
  names(): Promise<readonly SecretSummary[]>;
  /** Whether a secret of this name is held. Never its value. */
  has(name: SecretName): Promise<boolean>;
  /** A value in; person-only at the route. */
  put(name: SecretName, value: string): Promise<void>;
  remove(name: SecretName): Promise<boolean>;
  run(command: SecretUseCommand, ferret?: FerretId): Promise<Result<SecretUseResult, SecretUseRefusal>>;
  authorizeFetch(
    name: SecretName,
    hostAllowlist: readonly string[],
    request: OutboundHttpRequest,
    placement?: CredentialPlacement,
  ): Promise<AuthorizedOutcome>;
  /** Resolves `${secret:NAME}` in `env` for one ferret's child; a missing secret refuses the launch. */
  childEnvironment(
    ferret: FerretId,
    env: Readonly<Record<string, string>>,
  ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>>;
  /** Input requests: a ferret raises one, the owner answers on its card. */
  raiseInput(ferret: FerretId, raise: InputRaise): Promise<Result<InputRequestId, string>>;
  cancelInput(ferret: FerretId, id: InputRequestId): Promise<void>;
  inputState(id: InputRequestId): Promise<InputRequestState | undefined>;
}

export const VaultPort = definePort<VaultApi>('vault');

/** The set of secret names changed (never a value). A wake-up. */
export const SecretsChanged = defineEvent('vault.secrets-changed', z.strictObject({ generation: z.number().int() }));

/** A hold began or ended on a target; the guard generation moved. A wake-up; the truth is `OutputGuard`. */
export const HoldsChanged = defineEvent(
  'vault.holds-changed',
  z.strictObject({ target: z.strictObject({ kind: z.string(), key: z.string() }), generation: z.number().int() }),
);
export type HoldsChangedPayload = { readonly target: TargetRef; readonly generation: number };
