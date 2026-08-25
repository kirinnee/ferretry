/**
 * The single place a session id enters a fork's write surface.
 *
 * `bind` takes the reserved target id ONCE and hands back the whole write surface. Not one method on
 * that surface accepts a session id, so there is no argument through which a writer could be aimed at
 * the source and no code path that could pass one by mistake. The one method that still names an id —
 * the seam's `importPlan(plan, newSessionId)`, which requires it explicitly by contract — is checked
 * against the bound id before the importer is even constructed.
 *
 * WHAT IT RECONCILES, AND WHY ON EVERY OPERATION RATHER THAN ONLY ON `create`. Every step after the
 * durable receipt is claimed may be replayed, and the fork service SKIPS the phases its receipt
 * already records — so a replay resuming at `plan_persisted` or later never reaches `create` at all.
 * Reconciling only there would leave a corrupted or substituted target imported into, captured for
 * and started with nothing having proved it was the session the receipt reserved. So every bound
 * operation proves the target first: the id, the canonical working directory, the mode, the
 * authorized base command, a fresh identity, incarnation, runtime generation and credential, no
 * parent, `boardAccess: 'none'`, the whole plan-derived durable configuration, the lineage edge once
 * an import has written one, and the persisted plan compared VALUE FOR VALUE rather than by its
 * derived id. A disagreement refuses; it never overwrites, never creates a second target and never
 * starts one.
 *
 * THE ORDER IS IMPORT → PROVENANCE → START, and the launch argv is what makes that possible. A
 * session is created with its authorized BASE command, which is enough for the record to be
 * authorized and complete but is not yet a launch. Only after the import has succeeded is the
 * target's OWN transcript provenance captured, and the arguments that make that provenance true are
 * appended to the command in the SAME atomic document write that records it. Starting then launches
 * a wrapper whose argv and whose recorded transcript identity were decided together.
 *
 * THE SOURCE'S PROVENANCE IS NEVER COPIED. It names a harness home, a foreign session id and a
 * correlation token this daemon injected into that session and no other, so a copy would point the
 * new session's parser at somebody else's file. A replay REUSES the capture already recorded rather
 * than minting a second one, because for a harness whose session id the daemon mints, capturing
 * twice renames the transcript the first launch was going to write.
 *
 * THE OPENING TURN HAS ONE SET OF BYTES. The seam's brief writer and the lifecycle's own turn-one
 * document are the same file, and both are written from the same frozen plan through
 * {@link forkOpeningTurn} — so whichever writes last, and however many times a crash replays them,
 * the document the new agent reads is identical.
 */

import { createHash } from 'node:crypto';
import {
  type SessionConfig,
  SessionConfigSchema,
  type SessionTransferPlan,
  type SessionView,
  type TranscriptProvenance,
} from '@ferretry/protocol';
import type { CoreAccount } from '../../lib/core/inventory.ts';
import type { SessionPlanner } from '../../lib/core/session-planner.ts';
import type {
  SessionForkBoundTarget,
  SessionForkTargetBinder as SessionForkTargetBinderPort,
} from '../../lib/fork/types.ts';
import type { ClockPort } from '../../lib/ports.ts';
import { harnessQuirks } from '../../lib/session/harness/quirks.ts';
import { startupModelArguments } from '../../lib/session/harness/startup.ts';
import { assignedTaskDocument } from '../../lib/session/lifecycle/policy.ts';
import type { SessionRuntimeStartupHeldPort } from '../../lib/session/runtime-control/types.ts';
import {
  type LifecycleSessionStatus,
  MAX_ASSIGNED_TASK_LENGTH,
  SESSION_BOARD_CAPABILITY_VARIABLE,
  type SessionEnvironmentStore,
  type SessionLifecycleRecord,
} from '../../lib/session/lifecycle/types.ts';
import { claudeSessionArguments, claudeTranscriptFile } from '../../lib/session/transcript/claude-path.ts';
import type { SessionLifecycleService } from '../../lib/session/lifecycle/service.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import type { TranscriptProvenanceCapture } from '../../lib/session/transcript/provenance.ts';
import { renderTransferBrief } from '../../lib/transfer/brief.ts';
import { transferTargetLabel } from '../../lib/transfer/facets/lineage.ts';
import { SessionTransferImporter } from '../../lib/transfer/import.ts';
import type {
  SessionTransferImportOutcome,
  SessionTransferImportPorts,
  TransferBriefWriter,
} from '../../lib/transfer/types.ts';
import {
  type SessionForkStartAccountResolver,
  type SessionForkTargetAccount,
  type SessionForkTargetResolver,
  forkStartupRuntimeRequest,
  resolveForkTargetAccount,
} from './session-fork-target-resolver.ts';
import { storedTranscriptProvenance } from '../session/transcript/storage-transcript-provenance.ts';
import { transferSpawnProvenance } from '../transfer/storage-transfer-envelope-writer.ts';
import {
  type SessionProtocolEnvelope,
  StorageSessionLifecycleRepository,
} from '../session/lifecycle/storage-session-lifecycle-repository.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';
import type { JsonValue } from '../../lib/json.ts';
import { SessionAttachmentCopyError } from '../transfer/attachment-copier.ts';

/**
 * The startup-only half of the daemon's ONE runtime subsystem.
 *
 * NARROW ON PURPOSE, and deliberately not `SessionRuntimeSubsystem`. The mounted control admits only
 * a `running` session; this admits only a `starting` one, so the window between a fork's launch and
 * its first turn has exactly one owner and an ordinary control cannot race the startup picker from
 * another queue. The composition root supplies both halves of the same instance — the same durable
 * effect ledger, the same runtime decision service and catalogue cache, the same per-session queue —
 * so nothing here is a second anything.
 *
 * It answers nothing. A fork's startup control is applied for its effect on the pane, and the view
 * the fork reports is read afterwards from the session itself.
 */
/**
 * A target that cannot be shown to be the one this plan reserved.
 *
 * One class rather than a code per check: every one of them means the same thing to a caller — this
 * fork cannot be carried out, nothing was destroyed on the way to finding out, and presenting the
 * same request id again re-drives the same fork. The MESSAGE names which agreement failed, because
 * that is the part an operator has to act on.
 */
export class SessionForkTargetBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionForkTargetBindingError';
  }
}

export interface SessionForkTargetBinderPorts {
  /**
   * The daemon's authoritative session documents.
   *
   * Every call this adapter makes is keyed by the bound target id. The source is reachable through
   * the importer's read-only conversation validator and through nothing else here.
   */
  readonly storage: DaemonStorage;
  /**
   * The composition root's own lifecycle factory, with the target id already decided.
   *
   * The envelope is present only for the CREATE — a later transition merges over the document
   * already on disk, and passing an envelope again would restate protocol fields the transfer
   * envelope writer has since made authoritative.
   */
  readonly createLifecycle: (targetSessionId: SessionId, envelope?: SessionProtocolEnvelope) => SessionLifecycleService;
  readonly accounts: SessionForkStartAccountResolver;
  /**
   * The same resolver the fork service resolved this target with, for its `validate` half.
   *
   * The core validates before the receipt is claimed, which is where a refusal costs nothing. This
   * second call is the belt: a fork whose receipt was claimed by an older daemon, or before the
   * pre-claim validation existed, must still not launch a session at a level its account cannot
   * serve. Both calls hit the one held catalogue entry, so the second is a cached no-op.
   */
  readonly runtimeChoice: Pick<SessionForkTargetResolver, 'validate'>;
  readonly planner: SessionPlanner;
  /**
   * The plan copy that lives beneath the target session.
   *
   * Narrow on purpose: the binder installs one plan and reads it back, and a replay recovers the
   * decision from the target's own directory rather than from a source that has moved on. The
   * implementation must refuse a target already holding a DIFFERENT plan, which is the durable half
   * of "one transfer creates one session".
   */
  readonly plans: {
    read(targetSessionId: SessionId): Promise<SessionTransferPlan | undefined>;
    install(targetSessionId: SessionId, plan: SessionTransferPlan): Promise<unknown>;
  };
  /**
   * The evidence the target's own transcript is identified from, taken before its first launch.
   *
   * Declared as the capture METHOD rather than the class, because that is the whole of what a fork
   * needs and a narrower port is a narrower thing to get wrong.
   */
  readonly transcripts: Pick<TranscriptProvenanceCapture, 'capture'>;
  /**
   * The importer's port set: a pinned conversation validator, a hash and size verifying attachment
   * copier, an atomic brief writer and the target-only envelope writer. No board, no child grant, no
   * lifecycle, no stop and no source writer — the type itself forbids them.
   */
  readonly importPorts: SessionTransferImportPorts;
  /**
   * Read-only proofs for artifacts the importer already claimed were durable.
   *
   * These are kept outside the seam's write-only port set: later fork phases may prove the target
   * still holds the frozen brief and attachment bytes, but cannot silently repair either immediately
   * before launch.
   */
  readonly imported: {
    readonly brief: {
      file(targetSessionId: string): string;
      matches(targetSessionId: string, expected: string): Promise<boolean>;
    };
    readonly attachments: {
      verifyTarget(input: {
        readonly newSessionId: string;
        readonly expectedManifest: SessionTransferPlan['facets']['attachments']['attachments'][number];
      }): Promise<void>;
    };
  };
  /** The target's private environment, used only to prove its hash-bearing credential exists. */
  readonly environment: Pick<SessionEnvironmentStore, 'read'>;
  /** The lifecycle policy's own deterministic tmux name for this target id. */
  readonly tmuxSession: (targetSessionId: SessionId) => string;
  /** The startup half of the one runtime subsystem, used to apply the fork's effort before turn one. */
  readonly runtime: SessionRuntimeStartupHeldPort;
  /** The view every other surface reads, so a fork answers with the session they will show. */
  readonly view: (targetSessionId: SessionId) => Promise<SessionView | undefined>;
  /** The target's own private directory: the string a rollout is later correlated by. */
  readonly sessionDirectory: (targetSessionId: SessionId) => string;
  readonly clock: ClockPort;
}

/**
 * The exact opening-turn text a fork hands its new agent, derived from the frozen plan alone.
 *
 * TWO WRITERS, ONE DOCUMENT. The seam's brief writer puts this at `turns/turn-001.md` during import,
 * and the lifecycle writes its own turn-one document to the same path when it delivers the first
 * turn. Rendering both from this one function — through the lifecycle's own `assignedTaskDocument`
 * envelope — makes them byte-identical, so neither can tear the other and a replay of either
 * converges instead of oscillating between two spellings of the same brief.
 */
export function forkOpeningTurn(plan: SessionTransferPlan): string {
  return renderTransferBrief(plan, 'fork').trim();
}

/**
 * Why this plan's opening turn could not be delivered, or `undefined` when it can.
 *
 * IT IS MEASURED BEFORE THE RECEIPT IS CLAIMED, and that is the whole reason it is a separate,
 * exported function. The lifecycle refuses a prompt longer than `MAX_ASSIGNED_TASK_LENGTH`, and the
 * fork's prompt IS the rendered brief — so a large enough carried conversation would otherwise claim
 * a durable receipt whose target can never be created, and every retry of that request would fail
 * identically forever. Asking here turns it into an ordinary refusal of a fork that was never begun.
 *
 * It reads the lifecycle's OWN constant rather than a number repeated here, so the check and the
 * schema that enforces it cannot drift into disagreeing about which conversations are forkable.
 */
export function forkOpeningTurnRefusal(plan: SessionTransferPlan): string | undefined {
  const opening = forkOpeningTurn(plan);
  if (opening.length === 0)
    return `plan ${plan.planId} renders an empty opening turn, so the forked session would be handed no context at all`;
  if (opening.length > MAX_ASSIGNED_TASK_LENGTH)
    return (
      `plan ${plan.planId} renders an opening turn of ${opening.length} characters, and a session's first turn is ` +
      `limited to ${MAX_ASSIGNED_TASK_LENGTH}; the conversation must be cut at an earlier message to be forkable`
    );
  return undefined;
}

/** Stable JSON: keys sorted recursively, so two equal values compare equal however they were built. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`).join(',')}}`;
}

/** A JSON document as a plain field bag; anything else contributes no fields. */
function fields(document: unknown): Readonly<Record<string, unknown>> {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Readonly<Record<string, unknown>>)
    : {};
}

/** One agreement the persisted target must satisfy, or the prose that says it does not. */
function agree(subject: string, actual: unknown, expected: unknown): string | undefined {
  return actual === expected
    ? undefined
    : `its ${subject} is ${JSON.stringify(actual)} rather than ${JSON.stringify(expected)}`;
}

/** One agreement that is not an equality. */
function demand(held: boolean, complaint: string): string | undefined {
  return held ? undefined : complaint;
}

/** Everything decided about a target before its record is created or proved. */
interface ForkTargetShape {
  readonly account: CoreAccount;
  readonly executable: string;
  /** The authorized command a fork creates with. Capture may only ever APPEND to it. */
  readonly command: readonly string[];
  readonly prompt: string;
  readonly tmuxSession: string;
  readonly envelope: SessionProtocolEnvelope;
}

interface ProvedForkTarget {
  readonly shape: ForkTargetShape;
  readonly record: SessionLifecycleRecord;
  readonly document: unknown;
}

export class SessionForkTargetBinder implements SessionForkTargetBinderPort {
  constructor(private readonly ports: SessionForkTargetBinderPorts) {}

  /**
   * Binds the whole write surface to one target id AND to the receipt's own frozen plan.
   *
   * THE PLAN IS BOUND FOR THE SAME REASON THE ID IS. Three of the six operations take no plan
   * argument, and if they reconciled against whatever plan is installed beneath the target they
   * would be proving a document against itself: a SECOND, valid decision written under the same
   * derived plan id would be adopted by every later phase, self-consistently, and the fork would
   * finish having carried a conversation nobody chose. Anchoring to the receipt's plan is what makes
   * "one request, one frozen decision" hold for the phases that run after a crash as well as the
   * ones that run before it.
   */
  bind(targetSessionId: string, plan: SessionTransferPlan): SessionForkBoundTarget {
    const id = tryParseSessionId(targetSessionId);
    if (id === undefined)
      throw new SessionForkTargetBindingError(
        `${JSON.stringify(targetSessionId)} is not a usable session id, so no fork write surface can be bound to it`,
      );
    return {
      lifecycle: {
        create: async applied => await this.create(id, this.bound(plan, applied)),
        captureTranscriptProvenance: async () => await this.capture(id, plan),
        start: async () => await this.start(id, plan),
        view: async () => await this.observe(id, plan),
      },
      plans: { persist: async applied => await this.persist(id, this.bound(plan, applied)) },
      importer: {
        importPlan: async (applied, newSessionId) => await this.importPlan(id, this.bound(plan, applied), newSessionId),
      },
    };
  }

  /**
   * The plan an operation was handed, proved to be the plan this surface was bound to.
   *
   * A caller that drives one fork's write surface with another fork's plan is a defect in this
   * daemon rather than a caller error, and it is the one way a bound surface could still be aimed at
   * the wrong decision. Comparing by value rather than by id is deliberate: the id is derived, so two
   * different decisions can legitimately carry the same one.
   */
  private bound(receipt: SessionTransferPlan, applied: SessionTransferPlan): SessionTransferPlan {
    if (canonical(receipt) !== canonical(applied))
      throw new SessionForkTargetBindingError(
        `a write surface bound to plan ${receipt.planId} was driven with a different decision (${applied.planId}): ` +
          'every operation of one fork applies the one plan its receipt froze',
      );
    return receipt;
  }

  // ─── create and reconcile ──────────────────────────────────────────────────────────────────

  /**
   * Creates the target under the reserved id, or proves the one already there is that target.
   *
   * The title and the callsign are deliberately NOT passed. §12.3 rules both non-durable: a name is
   * reallocated for the new session — the lifecycle derives one from the opening turn — and a
   * callsign is a claimed, unique identity that two sessions cannot share, so carrying the source's
   * would make a bare callsign resolve to both.
   */
  private async create(id: SessionId, plan: SessionTransferPlan): Promise<void> {
    this.assertFresh(id, plan);
    const shape = await this.shape(id, plan);
    // Proved against the directory the plan froze, and before the record exists: an effort this
    // account cannot serve must never cost a session that holds a copied conversation.
    await this.ports.runtimeChoice.validate(plan.target, plan.durable.cwd);
    const held = await this.record(id);
    const record =
      held ??
      (await this.ports.createLifecycle(id, shape.envelope).create({
        agent: shape.executable,
        command: [...shape.command],
        cwd: plan.durable.cwd,
        mode: plan.durable.mode,
        prompt: shape.prompt,
      }));
    this.assertReconciled(id, plan, shape, record, await this.ports.storage.readConfig(id), {
      edge: 'optional',
      states: ['created'],
    });
    await this.assertCredential(id, record);
    await this.assertPlanReconciled(id, plan, { required: false });
    // LAST, and only for a record this fork ADOPTED: everything above has just proved that record is
    // the target this plan reserved, and the repair below writes into its journal on the strength of
    // exactly that proof.
    if (held !== undefined) await this.repairCreationBoundary(id, held);
  }

  /**
   * Completes the one durable prefix an adopted target is allowed to be missing.
   *
   * WHAT THE HOLE IS. Lifecycle creation publishes the configuration, then the state, then appends
   * `session.created`. A process that dies between the state write and the append leaves a record
   * that reads back perfectly well as `created` — that tear is deliberately recoverable — but whose
   * journal is empty. A fork replay ADOPTS that record instead of calling `create` again, so nothing
   * ever appends the event. The receipt then stamps `target_created` and the later transitions append
   * `session.starting` and `session.running`, leaving a session whose durable narrative begins in the
   * middle and can never be repaired, because every later attempt adopts the same record.
   *
   * SO THE REPAIR IS EXACTLY THE KNOWN PREFIX AND NOTHING ELSE. An empty journal on a record still in
   * `created` has one possible completion, and it is derived from the record this binder has just
   * finished proving rather than invented here. The one already-complete shape — exactly that
   * canonical `session.created` event and nothing after it — is accepted unchanged on replay. Any
   * other event, payload or suffix is not the prefix this repairs; appending a creation boundary
   * after a session has started would manufacture a narrative that never happened, so it refuses.
   *
   * IT RUNS BEFORE THE RECEIPT MAY STAMP `target_created`, because the whole point is that a target
   * the receipt has admitted must already have a complete ordered narrative.
   */
  private async repairCreationBoundary(id: SessionId, record: SessionLifecycleRecord): Promise<void> {
    // A target past `created` was started by somebody, so its journal is not the prefix this repairs.
    if (record.state.status !== 'created') return;
    // The canonical event lifecycle creation would have appended, derived from the record this binder
    // has just proved rather than assembled here.
    const creation = { agent: record.config.agent, mode: record.config.mode, cwd: record.config.cwd };
    // Two, so "exactly one" is a fact rather than an assumption about the page size.
    const page = await this.ports.storage.replay(id, 0, 2);
    const first = page.events.at(0);

    if (first === undefined) {
      await this.ports.storage.append(id, 'session.created', creation);
      return;
    }

    /**
     * EXACTLY ONE JOURNAL IS ACCEPTED, AND EVERYTHING ELSE REFUSES.
     *
     * A target still recorded as `created` has one honest journal: the creation boundary this record
     * implies, and nothing after it. That one passes untouched — it is what a replay of an already
     * repaired target looks like, and re-appending would be the duplication this whole path exists to
     * avoid. Checking only the first event's TYPE would additionally accept two states that are NOT
     * this prefix: a journal that has already moved on while the state document lags behind, and a
     * creation event whose payload describes some other session. In both the repair would declare a
     * narrative complete that nobody can reconstruct. So the whole shape is proved — one event at
     * sequence 1, the right type, and the exact payload — rather than its opening alone.
     */
    const disagreement =
      page.events.length > 1 || page.hasMore
        ? `it carries more than the creation boundary while its state is still ${record.state.status}`
        : first.sequence !== 1
          ? `its creation boundary has sequence ${first.sequence}, and the first lifecycle event must have sequence 1`
          : first.type !== 'session.created'
            ? `it begins with ${JSON.stringify(first.type)}, and a creation boundary is only ever the FIRST event`
            : canonical(first.data) !== canonical(creation)
              ? `its creation event describes ${JSON.stringify(first.data)} rather than ${JSON.stringify(creation)}`
              : undefined;
    if (disagreement !== undefined)
      throw new SessionForkTargetBindingError(
        `the durable journal of target ${id} is not one this fork could repair: ${disagreement}`,
      );
  }

  /** A fork always creates a fresh session and never writes into the one it read. */
  private assertFresh(id: SessionId, plan: SessionTransferPlan): void {
    if (id === plan.source.sessionId)
      throw new SessionForkTargetBindingError(
        `plan ${plan.planId} was bound to its own source ${plan.source.sessionId}: a fork writes only into the ` +
          'fresh session it reserved',
      );
  }

  /**
   * Everything the target's record and document are built from, decided once per call.
   *
   * EVERY RESOLVED DECISION IS RE-PROVED HERE rather than merely recomputed. The plan was frozen
   * against a fleet manifest that can be republished under it, and a re-run of the planner that
   * quietly answered with a different model would launch a session the caller never chose — at a
   * different price, a different context window and a different capability — while the durable plan
   * and the outcome the caller was shown still named the old one.
   */
  private async shape(id: SessionId, plan: SessionTransferPlan): Promise<ForkTargetShape> {
    const opening = forkOpeningTurnRefusal(plan);
    if (opening !== undefined) throw new SessionForkTargetBindingError(opening);
    const resolved = await this.account(plan);
    const outcome = this.ports.planner.plan({
      id,
      account: resolved.account,
      mode: plan.durable.mode,
      ...(plan.target.model === null ? {} : { requestedModel: plan.target.model }),
    });
    // THE PLANNER'S OWN REASON, ahead of the drift comparison below. This case used to surface as a
    // drift complaint — "expected haiku, got opus" — which is true and says nothing about WHY, while
    // the account has the operator's own sentence for it. A fork prepared against a model that has
    // since been taken out of service is exactly when that sentence is worth reading.
    if (outcome.kind === 'unservable-model')
      throw new SessionForkTargetBindingError(
        `the target plan ${plan.planId} was prepared for a model this account cannot serve: ${outcome.reason}`,
      );
    const planned = outcome.plan;
    // THE MODEL NEEDS NO COMPARISON ANY MORE, and leaving one would be a branch nothing can reach: a
    // resolution that returns a plan at all has answered with the model the target named, and the only
    // way it can now answer with a different one is the refusal above. The WINDOW still drifts on its
    // own — a context-window override this daemon carries can change under a frozen plan without the
    // account's model list changing at all — so that comparison stays.
    const drifted = [agree('context window', planned.contextWindow, plan.target.contextWindow)].filter(
      (complaint): complaint is string => complaint !== undefined,
    );
    if (drifted.length > 0)
      throw new SessionForkTargetBindingError(
        `account ${resolved.account.agent} no longer serves the target plan ${plan.planId} was prepared for: ` +
          `${drifted.join('; ')}`,
      );
    const targetLabel = transferTargetLabel(plan.facets.lineage, plan.durable.label);
    return {
      account: resolved.account,
      executable: resolved.executable,
      // Remote-control arguments only where the transfer decided the surface exists, then the
      // operator's own flags — which preparation already dropped for a cross-harness target — and
      // finally the resolved model. Both harness CLIs accept `--model`; placing it last makes the
      // plan's explicit choice win over a carried same-harness flag instead of merely recording a
      // model the wrapper default may never run.
      command: [
        resolved.executable,
        ...(plan.durable.remoteControl ? planned.extraArgs : []),
        ...plan.durable.harnessFlags,
        ...startupModelArguments(planned.model),
      ],
      prompt: forkOpeningTurn(plan),
      tmuxSession: this.ports.tmuxSession(id),
      envelope: {
        // An incarnation names one RUN of a session, and this is a brand-new session's first.
        incarnation: `${id}-1`,
        runtimeGeneration: 1,
        // I3, stated on the document as well as made unreachable by the importer's port set.
        boardAccess: 'none',
        agent: resolved.account.agent,
        harness: resolved.account.kind,
        modelHint: plan.target.model ?? '',
        model: planned.model,
        remoteControl: plan.durable.remoteControl,
        harnessFlags: [...plan.durable.harnessFlags],
        // A fork ALWAYS materialises `turns/turn-001.md`, so the counter says one whatever the mode:
        // recording zero for a session that already holds a turn-one document is what makes the first
        // revive plan turn one and overwrite the session's own opening context.
        turn: 1,
        intervalSeconds: plan.durable.intervalSeconds,
        timeoutSeconds: plan.durable.timeoutSeconds,
        nudgeAfterSeconds: plan.durable.nudgeAfterSeconds,
        killAfterSeconds: plan.durable.killAfterSeconds,
        directSendMaxChars: plan.durable.directSendMaxChars,
        resumeMenuChoice: plan.durable.resumeMenuChoice,
        maxSnapshots: plan.durable.maxSnapshots,
        retry: plan.durable.retry,
        ...(targetLabel === null ? {} : { label: targetLabel }),
      },
    };
  }

  /** The published account, re-proved to be exactly the one the frozen plan resolved. */
  private async account(plan: SessionTransferPlan): Promise<SessionForkTargetAccount> {
    const resolved = await resolveForkTargetAccount(this.ports.accounts, plan.target.agent);
    if (
      resolved.account.id !== plan.target.accountId ||
      resolved.account.kind !== plan.target.harness ||
      resolved.account.agent !== plan.target.agent
    )
      throw new SessionForkTargetBindingError(
        `agent ${plan.target.agent} now resolves to account ${resolved.account.id} (${resolved.account.kind}, ` +
          `published as ${resolved.account.agent}) but plan ${plan.planId} was prepared against ` +
          `${plan.target.accountId} (${plan.target.harness}, published as ${plan.target.agent}); the target a fork ` +
          'was decided for cannot change beneath it',
      );
    return resolved;
  }

  /**
   * Strict reconciliation of an existing or freshly created target.
   *
   * Everything a fork decided about the session it reserved, checked at once so the message names
   * every disagreement rather than the first one. A mismatch REFUSES: nothing is overwritten, no
   * second session is created, and the same request id may be presented again once whatever created
   * the impostor has been dealt with.
   */
  private assertReconciled(
    id: SessionId,
    plan: SessionTransferPlan,
    shape: ForkTargetShape,
    record: SessionLifecycleRecord,
    document: unknown,
    options: {
      readonly edge: 'required' | 'optional';
      readonly states: readonly LifecycleSessionStatus[];
    },
  ): void {
    const config = SessionConfigSchema.safeParse(document);
    if (!config.success)
      throw new SessionForkTargetBindingError(
        `the configuration document of target ${id} does not satisfy the protocol, so it cannot be shown to be the ` +
          `session plan ${plan.planId} reserved: ${config.error.issues.map(issue => issue.message).join('; ')}`,
      );
    const held = record.config;
    const disagreements = [
      agree('session id', held.id, id),
      agree('canonical working directory', held.cwd, plan.durable.cwd),
      agree('interaction mode', held.mode, plan.durable.mode),
      agree('authorized wrapper', held.agent, shape.executable),
      agree('tmux session', held.tmuxSession, shape.tmuxSession),
      agree('opening prompt', held.prompt, shape.prompt),
      demand(
        options.states.includes(record.state.status),
        `its lifecycle state is ${JSON.stringify(record.state.status)} rather than one of ` +
          `${JSON.stringify(options.states)}`,
      ),
      demand(
        storedTranscriptProvenance(document) !== undefined ||
          (held.command.length === shape.command.length &&
            shape.command.every((argument, index) => held.command[index] === argument)),
        `its launch command ${JSON.stringify(held.command)} is not exactly the authorized base command ` +
          `${JSON.stringify(shape.command)} this fork creates with`,
      ),
      demand(held.parent === undefined, `it descends from ${JSON.stringify(held.parent)} rather than from nothing`),
      demand(held.sessionCapabilityHash !== undefined, 'it holds no credential of its own'),
      agree('board access', config.data.boardAccess, 'none'),
      agree('incarnation', config.data.incarnation, `${id}-1`),
      agree('runtime generation', config.data.runtimeGeneration, 1),
      agree('harness', config.data.harness, plan.target.harness),
      agree('agent', config.data.agent, shape.account.agent),
      agree('model', config.data.model, shape.envelope.model),
      // The durable configuration the transfer decided, which the envelope writer makes
      // authoritative and which no later transition may drift from.
      agree('interval', config.data.intervalSeconds, plan.durable.intervalSeconds),
      agree('timeout', config.data.timeoutSeconds, plan.durable.timeoutSeconds),
      agree('nudge delay', config.data.nudgeAfterSeconds, plan.durable.nudgeAfterSeconds),
      agree('kill delay', config.data.killAfterSeconds, plan.durable.killAfterSeconds),
      agree('direct-send ceiling', config.data.directSendMaxChars, plan.durable.directSendMaxChars),
      agree('resume menu choice', config.data.resumeMenuChoice, plan.durable.resumeMenuChoice),
      agree('snapshot ceiling', config.data.maxSnapshots, plan.durable.maxSnapshots),
      agree('remote control', config.data.remoteControl, plan.durable.remoteControl),
      agree('label', config.data.label ?? null, transferTargetLabel(plan.facets.lineage, plan.durable.label)),
      agree('harness flags', canonical(config.data.harnessFlags), canonical(plan.durable.harnessFlags)),
      agree('retry policy', canonical(config.data.retry), canonical(plan.durable.retry)),
      // The edge an import wrote is part of what proves this is the same target — and from the
      // import onward its ABSENCE is itself a disagreement, because a target the receipt says was
      // imported into and that carries no lineage back to this plan is not the session that was.
      ...(config.data.transferredFrom === undefined
        ? [
            options.edge === 'required'
              ? 'it carries no transfer edge back to this plan, although this fork has already imported into it'
              : undefined,
          ]
        : this.edgeDisagreements(config.data.transferredFrom, plan)),
      // The spawn stamp the envelope writer derives from this very plan. Once the import has run it
      // must be exactly that value: a target carrying a foreign warden stamp would be shielded from
      // escalation on the strength of somebody else's ancestry.
      options.edge === 'required'
        ? agree(
            'spawn provenance',
            canonical(fields(document).provenance),
            canonical(transferSpawnProvenance(plan.facets.lineage, plan.preparedAt)),
          )
        : undefined,
    ].filter((complaint): complaint is string => complaint !== undefined);
    if (disagreements.length > 0)
      throw new SessionForkTargetBindingError(
        `session ${id} is not the fresh target plan ${plan.planId} reserved: ${disagreements.join('; ')}`,
      );
    const recorded = storedTranscriptProvenance(document);
    if (recorded !== undefined) this.assertOwnTranscript(id, plan, shape, recorded, fields(document).command);
  }

  /** The record hash and the private environment must prove the same fresh credential. */
  private async assertCredential(id: SessionId, record: SessionLifecycleRecord): Promise<void> {
    const expected = record.config.sessionCapabilityHash;
    if (expected === undefined)
      throw new SessionForkTargetBindingError(
        `target ${id} holds no credential hash of its own, so it is not the fresh session this fork reserved`,
      );
    let environment: Readonly<Record<string, string>>;
    try {
      environment = await this.ports.environment.read(id);
    } catch (error) {
      throw new SessionForkTargetBindingError(
        `target ${id}'s private credential environment cannot be read: ${message(error)}`,
      );
    }
    const capability = environment[SESSION_BOARD_CAPABILITY_VARIABLE];
    const actual = capability === undefined ? undefined : createHash('sha256').update(capability, 'utf8').digest('hex');
    if (actual !== expected)
      throw new SessionForkTargetBindingError(
        `target ${id}'s private credential does not match the hash in its session record; refusing to launch a ` +
          'target whose identity was torn during creation',
      );
  }

  /** The lineage edge an import wrote, checked against the plan rather than rebuilt beside it. */
  private edgeDisagreements(
    edge: NonNullable<SessionConfig['transferredFrom']>,
    plan: SessionTransferPlan,
  ): readonly (string | undefined)[] {
    return [
      agree('transfer kind', edge.kind, 'fork'),
      agree('edge plan', edge.planId, plan.planId),
      agree('edge source', edge.sourceSessionId, plan.source.sessionId),
      agree('edge source incarnation', edge.sourceIncarnation, plan.source.incarnation),
      agree('edge source harness', edge.sourceHarness, plan.source.harness),
      agree('edge instant', edge.at, plan.preparedAt),
      agree('edge cut', canonical(edge.cutMessagePoint), canonical(plan.source.cutMessagePoint)),
    ];
  }

  /**
   * The plan beneath the target must be THIS plan, value for value.
   *
   * `planId` alone is not enough, and that is the defect this closes. The id is DERIVED from the
   * source session and the caller's request id, so a second preparation of the same request — after
   * the source gained an attachment, changed a durable setting or moved on a message — produces a
   * different decision under the very same id. Comparing the whole parsed value is what makes
   * "one request, one frozen decision" true rather than merely named.
   */
  private async assertPlanReconciled(
    id: SessionId,
    plan: SessionTransferPlan,
    options: { readonly required: boolean },
  ): Promise<void> {
    const installed = await this.plan(id);
    if (installed === undefined) {
      if (!options.required) return;
      throw new SessionForkTargetBindingError(
        `target ${id} carries no persisted transfer plan, so there is no frozen decision left to replay`,
      );
    }
    if (installed.planId !== plan.planId)
      throw new SessionForkTargetBindingError(
        `target ${id} already holds transfer plan ${installed.planId}, not ${plan.planId}: one transfer creates one ` +
          'session, so this fork is refused rather than applied over another one',
      );
    if (canonical(installed) !== canonical(plan))
      throw new SessionForkTargetBindingError(
        `the transfer plan persisted beneath target ${id} is a DIFFERENT decision under the same id ${plan.planId}: ` +
          'a plan is frozen once, so the fork is refused rather than applied from whichever copy arrived last',
      );
  }

  // ─── the plan beneath the target ───────────────────────────────────────────────────────────

  /** Persists the parsed plan so a crashed import replays it rather than deriving a new one. */
  private async persist(id: SessionId, plan: SessionTransferPlan): Promise<void> {
    await this.proveTarget(id, plan, { edge: 'optional', states: ['created'] });
    await this.ports.plans.install(id, plan);
    // Re-read rather than trusted: `install` leaves an existing document alone, so this is what turns
    // "a plan is already there" into "the plan already there is this one".
    await this.assertPlanReconciled(id, plan, { required: true });
  }

  /** The plan installed beneath the target, with a damaged document reported as this fork's refusal. */
  private async plan(id: SessionId): Promise<SessionTransferPlan | undefined> {
    try {
      return await this.ports.plans.read(id);
    } catch (error) {
      throw new SessionForkTargetBindingError(
        `the transfer plan persisted beneath target ${id} cannot be read: ${message(error)}`,
      );
    }
  }

  /**
   * The proof every operation that runs AFTER the import must pass before it does anything.
   *
   * WHY EVERY BOUND OPERATION AND NOT ONLY `create`. The fork service skips the phases its receipt
   * already records, so a replay that resumes at `plan_persisted` or later never calls `create` — and
   * if `create` were the only place the target was reconciled, a corrupted or substituted target
   * would be imported into, captured for and STARTED without anything ever proving it was the
   * session the receipt reserved. So the proof runs first on every operation, and a target that
   * cannot be proved refuses instead of being written to.
   *
   * It is anchored to the RECEIPT's plan, which `bind` closed over, rather than to the plan installed
   * beneath the target. Reconciling the installed plan against itself would accept a second valid
   * decision written under the same derived id; requiring it to value-equal the receipt's is what
   * makes that impossible.
   */
  private async proveImported(
    id: SessionId,
    plan: SessionTransferPlan,
    options: { readonly states: readonly LifecycleSessionStatus[] },
  ): Promise<ProvedForkTarget> {
    // The frozen decision first: it is the anchor everything else is proved against, so a target
    // carrying no plan at all is reported as that rather than as a hundred fields disagreeing.
    await this.assertPlanReconciled(id, plan, { required: true });
    const proved = await this.proveTarget(id, plan, { edge: 'required', states: options.states });
    await this.assertImportedArtifacts(id, plan, proved.shape);
    return proved;
  }

  /** The deterministic brief and every planned attachment must still be present before launch. */
  private async assertImportedArtifacts(
    id: SessionId,
    plan: SessionTransferPlan,
    shape: ForkTargetShape,
  ): Promise<void> {
    const disagreement = await this.importedArtifactDisagreement(id, plan, shape);
    if (disagreement !== undefined) throw new SessionForkTargetBindingError(disagreement);
  }

  /**
   * The first target-owned fact that distinguishes a complete import from one that must be replayed.
   *
   * A mismatch is returned rather than thrown because it has two callers with deliberately different
   * policies. A later phase refuses it: its receipt already claims the import completed. The import
   * phase repairs it by re-driving the frozen plan, because a crash may have landed the edge before
   * the last attachment or brief. Unexpected I/O still throws in both cases; only a proved absence or
   * content mismatch is a replayable incomplete target.
   */
  private async importedArtifactDisagreement(
    id: SessionId,
    plan: SessionTransferPlan,
    shape: ForkTargetShape,
  ): Promise<string | undefined> {
    const brief = assignedTaskDocument(shape.prompt);
    if (!(await this.ports.imported.brief.matches(id, brief)))
      return `target ${id}'s opening-turn document does not match persisted transfer plan ${plan.planId}`;
    for (const expectedManifest of plan.facets.attachments.attachments) {
      try {
        await this.ports.imported.attachments.verifyTarget({ newSessionId: id, expectedManifest });
      } catch (error) {
        if (error instanceof SessionAttachmentCopyError && error.failure === 'corrupt')
          return (
            `target ${id}'s imported attachment ${expectedManifest.id} does not match persisted transfer plan ` +
            `${plan.planId}`
          );
        throw new SessionForkTargetBindingError(
          `target ${id}'s imported attachment ${expectedManifest.id} cannot be proved against plan ${plan.planId}: ` +
            `${message(error)}`,
        );
      }
    }
    return undefined;
  }

  /** The record and document, proved to still be the fresh target this plan reserved. */
  private async proveTarget(
    id: SessionId,
    plan: SessionTransferPlan,
    options: {
      readonly edge: 'required' | 'optional';
      readonly states: readonly LifecycleSessionStatus[];
    },
  ): Promise<ProvedForkTarget> {
    this.assertFresh(id, plan);
    const shape = await this.shape(id, plan);
    const record = await this.record(id);
    if (record === undefined)
      throw new SessionForkTargetBindingError(
        `target ${id} has no session record, so plan ${plan.planId} cannot be applied to it: a fork writes only into ` +
          'the session its receipt reserved and created',
      );
    const document = await this.ports.storage.readConfig(id);
    this.assertReconciled(id, plan, shape, record, document, options);
    await this.assertCredential(id, record);
    return { shape, record, document };
  }

  // ─── import ────────────────────────────────────────────────────────────────────────────────

  /**
   * The seam's import, mechanically keyed to the bound target.
   *
   * The seam requires the fresh id as an argument, and a caller that supplied a different one would
   * be importing this plan into a session this binder never proved anything about. So the argument is
   * checked against the id `bind` closed over, and the importer is handed that same id.
   */
  private async importPlan(
    id: SessionId,
    plan: SessionTransferPlan,
    newSessionId: string,
  ): Promise<SessionTransferImportOutcome> {
    this.assertFresh(id, plan);
    if (newSessionId !== id)
      throw new SessionForkTargetBindingError(
        `an import for ${JSON.stringify(newSessionId)} was driven through a surface bound to ${id}: every write a ` +
          'fork makes belongs to the one session its receipt reserved',
      );
    const target = await this.proveTarget(id, plan, { edge: 'optional', states: ['created'] });
    await this.assertPlanReconciled(id, plan, { required: true });

    /**
     * TARGET EVIDENCE COMES BEFORE THE MUTABLE SOURCE ON REPLAY.
     *
     * Import writes its edge first and its deterministic brief last. If all target-owned evidence is
     * already complete, the previous import crossed the boundary and only the receipt advance was
     * lost; re-reading a source that may since have been pruned or compacted would make a completed
     * fork impossible to acknowledge. If the edge is absent, or any artifact is incomplete, this
     * remains a real import attempt and the seam below performs its ordinary pinned-source validation
     * before repairing anything.
     */
    if (SessionConfigSchema.parse(target.document).transferredFrom !== undefined) {
      const imported = await this.proveTarget(id, plan, { edge: 'required', states: ['created'] });
      if ((await this.importedArtifactDisagreement(id, plan, imported.shape)) === undefined) {
        return {
          briefPath: this.ports.imported.brief.file(id),
          copiedAttachmentIds: plan.facets.attachments.attachments.map(attachment => attachment.id),
        };
      }
    }

    const outcome = await new SessionTransferImporter(
      { ...this.ports.importPorts, brief: this.brief() },
      'fork',
    ).importPlan(plan, id);
    await this.proveImported(id, plan, { states: ['created'] });
    return outcome;
  }

  /** The brief writer, wrapped so its bytes are exactly the turn-one document the lifecycle writes. */
  private brief(): TransferBriefWriter {
    return {
      write: async (newSessionId, document) =>
        await this.ports.importPorts.brief.write(newSessionId, assignedTaskDocument(document.trim())),
    };
  }

  // ─── the target's own transcript identity ──────────────────────────────────────────────────

  /**
   * Captures the TARGET's own transcript provenance and makes the argv that proves it true.
   *
   * The record and the arguments land in ONE atomic document write, because a launch that carried a
   * `--session-id` no record named — or a record naming a transcript no launch would write — is a
   * session whose transcript can never be attributed afterwards.
   *
   * A capture already recorded is REUSED, never repeated: for a harness whose session id this daemon
   * mints, a second capture names a different file, and the argv would then disagree with whichever
   * of the two the record kept.
   */
  private async capture(id: SessionId, plan: SessionTransferPlan): Promise<void> {
    const proved = await this.proveImported(id, plan, {
      states: ['created', 'starting', 'running', 'failed'],
    });
    const { shape, record, document } = proved;
    const recorded = storedTranscriptProvenance(document);
    if (recorded !== undefined) {
      this.assertOwnTranscript(id, plan, shape, recorded, fields(document).command);
      return;
    }
    if (record.state.status !== 'created')
      throw new SessionForkTargetBindingError(
        `target ${id} reached lifecycle state ${record.state.status} without its own transcript provenance; ` +
          'a fork may capture that identity only before its first launch',
      );
    const captured = await this.ports.transcripts.capture({
      harness: shape.account.kind,
      executable: shape.executable,
      cwd: plan.durable.cwd,
      correlationToken: this.ports.sessionDirectory(id),
      at: this.ports.clock.now(),
    });
    if (captured.provenance === undefined)
      throw new SessionForkTargetBindingError(
        `target ${id}'s ${shape.account.kind} wrapper did not yield transcript provenance; the fork cannot mark ` +
          'capture complete and launch a session whose conversation could later resolve elsewhere',
      );
    await this.ports.storage.updateConfig(id, current => {
      // Re-checked under the document's own lock: a capture that lost a race must not replace the
      // record that won it, and the minted identity it holds was never launched with.
      if (storedTranscriptProvenance(current) !== undefined) return current;
      return {
        ...fields(current),
        transcript: captured.provenance,
        command: [...shape.command, ...captured.launchArguments],
      } as JsonValue;
    });
    const updated = await this.ports.storage.readConfig(id);
    const stored = storedTranscriptProvenance(updated);
    if (stored === undefined)
      throw new SessionForkTargetBindingError(`target ${id}'s transcript provenance was not durable after capture`);
    this.assertOwnTranscript(id, plan, shape, stored, fields(updated).command);
  }

  /** The post-capture proof required before either starting or reporting the target. */
  private async proveCaptured(
    id: SessionId,
    plan: SessionTransferPlan,
    states: readonly LifecycleSessionStatus[],
  ): Promise<ProvedForkTarget> {
    const proved = await this.proveImported(id, plan, { states });
    const recorded = storedTranscriptProvenance(proved.document);
    if (recorded === undefined)
      throw new SessionForkTargetBindingError(
        `target ${id} has no transcript provenance of its own although this fork is past the capture boundary`,
      );
    this.assertOwnTranscript(id, plan, proved.shape, recorded, fields(proved.document).command);
    return proved;
  }

  /**
   * A transcript record already on the target must be the TARGET's own, and internally consistent.
   *
   * "Not the source's file" is not enough. A provenance record is what every later reader — the
   * migration preflight, analytics, learning extraction, the transcript tail — resolves this
   * session's transcript through, so a syntactically valid record naming somebody else's file hands
   * one agent's conversation to another session, and the mistake is invisible afterwards. The record
   * is therefore reconciled with the two things that would have had to be true for this daemon to
   * have written it: the file its own launch argv would produce, and the working directory the plan
   * froze.
   *
   * The two harnesses are proved differently because they are identified differently. Claude's id is
   * MINTED by this daemon and put on the argv, so the file is a pure function of the home, the cwd
   * and that id, and the argv must carry it. Codex names its own session later, so what can be proved
   * before launch is the correlation token — which must be this target's own directory, because a
   * token belonging to another session is exactly how a rollout gets attributed to the wrong one.
   */
  private assertOwnTranscript(
    id: SessionId,
    plan: SessionTransferPlan,
    shape: ForkTargetShape,
    recorded: TranscriptProvenance,
    command: unknown,
  ): void {
    if (recorded.file !== undefined && recorded.file === plan.source.transcriptProvenance?.file)
      throw new SessionForkTargetBindingError(
        `target ${id} records the SOURCE session's transcript ${recorded.file} as its own; a fork captures its own ` +
          'provenance and never copies the one it read',
      );
    const argv = Array.isArray(command) ? (command as readonly unknown[]) : [];
    const mints = !harnessQuirks(shape.account.kind).mintsOwnSessionIds;
    const expected = mints
      ? [...shape.command, ...claudeSessionArguments(recorded.harnessSessionId ?? '')]
      : shape.command;
    const disagreements = [
      mints
        ? agree('recorded transcript identity', recorded.identity, 'minted')
        : demand(
            recorded.correlationToken === this.ports.sessionDirectory(id),
            `its correlation token ${JSON.stringify(recorded.correlationToken)} is not this target's own session ` +
              'directory, so the rollout it would claim belongs to another session',
          ),
      mints
        ? agree(
            'recorded transcript file',
            recorded.file,
            recorded.harnessSessionId === undefined
              ? undefined
              : claudeTranscriptFile(recorded.home, plan.durable.cwd, recorded.harnessSessionId),
          )
        : undefined,
      demand(
        expected.length === argv.length && expected.every((argument, index) => argv[index] === argument),
        `its launch command ${JSON.stringify(argv)} is not the authorized base command with the arguments that ` +
          `record would need (${JSON.stringify(expected)})`,
      ),
    ].filter((complaint): complaint is string => complaint !== undefined);
    if (disagreements.length > 0)
      throw new SessionForkTargetBindingError(
        `the transcript record already on target ${id} is not one this fork could have captured: ` +
          `${disagreements.join('; ')}`,
      );
  }

  // ─── launch ────────────────────────────────────────────────────────────────────────────────

  /**
   * Launches the target and applies its runtime choice before the first turn is delivered.
   *
   * The runtime request id is derived from the PLAN, so a replay that reaches this boundary again
   * presents the same id to the runtime path and is answered from its ledger rather than driving a
   * modal picker into a live pane a second time.
   */
  private async start(id: SessionId, plan: SessionTransferPlan): Promise<SessionView> {
    await this.proveCaptured(id, plan, ['created', 'starting', 'running', 'failed']);
    const startup = forkStartupRuntimeRequest(plan.target.harness, plan.target.model, plan.target.effort);
    await this.ports.createLifecycle(id).start(
      id,
      startup === undefined
        ? undefined
        : async () => {
            await this.ports.runtime.startupWhileHeld(id, startup, `${plan.planId}:startup-runtime`);
          },
    );
    return await this.observe(id, plan);
  }

  /** The target's current view. A completed replay reads this instead of starting anything. */
  private async observe(id: SessionId, plan: SessionTransferPlan): Promise<SessionView> {
    await this.proveCaptured(id, plan, ['running', 'failed', 'kill_failed', 'stopped']);
    const view = await this.ports.view(id).catch(() => undefined);
    if (view === undefined)
      throw new SessionForkTargetBindingError(
        `target ${id} was written but its documents do not satisfy the protocol, so this fork cannot be reported`,
      );
    return view;
  }

  /** The lifecycle record, with an unreadable one reported as this fork's refusal rather than raw. */
  private async record(id: SessionId): Promise<SessionLifecycleRecord | undefined> {
    try {
      return await new StorageSessionLifecycleRepository(this.ports.storage).read(id);
    } catch (error) {
      throw new SessionForkTargetBindingError(
        `the session record already at target ${id} cannot be read, so this fork cannot prove it is the target it ` +
          `reserved: ${message(error)}`,
      );
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
