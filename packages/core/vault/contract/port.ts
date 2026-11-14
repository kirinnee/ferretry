import { defineEvent, definePort, type FerretId, type TargetRef } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import type { InputRaise, InputRequestId, InputRequestState } from './inputs.ts';
import type { PhoneApprovalAgentView, PhoneApprovalAsk } from './phone.ts';
import type { ObserveResult, PushNumberRead } from './targets.ts';
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
  /**
   * Resolves `${secret:NAME}` in `env` for one ferret's child; a missing secret refuses the launch. A variable whose
   * whole value is an optional reference (`${secret?:NAME}`, {@link optionalSecretReference}) is set when the secret
   * is held and left out of the child's environment when it is not.
   */
  childEnvironment(
    ferret: FerretId,
    env: Readonly<Record<string, string>>,
  ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>>;
  /**
   * {@link childEnvironment} for ONE command started for `runtime`: besides what the caller may use, the secrets that
   * runtime's profile references (`ProfileSecrets`, Runtimes' answer) are allowed, for this call only; nothing is kept,
   * so the next call is asked afresh. Present only for a plugin whose manifest declares `permissions.profileSecrets`.
   */
  childEnvironmentForRuntime?(
    runtime: string,
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
  /**
   * An OPEN input card's target key as the DAEMON saw it (never the agent's word), for a 2FA seed set up from that card
   * (today's `InputRequestService.cardTarget`): Accounts saves it only to an account that signs in there. `undefined`:
   * no such open card. Additive.
   */
  cardTarget?(requestId: string): { readonly matchKey?: string; readonly observedDigest?: string } | undefined;
  /**
   * "USE IT NOW" (today's `InputRequestService.useNow`): the owner just saved a 2FA seed with a passkey from this OPEN
   * code card, so the Vault types the new key's first code into that card through every check a "Use code from Ferretry"
   * tap gets, against `observedDigest` (the card as the owner saw it). Whether it was typed; never the code. Additive.
   */
  useNow?(
    requestId: string,
    use: {
      readonly account: string;
      readonly factor: string;
      readonly observedDigest: string;
      readonly submit?: boolean;
      readonly actor: { readonly kind: 'host' } | { readonly kind: 'device'; readonly deviceId: string };
    },
  ): Promise<boolean>;
  /**
   * APPROVE ON YOUR PHONE, the reads Accounts' approval makes (docs/input-requests.md). Additive and optional, and
   * ABSENT for every needer but Accounts: the Vault owns the `input.targets` adapters and the sign-in lock, and an
   * approval looks at them only through these. An absent member means no approval is raised (fail closed).
   *
   * The push number the ferret's page `key` shows now, read in the page's own queue from a provider's own challenge
   * view only, never an element a ferret points at. Nothing: no such page, or the target cannot read one.
   */
  pushNumber?(
    ferret: FerretId,
    key: string,
  ): Promise<{ readonly pageId: string; readonly read: PushNumberRead } | undefined>;
  /** What the input bridge observes at the ferret's terminal `key` (its prompt line and program); never its screen. */
  observeTerminal?(ferret: FerretId, key: string): Promise<ObserveResult>;
  /**
   * Whether the ferret could have steered a surface of `kind` (today's `LoginObserver.tainted`): for a page, it ran a
   * page script in this session; or it acted on that kind of surface at or after `since` (ms; unreadable counts as acted).
   */
  tainted?(ferret: FerretId, kind: 'browser' | 'terminal', since: number): boolean;
  /**
   * A ferret's `push: true` raise on a request tool (Browsers' `browser_request_input`): handed to whichever service
   * provides `input.phone-approval` (Accounts). Refused with {@link PHONE_APPROVAL_UNAVAILABLE} while none is bound.
   * Present only for the plugins whose tools carry the raise; the ferret is the CALLER's credential, never a body.
   */
  raisePhoneApproval?(ferret: FerretId, ask: PhoneApprovalAsk): Promise<Result<PhoneApprovalAgentView, string>>;
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
