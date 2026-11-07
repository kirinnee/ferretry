import type { SessionView } from '../lib/protocol/session.ts';
import {
  FileSessionForkReceiptStore,
  forkOpeningTurnRefusal,
  forkReceiptFile,
  type SessionForkStartAccountResolver,
  SessionForkTargetBinder,
  SessionForkTargetResolver,
} from '../adapters/forks/index.ts';
import { KeyedSerialExecutor } from '../../src/adapters/index.ts';
import type { FileSessionEnvironmentStore, SessionProtocolEnvelope } from '../adapters/session/lifecycle/index.ts';
import { StorageTranscriptDigestJournal } from '../../src/adapters/session/transcript/index.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import {
  GitTransferWorkspaceProbe,
  SessionAttachmentTransferReader,
  StorageTransferConversationReader,
  StorageTransferEnvelopeWriter,
  StorageTransferSourceReader,
} from '../adapters/transfer/index.ts';
import type { GitWorktreeGateway } from '../adapters/worktrees/index.ts';
import {
  SessionForkFacade,
  type SessionForkIdFactory,
  SessionForkService,
  sessionForkKey,
} from '../lib/forks/index.ts';
import {
  type ClockPort,
  type CodexRuntimeCatalogCache,
  createSessionPaths,
  defaultSessionLifecycleSettings,
  type FoundationPaths,
  type HarnessQuirkService,
  handoffFolders,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  type SecretRedactor,
  type SessionAttachmentStore,
  type SessionId,
  type SessionLifecycleService,
  type SessionPlanner,
  type SessionRuntimeStartupHeldPort,
  type SessionTranscriptMessageTokenCodec,
  type TranscriptProvenanceCapture,
  type TranscriptSource,
  verifySessionTranscriptMessageToken,
} from '../../src/lib/index.ts';
import type { TransferProvides } from './transfer.ts';
import { type SessionForkSubsystem, sessionForkContribution } from '../lib/runtime/mounts/session-fork.ts';
import { sessionTmuxName } from '../lib/session/lifecycle/policy.ts';
import {
  AttachmentFacetContributor,
  ConversationFacetContributor,
  LineageFacetContributor,
  ReferenceFacetContributor,
  SessionTransferPreparer,
  TransferPrepareError,
  WorkspaceFacetContributor,
} from '../lib/transfer/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';

/**
 * Forking a conversation from an exact message: the one route `POST /v1/ferrets/:ferretId/fork` and the whole
 * restart-safe machine behind it (the preparer, the target resolver and binder, the durable receipt store and the
 * service that drives them).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the receipt store, the preparer and its contributors, the binder and the serial executor are
 * fixed production adapters; every owner the fork borrows is a need), no jobs and no releases of its own: every
 * constructor in {@link createForkSubsystem} is pure (it captures its inputs and reads nothing), so the single build sits
 * where the fork was always assembled — after the runtime and move dependencies it borrows from and before the
 * subsystem literal that mounts it. It claims no protocol feature.
 *
 * THE FORK STAYS COMPOSED OF THE SESSIONS' OWNERS. Session lifecycle, launch, account resolution, planning, the runtime
 * and the transcript capture are session code that stays in `fyd.ts` (each later wave-E PR moves one of those), so they
 * reach this module only as typed {@link SessionForkNeeds}: the very locals the old call passed, and every value the old
 * code read LATE (the account resolution, the lifecycle factory and the session view are closures over `fyd.ts` locals,
 * read per call) is still handed in as that closure, so each is read at the same moment it always was. The transfer
 * module's {@link TransferProvides.transferPorts} factory is still injected and still CALLED inside the build, at the
 * point those ports were always constructed.
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
  readonly storage: DaemonStorage;
  readonly paths: FoundationPaths;
  readonly attachmentStore: SessionAttachmentStore;
  /**
   * Where one session's attachment originals live: `attachmentDirectory`'s
   * `<state>/attachments/<daemonId>/<sessionId>`, the same resolver the store's originals adapter reads.
   *
   * It is a PARAMETER rather than something derived here, and that is the whole point. The daemon id
   * is only known after pairing opens, and the copier and the store must address one tree: a copier
   * writing under the session's own private directory puts real bytes on disk that
   * `attachmentStore.download` and `unlock` cannot see, so a forked session shows its attachments in
   * the manifest and fails to open any of them. Wired from the same two values that construct the
   * store, in the one place that holds both.
   */
  readonly attachmentOriginals: (sessionId: string) => string;
  /**
   * The transfer module's factory for the target plan store, the brief writer and the attachment copier. It is CALLED
   * inside `createForkSubsystem` at the point those ports were always constructed, never ahead of it.
   */
  readonly transferPorts: TransferProvides['transferPorts'];
  readonly transcriptSources: readonly TranscriptSource[];
  readonly gateway: GitWorktreeGateway;
  readonly accounts: SessionForkStartAccountResolver;
  readonly planner: SessionPlanner;
  readonly harness: Pick<HarnessQuirkService, 'planSwitch'>;
  readonly catalog: CodexRuntimeCatalogCache;
  readonly createLifecycle: (id: SessionId, envelope?: SessionProtocolEnvelope) => SessionLifecycleService;
  readonly transcripts: Pick<TranscriptProvenanceCapture, 'capture'>;
  /** The one daemon-private codec shared with the operator message read surface. */
  readonly messageTokens: SessionTranscriptMessageTokenCodec;
  /** The same fail-closed redactor used by operator transcript reads. */
  readonly redactor: Pick<SecretRedactor, 'batch'>;
  readonly environment: Pick<FileSessionEnvironmentStore, 'read'>;
  /** The startup half only — the intermediate annotation must not erase it. */
  readonly runtime: SessionRuntimeStartupHeldPort;
  readonly view: (id: SessionId) => Promise<SessionView | undefined>;
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
  const conversation = new StorageTransferConversationReader(
    parts.transcriptSources,
    new StorageTranscriptDigestJournal(parts.storage),
    parts.redactor,
  );
  const preparer = new SessionTransferPreparer({
    source: new StorageTransferSourceReader(parts.storage),
    selection: {
      verifySelection: async (evidence, binding) =>
        (await verifySessionTranscriptMessageToken(
          parts.messageTokens,
          SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
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
      conversation: new ConversationFacetContributor(conversation, parts.redactor),
      attachments: new AttachmentFacetContributor(new SessionAttachmentTransferReader(parts.attachmentStore)),
      references: new ReferenceFacetContributor(),
      workspace: new WorkspaceFacetContributor(new GitTransferWorkspaceProbe(parts.gateway)),
      lineage: new LineageFacetContributor(),
    },
  });
  const { planStore, briefWriter, attachmentCopier } = parts.transferPorts({
    paths: parts.paths,
    attachmentOriginals: parts.attachmentOriginals,
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
    importPorts: {
      envelope: new StorageTransferEnvelopeWriter(parts.storage),
      brief: briefWriter,
      // The store's OWN tree, not the session's private directory: bytes written anywhere else are
      // real files that `attachmentStore.download` and `unlock` cannot find, so a forked session
      // would list its attachments and fail to open a single one.
      attachments: attachmentCopier,
      conversation,
    },
    imported: { brief: briefWriter, attachments: attachmentCopier },
    environment: parts.environment,
    tmuxSession: id => sessionTmuxName(id, defaultSessionLifecycleSettings),
    runtime: parts.runtime,
    view: parts.view,
    sessionDirectory: id => createSessionPaths(parts.paths, id).directory,
    readableHandoffs: id =>
      handoffFolders(createSessionPaths(parts.paths, id).directory, parts.attachmentOriginals(id)),
    clock: parts.clock,
  });
  return new SessionForkFacade(
    new SessionForkService({
      receipts: new FileSessionForkReceiptStore(key => forkReceiptFile(parts.paths.state, key)),
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

export const sessionForkModule: DaemonModule<void, SessionForkNeeds, SessionForkSubsystem> = {
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
