import { type AskSourceSpec, type AsksApi, EntryIdSchema } from '@ferretry/core-asks/contract';
import type { GateApi } from '@ferretry/core-gate/contract';
import type { FerretId, InputHolds, KernelPorts } from '@ferretry/kernel/contract';
import type { HookInvoker, ToolHandler } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import { InputAskRefSchema, type InputTargetAdapter, InputRequestFiles, InputTargets } from '../contract/index.ts';
import { INPUT_ASK_SOURCE, InputAgentNotifierAdapter, InputAsksAdapter } from './adapters/inputs/asks.ts';
import { InputGateAudit } from './adapters/inputs/audit.ts';
import { InputHoldsOverService } from './adapters/inputs/holds.ts';
import { InputStateJournal } from './adapters/inputs/journal.ts';
import { PageTargetThroughHook, TerminalTargetThroughHook } from './adapters/inputs/targets.ts';
import type { SignInGrantSource } from './lib/inputs/borrowed-grants.ts';
import type { EphemeralValues } from './lib/inputs/ephemeral-values.ts';
import type { LoginFactSink, LoginObserver } from './lib/inputs/login-observer.ts';
import type { InputChoicePort, InputLoginPort, InputPasteRules, InputSealedPort } from './lib/inputs/ports.ts';
import type { QuarantineRegistry } from './lib/inputs/quarantine.ts';
import { type SecretStoreDirectory, SecretStoreTarget } from './lib/inputs/secret-store-target.ts';
import { InputRequestService } from './lib/inputs/service.ts';
import { INPUT_REQUEST_SWEEP_MS } from './lib/inputs/sweep.ts';
import { InputTargetRouter } from './lib/inputs/target-router.ts';
import { TypedIdentities } from './lib/inputs/typed-identities.ts';
import { inputRequestRoutes } from './lib/runtime/mounts/inputs.ts';
import { inputTools } from './lib/runtime/tools/input-wait.ts';

/**
 * THE INPUT BRIDGE (today's `bin/modules/input-requests.ts`): a ferret stuck at a password prompt, a code or a
 * question asks the owner through an input card (an ask of source `input`), and the Vault types the owner's value into
 * the terminal or page through that tool's `input.targets` adapter (§4.7), then holds the target and masks the value.
 *
 * Built synchronously inside the Vault's `build(ctx)`; the restore and the sweep are jobs (they ran from
 * `startInputHousekeeping` today). Nothing built here stores a value except the service's own in-memory map of values
 * to mask.
 */

/** What Vault's own build hands the input bridge (vault-a's half owns the redactor and the secret store). */
export interface InputsDeps {
  /** The redaction window: the one retained copy of a typed value (I9), shared with the output redactor. */
  readonly values: EphemeralValues;
  /** The live holds (`InputHolds`): the same registry the kernel-bound hold decision reads. */
  readonly quarantine: QuarantineRegistry;
  /** Masks every known secret in a line before the card shows it. */
  readonly redact: (text: string) => Promise<string>;
  /** Where a paste "as the secret NAME" is kept; absent: such a paste is unsupported. */
  readonly secretStore?: SecretStoreDirectory;
  /**
   * Saved logins, sign-ins, secure copies, paste rules and approved sign-ins: Accounts' (the proposed `input.saved`
   * hook). Each is optional exactly as today; absent, the card offers nothing saved and every value is typed.
   */
  readonly accounts?: {
    readonly logins?: InputLoginPort;
    readonly choice?: InputChoicePort;
    readonly sealed?: InputSealedPort;
    readonly rules?: InputPasteRules;
    readonly grants?: SignInGrantSource;
    readonly loginFacts?: LoginFactSink;
  };
  /** Tells a ferret its request ended (today's agent reply outbox); absent, the ferret reads its state instead. */
  readonly tellFerret?: (ferret: FerretId, key: string, message: string) => Promise<unknown>;
  /** Whether a ferret has finished, so what it was given is no longer held for it; absent, none has. */
  readonly ferretEnded?: (ferret: FerretId) => Promise<boolean>;
  readonly hostName?: string;
}

/** What the rest of the Vault uses of the input bridge. */
export interface Inputs {
  readonly service: InputRequestService;
  readonly identities: TypedIdentities;
  readonly observer?: LoginObserver;
  /** The owner's input routes, by the keys `manifest.ts` declares: Vault's build spreads them into its `routes`. */
  readonly routes: ReturnType<typeof inputRequestRoutes>;
  /** The agent tools, by the names `manifest.ts` declares (`input_wait`): spread into Vault's `tools`. */
  readonly tools: { readonly input_wait: ToolHandler };
  /** The kernel-bound `InputHolds` Vault provides as `inputHolds`. */
  readonly holds: InputHolds;
  /** Vault's `ask.sources` provider for the key `input`: the input card's ref and title. */
  readonly askSource: AskSourceSpec;
}

/** The input card as Asks knows the source: the request it presents, answered on the input form, never as an ask. */
export const INPUT_ASK_SOURCE_SPEC: AskSourceSpec = {
  schema: InputAskRefSchema,
  title: 'Input request {request}',
  form: false,
};

/** The part of `build(ctx)` the input bridge reads. */
export interface InputsContext {
  readonly kernel: Pick<KernelPorts, 'clock' | 'state' | 'jobs'>;
  readonly needs: { readonly asks: AsksApi; readonly gate: Pick<GateApi, 'audit'> };
  readonly hooks: Pick<HookInvoker, 'provider'>;
}

export function buildInputs(ctx: InputsContext, deps: InputsDeps): Inputs {
  const { clock, state, jobs } = ctx.kernel;
  const provider = (kind: 'terminal' | 'page'): InputTargetAdapter | undefined => {
    const found = ctx.hooks.provider(InputTargets, kind);
    return found === 'unavailable' ? undefined : found;
  };
  const cardOf = async (requestId: string) => {
    const [open] = await ctx.needs.asks.open({
      source: INPUT_ASK_SOURCE,
      entry: EntryIdSchema.parse(requestId),
      state: 'open',
    });
    return open?.id as string | undefined;
  };
  const journal = new InputStateJournal(state, cardOf, () => clock.now());
  // Who a page is signing in, as the ferret typed it: plain text it held already, for the owner's card only.
  const identities = new TypedIdentities(() => clock.nowMs());
  const accounts = deps.accounts ?? {};
  const service = new InputRequestService({
    identities,
    target: new InputTargetRouter(
      new TerminalTargetThroughHook(provider),
      new PageTargetThroughHook(provider),
      // A secure copy pasted "as the secret NAME": the vault's management surface, which replaces a value and lists
      // names, never returns one.
      deps.secretStore === undefined ? undefined : new SecretStoreTarget(deps.secretStore),
    ),
    agenda: new InputAsksAdapter(ctx.needs.asks, journal),
    notifier: new InputAgentNotifierAdapter(deps.tellFerret ?? (async () => undefined)),
    journal,
    audit: new InputGateAudit(ctx.needs.gate),
    clock: { now: () => clock.nowMs() },
    ids: { requestId: () => crypto.randomUUID().replaceAll('-', '') },
    timers: { after: async ms => await clock.sleep(milliseconds(ms)) },
    sessions: {
      ended: async ferret => (await deps.ferretEnded?.(ferret as FerretId)) ?? false,
      all: async () => [...new Set(await ferretsWithRequests(state))],
    },
    values: deps.values,
    quarantine: deps.quarantine,
    redact: deps.redact,
    ...(accounts.logins === undefined ? {} : { logins: accounts.logins }),
    ...(accounts.choice === undefined ? {} : { choice: accounts.choice }),
    ...(accounts.sealed === undefined ? {} : { sealed: accounts.sealed }),
    ...(accounts.rules === undefined ? {} : { rules: accounts.rules }),
    ...(accounts.grants === undefined ? {} : { grants: accounts.grants }),
    ...(deps.hostName === undefined ? {} : { hostName: deps.hostName }),
  });
  // Every hold comes back before any request does (I82); then the sweep runs on its own interval.
  jobs.add({ id: 'inputs-restore', schedule: { onceAfterStart: true }, run: async () => await service.restore() });
  jobs.add({
    id: 'inputs-sweep',
    schedule: { every: milliseconds(INPUT_REQUEST_SWEEP_MS) },
    after: ['inputs-restore'],
    run: async () => await service.sweep(),
  });
  return {
    service,
    identities,
    routes: inputRequestRoutes(service),
    tools: inputTools(service),
    holds: new InputHoldsOverService(service, deps.quarantine, () => clock.nowMs()),
    askSource: INPUT_ASK_SOURCE_SPEC,
  };
}

async function ferretsWithRequests(state: InputsContext['kernel']['state']): Promise<readonly string[]> {
  const ferrets: string[] = [];
  for (const name of await state.list(InputRequestFiles)) {
    const read = await state.read(InputRequestFiles, name);
    if (read.ok && read.value !== undefined) ferrets.push(read.value.ferret);
  }
  return ferrets;
}
