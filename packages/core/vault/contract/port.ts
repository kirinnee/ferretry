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

/** The opaque child environment lives in the kernel leaf (lead decision 9: the kernel opens it at exec time). */
export type { ChildEnvironment } from '@ferretry/kernel/contract';
import type { ChildEnvironment } from '@ferretry/kernel/contract';

/**
 * The page a ferret's act touched, as the sign-in lock groups acts (today's `ActedPage`): its id, whether it shares
 * storage with others (incognito, a popup's opener) and the hosts it and its popups were on around the act. No
 * `hosts` widens the act to every host (I100).
 */
export interface ActedPage {
  readonly id: string;
  readonly incognito?: true;
  readonly openerId?: string;
  readonly hosts?: readonly string[];
}

/** One page act, told BEFORE it runs; until `placed` says which page, it counts on every page (I100). */
export interface PageActNote {
  placed(page: ActedPage | undefined): void;
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
  /**
   * WHAT A FERRET DID TO A PAGE, told by Browsers (lead DECISIONS-2 #5; today's `loginActs.acted`, I98–I100): a ferret
   * is about to act on a page of its own, or run a page script (`script`). A sign-in's after-submit facts the ferret
   * could have steered are not kept, and a page card's lock reads it per page. Additive: absent, the kernel's
   * host-less act notes are all the lock hears (stricter, never looser).
   */
  pageActed?(ferret: FerretId, script: boolean): PageActNote;
  /**
   * A page script is about to run, anywhere on the machine (today's `RuleSignInGrants.running`): until the returned
   * call, every page card counts as scripted. Memory only: a restart ends every script.
   */
  scriptRunning?(): () => void;
  /**
   * A page script ran on `host`, or on a page whose origin could not be read (`undefined`: it may have been any)
   * (today's `RuleSignInGrants.scriptedOn`): every page on that site counts as scripted from now on.
   */
  scriptedOn?(host: string | undefined): void;
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
