import { afterEach, describe, it } from 'bun:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ConversationMessagePoint,
  type RuntimeControlRequest,
  type RuntimeModelChoice,
  SessionConfigSchema,
  SessionStateSchema,
  type SessionTransferPlan,
  type SessionView,
} from '@ferretry/protocol';
import should from 'should';
import {
  FileSessionForkReceiptStore,
  forkReceiptFile,
} from '../../../src/adapters/fork/file-session-fork-receipt-store.ts';
import {
  SessionForkTargetBinder,
  SessionForkTargetBindingError,
  forkOpeningTurn,
  forkOpeningTurnRefusal,
} from '../../../src/adapters/fork/session-fork-target-binder.ts';
import {
  type SessionForkTargetAccount,
  SessionForkTargetResolver,
} from '../../../src/adapters/fork/session-fork-target-resolver.ts';
import { BunGitRunner } from '../../../src/adapters/git/index.ts';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import { FileSessionEffectLedger } from '../../../src/adapters/session/effects/file-session-effect-ledger.ts';
import { FileSessionEnvironmentStore } from '../../../src/adapters/session/lifecycle/file-session-environment-store.ts';
import { FileSessionTaskStore } from '../../../src/adapters/session/lifecycle/file-session-task-store.ts';
import { NodeSessionCredentialIssuer } from '../../../src/adapters/session/lifecycle/node-session-credential-issuer.ts';
import { NodeWorkingDirectoryResolver } from '../../../src/adapters/session/lifecycle/node-working-directory-resolver.ts';
import {
  type SessionProtocolEnvelope,
  StorageSessionLifecycleRepository,
} from '../../../src/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { FileHarnessWrapperSource } from '../../../src/adapters/session/transcript/file-harness-wrapper-source.ts';
import {
  FileSessionTranscriptMessageTokenCodec,
  sessionMessageTokenKeyFile,
} from '../../../src/adapters/session/transcript/file-message-token-codec.ts';
import { StorageTranscriptDigestJournal } from '../../../src/adapters/session/transcript/storage-transcript-digest-journal.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';
import { NodeTranscriptSource } from '../../../src/adapters/transcript/index.ts';
import { FileSessionAttachmentCopier } from '../../../src/adapters/transfer/attachment-copier.ts';
import { FileSessionTransferBriefWriter } from '../../../src/adapters/transfer/brief-writer.ts';
import { GitTransferWorkspaceProbe } from '../../../src/adapters/transfer/git-transfer-workspace-probe.ts';
import { FileSessionTransferTargetPlanStore } from '../../../src/adapters/transfer/plan-store.ts';
import { SessionAttachmentTransferReader } from '../../../src/adapters/transfer/session-attachment-reader.ts';
import { StorageTransferConversationReader } from '../../../src/adapters/transfer/storage-transfer-conversation-reader.ts';
import { StorageTransferEnvelopeWriter } from '../../../src/adapters/transfer/storage-transfer-envelope-writer.ts';
import { StorageTransferSourceReader } from '../../../src/adapters/transfer/storage-transfer-source-reader.ts';
import {
  GitWorktreeGateway,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
} from '../../../src/adapters/worktrees/index.ts';
import { SessionAttachmentStore } from '../../../src/lib/attachments/session-attachments.ts';
import { SessionForkRequestConflictError } from '../../../src/lib/fork/failures.ts';
import { type SessionForkCommand, type SessionForkKey, sessionForkKey } from '../../../src/lib/fork/identity.ts';
import { SessionForkService } from '../../../src/lib/fork/service.ts';
import type { SessionForkPorts, SessionForkResult } from '../../../src/lib/fork/types.ts';
import type { JsonValue } from '../../../src/lib/json.ts';
import { type FoundationPaths, createSessionPaths, temporaryFilePath } from '../../../src/lib/paths.ts';
import { CodexRuntimeCatalogCache } from '../../../src/lib/session/harness/codex-catalog-cache.ts';
import { planRuntimeSwitch } from '../../../src/lib/session/harness/runtime-switch.ts';
import { startupModelArguments } from '../../../src/lib/session/harness/startup.ts';
import { assignedTaskDocument, sessionTmuxName } from '../../../src/lib/session/lifecycle/policy.ts';
import { SessionLifecycleService } from '../../../src/lib/session/lifecycle/service.ts';
import { defaultSessionLifecycleSettings } from '../../../src/lib/session/lifecycle/settings.ts';
import { SessionRuntimeError } from '../../../src/lib/session/runtime-control/types.ts';
import { claudeSessionArguments } from '../../../src/lib/session/transcript/claude-path.ts';
import { sameConversationMessagePoint } from '../../../src/lib/session/transcript/digest.ts';
import {
  issueSessionTranscriptMessageToken,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  verifySessionTranscriptMessageToken,
} from '../../../src/lib/session/transcript/message-token.ts';
import { TranscriptProvenanceCapture } from '../../../src/lib/session/transcript/provenance.ts';
import { type SessionId, parseSessionId } from '../../../src/lib/session-id.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import { AttachmentFacetContributor } from '../../../src/lib/transfer/facets/attachments.ts';
import { ConversationFacetContributor } from '../../../src/lib/transfer/facets/conversation.ts';
import { LineageFacetContributor } from '../../../src/lib/transfer/facets/lineage.ts';
import { ReferenceFacetContributor } from '../../../src/lib/transfer/facets/references.ts';
import { WorkspaceFacetContributor } from '../../../src/lib/transfer/facets/workspace.ts';
import { SessionTransferPreparer } from '../../../src/lib/transfer/prepare.ts';
import { TransferImportError, TransferPrepareError } from '../../../src/lib/transfer/types.ts';
import { WARDEN_LABEL } from '../../../src/lib/warden/types.ts';
import { AT, SOURCE_ID, account, cleanup, planner, realTemporaryDirectory } from './fixtures.ts';

/**
 * ONE FORK, END TO END, OVER THE PRODUCTION COMPOSITION — a real state home, a real transcript file
 * on disk, the real preparer and its facet contributors, the real receipt store, target plan store,
 * envelope/brief/attachment writers, the real binder, and the real service driving all of them.
 *
 * WHY THIS FILE HAS TO BE REAL. Every adapter suite beside it proves its own bytes against a fixture
 * written to expect them, and each of those fixtures is a second statement of a layout, a point or a
 * plan. What a fork actually promises are properties of the COMPOSITION, and none of them is visible
 * in any single adapter: that the message a caller pointed at is the one that crosses, that the
 * session it was read from is byte-for-byte as it was afterwards, that a process boundary anywhere in
 * the sequence finishes THAT fork rather than starting a second one, and that a target something else
 * damaged is refused rather than launched. A fake preparer or a fake binder proves only that this
 * file agrees with itself.
 *
 * WHAT IS STUBBED, AND WHY NONE OF IT IS THE SUBJECT. The fleet account resolution and the live Codex
 * catalogue are external inventories this host does not have; the tmux launcher and the mounted
 * runtime path drive a real pane. Two one-shot levers reproduce crashes without crashing: the source
 * transcript may be mutated between preparation and import, which is the race a frozen plan exists
 * for, and the target's transcript capture may be made to throw, which is a death between recording
 * `imported` and capturing the target's own identity. Everything the fork itself decides or writes is
 * the shipped code.
 *
 * THE CUT IS AN EXACT BYTE OFFSET IN A REAL FILE. The seeded transcript's second record begins at
 * byte 512 exactly, and that record carries TWO content blocks — so `{ v: 1, byteOffset: 512,
 * blockIndex: 0 }` names one message and `blockIndex: 1` names a different one. A journey that
 * carried "everything up to the last record" would satisfy every other assertion here and fail that.
 */

const CUT: ConversationMessagePoint = { v: 1, byteOffset: 512, blockIndex: 0 };
const DESCENDANT_ID = '20260806-descendant';
const FIRST_TARGET = '20260806-target-1';
const DAEMON_ID = 'daemon-journey';
const WARDEN_ID = '20260806-warden';
const SOURCE_NAME = 'Port The Transfer Seam';
const SOURCE_HARNESS_SESSION = 'harness-source';
const SOURCE_FLAG = '--dangerously-skip-permissions';

/** The text of every record the seeded transcript holds, so an assertion can name them. */
const OPENING = 'the question that opened this conversation';
const CARRIED = 'the answer the fork is cut at';
const AFTER_BLOCK = 'a second block of the same record, which is a different message point';
const AFTER_CUT = 'said after the plan was made, and beyond the cut';
const APPENDED = 'still working, long after the plan was frozen';
const EARLIER_REPLACEMENT = 'an earlier message replaced after the operator selected the cut';

/** The Codex rows the live catalogue advertises, for the cross-family target's reasoning level. */
const CODEX_CATALOG: readonly RuntimeModelChoice[] = [
  {
    value: 'gpt-5.6-terra',
    label: 'terra',
    reasoningEfforts: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
    defaultReasoningEffort: 'high',
  },
];

/** A tiny PDF the attachment store reads as encrypted, so the copied original is a LOCKED one. */
const LOCKED_PDF = new TextEncoder().encode('%PDF-1.7\n/Encrypt 1 0 R\nthe original bytes\n%%EOF\n');

// ─── the source transcript, with the cut at an exact byte offset ────────────────────────────────

/** One Claude JSONL record, in the shape its own parser normalizes. */
function record(role: 'user' | 'assistant', uuid: string, blocks: readonly string[]): string {
  return JSON.stringify({
    type: role,
    uuid,
    timestamp: AT,
    message: { role, content: blocks.map(text => ({ type: 'text', text })) },
  });
}

/**
 * The opening record, padded so the record AFTER it begins at byte 512 exactly.
 *
 * Padded rather than measured: the coordinate this journey pins is the literal `byteOffset: 512`, and
 * a transcript whose second record happened to land elsewhere would make that literal a lie the test
 * itself had told.
 */
function openingRecord(text = OPENING): string {
  const bare = record('user', 'rec-1', [text]);
  const padding = CUT.byteOffset - (bare.length + 1);
  if (padding < 0) throw new Error('the opening transcript record does not fit before the pinned cut');
  return record('user', 'rec-1', [`${text}${'.'.repeat(padding)}`]);
}

/** The seeded transcript: an opening record, the two-block cut record, and one record past it. */
function sourceTranscript(): string {
  return `${[
    openingRecord(),
    record('assistant', 'rec-2', [CARRIED, AFTER_BLOCK]),
    record('user', 'rec-3', [AFTER_CUT]),
  ].join('\n')}\n`;
}

/** The same transcript with two further records appended, exactly as a live session grows. */
function appendedTranscript(): string {
  return `${sourceTranscript()}${[
    record('assistant', 'rec-4', [APPENDED]),
    record('user', 'rec-5', ['and again']),
  ].join('\n')}\n`;
}

/** The pinned message, rewritten in place: the same coordinate now says something else. */
function rewrittenTranscript(): string {
  return `${[
    openingRecord(),
    record('assistant', 'rec-2', ['this is not what the plan froze', AFTER_BLOCK]),
    record('user', 'rec-3', [AFTER_CUT]),
  ].join('\n')}\n`;
}

/** The selected record is unchanged, but its authenticated raw prefix is not. */
function earlierRewrittenTranscript(): string {
  return `${[
    openingRecord(EARLIER_REPLACEMENT),
    record('assistant', 'rec-2', [CARRIED, AFTER_BLOCK]),
    record('user', 'rec-3', [AFTER_CUT]),
  ].join('\n')}\n`;
}

/**
 * The transcript truncated to end BEFORE the pinned coordinate, so byte 512 addresses nothing.
 *
 * Deleting the cut record alone would not do it: the next record would then begin at byte 512 and the
 * coordinate would still name a message — a rewritten one. This is the other answer, and the two are
 * refused with different words.
 */
function truncatedTranscript(): string {
  return `${openingRecord()}\n`;
}

// ─── real session documents ─────────────────────────────────────────────────────────────────────

interface SourceSeed {
  readonly id: string;
  readonly cwd: string;
  readonly transcriptFile: string;
  readonly warden: boolean;
}

/** One complete configuration document, as a live Claude session carries it. */
function sourceConfiguration(seed: SourceSeed): Record<string, unknown> {
  return {
    id: seed.id,
    incarnation: `${seed.id}-4`,
    runtimeGeneration: 3,
    name: SOURCE_NAME,
    teammate: 'alistair',
    label: 'f117',
    boardAccess: 'worker',
    agent: 'claude-auto-source',
    harness: 'claude',
    modelHint: 'opus',
    model: 'claude-opus-5',
    mode: 'auto',
    remoteControl: true,
    harnessFlags: [SOURCE_FLAG],
    cwd: seed.cwd,
    createdAt: AT,
    updatedAt: AT,
    turn: 12,
    intervalSeconds: 30,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 120,
    killAfterSeconds: 900,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'full',
    maxSnapshots: 5,
    transcript: {
      v: 1,
      home: '/fleet/homes/source',
      harnessSessionId: SOURCE_HARNESS_SESSION,
      identity: 'minted',
      file: seed.transcriptFile,
      resolvedAt: AT,
    },
    provenance: seed.warden
      ? {
          v: 1,
          at: AT,
          origin: 'warden',
          warden: WARDEN_ID,
          wardenLineage: true,
          lineageSource: 'parent_stamp',
        }
      : { v: 1, at: AT, origin: 'human', wardenLineage: false, lineageSource: 'none' },
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  };
}

/** A state document for a session that is running, as the source is. */
function sessionState(id: string): Record<string, unknown> {
  return { id, status: 'running', turn: 12, startedAt: AT, lastActivityAt: AT, observedModel: 'claude-opus-5' };
}

// ─── the journey harness ────────────────────────────────────────────────────────────────────────

/** A recursive map of relative path to hex-encoded content: bytes, never parsed values. */
type Snapshot = Record<string, string>;

async function snapshotTree(root: string, prefix: string, into: Snapshot): Promise<Snapshot> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await snapshotTree(path, key, into);
    else into[key] = (await readFile(path)).toString('hex');
  }
  return into;
}

/** The same snapshot with the transcript blanked, for a case that rewrote the transcript itself. */
function besideTheTranscript(snapshot: Snapshot): Snapshot {
  return { ...snapshot, transcript: '' };
}

/** The runtime subsystem's opaque comparison, repeated only by this stateful port stand-in. */
function runtimeEffectFingerprint(request: RuntimeControlRequest): string {
  return JSON.stringify([
    request.action,
    request.action === 'compact' ? null : (request.effort ?? null),
    request.action === 'model' ? (request.model ?? null) : null,
  ]);
}

interface JourneyOptions {
  /** The family the fork targets. `codex` is the cross-harness case. */
  readonly targetHarness?: 'claude' | 'codex';
  /** Whether the source carries a warden stamp, which forces the target's operational label. */
  readonly warden?: boolean;
  /** Loses the first startup runtime outcome after its irreversible action has begun. */
  readonly loseRuntimeOutcomeOnce?: boolean;
  /** Loses the receipt advance after a complete import, leaving the target ahead of the receipt. */
  readonly loseImportStampOnce?: boolean;
  readonly redact?: (text: string) => Promise<string>;
}

interface Journey {
  readonly cwd: string;
  readonly agent: string;
  readonly model: string;
  /** The absolute wrapper the target account is launched through. */
  readonly executable: string;
  readonly transcriptFile: string;
  /** Opaque evidence issued by a real initial transcript read under this state home's durable key. */
  readonly selectionBinding: string;
  /** Everything the preparer, the launcher and the runtime path were observed doing, in order. */
  readonly happened: string[];
  /** Every target id this fork's id factory was asked for. A second entry is a second target. */
  readonly minted: string[];
  fork(key: SessionForkKey, command: SessionForkCommand): Promise<SessionForkResult>;
  /** Closes the state home and reopens it, rebuilding every adapter: a real process boundary. */
  restart(): Promise<void>;
  storage(): DaemonStorage;
  directory(id: string): string;
  attachments(): SessionAttachmentStore;
  /** Rewrites the source transcript ONCE, after preparation has frozen its plan and before import. */
  moveSourceAfterPrepare(text: string): void;
  /** Makes the target's transcript capture throw, reproducing a death just after the import. */
  breakCapture(broken: boolean): void;
  writeTranscript(text: string): Promise<void>;
  snapshotSource(): Promise<Snapshot>;
  /** The durable event pointers of the source and its descendant, resolved through the index. */
  pointers(): Promise<string>;
  receipt(requestId: string): Promise<Record<string, unknown>>;
  hasReceipt(requestId: string): Promise<boolean>;
  /** The plan copy beneath the target, which exists from `plan_persisted` onwards. */
  targetPlan(id: string): Promise<string>;
  target(id: string): Promise<{
    readonly config: Record<string, unknown>;
    readonly plan: string;
    readonly brief: string;
  }>;
  close(): Promise<void>;
}

async function journey(label: string, options: JourneyOptions = {}): Promise<Journey> {
  const targetHarness = options.targetHarness ?? 'claude';
  const home = await realTemporaryDirectory(`fy-journey-${label}-`);
  const cwd = await realTemporaryDirectory(`fy-journey-${label}-cwd-`);
  const fleet = await realTemporaryDirectory(`fy-journey-${label}-fleet-`);
  const harnessHome = await realTemporaryDirectory(`fy-journey-${label}-harness-`);
  const transcriptDirectory = await realTemporaryDirectory(`fy-journey-${label}-transcript-`);
  const transcriptFile = join(transcriptDirectory, 'source.jsonl');
  const happened: string[] = [];
  const minted: string[] = [];
  let brokenCapture = false;
  let moveAfterPrepare: string | undefined;
  let harnessSessions = 0;
  let terminalAlive = false;
  let loseRuntimeOutcome = options.loseRuntimeOutcomeOnce === true;
  let loseImportStamp = options.loseImportStampOnce === true;

  /**
   * The published fleet: two accounts and their wrappers, written as the real scripts a fleet
   * publishes, so the production wrapper reader learns each harness home from a file rather than
   * from a fake that agrees with this test by construction.
   */
  const claudeExecutable = join(fleet, 'claude-auto-zelda');
  const codexExecutable = join(fleet, 'codex-auto-terra');
  await writeFile(claudeExecutable, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR=${harnessHome}\nexec claude "$@"\n`);
  await writeFile(codexExecutable, `#!/bin/sh\nexport CODEX_HOME=${harnessHome}\nexec codex "$@"\n`);
  const published: readonly SessionForkTargetAccount[] = [
    { account: account({ wrapper: claudeExecutable }), executable: claudeExecutable },
    {
      account: account({
        id: 'acct-codex',
        agent: 'codex-auto-terra',
        kind: 'codex',
        wrapper: codexExecutable,
        home: harnessHome,
        displayName: 'Terra',
        defaultModel: 'gpt-5.6-terra',
        models: [{ id: 'gpt-5.6-terra', available: true }],
      }),
      executable: codexExecutable,
    },
  ];
  const chosen = published[targetHarness === 'claude' ? 0 : 1];
  if (chosen === undefined) throw new Error('the journey fleet is missing its target account');

  let opened = await openStorageAt(home);
  const createMessageTokens = (paths: FoundationPaths): FileSessionTranscriptMessageTokenCodec => {
    const keyFile = sessionMessageTokenKeyFile(paths.state);
    return new FileSessionTranscriptMessageTokenCodec(keyFile, writerId => temporaryFilePath(paths, keyFile, writerId));
  };
  let messageTokens = createMessageTokens(opened.paths);
  const directory = (id: string): string => createSessionPaths(opened.paths, parseSessionId(id)).directory;
  const effects = new FileSessionEffectLedger(id => directory(id));
  const attachments = (): SessionAttachmentStore =>
    new SessionAttachmentStore({ root: opened.paths.state, daemonId: DAEMON_ID, now: () => new Date(AT) });
  /** The target's private credential file: written by the lifecycle, proved by the binder. */
  const environments = (): FileSessionEnvironmentStore => new FileSessionEnvironmentStore(id => directory(id));

  const conversationReader = (storage: DaemonStorage): StorageTransferConversationReader =>
    new StorageTransferConversationReader(
      [new NodeTranscriptSource(new ClaudeTranscriptParser()), new NodeTranscriptSource(new CodexTranscriptParser())],
      new StorageTranscriptDigestJournal(storage),
      { redact: options.redact ?? (async text => text) },
    );

  /** The composition root's own start-account resolution, over the two published accounts. */
  async function resolveAccount(agent: string): Promise<SessionForkTargetAccount> {
    const found = published.find(candidate => candidate.account.agent === agent);
    if (found === undefined)
      throw Object.assign(new Error(`no account is published as ${JSON.stringify(agent)}`), {
        failure: 'unknown_agent',
      });
    return found;
  }

  /** The lifecycle every other create goes through, with only its terminal seam replaced. */
  function lifecycle(id: SessionId, envelope?: SessionProtocolEnvelope): SessionLifecycleService {
    return new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(opened.storage, envelope),
        launcher: {
          alive: async () => terminalAlive,
          launch: async () => {
            terminalAlive = true;
            happened.push('launch');
          },
          ready: async _record => {
            happened.push('ready');
          },
          deliver: async (_record, instruction, beforeWrite) => {
            await beforeWrite?.();
            happened.push(`deliver:${instruction.includes('turn-001.md') ? 'turn-one' : 'other'}`);
          },
          snapshot: async () => undefined,
          stop: async () => {
            terminalAlive = false;
          },
        },
        tasks: new FileSessionTaskStore(held => directory(held)),
        effects,
        directories: new NodeWorkingDirectoryResolver(),
        ids: {
          next: () => {
            happened.push(`create:${id}`);
            return id;
          },
        },
        clock: { now: () => AT },
        serial: new KeyedSerialExecutor(),
        // The production issuer and the production environment store, because the binder proves the
        // record's hash against the credential really on disk before it launches anything.
        credentials: new NodeSessionCredentialIssuer(),
        environment: environments(),
      },
      defaultSessionLifecycleSettings,
    );
  }

  /** The one place the production adapter set is built, so a restart rebuilds all of it. */
  function ports(): SessionForkPorts {
    const storage = opened.storage;
    const paths = opened.paths;
    const conversation = conversationReader(storage);
    const preparer = new SessionTransferPreparer({
      source: new StorageTransferSourceReader(storage),
      selection: {
        verifySelection: async (evidence, binding) =>
          (await verifySessionTranscriptMessageToken(
            messageTokens,
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
        conversation: new ConversationFacetContributor(conversation, {
          redact: options.redact ?? (async text => text),
        }),
        attachments: new AttachmentFacetContributor(new SessionAttachmentTransferReader(attachments())),
        references: new ReferenceFacetContributor(),
        workspace: new WorkspaceFacetContributor(
          new GitTransferWorkspaceProbe(
            new GitWorktreeGateway(new BunGitRunner(), new NodeWorktreeFileSystem(), new SystemWorktreeClock()),
          ),
        ),
        lineage: new LineageFacetContributor(),
      },
    });
    const plans = new FileSessionTransferTargetPlanStore(id => join(directory(id), 'transfer-plan.json'));
    const resolver = new SessionForkTargetResolver({
      accounts: resolveAccount,
      planner: planner(),
      harness: { planSwitch: planRuntimeSwitch },
      catalog: new CodexRuntimeCatalogCache(async () => CODEX_CATALOG),
    });
    const capture = new TranscriptProvenanceCapture(
      new FileHarnessWrapperSource(),
      {
        next: () => {
          harnessSessions += 1;
          return `harness-target-${String(harnessSessions)}`;
        },
      },
      { ids: async () => [] },
      {},
    );
    // ONE brief writer and ONE copier, handed to the import half as writers and to the proof half as
    // readers: two instances over one layout would be two answers to where the target's bytes are.
    const brief = new FileSessionTransferBriefWriter(id => directory(id));
    // The store's OWN tree, spelled exactly as the composition root spells it.
    const copier = new FileSessionAttachmentCopier(id => join(paths.state, 'attachments', DAEMON_ID, id));
    const binder = new SessionForkTargetBinder({
      storage,
      createLifecycle: (id, envelope) => lifecycle(id, envelope),
      accounts: resolveAccount,
      runtimeChoice: resolver,
      planner: planner(),
      plans: {
        read: async id => await plans.load(id),
        install: async (id, plan) => await plans.install(id, plan),
      },
      transcripts: {
        // The crash lever: a fork that died between recording `imported` and capturing the target's
        // own transcript identity. Everything either side of it is the production capture.
        capture: async request => {
          if (brokenCapture) throw new Error('the harness home could not be read');
          return await capture.capture(request);
        },
      },
      importPorts: { envelope: new StorageTransferEnvelopeWriter(storage), brief, attachments: copier, conversation },
      // The same two writers, read-only: a later phase proves the brief and the copied original are
      // still what the receipt claimed rather than repairing either just before a launch.
      imported: { brief, attachments: copier },
      environment: environments(),
      tmuxSession: id => sessionTmuxName(id, defaultSessionLifecycleSettings),
      runtime: {
        startupWhileHeld: async (sessionId, request, requestId) => {
          const id = parseSessionId(sessionId);
          const key = { sessionId: id, effectId: `runtime:${requestId}` } as const;
          const fingerprint = runtimeEffectFingerprint(request);
          const standing = await effects.inspect(key, fingerprint);
          if (standing === 'settled') return;
          if (standing === 'conflict')
            throw new SessionRuntimeError('conflict', `runtime request ${requestId} holds a different action`);
          if (standing === 'unsettled')
            throw new SessionRuntimeError(
              'unsettled',
              `runtime request ${requestId} began but its outcome was never recorded`,
            );
          const admission = await effects.begin(key, fingerprint, AT);
          if (admission === 'settled') return;
          if (admission === 'conflict')
            throw new SessionRuntimeError('conflict', `runtime request ${requestId} holds a different action`);
          if (admission === 'unsettled')
            throw new SessionRuntimeError(
              'unsettled',
              `runtime request ${requestId} began but its outcome was never recorded`,
            );
          happened.push(`runtime:${JSON.stringify(request)}:${requestId}`);
          if (loseRuntimeOutcome) {
            loseRuntimeOutcome = false;
            throw new SessionRuntimeError(
              'failed',
              `runtime request ${requestId} reached the harness but its response bookkeeping was lost`,
            );
          }
          await effects.settle(key, fingerprint, AT);
        },
      },
      view: async id => await view(storage, paths, id).catch(() => undefined),
      sessionDirectory: id => directory(id),
      clock: { now: () => AT },
    });
    const queue = new KeyedSerialExecutor();
    const receipts = new FileSessionForkReceiptStore(held => forkReceiptFile(paths.state, held));
    return {
      receipts: {
        read: async key => await receipts.read(key),
        claim: async receipt => await receipts.claim(receipt),
        advance: async receipt => {
          if (loseImportStamp && receipt.phase === 'imported') {
            loseImportStamp = false;
            throw new Error('the imported target survived but its receipt advance was lost');
          }
          await receipts.advance(receipt);
        },
      },
      resolver,
      preparer: {
        prepare: async request => {
          happened.push(`prepare:${JSON.stringify(request.cutMessagePoint)}`);
          const plan = await preparer.prepare(request);
          // The source moves on between the decision and the import, which is precisely the race a
          // frozen plan and the import's re-read exist to survive. One shot, so the retry is clean.
          if (moveAfterPrepare !== undefined) {
            await writeFile(transcriptFile, moveAfterPrepare);
            moveAfterPrepare = undefined;
          }
          return plan;
        },
      },
      opening: {
        assertDeliverable: plan => {
          const refusal = forkOpeningTurnRefusal(plan);
          if (refusal !== undefined) throw new TransferPrepareError('plan_invalid', refusal);
        },
      },
      binder,
      ids: {
        next: () => {
          const next = `20260806-target-${String(minted.length + 1)}`;
          minted.push(next);
          return next;
        },
      },
      clock: { now: () => AT },
      serial: { run: async (held, work) => await queue.run(sessionForkKey(held), work) },
    };
  }

  /**
   * The source, its descendant, its waiters, its journal, its locked attachment and its transcript.
   *
   * Written through the production stores, so the snapshot a later assertion compares is a snapshot
   * of documents this daemon really produces rather than of literals this file invented.
   */
  async function seed(): Promise<void> {
    const source = parseSessionId(SOURCE_ID);
    const descendant = parseSessionId(DESCENDANT_ID);
    const warden = options.warden === true;
    await writeFile(transcriptFile, sourceTranscript());
    await opened.storage.writeConfig(source, sourceConfiguration({ id: SOURCE_ID, cwd, transcriptFile, warden }));
    await opened.storage.writeState(source, sessionState(SOURCE_ID));
    await opened.storage.append(source, 'session.created', { agent: 'claude-auto-source' });
    await opened.storage.append(source, 'session.turn', { turn: 12 });
    // A descendant of the source, so "a fork never restamps the tree hanging off what it read" has
    // something real to be true about.
    await opened.storage.writeConfig(descendant, {
      ...sourceConfiguration({ id: DESCENDANT_ID, cwd, transcriptFile, warden }),
      parent: SOURCE_ID,
      teammate: 'savana',
    });
    await opened.storage.writeState(descendant, sessionState(DESCENDANT_ID));
    await opened.storage.append(descendant, 'session.created', { parent: SOURCE_ID });
    // Waiter, channel and coordination artefacts, in the exact files their own adapters own.
    const held = directory(SOURCE_ID);
    await mkdir(join(held, 'channel'), { recursive: true, mode: 0o700 });
    await mkdir(join(held, 'checks'), { recursive: true, mode: 0o700 });
    await mkdir(join(held, 'turns'), { recursive: true, mode: 0o700 });
    await writeFile(join(held, 'channel', 'inbox.jsonl'), `${JSON.stringify({ at: AT, from: 'alistair' })}\n`);
    await writeFile(
      join(held, 'channel', 'sends.jsonl'),
      `${JSON.stringify({ sendId: 'send-1', at: AT, awaitingReply: true })}\n`,
    );
    await writeFile(join(held, 'checks', 'waiting.json'), `${JSON.stringify({ since: AT, condition: 'a reply' })}\n`);
    await writeFile(join(held, 'turns', 'turn-001.md'), '# The source own first turn\n');
    await writeFile(join(held, 'attention.json'), `${JSON.stringify({ v: 1, entries: [] })}\n`);
    await attachments().upload(SOURCE_ID, { filename: 'brief.pdf', mime: 'application/pdf', bytes: LOCKED_PDF });
  }

  /**
   * What a real GET messages read would hand back for the cut: one transcript pass, then one opaque
   * tag under the same durable codec preparation receives. The raw prefix never leaves this helper.
   */
  async function issueInitialSelectionBinding(): Promise<string> {
    const config = SessionConfigSchema.parse(await opened.storage.readConfig(parseSessionId(SOURCE_ID)));
    const provenance = config.transcript;
    if (provenance === undefined || provenance.identity === 'undiscovered')
      throw new Error('the source fixture must carry completed transcript provenance');
    const digest = await conversationReader(opened.storage).digest({
      sourceSessionId: SOURCE_ID,
      sourceHarness: config.harness,
      transcriptProvenance: provenance,
      through: CUT,
    });
    const evidence = digest?.selectionEvidence;
    if (evidence === undefined)
      throw new Error('the initial transcript read did not produce private raw-prefix evidence for the cut');
    if (!sameConversationMessagePoint(evidence.point, CUT))
      throw new Error('the initial transcript read returned evidence for a different message point');
    return await issueSessionTranscriptMessageToken(
      messageTokens,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      { sessionId: SOURCE_ID, incarnation: config.incarnation, provenance },
      CUT,
      evidence.rawPrefix,
    );
  }

  await seed();
  const selectionBinding = await issueInitialSelectionBinding();

  return {
    cwd,
    agent: chosen.account.agent,
    model: chosen.account.defaultModel ?? '',
    executable: chosen.executable,
    transcriptFile,
    selectionBinding,
    happened,
    minted,
    fork: async (held, command_) => await new SessionForkService(ports()).fork(held, command_),
    restart: async () => {
      await opened.storage.close();
      opened = await openStorageAt(home);
      // A process boundary forgets the in-memory key promise; the new codec must adopt the durable
      // winner and still verify the binding issued before the restart.
      messageTokens = createMessageTokens(opened.paths);
    },
    storage: () => opened.storage,
    directory,
    attachments,
    moveSourceAfterPrepare: text => {
      moveAfterPrepare = text;
    },
    breakCapture: broken => {
      brokenCapture = broken;
    },
    writeTranscript: async text => await writeFile(transcriptFile, text),
    snapshotSource: async () => {
      const into: Snapshot = { transcript: (await readFile(transcriptFile)).toString('hex') };
      await snapshotTree(directory(SOURCE_ID), 'source', into);
      await snapshotTree(directory(DESCENDANT_ID), 'descendant', into);
      await snapshotTree(join(opened.paths.state, 'attachments', DAEMON_ID, SOURCE_ID), 'attachments', into);
      return into;
    },
    pointers: async () =>
      JSON.stringify([
        await opened.storage.replay(parseSessionId(SOURCE_ID)),
        await opened.storage.replay(parseSessionId(DESCENDANT_ID)),
      ]),
    receipt: async requestId =>
      JSON.parse(
        await readFile(forkReceiptFile(opened.paths.state, { sourceSessionId: SOURCE_ID, requestId }), 'utf8'),
      ) as Record<string, unknown>,
    hasReceipt: async requestId =>
      await readFile(forkReceiptFile(opened.paths.state, { sourceSessionId: SOURCE_ID, requestId })).then(
        () => true,
        () => false,
      ),
    targetPlan: async id => await readFile(join(directory(id), 'transfer-plan.json'), 'utf8'),
    target: async id => ({
      config: (await opened.storage.readConfig(parseSessionId(id))) as Record<string, unknown>,
      plan: await readFile(join(directory(id), 'transfer-plan.json'), 'utf8'),
      brief: await readFile(join(directory(id), 'turns', 'turn-001.md'), 'utf8'),
    }),
    close: async () => await opened.storage.close(),
  };
}

/** A real, locked state home with a real SQLite index behind it, at an EXISTING home path. */
async function openStorageAt(home: string): Promise<{ storage: DaemonStorage; paths: FoundationPaths }> {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(AT)),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  return { storage: opened.storage, paths: opened.paths };
}

async function view(storage: DaemonStorage, paths: FoundationPaths, id: SessionId): Promise<SessionView> {
  return {
    config: SessionConfigSchema.parse(await storage.readConfig(id)),
    state: SessionStateSchema.parse(await storage.readState(id)),
    directory: createSessionPaths(paths, id).directory,
  };
}

/** The command a caller sends, with only the pieces one case varies spelled out. */
function command(subject: Journey, overrides: Partial<SessionForkCommand> = {}): SessionForkCommand {
  return {
    through: CUT,
    selectionBinding: subject.selectionBinding,
    agent: subject.agent,
    model: subject.model,
    effort: 'high',
    ...overrides,
  };
}

const key = (requestId: string): SessionForkKey => ({ sourceSessionId: SOURCE_ID, requestId });

async function refused(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected this fork to be refused, but it resolved');
    },
    (error: unknown) => error,
  );
}

/** How many times one observed step happened across every attempt at a fork. */
function times(subject: Journey, step: string): number {
  return subject.happened.filter(held => held === step || held.startsWith(`${step}:`)).length;
}

afterEach(async () => await cleanup());

describe('the fork journey over real storage', () => {
  it('should carry the exact pinned message into a fresh same-harness target and touch nothing it read', async () => {
    // Arrange: a warden-descended Claude source, forked within its own family.
    const subject = await journey('same-harness', { warden: true });
    const before = await subject.snapshotSource();
    const pointersBefore = await subject.pointers();

    // Assert FIRST that the snapshot is a proof of anything: an empty map compares equal to an empty
    // map, so a path typo anywhere in it would turn the immutability assertion below into a no-op.
    should(Object.keys(before)).containDeep([
      'transcript',
      'source/config.json',
      'source/state.json',
      'source/events.jsonl',
      'source/session-version',
      'source/attention.json',
      'source/channel/inbox.jsonl',
      'source/channel/sends.jsonl',
      'source/checks/waiting.json',
      'source/turns/turn-001.md',
      'descendant/config.json',
      'descendant/state.json',
      'descendant/events.jsonl',
    ]);
    // The locked original and its manifest, in the store's own tree.
    should(Object.keys(before).filter(path => path.startsWith('attachments/'))).have.length(2);
    should(Object.values(before).filter(bytes => bytes === '')).eql([]);
    should(before.transcript).equal(Buffer.from(sourceTranscript()).toString('hex'));
    should(pointersBefore).match(/session\.created/u);
    should(pointersBefore).match(/session\.turn/u);

    // Act
    const outcome = await subject.fork(key('first'), command(subject));

    // Assert: one fresh target, and the exact coordinate the caller pointed at.
    should(outcome.targetSessionId).equal(FIRST_TARGET);
    should(subject.minted).eql([FIRST_TARGET]);
    should(outcome.plan.source.sessionId).equal(SOURCE_ID);
    should(outcome.plan.source.cutMessagePoint).eql(CUT);
    // The conversation ends AT that point. The second block of the same record and the record after
    // it are both past the cut, and neither crosses.
    should(outcome.plan.facets.conversation?.messages.map(message => message.point)).eql([
      { v: 1, byteOffset: 0, blockIndex: 0 },
      CUT,
    ]);
    should(outcome.plan.facets.conversation?.messages.map(message => message.role)).eql(['user', 'assistant']);
    should(outcome.plan.facets.conversation?.messages.at(-1)?.text).equal(CARRIED);
    should(JSON.stringify(outcome.plan.facets.conversation)).not.match(/a second block of the same record/u);
    should(JSON.stringify(outcome.plan.facets.conversation)).not.match(/beyond the cut/u);

    // Assert: a fresh identity that inherits nothing it must not, and the target-only lineage edge.
    const held = await subject.target(outcome.targetSessionId);
    const config = SessionConfigSchema.parse(held.config);
    should(config.id).equal(outcome.targetSessionId);
    should(config.incarnation).equal(`${outcome.targetSessionId}-1`);
    should(config.runtimeGeneration).equal(1);
    should(config.boardAccess).equal('none');
    should(config.parent).equal(undefined);
    should(config.teammate).equal(undefined);
    should(config.name).not.equal(SOURCE_NAME);
    should(config.turn).equal(1);
    should(config.harness).equal('claude');
    should(config.agent).equal('claude-auto-zelda');
    should(config.cwd).equal(subject.cwd);
    should(config.harnessFlags).eql([SOURCE_FLAG]);
    // Warden descent forces the target's operational label from its first write; the source's own
    // label stays inventoried on the plan.
    should(config.label).equal(WARDEN_LABEL);
    should(outcome.plan.source.label).equal('f117');
    should(held.config.provenance).eql({
      v: 1,
      at: AT,
      origin: 'warden',
      warden: WARDEN_ID,
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    });
    should(config.transferredFrom).eql({
      v: 1,
      kind: 'fork',
      sourceSessionId: SOURCE_ID,
      sourceIncarnation: `${SOURCE_ID}-4`,
      sourceHarness: 'claude',
      cutMessagePoint: CUT,
      planId: outcome.plan.planId,
      at: AT,
    });
    // The target's OWN transcript identity, never the source's copied across.
    should(config.transcript?.identity).equal('minted');
    should(config.transcript?.harnessSessionId).equal('harness-target-1');
    should(config.transcript?.file).not.equal(subject.transcriptFile);
    should(JSON.stringify(config.transcript)).not.match(new RegExp(SOURCE_HARNESS_SESSION, 'u'));
    // The argv that makes that record TRUE: the authorized base command, the remote-control arguments
    // this family has, the operator's carried flag, the resolved model, and the minted transcript
    // identity appended last by the capture.
    should(held.config.command).eql([
      subject.executable,
      '--chrome',
      '--rc',
      '--remote-control-session-name-prefix',
      `fyrc-${outcome.targetSessionId}`,
      SOURCE_FLAG,
      ...startupModelArguments('claude-opus-5'),
      ...claudeSessionArguments('harness-target-1'),
    ]);

    // Assert: the frozen plan and the deterministic opening brief are durable beneath the target.
    should((JSON.parse(held.plan) as SessionTransferPlan).planId).equal(outcome.plan.planId);
    should(JSON.parse(held.plan)).eql(outcome.plan);
    should(held.brief).equal(assignedTaskDocument(forkOpeningTurn(outcome.plan)));
    should(held.brief).match(/Prior context carried into this session by a fork/u);
    should(held.brief).match(new RegExp(CARRIED, 'u'));
    should(outcome.report.briefPath).equal(join(subject.directory(outcome.targetSessionId), 'turns', 'turn-001.md'));

    // Assert: the locked original is copied byte for byte into the tree the store itself reads.
    const attachmentId = outcome.plan.facets.attachments.attachments[0]?.id ?? '';
    should(outcome.report.copiedAttachmentIds).eql([attachmentId]);
    const copied = await subject.attachments().download(outcome.targetSessionId, attachmentId);
    should(copied.bytes).eql(LOCKED_PDF);
    should(copied.attachment.encrypted).eql({ kind: 'pdf', locked: true });
    should((await subject.attachments().list(outcome.targetSessionId)).map(entry => entry.id)).eql([attachmentId]);
    should(outcome.plan.notCarried.filter(omission => omission.reason === 'credential')).have.length(1);
    // Same family, so the operator's own launch arguments cross rather than being dropped.
    should(outcome.plan.notCarried.filter(omission => omission.reason === 'harness_incompatible')).eql([]);

    // Assert: the source, its descendant, its waiters, its journal, its attachment and its transcript
    // are byte-for-byte what they were, and its durable event pointers still resolve identically.
    should(await subject.snapshotSource()).eql(before);
    should(await subject.pointers()).equal(pointersBefore);
    await subject.close();
  });

  it('should launch, apply the planned reasoning level and only then deliver the opening turn', async () => {
    // Arrange
    const subject = await journey('effort-order', { warden: true });

    // Act
    const outcome = await subject.fork(key('effort'), command(subject, { effort: 'high' }));

    // Assert: the ordering the whole feature rests on, with the plan-derived runtime request id.
    should(subject.happened.filter(step => !step.startsWith('prepare:'))).eql([
      `create:${outcome.targetSessionId}`,
      'launch',
      'ready',
      `runtime:{"action":"effort","effort":"high"}:${outcome.plan.planId}:startup-runtime`,
      'deliver:turn-one',
    ]);
    await subject.close();
  });

  it('should refuse a replay whose startup runtime action began but never settled', async () => {
    // Arrange: the first attempt reaches the harness after its durable begin, then loses all outcome
    // bookkeeping. The receipt has crossed provenance, but no first-turn effect has begun.
    const subject = await journey('runtime-unsettled', { warden: true, loseRuntimeOutcomeOnce: true });

    // Act: lose the first response, cross a real storage/process boundary, and replay the identical
    // fork. The file ledger — not process memory — must decide the second attempt.
    const firstFailure = await refused(subject.fork(key('runtime-unsettled'), command(subject)));
    const firstReceipt = await subject.receipt('runtime-unsettled');
    const plan = firstReceipt.plan as SessionTransferPlan;
    await subject.restart();
    const replayFailure = await refused(subject.fork(key('runtime-unsettled'), command(subject)));

    // Assert: the same plan-derived request id is now durably unsettled. Replay waits for readiness,
    // but performs no second runtime action, never admits turn one, and cannot advance the receipt.
    should(firstFailure).be.instanceOf(SessionRuntimeError);
    should((firstFailure as SessionRuntimeError).failure).equal('failed');
    should(firstReceipt.phase).equal('provenance_captured');
    should(replayFailure).be.instanceOf(SessionRuntimeError);
    should((replayFailure as SessionRuntimeError).failure).equal('unsettled');
    should((await subject.receipt('runtime-unsettled')).phase).equal('provenance_captured');
    should(subject.minted).eql([FIRST_TARGET]);
    should(subject.happened.filter(step => !step.startsWith('prepare:'))).eql([
      `create:${FIRST_TARGET}`,
      'launch',
      'ready',
      `runtime:{"action":"effort","effort":"high"}:${plan.planId}:startup-runtime`,
      'ready',
    ]);
    should(times(subject, 'runtime')).equal(1);
    should(times(subject, 'deliver')).equal(0);
    await subject.close();
  });

  it('should ask for no runtime control at all when the fork chose no reasoning level', async () => {
    // Arrange
    const subject = await journey('no-effort', { warden: true });

    // Act
    const outcome = await subject.fork(key('plain'), command(subject, { effort: null }));

    // Assert
    should(outcome.plan.target.effort).equal(null);
    should(subject.happened.filter(step => !step.startsWith('prepare:'))).eql([
      `create:${outcome.targetSessionId}`,
      'launch',
      'deliver:turn-one',
    ]);
    await subject.close();
  });

  it('should fork across harness families at the same point, dropping the flags its plan names', async () => {
    // Arrange: a Claude source with no warden ancestry, forked onto a Codex account.
    const subject = await journey('cross-harness', { targetHarness: 'codex' });
    const before = await subject.snapshotSource();

    // Act
    const outcome = await subject.fork(key('cross'), command(subject));

    // Assert: a permitted cross-family fork, not a disguised harness-mismatch refusal.
    should(outcome.plan.target.harness).equal('codex');
    should(outcome.plan.target.agent).equal('codex-auto-terra');
    should(outcome.plan.target.model).equal('gpt-5.6-terra');
    should(outcome.plan.source.harness).equal('claude');
    should(outcome.plan.source.cutMessagePoint).eql(CUT);
    should(outcome.plan.facets.conversation?.messages.map(message => message.point)).eql([
      { v: 1, byteOffset: 0, blockIndex: 0 },
      CUT,
    ]);
    should(outcome.plan.facets.conversation?.messages.at(-1)?.text).equal(CARRIED);

    // Assert: the operator's Claude argv is dropped and NAMED, which the plan owns as an omission.
    should(outcome.plan.durable.harnessFlags).eql([]);
    should(
      outcome.plan.notCarried.filter(
        omission => omission.reason === 'harness_incompatible' && omission.subject === SOURCE_FLAG,
      ),
    ).have.length(1);

    // Assert: a Codex target, its picker-shaped runtime control, and a Codex transcript baseline.
    const held = await subject.target(outcome.targetSessionId);
    const config = SessionConfigSchema.parse(held.config);
    should(config.harness).equal('codex');
    should(config.agent).equal('codex-auto-terra');
    should(config.harnessFlags).eql([]);
    should(config.label).equal('f117');
    should(held.config.provenance).eql({ v: 1, at: AT, origin: 'human', wardenLineage: false, lineageSource: 'none' });
    should(config.transferredFrom?.cutMessagePoint).eql(CUT);
    should(config.transcript?.identity).equal('undiscovered');
    should(config.transcript?.correlationToken).equal(subject.directory(outcome.targetSessionId));
    // The wrapper and the resolved model alone: Codex has no remote-control surface and names its own
    // session, so neither the Claude remote-control arguments nor a minted `--session-id` reach it,
    // and the dropped Claude flag is not translated into one it might accept.
    should(held.config.command).eql([subject.executable, ...startupModelArguments('gpt-5.6-terra')]);
    should(subject.happened.filter(step => step.startsWith('runtime:'))).eql([
      `runtime:{"action":"model","model":"gpt-5.6-terra","effort":"high"}:${outcome.plan.planId}:startup-runtime`,
    ]);
    should(times(subject, 'launch')).equal(1);
    should(held.brief).equal(assignedTaskDocument(forkOpeningTurn(outcome.plan)));

    // Assert: the source it read is untouched by having been read across families.
    should(await subject.snapshotSource()).eql(before);
    await subject.close();
  });

  it('should reuse one target and one frozen plan after a lost response and a restart', async () => {
    // Arrange: a fork that completed, whose answer the caller never received.
    const subject = await journey('restart', { warden: true });
    const first = await subject.fork(key('lost'), command(subject));
    const held = await subject.target(first.targetSessionId);
    const before = await subject.snapshotSource();

    // Act: a real process boundary, then the identical request again.
    await subject.restart();
    const replay = await subject.fork(key('lost'), command(subject));

    // Assert: the same target, the same decision, and no second anything.
    should(replay.targetSessionId).equal(first.targetSessionId);
    should(replay.plan).eql(first.plan);
    should(replay.report).eql(first.report);
    should(subject.minted).eql([first.targetSessionId]);
    should(times(subject, 'prepare')).equal(1);
    should(times(subject, 'create')).equal(1);
    should(times(subject, 'launch')).equal(1);
    should(times(subject, 'deliver')).equal(1);
    // The target's frozen plan, brief, configuration and copied bytes are exactly as they were.
    const after = await subject.target(first.targetSessionId);
    should(after.plan).equal(held.plan);
    should(after.brief).equal(held.brief);
    should(after.config).eql(held.config);
    should(await subject.snapshotSource()).eql(before);
    should((await subject.receipt('lost')).phase).equal('completed');
    await subject.close();
  });

  it('should recover a lost import receipt stamp from the complete target after the source becomes unreadable', async () => {
    // Arrange: import has durably written its edge, locked attachment and opening brief, then the
    // process loses the receipt advance that would have recorded that boundary.
    const subject = await journey('lost-import-stamp', { warden: true, loseImportStampOnce: true });
    const firstFailure = await refused(subject.fork(key('lost-import-stamp'), command(subject)));
    const stranded = await subject.receipt('lost-import-stamp');
    const frozen = stranded.plan as SessionTransferPlan;
    const targetId = String(stranded.targetSessionId);
    const imported = await subject.target(targetId);

    should((firstFailure as Error).message).match(/receipt advance was lost/u);
    should(stranded.phase).equal('plan_persisted');
    should(imported.config.transferredFrom).not.equal(undefined);
    should(imported.brief).equal(assignedTaskDocument(forkOpeningTurn(frozen)));

    // The pinned source can no longer answer the cut. A replay that entered SessionTransferImporter
    // again would now refuse `cut_unreadable`; only target-first proof can close the lost boundary.
    await subject.writeTranscript(truncatedTranscript());
    await subject.restart();

    // Act
    const replay = await subject.fork(key('lost-import-stamp'), command(subject));

    // Assert: the deterministic report is reconstructed from the exact target evidence, then the
    // remaining capture/start phases run once. Nothing is prepared, created or imported into a
    // second target, and source loss cannot undo an import whose durable outputs all survived.
    should(replay.targetSessionId).equal(targetId);
    should(replay.plan).eql(frozen);
    should(replay.report).eql({
      briefPath: join(subject.directory(targetId), 'turns', 'turn-001.md'),
      copiedAttachmentIds: frozen.facets.attachments.attachments.map(attachment => attachment.id),
    });
    should((await subject.receipt('lost-import-stamp')).phase).equal('completed');
    should(subject.minted).eql([targetId]);
    should(times(subject, 'prepare')).equal(1);
    should(times(subject, 'create')).equal(1);
    should(times(subject, 'launch')).equal(1);
    should(times(subject, 'deliver')).equal(1);
    await subject.close();
  });

  it('should refuse a changed payload under a spent request id without preparing or writing anything', async () => {
    // Arrange
    const subject = await journey('conflict', { warden: true });
    const first = await subject.fork(key('spent'), command(subject));
    const held = await subject.target(first.targetSessionId);
    const before = await subject.snapshotSource();

    // Act: the same id, a different point and a different reasoning level.
    await subject.restart();
    const conflict = await refused(
      subject.fork(key('spent'), command(subject, { through: { v: 1, byteOffset: 0, blockIndex: 0 }, effort: 'low' })),
    );

    // Assert: only the caller can decide which fork it meant, so nothing at all is applied.
    should(conflict).be.instanceOf(SessionForkRequestConflictError);
    should(subject.minted).eql([first.targetSessionId]);
    should(times(subject, 'prepare')).equal(1);
    should((await subject.target(first.targetSessionId)).config).eql(held.config);
    should(await subject.snapshotSource()).eql(before);
    await subject.close();
  });

  it('should stale same-point and earlier-prefix replacements before claiming a receipt or minting a target', async () => {
    // Arrange: the binding was issued by journey() over the original real transcript and durable
    // key. Nothing has been prepared or claimed yet.
    const subject = await journey('selection-stale', { warden: true });
    const before = await subject.snapshotSource();

    // Act: first replace the selected row at the same durable point, then restore that row while
    // replacing only an earlier record. Both still parse and both still contain CUT.
    await subject.writeTranscript(rewrittenTranscript());
    const samePoint = await refused(subject.fork(key('selection-same-point'), command(subject)));
    await subject.writeTranscript(earlierRewrittenTranscript());
    const earlierPrefix = await refused(subject.fork(key('selection-earlier-prefix'), command(subject)));

    // Assert: one public refusal for either mismatch, at preparation's read-only boundary. The id
    // factory was never consulted and neither request owns a receipt that a retry could drive.
    should(samePoint).be.instanceOf(TransferPrepareError);
    should((samePoint as TransferPrepareError).failure).equal('selection_stale');
    should(earlierPrefix).be.instanceOf(TransferPrepareError);
    should((earlierPrefix as TransferPrepareError).failure).equal('selection_stale');
    should(subject.minted).eql([]);
    should(await subject.hasReceipt('selection-same-point')).equal(false);
    should(await subject.hasReceipt('selection-earlier-prefix')).equal(false);
    should(times(subject, 'create')).equal(0);
    should(times(subject, 'launch')).equal(0);
    // Apart from the transcript mutations this case deliberately made, preparation changed no
    // source, descendant, coordination or attachment byte.
    should(besideTheTranscript(await subject.snapshotSource())).eql(besideTheTranscript(before));
    await subject.close();
  });

  it('should refuse while the pinned message has been rewritten or removed, and reserve one target', async () => {
    // Arrange: the plan is frozen against the transcript as it was, and the record then moves under
    // it before the import can be applied.
    const subject = await journey('rewritten', { warden: true });
    const before = await subject.snapshotSource();
    subject.moveSourceAfterPrepare(rewrittenTranscript());

    // Act
    const rewritten = await refused(subject.fork(key('moving'), command(subject)));
    await subject.writeTranscript(truncatedTranscript());
    await subject.restart();
    const removed = await refused(subject.fork(key('moving'), command(subject)));

    // Assert: the importer's own two words for a source that moved beneath a frozen plan.
    should(rewritten).be.instanceOf(TransferImportError);
    should((rewritten as TransferImportError).failure).equal('cut_rewritten');
    should(removed).be.instanceOf(TransferImportError);
    should((removed as TransferImportError).failure).equal('cut_unreadable');

    // Assert: one reserved target, stopped at the boundary it reached, and nothing launched.
    should(subject.minted).eql([FIRST_TARGET]);
    should(times(subject, 'prepare')).equal(1);
    should(times(subject, 'launch')).equal(0);
    should((await subject.receipt('moving')).phase).equal('plan_persisted');
    // Everything except the transcript this test moved itself is byte-for-byte as it was.
    should(besideTheTranscript(await subject.snapshotSource())).eql(besideTheTranscript(before));
    await subject.close();
  });

  it('should complete the same fork once the source has only been appended to beyond the cut', async () => {
    // Arrange: a fork stopped at its import, exactly as a moved source leaves one.
    const subject = await journey('appended', { warden: true });
    subject.moveSourceAfterPrepare(rewrittenTranscript());
    await refused(subject.fork(key('growing'), command(subject)));
    should((await subject.receipt('growing')).phase).equal('plan_persisted');

    // Act: the pinned prefix reads as it always did, and the session has kept talking past it.
    await subject.writeTranscript(appendedTranscript());
    await subject.restart();
    const replay = await subject.fork(key('growing'), command(subject));

    // Assert: growth beyond the cut is invisible, so the original target and plan complete.
    should(replay.targetSessionId).equal(FIRST_TARGET);
    should(subject.minted).eql([FIRST_TARGET]);
    should(replay.plan.source.cutMessagePoint).eql(CUT);
    should(replay.plan.facets.conversation?.messages.at(-1)?.text).equal(CARRIED);
    should(JSON.stringify(replay.plan.facets.conversation)).not.match(new RegExp(APPENDED, 'u'));
    should(times(subject, 'prepare')).equal(1);
    should(times(subject, 'create')).equal(1);
    should(times(subject, 'deliver')).equal(1);
    should((await subject.receipt('growing')).phase).equal('completed');
    await subject.close();
  });

  it('should refuse a replay whose persisted target plan was replaced after it was recorded', async () => {
    // Arrange: a fork stopped at `plan_persisted`, whose plan copy is then a DIFFERENT decision
    // written under the very same derived id.
    const subject = await journey('plan-substituted', { warden: true });
    subject.moveSourceAfterPrepare(rewrittenTranscript());
    await refused(subject.fork(key('substituted'), command(subject)));
    const before = await subject.snapshotSource();
    const substitute = JSON.parse(await subject.targetPlan(FIRST_TARGET)) as SessionTransferPlan;
    await writeFile(
      join(subject.directory(FIRST_TARGET), 'transfer-plan.json'),
      `${JSON.stringify({
        ...substitute,
        facets: { ...substitute.facets, workspace: { ...substitute.facets.workspace, head: '0'.repeat(40) } },
      })}\n`,
    );

    // Act: the pinned cut reads honestly again, so the substituted plan is the only thing left wrong.
    await subject.writeTranscript(sourceTranscript());
    await subject.restart();
    const rejected = await refused(subject.fork(key('substituted'), command(subject)));

    // Assert: a derived plan id is not an identity, so the whole value is compared.
    should(rejected).be.instanceOf(SessionForkTargetBindingError);
    should((rejected as Error).message).match(/is a DIFFERENT decision under the same id/u);
    should(subject.minted).eql([FIRST_TARGET]);
    should(times(subject, 'launch')).equal(0);
    should((await subject.receipt('substituted')).phase).equal('plan_persisted');
    should(besideTheTranscript(await subject.snapshotSource())).eql(besideTheTranscript(before));
    await subject.close();
  });

  it('should refuse a replay whose target spawn stamp was replaced after the import', async () => {
    // Arrange: a fork that recorded `imported` and then died before capturing its own transcript.
    const subject = await journey('stamp-substituted', { warden: true });
    subject.breakCapture(true);
    await refused(subject.fork(key('restamped'), command(subject)));
    should((await subject.receipt('restamped')).phase).equal('imported');
    const before = await subject.snapshotSource();
    await subject.restart();
    // A syntactically valid stamp naming somebody else's warden: the shape a substituted target
    // carries, and the one a fork must never be shielded on the strength of.
    await subject.storage().updateConfig(
      parseSessionId(FIRST_TARGET),
      current =>
        ({
          ...(current as Record<string, unknown>),
          provenance: {
            v: 1,
            at: AT,
            origin: 'warden',
            warden: '20260806-another-warden',
            wardenLineage: true,
            lineageSource: 'parent_stamp',
          },
        }) as JsonValue,
    );

    // Act
    subject.breakCapture(false);
    const rejected = await refused(subject.fork(key('restamped'), command(subject)));

    // Assert: a stated refusal, no advance past the boundary already crossed, and no second target.
    should(rejected).be.instanceOf(SessionForkTargetBindingError);
    should((rejected as Error).message).match(/spawn provenance/u);
    should((await subject.receipt('restamped')).phase).equal('imported');
    should(subject.minted).eql([FIRST_TARGET]);
    should(times(subject, 'launch')).equal(0);
    should(await subject.snapshotSource()).eql(before);
    await subject.close();
  });

  it('redacts transcript text in the durable plan, receipt and imported opening document', async () => {
    const subject = await journey('redacted-artifacts', {
      redact: async text => text.replace(CARRIED, '[redacted:SECRET]'),
    });

    const outcome = await subject.fork(key('redacted'), command(subject));
    const held = await subject.target(outcome.targetSessionId);
    const receipt = await subject.receipt('redacted');
    should(receipt.phase).equal('completed');
    const serialized = `${JSON.stringify(outcome.plan)}${held.plan}${JSON.stringify(receipt)}${held.brief}`;

    should(serialized).not.containEql(CARRIED);
    should(serialized).containEql('[redacted:SECRET]');
    await subject.close();
  });
});
