/**
 * Changing what a RUNNING session is running, and reading what it may be changed to.
 *
 * THE DECISION IS NOT MADE HERE EITHER. `HarnessQuirkService.planSwitch` answers "refuse", "type this
 * command" or "drive the picker to this exact target", and this service only performs the answer
 * under the guarantees below. What it owns is the ORDER of things — which is the whole of the safety.
 *
 * FOUR PRECONDITIONS, IN THIS ORDER, and each one is a different question:
 *
 *   1. The session exists in the EXACT lifecycle status this caller may drive: `running` for the
 *      mounted control and `starting` for daemon-private startup.
 *   2. It is not holding the picker quarantine.
 *   3. Its pane is alive.
 *   4. Its harness is at an IDLE PROMPT.
 *
 * THE ANSWER IS THE SAME SESSION VIEW EVERY OTHER SURFACE READS, re-read after the act rather than
 * projected from it. The daemon must not claim the switch took: for Codex it is `thread_settings` in
 * the harness's own transcript that says so, and the observation projection picks that up on the very
 * next read. A view assembled here from what was REQUESTED would be the configured-model lie this
 * whole row exists to remove, one layer further in.
 *
 * IT LIVES IN THE DOMAIN, not in the composition root. The one durable effect ledger, both admission
 * checks, all four preconditions, the catalog gate and the quarantine ordering are therefore proved
 * without constructing a second mount-owned runtime implementation.
 */

import type { RuntimeControlRequest, RuntimeModelCatalog, SessionView } from '@ferretry/protocol';
import {
  type AccountInventoryPort,
  type CoreAccount,
  findAccountByAgent,
  servableModels,
} from '../../core/inventory.ts';
import { jsonObject, type JsonValue } from '../../json.ts';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { SessionEffectAdmission, SessionEffectKey, SessionEffectLedger } from '../effects/types.ts';
import type { CodexRuntimeCatalogCache } from '../harness/codex-catalog-cache.ts';
import { claudeRuntimeCatalog, codexRuntimeCatalog, codexSwitchContext } from '../harness/model-catalog.ts';
import { CodexModelPickerDriver, type PickerSleeper } from '../harness/picker-drive.ts';
import { failureMessage } from '../harness/quarantine.ts';
import type { RuntimeSwitchPlan } from '../harness/runtime-switch.ts';
import type { HarnessQuirkService } from '../harness/service.ts';
import { runtimeRequestFingerprint } from './ledger.ts';
import { documentRefusal, needsLiveCatalog, paneRefusal, switchRequest } from './policy.ts';
import {
  type RuntimeInjector,
  type RuntimePane,
  type RuntimePickerTransport,
  type RuntimeQuarantinePatch,
  type RuntimeRepository,
  SessionRuntimeError,
  type SessionRuntimeStartupHeldPort,
  type SessionRuntimeSubsystem,
} from './types.ts';

/** The command each harness answers with its own native model picker. */
export const HARNESS_PICKER_COMMAND = '/model';
/** The harness-native context command. It is not a message and never advances the turn. */
export const HARNESS_COMPACT_COMMAND = '/compact';

/**
 * Merge picker quarantine fields without weakening a verified failed-stop verdict.
 *
 * The storage adapter calls this inside its atomic state update. A standing `kill_failed` owns the
 * termination result, so runtime recovery may close its input gates and add diagnostics but may not
 * replace the status, reason, finish time, exit code, or any other terminal evidence.
 */
export function runtimeQuarantineState(current: JsonValue, patch: RuntimeQuarantinePatch): JsonValue {
  const state = jsonObject(current) ?? {};
  if (state.status !== 'kill_failed') return { ...state, ...patch };
  return {
    ...state,
    health: patch.health,
    promptReady: patch.promptReady,
    needsHuman: patch.needsHuman,
    needsHumanKind: patch.needsHumanKind,
  };
}

export interface SessionRuntimeControlPorts {
  readonly repository: RuntimeRepository;
  /** Durable begun/settled ownership for every irreversible runtime-control request. */
  readonly effects: SessionEffectLedger;
  readonly pane: RuntimePane;
  readonly injector: RuntimeInjector;
  readonly picker: RuntimePickerTransport;
  /** The per-harness decision and the recovery for a picker drive that failed part-way. */
  readonly harness: HarnessQuirkService;
  readonly accounts: AccountInventoryPort;
  /** One held catalog per account, so opening the model sheet twice does not spawn two probes. */
  readonly catalog: CodexRuntimeCatalogCache;
  /** Serializes controls per session: two drives into one modal is the failure this prevents. */
  readonly serial: SerialExecutor;
  readonly sleeper: PickerSleeper;
  readonly clock: ClockPort;
  /** The CLI a quarantined session tells a human to type. Never this daemon's own name. */
  readonly clientName: string;
}

export class SessionRuntimeControlService implements SessionRuntimeSubsystem, SessionRuntimeStartupHeldPort {
  constructor(private readonly ports: SessionRuntimeControlPorts) {}

  async models(reference: string): Promise<RuntimeModelCatalog> {
    return await this.#catalogFor(this.#require(reference));
  }

  async control(reference: string, request: RuntimeControlRequest, requestId: string): Promise<SessionView> {
    const id = this.#require(reference);
    const effect = this.#effect(id, request, requestId);
    // A settled retry need not wait behind a live picker drive. The held path repeats this check,
    // because only that second read can exclude two concurrent first attempts.
    const replay = await this.#replay(effect, requestId);
    if (replay !== undefined) return replay;
    return await this.ports.serial.run(
      id,
      async () => await this.#driveWhileHeld(effect, request, requestId, 'public'),
    );
  }

  /** The daemon-private half; its lifecycle caller already owns this session's mutation fence. */
  async startupWhileHeld(reference: string, request: RuntimeControlRequest, requestId: string): Promise<void> {
    const id = this.#require(reference);
    await this.#driveWhileHeld(this.#effect(id, request, requestId), request, requestId, 'startup');
  }

  /** Both refusals kept apart, because they are two different mistakes and two different statuses. */
  #require(reference: string): SessionId {
    const found = this.ports.repository.find(reference);
    if (found.kind === 'invalid')
      throw new SessionRuntimeError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    if (found.kind === 'missing') throw new SessionRuntimeError('not_found', `no session ${reference}`);
    return found.id;
  }

  async #view(id: SessionId): Promise<SessionView> {
    const current = await this.ports.repository.view(id).catch((error: unknown) => {
      throw new SessionRuntimeError('failed', failureMessage(error));
    });
    if (current === undefined)
      throw new SessionRuntimeError('failed', `session ${id} exists but its documents do not satisfy the protocol`);
    return current;
  }

  /** The launch document, which is where the pane name and the account's own executable live. */
  async #launch(id: SessionId) {
    const launch = await this.ports.repository.launch(id);
    if (launch === undefined)
      throw new SessionRuntimeError('failed', `session ${id} has no readable launch record to address its pane with`);
    return launch;
  }

  /** The published account this session runs on, by the executable NAME its record carries. */
  async #accountFor(agent: string): Promise<CoreAccount> {
    const published = await this.ports.accounts.accounts().catch((error: unknown) => {
      throw new SessionRuntimeError('catalog_unavailable', failureMessage(error));
    });
    const account = findAccountByAgent(published, agent);
    if (account === undefined)
      throw new SessionRuntimeError(
        'catalog_unavailable',
        `no account is published under ${agent}, so this session's model choices cannot be read`,
      );
    return account;
  }

  async #catalogFor(id: SessionId): Promise<RuntimeModelCatalog> {
    const current = await this.#view(id);
    if (current.config.harness !== 'codex') {
      const account = await this.#accountFor(current.config.agent);
      const claude = claudeRuntimeCatalog(account);
      // AN EMPTY CLAUDE CATALOG IS A FAILURE, NOT AN ANSWER. `servableModels` empties for an account
      // the manifest declared down, and the browser's native-picker escape hatch is Codex-only — so a
      // `200` with no choices renders a blank sheet with no explanation, which is the plausible-empty
      // response this row exists to delete. An account that cannot serve a session cannot serve a
      // switch into one either, and it must say so.
      if (claude.choices.length === 0)
        throw new SessionRuntimeError(
          'catalog_unavailable',
          account.available
            ? `account ${account.agent} publishes no available model, so this session cannot be switched`
            : `account ${account.agent} is unavailable (${account.unavailableReason ?? 'no reason published'}), so this session cannot be switched`,
        );
      return claude;
    }
    const launch = await this.#launch(id);
    const choices = await this.ports.catalog.get(launch.agent, launch.cwd).catch((error: unknown) => {
      throw new SessionRuntimeError('catalog_unavailable', failureMessage(error));
    });
    return codexRuntimeCatalog(choices);
  }

  /** Types one native command, and refuses if the harness read it as a turn instead of a command. */
  async #inject(tmuxSession: string, command: string): Promise<void> {
    const outcome = await this.ports.injector.deliver(tmuxSession, command).catch((error: unknown) => {
      throw new SessionRuntimeError('failed', failureMessage(error));
    });
    if (outcome !== 'handled-local')
      throw new SessionRuntimeError(
        'failed',
        `the harness consumed ${command} as a model turn instead of a native runtime control`,
      );
  }

  /**
   * Drive the picker, and if that throws, close whatever it left open BEFORE anything else.
   *
   * The quarantine is written durably before the pane is stopped, so a stop that also fails still
   * leaves the input gates closed — a decision held only in memory is undone by the next restart,
   * which is exactly when nobody is watching.
   */
  async #drivePicker(
    id: SessionId,
    tmuxSession: string,
    plan: Extract<RuntimeSwitchPlan, { kind: 'drive_picker' }>,
  ): Promise<void> {
    const driver = new CodexModelPickerDriver(this.ports.picker(tmuxSession), this.ports.sleeper);
    try {
      await driver.drive(plan.target);
    } catch (failure) {
      const recovery = await this.ports.harness.recoverFromFailedDrive(tmuxSession, failure);
      if (recovery.kind === 'recovered') throw new SessionRuntimeError('failed', failureMessage(failure));
      await this.ports.repository.quarantine(id, {
        status: 'failed',
        health: 'crashed',
        promptReady: false,
        finishedAt: this.ports.clock.now(),
        reason: recovery.quarantine.reason,
        needsHuman: recovery.quarantine.needsHuman,
        needsHumanKind: recovery.quarantine.needsHumanKind,
      });
      await this.ports.repository.journal(id, 'session.codex_picker_quarantined', recovery.quarantine.evidence);
      const stopFailure = await this.ports.pane
        .stop(tmuxSession)
        .then(() => undefined)
        .catch((error: unknown) => error);
      throw new SessionRuntimeError('failed', this.ports.harness.report(recovery.quarantine, stopFailure));
    }
  }

  async #apply(
    id: SessionId,
    request: RuntimeControlRequest,
    admits: 'public' | 'startup',
    /** Called the instant before the harness is touched, so a retry can never repeat a keystroke. */
    spend: () => Promise<Extract<SessionEffectAdmission, 'perform' | 'settled'>>,
  ): Promise<{ readonly performed: boolean }> {
    const current = await this.#view(id);
    const refused = documentRefusal(current, this.ports.clientName, admits);
    if (refused !== undefined) throw refused;

    const launch = await this.#launch(id);
    const pane = await this.ports.pane.state(launch.tmuxSession);
    const unusable = paneRefusal(pane);
    if (unusable !== undefined) throw unusable;

    if (request.action === 'compact') {
      // Spent BEFORE the keystrokes. `/compact` is the least naturally idempotent arm in the union —
      // compacting twice discards context nobody asked to lose — and it is the arm whose bookkeeping
      // can still fail after the harness has already done the work.
      if ((await spend()) === 'settled') return { performed: false };
      await this.#inject(launch.tmuxSession, HARNESS_COMPACT_COMMAND);
      await this.ports.repository.journal(id, 'control.session_command', {
        harness: current.config.harness,
        command: 'compact',
      });
      return { performed: true };
    }

    const wanted = switchRequest(current, request);
    const plan = this.ports.harness.planSwitch(wanted, {
      wrapper: current.config.agent,
      ...(current.config.harness === 'codex'
        ? {}
        : { allowedModels: servableModels(await this.#accountFor(current.config.agent)).map(model => model.id) }),
      ...(needsLiveCatalog(wanted) ? { catalog: codexSwitchContext(await this.#catalogFor(id)) } : {}),
    });

    if (plan.kind === 'refused') throw new SessionRuntimeError('unsupported', plan.reason);
    // Everything above this line is decision and refusal, and none of it has touched the pane. The id
    // is spent HERE, on the last line before the first keystroke — a refused plan leaves the id unspent
    // so the caller may fix the request and reuse it, and a driven pane can never be driven again.
    if ((await spend()) === 'settled') return { performed: false };
    if (plan.kind === 'inject') await this.#inject(launch.tmuxSession, plan.command);
    else await this.#drivePicker(id, launch.tmuxSession, plan);

    await this.ports.repository.journal(id, 'control.runtime_model', {
      harness: current.config.harness,
      ...(wanted.model === undefined ? {} : { requestedModel: wanted.model }),
      ...(wanted.effort === undefined ? {} : { requestedEffort: wanted.effort }),
      // A bare picker open is the one arm where the daemon made no choice, so it claims none.
      ...(plan.kind === 'inject' && !plan.claimsOutcome ? { picker: true } : {}),
    });
    return { performed: true };
  }

  #effect(
    id: SessionId,
    request: RuntimeControlRequest,
    requestId: string,
  ): { readonly id: SessionId; readonly key: SessionEffectKey; readonly fingerprint: string } {
    return {
      id,
      key: { sessionId: id, effectId: `runtime:${requestId}` },
      fingerprint: runtimeRequestFingerprint(request),
    };
  }

  async #replay(
    effect: { readonly id: SessionId; readonly key: SessionEffectKey; readonly fingerprint: string },
    requestId: string,
  ): Promise<SessionView | undefined> {
    const standing = await this.ports.effects.inspect(effect.key, effect.fingerprint).catch((error: unknown) => {
      throw new SessionRuntimeError('failed', failureMessage(error));
    });
    if (standing === 'unclaimed') return undefined;
    if (standing === 'settled') return await this.#view(effect.id);
    if (standing === 'conflict')
      throw new SessionRuntimeError(
        'conflict',
        `request id ${JSON.stringify(requestId)} was already spent on a different runtime control for this session`,
      );
    throw new SessionRuntimeError(
      'unsettled',
      `request id ${JSON.stringify(requestId)} already began a runtime control on this session and its outcome was not recorded; the pane may have been touched, so read the session rather than retrying`,
    );
  }

  /**
   * One control while the process-wide session mutation fence is already held.
   *
   * Public control reaches this through `serial.run`; startup reaches it from the lifecycle's
   * `beforeFirstTurn` callback. This method must never acquire the non-reentrant serial itself.
   */
  async #driveWhileHeld(
    effect: { readonly id: SessionId; readonly key: SessionEffectKey; readonly fingerprint: string },
    request: RuntimeControlRequest,
    requestId: string,
    admits: 'public' | 'startup',
  ): Promise<SessionView> {
    const queued = await this.#replay(effect, requestId);
    if (queued !== undefined) return queued;
    const outcome = await this.#apply(effect.id, request, admits, async () => {
      const admission = await this.ports.effects
        .begin(effect.key, effect.fingerprint, this.ports.clock.now())
        .catch(error => {
          throw new SessionRuntimeError('failed', failureMessage(error));
        });
      if (admission === 'conflict')
        throw new SessionRuntimeError(
          'conflict',
          `request id ${JSON.stringify(requestId)} was already spent on a different runtime control for this session`,
        );
      if (admission === 'unsettled')
        throw new SessionRuntimeError(
          'unsettled',
          `request id ${JSON.stringify(requestId)} already began a runtime control on this session and its outcome was not recorded; the pane may have been touched, so read the session rather than retrying`,
        );
      return admission;
    });
    // Settle after the pane effect and journal, but before the response projection. A failed final
    // read can then replay from the durable fact without repeating any keystroke.
    if (outcome.performed)
      await this.ports.effects.settle(effect.key, effect.fingerprint, this.ports.clock.now()).catch(error => {
        throw new SessionRuntimeError('failed', failureMessage(error));
      });
    return await this.#view(effect.id);
  }
}
