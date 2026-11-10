import type { Redaction, StatePort } from '@ferretry/kernel/contract';
import {
  forkOpeningTurnRefusal,
  type SessionForkStartAccountResolver,
  SessionForkTargetBinder,
  SessionForkTargetResolver,
  StateSessionForkReceiptStore,
} from '../adapters/forks/index.ts';
import type { SessionProtocolEnvelope } from '../adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { KeyedSerialExecutor } from '../adapters/storage/keyed-serial-executor.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import {
  GitTransferWorkspaceProbe,
  StorageTransferEnvelopeWriter,
  StorageTransferSourceReader,
} from '../adapters/transfer/index.ts';
import type { GitWorktreeGateway } from '../adapters/worktrees/index.ts';
import {
  type ForkHarnessFacts,
  type ForkSelectionTokens,
  type ForkTranscriptCaptures,
  SessionForkFacade,
  type SessionForkIdFactory,
  SessionForkService,
  sessionForkKey,
} from '../lib/forks/index.ts';
import type { ClockPort } from '../lib/ports.ts';
import type { SessionView } from '../lib/protocol/session.ts';
import {
  type SessionForkRoute,
  type SessionForkSubsystem,
  sessionForkContribution,
} from '../lib/runtime/mounts/session-fork.ts';
import type { SessionId } from '../lib/session-id.ts';
import { sessionTmuxName } from '../lib/session/lifecycle/policy.ts';
import type { SessionLifecycleService } from '../lib/session/lifecycle/service.ts';
import { defaultSessionLifecycleSettings } from '../lib/session/lifecycle/settings.ts';
import type { SessionEnvironmentStore } from '../lib/session/lifecycle/types.ts';
import type { SessionPlanner } from '../lib/session/peers/core.ts';
import type {
  CodexRuntimeCatalogCache,
  HarnessQuirkService,
  HarnessRuntimeCatalogs,
} from '../lib/session/peers/harness.ts';
import type { SessionRuntimeStartupHeldPort } from '../lib/session/runtime-control/types.ts';
import {
  AttachmentFacetContributor,
  ConversationFacetContributor,
  LineageFacetContributor,
  ReferenceFacetContributor,
  SessionTransferPreparer,
  TransferPrepareError,
  WorkspaceFacetContributor,
} from '../lib/transfer/index.ts';
import type { TransferAttachmentStore } from '../lib/transfer/ports.ts';
import type {
  TransferAttachmentReader,
  TransferConversationReader,
  TransferConversationValidator,
} from '../lib/transfer/types.ts';
import type { TransferPortsParts, TransferProvides } from './transfer.ts';

/**
 * Forking a conversation from an exact message: the one route `POST /v1/ferrets/:ferretId/fork` and the whole
 * restart-safe machine behind it (the preparer, the target resolver and binder, the durable receipt store and the
 * service that drives them).
 *
 * This module has no seams (the receipt store, the preparer and its contributors, the binder and the serial executor are
 * fixed production adapters; every owner the fork borrows is a need), no jobs and no releases of its own: every
 * constructor in {@link createForkSubsystem} is pure (it captures its inputs and reads nothing), so the single build sits
 * where the fork was always assembled — after the runtime and move dependencies it borrows from and before the
 * subsystem literal that mounts it. It claims no protocol feature.
 *
 * THE FORK STAYS COMPOSED OF THE SESSIONS' OWNERS. Session lifecycle, launch, account resolution, planning, the runtime
 * and the transcript capture are session code, so they reach this module only as typed {@link SessionForkNeeds}: every
 * value the old code read LATE (the account resolution, the lifecycle factory and the session view are closures over the
 * host's locals, read per call) is still handed in as that closure, so each is read at the same moment it always was. The
 * transfer module's {@link TransferProvides.transferPorts} factory is still injected and still CALLED inside the build,
 * at the point those ports were always constructed.
 *
 * WHAT IS NOT FERRETS' IS A PORT. The owners outside Ferrets (core) are reached through the smallest structural
 * interface the fork uses, and the host binds each: the conversation reader and validator, the attachment inventory,
 * the message-token selection verifier, the transcript capture and the harness facts (owners: the conversation and the
 * harness plugins), and the redaction port (owner: the vault). A host that has none of them binds a fail-closed
 * skeleton, so an unbound fork refuses rather than guesses.
 *
 * What it provides is the subsystem itself, read by nothing but its own route.
 */

/**
 * Everything the fork subsystem is assembled from, named once so the assembly below reads as one
 * decision rather than a wall of positional arguments.
 *
 * Each field is an EXISTING owner rather than a fork-private one, and that is the point of writing
 * this out: the account resolution is the start's, the planner is the process's one planner, the
 * quirk service and the Codex catalogue cache are the runtime route's, and the lifecycle factory is
 * the same one every other create goes through. A fork that resolved an account differently from a
 * start, or read a second catalogue, would launch an agent this daemon was wrong about.
 */
export interface SessionForkNeeds {
  /** Ferrets' own state: the fork receipts (`state/ferrets/forks/<planId>.json`, the contract's `ForkFiles`). */
  readonly state: StatePort;
  readonly storage: DaemonStorage;
  /** A target's private directory: the string its rollout is later correlated by. */
  readonly sessionDirectory: (id: SessionId) => string;
  /** A target's own private `sessions` handle, where its first-turn brief is written as its `turns/turn-001.md`. */
  readonly briefs: TransferPortsParts['briefs'];
  /**
   * The attachment owner's store (owner: the conversation plugin): the source originals are read from it and the
   * target's are written into it, so a forked session shows its attachments in the manifest AND can open them. The
   * copier and the store address one tree because they are the same store.
   */
  readonly attachmentStore: TransferAttachmentStore;
  /**
   * The transfer module's factory for the target plan store, the brief writer and the attachment copier. It is CALLED
   * inside `createForkSubsystem` at the point those ports were always constructed, never ahead of it.
   */
  readonly transferPorts: TransferProvides['transferPorts'];
  /**
   * The attachment inventory the preparation reads (owner: the conversation plugin's attachment store).
   * Read-only: preparation has no writer.
   */
  readonly attachments: TransferAttachmentReader;
  /**
   * The conversation cut, made against one exact transcript file at preparation and again at import (owner: the
   * conversation plugin's transcript reader). One object answers both halves, because two implementations would
   * eventually disagree about the same cut.
   */
  readonly conversation: TransferConversationReader & TransferConversationValidator;
  /** The same fail-closed redaction the operator transcript reads use, narrowed to the one-vault-open batch read. */
  readonly redactor: Pick<Redaction, 'read'>;
  /** The one daemon-private message-token verification shared with the operator message read surface. */
  readonly selection: ForkSelectionTokens;
  readonly gateway: GitWorktreeGateway;
  readonly accounts: SessionForkStartAccountResolver;
  readonly planner: SessionPlanner;
  readonly harness: Pick<HarnessQuirkService, 'planSwitch'>;
  readonly catalog: CodexRuntimeCatalogCache;
  /** The harness plugins' catalogue projection into the switch planner's context, narrowed to what a fork reaches. */
  readonly catalogs: Pick<HarnessRuntimeCatalogs, 'codexSwitchContext'>;
  /** The harness quirk rows, the launch model argument and Claude's transcript file name. */
  readonly harnessFacts: ForkHarnessFacts;
  readonly createLifecycle: (id: SessionId, envelope?: SessionProtocolEnvelope) => SessionLifecycleService;
  readonly transcripts: ForkTranscriptCaptures;
  readonly environment: Pick<SessionEnvironmentStore, 'read'>;
  /** The startup half only — the intermediate annotation must not erase it. */
  readonly runtime: SessionRuntimeStartupHeldPort;
  readonly view: (id: SessionId) => Promise<SessionView | undefined>;
  /**
   * The folders a session's agent is pointed into to read what it was sent: its turn documents, its queued messages, its
   * attachments and the copies a send delivers (`handoffFolders`, over the session directory and the attachment root).
   */
  readonly readableHandoffs: (id: SessionId) => readonly string[];
  readonly ids: SessionForkIdFactory;
  readonly clock: ClockPort;
}

/**
 * The production fork: one route, and the whole restart-safe machine behind it.
 *
 * THE PREPARATION HALF READS AND NOTHING ELSE. It is handed a source reader, a conversation reader,
 * an attachment reader and a workspace probe — no writer, no lifecycle, no board — so seam
 * invariants I1 and I2 hold because there is nothing here to violate them with.
 *
 * THE IMPORT HALF IS BOUND TO THE TARGET. Its port set is `{envelope, brief, attachments,
 * conversation}`: the first three write only into the id the binder was constructed with, and the
 * fourth is read-only revalidation of the pinned point. There is no board port and no child-grant
 * requester, so an imported session cannot inherit board access — it has no way to ask for one.
 *
 * THE REFERENCE CONTRIBUTOR IS DELIBERATELY UNINJECTED. No production counter for the reference
 * grammar exists yet, and this is not the place to invent one: a regex here would be a second
 * grammar with nothing to keep it honest against the owner's. Uninjected, the contributor reports a
 * structured `not_implemented` omission, which is the honest answer and a visible one.
 *
 * The serial executor is its OWN queue, for the reason the move's is: a fork holds its key
 * across a create, an import and a launch, and must not make every unrelated document write in this
 * daemon wait behind it.
 */
function createForkSubsystem(parts: SessionForkNeeds): SessionForkSubsystem {
  const forkQueue = new KeyedSerialExecutor();
  const preparer = new SessionTransferPreparer({
    source: new StorageTransferSourceReader(parts.storage),
    selection: {
      verifySelection: async (evidence, binding) =>
        (await parts.selection.verifySelection(
          {
            sessionId: evidence.sourceSessionId,
            incarnation: evidence.sourceIncarnation,
            provenance: evidence.transcriptProvenance,
          },
          evidence.through,
          evidence.rawPrefix,
          binding,
        )) === 'accepted',
    },
    contributors: {
      conversation: new ConversationFacetContributor(parts.conversation, parts.redactor),
      attachments: new AttachmentFacetContributor(parts.attachments),
      references: new ReferenceFacetContributor(),
      workspace: new WorkspaceFacetContributor(new GitTransferWorkspaceProbe(parts.gateway)),
      lineage: new LineageFacetContributor(),
    },
  });
  const { planStore, briefWriter, attachmentCopier } = parts.transferPorts({
    state: parts.state,
    briefs: parts.briefs,
    attachments: parts.attachmentStore,
  });
  /**
   * ONE resolver instance, handed to both halves.
   *
   * The service validates before the receipt is claimed, where a refusal costs nothing; the binder
   * validates again at create, so a receipt claimed by an older daemon — or before the pre-claim
   * check existed — still cannot launch a session at a level its account will not serve. Sharing the
   * instance is what makes the second call free: both hit the same held catalogue entry, so the
   * belt costs a map lookup rather than a second probe against a live account.
   */
  const resolver = new SessionForkTargetResolver({
    accounts: parts.accounts,
    planner: parts.planner,
    harness: parts.harness,
    // The ONE held Codex catalogue. It is probed by `validate`, in the working directory the plan
    // froze, rather than at resolution time — resolution runs before anything has read the source,
    // so the target's own directory is not known to it yet.
    catalog: parts.catalog,
    catalogs: parts.catalogs,
    harnessFacts: parts.harnessFacts,
  });
  const binder = new SessionForkTargetBinder({
    runtimeChoice: resolver,
    storage: parts.storage,
    createLifecycle: parts.createLifecycle,
    accounts: parts.accounts,
    planner: parts.planner,
    // A NAME SHIM ONLY: the binder's port spells the read `read` where the store spells it `load`.
    // Renaming either owner to match the other would touch a file this composition does not own, and
    // a second implementation would give one document two writers.
    plans: {
      read: async id => await planStore.load(id),
      install: async (id, plan) => await planStore.install(id, plan),
    },
    transcripts: parts.transcripts,
    harnessFacts: parts.harnessFacts,
    importPorts: {
      envelope: new StorageTransferEnvelopeWriter(parts.storage),
      brief: briefWriter,
      // The store's OWN tree, not the session's private directory: bytes written anywhere else are
      // real files that `attachmentStore.download` and `unlock` cannot find, so a forked session
      // would list its attachments and fail to open a single one.
      attachments: attachmentCopier,
      conversation: parts.conversation,
    },
    imported: { brief: briefWriter, attachments: attachmentCopier },
    environment: parts.environment,
    tmuxSession: id => sessionTmuxName(id, defaultSessionLifecycleSettings),
    runtime: parts.runtime,
    view: parts.view,
    sessionDirectory: parts.sessionDirectory,
    readableHandoffs: parts.readableHandoffs,
    clock: parts.clock,
  });
  return new SessionForkFacade(
    new SessionForkService({
      receipts: new StateSessionForkReceiptStore(parts.state),
      resolver,
      preparer,
      /**
       * The lifecycle's own limit, asked rather than copied.
       *
       * `forkOpeningTurnRefusal` measures the exact rendering the brief writer and the lifecycle's
       * turn-one document both use, against the very constants `lifecycle.create` parses with. It is
       * ASKED rather than re-derived: a second reading of that limit here would be a second owner of
       * it, and the arm that drifted would either claim a fork that can never be created or refuse
       * one that could. Asking it before the claim turns a conversation too large to hand over into
       * an ordinary refusal that wrote nothing, instead of a claimed receipt whose create can never
       * succeed and whose every retry re-drives the same impossible step forever.
       */
      opening: {
        assertDeliverable: plan => {
          const refusal = forkOpeningTurnRefusal(plan);
          if (refusal !== undefined) throw new TransferPrepareError('plan_invalid', refusal);
        },
      },
      binder,
      ids: parts.ids,
      clock: { now: () => parts.clock.now() },
      // The composite key becomes the executor's string key HERE, through the core's own renderer,
      // so two forks of different sources never queue behind each other for sharing a request id.
      // Its own executor, for the reason the move has one: a fork holds its key across a
      // create, an import and a launch, and must not make unrelated document writes wait on it.
      serial: { run: async (key, work) => await forkQueue.run(sessionForkKey(key), work) },
    }),
  );
}

/** The part of the host's module lifecycle this module is handed: a release that runs when the daemon stops. */
export interface SessionForkLifecycle {
  readonly onRelease: (label: string, release: () => void | Promise<void>) => unknown;
  readonly releasing?: () => boolean;
}

/** What building the module yields: the subsystem, no jobs, and the one route's handler. */
export interface BuiltSessionFork {
  readonly id: 'sessionFork';
  readonly provides: SessionForkSubsystem;
  readonly jobs: Readonly<Record<string, never>>;
  readonly contributes: { readonly routes: readonly SessionForkRoute[] };
}

export const sessionForkModule: {
  readonly id: 'sessionFork';
  readonly build: (needs: SessionForkNeeds, seams?: undefined, lifecycle?: SessionForkLifecycle) => BuiltSessionFork;
} = {
  id: 'sessionFork',
  build: needs => {
    const sessionFork = createForkSubsystem(needs);
    return {
      id: 'sessionFork',
      provides: sessionFork,
      jobs: {},
      // Same shape and depth as its neighbours: the literal `fork` cannot shadow or be shadowed by a sibling, nor by the
      // shallower session read.
      contributes: sessionForkContribution(sessionFork),
    };
  },
};
