/**
 * Resolving what a fork's TARGET actually is, against the owners of every fact involved.
 *
 * A fork's request names three opaque things — an agent, maybe a model, maybe an effort — and none
 * of them may be interpreted here. The account inventory owns which wrapper is published and whether
 * this host can run it; the session planner owns which model an account really serves and how big
 * its context is; the harness quirk table and the runtime-switch planner own which efforts a harness
 * can express and which of them a live Codex account currently advertises. This adapter's whole job
 * is to ASK those owners in the right order and assemble one {@link TransferTargetChoice}.
 *
 * THE HARNESS IS RETURNED, NEVER GUESSED. It is `account.kind` — the family the fleet manifest
 * declares for the resolved account — so a caller can neither assert a family nor have one inferred
 * from the spelling of a wrapper name. That is also why the wire request has no `harness` field.
 *
 * NO SECOND CATALOGUE, NO SECOND EFFORT VOCABULARY, NO SECOND CACHE. `RUNTIME_EFFORT_LEVELS`,
 * `ADVANCED_EFFORTS` and `quickPickerAppliesPreset` are all reached through the one
 * `planRuntimeSwitch` this daemon publishes, via the same `HarnessQuirkService` the runtime route
 * uses, over the ONE `CodexRuntimeCatalogCache` the composition root builds. Every one of those is
 * injected rather than constructed, because a second cache here would be a second probe against a
 * live account and a second effort list would eventually promise a level the picker cannot reach.
 *
 * TWO STEPS, NOT ONE, AND THE ORDER IS THE DESIGN: `resolve` → prepare → `validate` → claim the
 * receipt. `resolve` answers what the target IS, from facts that need no session. `validate` proves
 * the account can actually serve that choice, and it is separate because the live Codex catalogue is
 * keyed by working directory — the target's is the SOURCE's, and that is only known once preparation
 * has read the source. Validating inside `resolve` would have to invent a directory and would answer
 * about a catalogue no session will ever run under.
 *
 * Both halves happen before the receipt is claimed, which is what makes an unserviceable effort an
 * ordinary refusal rather than a durable fork that can never finish. `validate` checks exactly the
 * request object the binder later applies (see {@link forkStartupRuntimeRequest}), so what is proved
 * and what is performed cannot drift apart.
 */

import type { ForkSessionFailure, RuntimeControlRequest, RuntimeModelChoice } from '@ferretry/protocol';
import type { CodexRuntimeCatalogCache } from '../../lib/session/harness/codex-catalog-cache.ts';
import { codexRuntimeCatalog, codexSwitchContext } from '../../lib/session/harness/model-catalog.ts';
import { harnessQuirks } from '../../lib/session/harness/quirks.ts';
import type { HarnessRuntimeSwitchRequest } from '../../lib/session/harness/runtime-switch.ts';
import type { HarnessQuirkService } from '../../lib/session/harness/service.ts';
import type { CoreAccount, HarnessKind } from '../../lib/core/inventory.ts';
import type { SessionPlanner } from '../../lib/core/session-planner.ts';
import type { SessionForkCommand } from '../../lib/fork/identity.ts';
import type { SessionForkTargetResolver as SessionForkTargetResolverPort } from '../../lib/fork/types.ts';
import type { TransferTargetChoice } from '../../lib/transfer/types.ts';

/**
 * Why a target could not be resolved, as the two arms the WIRE already owns.
 *
 * Derived from `ForkSessionFailure` by extraction rather than respelled, so this can never name a
 * code the protocol does not have — and so the composition root's facade can pass the value straight
 * through instead of translating it. The two are genuinely different next actions for a caller: one
 * says "no such agent, pick another", the other says "that agent exists and cannot serve this fork".
 */
export type SessionForkTargetResolutionFailure = Extract<ForkSessionFailure, 'unknown_agent' | 'agent_unavailable'>;

/**
 * A target this daemon will not resolve, carrying the code the caller is answered with.
 *
 * It is a DOMAIN error rather than the route mount's refusal: an adapter that imported the HTTP
 * vocabulary would make the wire the thing this layer is written against, and the same resolution
 * has to serve a compiled-binary caller with no HTTP anywhere near it. The facade restates it.
 */
export class SessionForkTargetResolutionError extends Error {
  constructor(
    readonly failure: SessionForkTargetResolutionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionForkTargetResolutionError';
  }
}

/** One published account and the absolute wrapper this host would launch it through. */
export interface SessionForkTargetAccount {
  readonly account: CoreAccount;
  readonly executable: string;
}

/**
 * The composition root's own start-account resolution, injected as a function.
 *
 * A start and a fork must agree about which agents exist and which of them this host can run, and
 * the only way to be sure of that is to call the very same resolution. It is a function rather than
 * an interface because the root's version is a private function over the fleet manifest and this
 * host's `PATH`, and widening it into a published port would be a second declaration of it.
 *
 * It may reject with anything; a rejection that already carries a `failure` of `unknown_agent` is
 * read as such, and everything else is reported as an account that cannot serve.
 */
export type SessionForkStartAccountResolver = (agent: string) => Promise<SessionForkTargetAccount>;

export interface SessionForkTargetResolverPorts {
  readonly accounts: SessionForkStartAccountResolver;
  /** Decides the real model and the context window, under the policy the root configured once. */
  readonly planner: SessionPlanner;
  /**
   * The one quirk service the runtime route uses, narrowed to the only method a fork reaches.
   *
   * `planSwitch` is `planRuntimeSwitch` and nothing else, so this is where `RUNTIME_EFFORT_LEVELS`,
   * `ADVANCED_EFFORTS` and `quickPickerAppliesPreset` are consulted. Naming the method rather than
   * the class keeps the picker cleanup and quarantine machinery — which a fork has no business
   * touching, because it has no live pane yet — out of reach.
   */
  readonly harness: Pick<HarnessQuirkService, 'planSwitch'>;
  /** The ONE held Codex catalogue. A second cache is a second probe against a live account. */
  readonly catalog: CodexRuntimeCatalogCache;
}

/**
 * The id handed to the planner for a resolution that has no session yet.
 *
 * The planner mints a tmux name and remote-control arguments from the id, and this resolution reads
 * NEITHER — it takes only `model` and `contextWindow`, both of which are functions of the account
 * and the requested model alone. The binder plans again against the real target id for the argv, so
 * nothing derived from this constant can reach a session.
 */
const RESOLUTION_PROBE_ID = 'fork-target-resolution';

/**
 * The one startup runtime control a forked target is launched with, or `undefined` for a fork that
 * asked for no effort.
 *
 * ONE FUNCTION, TWO CALLERS, and that is the point: the resolver validates exactly this request
 * against the harness's own switch planner, and the binder applies exactly this request through the
 * startup-only half of that same runtime subsystem before turn one. Two spellings of "what should
 * this session be set to" would let a fork validate one thing and perform another.
 *
 * The shape follows the harness rather than the caller: a harness whose effort is a native command
 * takes the effort alone, and a harness that can only reach effort inside its modal picker must be
 * given the model with it, because the picker cannot be driven to a level without a row to select.
 */
export function forkStartupRuntimeRequest(
  harness: HarnessKind,
  model: string | null,
  effort: string | null,
): RuntimeControlRequest | undefined {
  if (effort === null) return undefined;
  if (harnessQuirks(harness).effortIsRuntimeCommand) return { action: 'effort', effort };
  return { action: 'model', ...(model === null ? {} : { model }), effort };
}

/**
 * The published account behind one agent name, with the two halves of a failure kept apart.
 *
 * ONE OWNER FOR THE SPLIT, because the fork binder resolves the same account again when it creates
 * the target — the account could have been withdrawn between the receipt claim and the create — and
 * two spellings of "was that unknown or merely unavailable" would answer one caller two ways for one
 * cause.
 */
export async function resolveForkTargetAccount(
  accounts: SessionForkStartAccountResolver,
  agent: string,
): Promise<SessionForkTargetAccount> {
  try {
    return await accounts(agent);
  } catch (error) {
    throw new SessionForkTargetResolutionError(
      unknownAgent(error) ? 'unknown_agent' : 'agent_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export class SessionForkTargetResolver implements SessionForkTargetResolverPort {
  constructor(private readonly ports: SessionForkTargetResolverPorts) {}

  async resolve(command: Pick<SessionForkCommand, 'agent' | 'model' | 'effort'>): Promise<TransferTargetChoice> {
    const resolved = await resolveForkTargetAccount(this.ports.accounts, command.agent);
    const account = resolved.account;
    // The planner owns both of these, AND IT MAY REFUSE. A caller's model used to be a request the
    // resolver silently downgraded — "an account that cannot serve it resolves to the one it can" —
    // which is the defect: the choice froze the substitute, so the binder's later drift comparison had
    // nothing to disagree with, and the fork ran a model the caller never named at a different price
    // and in a different context window. `agent_unavailable` is the wire's own word for "that agent
    // exists and cannot serve this fork", which is exactly what happened; the account's own reason
    // travels in the message.
    const planned = this.ports.planner.plan({
      id: RESOLUTION_PROBE_ID,
      account,
      mode: 'auto',
      ...(command.model === null ? {} : { requestedModel: command.model }),
    });
    if (planned.kind === 'unservable-model')
      throw new SessionForkTargetResolutionError('agent_unavailable', planned.reason);
    return {
      accountId: account.id,
      agent: account.agent,
      // The RESOLVED account's declared family, never a string the caller or this adapter chose.
      harness: account.kind,
      model: planned.plan.model,
      effort: command.effort,
      contextWindow: planned.plan.contextWindow,
    };
  }

  /**
   * Proves a resolved choice is serviceable IN THE DIRECTORY THE PLAN FROZE, before anything is
   * created.
   *
   * A SEPARATE STEP FROM `resolve`, and the separation is the whole point. `CodexRuntimeCatalogCache`
   * keys its live answer by `(executable, working directory)`, because a Codex account advertises a
   * different catalogue in a project that configures one — and the target's working directory is the
   * SOURCE's, which only exists once preparation has read the source. Validating during `resolve`
   * would therefore have to invent a directory and would be answering about a catalogue no session
   * will ever run under. So the order is resolve → prepare → validate → claim, and this is the third
   * step: it runs before the receipt is claimed, so an effort this account cannot serve is an
   * ordinary refusal instead of a durable fork that can never finish.
   *
   * The decision is `planRuntimeSwitch`'s, reached through the same service the runtime route calls.
   * A `drive_picker` answer is a SUCCESS even when it carries `quickPickerAppliesPreset`: that flag
   * says the driver must read the real screen before selecting a row, which is the driver's problem
   * and not a reason to refuse a fork the account can serve.
   */
  async validate(target: TransferTargetChoice, cwd: string): Promise<void> {
    const startup = forkStartupRuntimeRequest(target.harness, target.model, target.effort);
    if (startup === undefined) return;
    const resolved = await resolveForkTargetAccount(this.ports.accounts, target.agent);
    if (resolved.account.id !== target.accountId || resolved.account.kind !== target.harness)
      throw new SessionForkTargetResolutionError(
        'agent_unavailable',
        `agent ${target.agent} now resolves to account ${resolved.account.id} (${resolved.account.kind}) rather ` +
          `than the ${target.accountId} (${target.harness}) this fork was decided for`,
      );
    const wanted: HarnessRuntimeSwitchRequest = {
      harness: target.harness,
      ...(startup.action === 'model' && startup.model !== undefined ? { model: startup.model } : {}),
      ...(startup.action === 'compact' || startup.effort === undefined ? {} : { effort: startup.effort }),
    };
    const plan = this.ports.harness.planSwitch(wanted, {
      wrapper: resolved.account.agent,
      // Read ONLY where a targeted picker switch needs one, exactly as the runtime route reads it:
      // a harness that takes the effort as a command needs no catalogue, and probing for one would
      // make a fork fail on an account whose catalogue is momentarily unreadable but whose effort
      // vocabulary is fixed.
      ...(wanted.model === undefined
        ? {}
        : { catalog: codexSwitchContext(codexRuntimeCatalog(await this.choices(resolved, cwd))) }),
    });
    if (plan.kind === 'refused')
      throw new SessionForkTargetResolutionError(
        'agent_unavailable',
        `account ${resolved.account.agent} cannot start a session at the requested reasoning level: ${plan.reason}`,
      );
  }

  /** The live Codex catalogue, from the one held cache, for the exact directory the target runs in. */
  private async choices(resolved: SessionForkTargetAccount, cwd: string): Promise<readonly RuntimeModelChoice[]> {
    try {
      return await this.ports.catalog.get(resolved.executable, cwd);
    } catch (error) {
      throw new SessionForkTargetResolutionError(
        'agent_unavailable',
        `the model catalogue for account ${resolved.account.agent} could not be read, so a fork cannot be ` +
          `planned against it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Whether a resolution failure was "no such agent" rather than "that agent cannot serve". */
function unknownAgent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'failure' in error &&
    (error as { readonly failure: unknown }).failure === 'unknown_agent'
  );
}
