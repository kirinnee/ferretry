import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Redaction } from '@ferretry/kernel/contract';
import type { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import type { JsonValue } from '@ferretry/std';
import { ForkFiles } from '../../../../contract/index.ts';
import { TransferPlanFiles } from '../../../../contract/transfer-state.ts';
import type { SessionTransferPlan } from '../../../../contract/transfer.ts';
import {
  forkReceiptName,
  StateSessionForkReceiptStore,
} from '../../../../daemon/adapters/forks/state-session-fork-receipt-store.ts';
import {
  SessionForkTargetBinder,
  SessionForkTargetBindingError,
  forkOpeningTurn,
  forkOpeningTurnRefusal,
} from '../../../../daemon/adapters/forks/session-fork-target-binder.ts';
import {
  type SessionForkTargetAccount,
  SessionForkTargetResolver,
} from '../../../../daemon/adapters/forks/session-fork-target-resolver.ts';
import { NodeWorkingDirectoryResolver } from '../../../../daemon/adapters/session/lifecycle/node-working-directory-resolver.ts';
import {
  type SessionProtocolEnvelope,
  StorageSessionLifecycleRepository,
} from '../../../../daemon/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import type { DaemonStorage } from '../../../../daemon/adapters/storage/session-storage.ts';
import { FileSessionAttachmentCopier } from '../../../../daemon/adapters/transfer/attachment-copier.ts';
import { FileSessionTransferBriefWriter } from '../../../../daemon/adapters/transfer/brief-writer.ts';
import { FileSessionTransferTargetPlanStore } from '../../../../daemon/adapters/transfer/plan-store.ts';
import { SessionAttachmentTransferReader } from '../../../../daemon/adapters/transfer/session-attachment-reader.ts';
import { StorageTransferConversationReader } from '../../../../daemon/adapters/transfer/storage-transfer-conversation-reader.ts';
import { StorageTransferEnvelopeWriter } from '../../../../daemon/adapters/transfer/storage-transfer-envelope-writer.ts';
import { StorageTransferSourceReader } from '../../../../daemon/adapters/transfer/storage-transfer-source-reader.ts';
import { SessionForkRequestConflictError } from '../../../../daemon/lib/forks/failures.ts';
import { type SessionForkCommand, type SessionForkKey, sessionForkKey } from '../../../../daemon/lib/forks/identity.ts';
import { SessionForkService } from '../../../../daemon/lib/forks/service.ts';
import type { SessionForkPorts, SessionForkResult } from '../../../../daemon/lib/forks/types.ts';
import type { ConversationMessagePoint } from '../../../../daemon/lib/protocol/session-transfer-edge.ts';
import {
  type RuntimeModelChoice,
  SessionConfigSchema,
  SessionStateSchema,
  type SessionView,
} from '../../../../daemon/lib/protocol/session.ts';
import { type SessionId, parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { assignedTaskDocument, sessionTmuxName } from '../../../../daemon/lib/session/lifecycle/policy.ts';
import { SessionLifecycleService } from '../../../../daemon/lib/session/lifecycle/service.ts';
import { defaultSessionLifecycleSettings } from '../../../../daemon/lib/session/lifecycle/settings.ts';
import type { CodexRuntimeCatalogCache } from '../../../../daemon/lib/session/peers/harness.ts';
import {
  claudeSessionArguments,
  codexCorrelationArguments,
} from '../../../../daemon/lib/session/peers/transcript-launch.ts';
import { SessionRuntimeError } from '../../../../daemon/lib/session/runtime-control/types.ts';
import { AttachmentFacetContributor } from '../../../../daemon/lib/transfer/facets/attachments.ts';
import { ConversationFacetContributor } from '../../../../daemon/lib/transfer/facets/conversation.ts';
import { LineageFacetContributor } from '../../../../daemon/lib/transfer/facets/lineage.ts';
import { ReferenceFacetContributor } from '../../../../daemon/lib/transfer/facets/references.ts';
import { WorkspaceFacetContributor } from '../../../../daemon/lib/transfer/facets/workspace.ts';
import { SessionTransferPreparer } from '../../../../daemon/lib/transfer/prepare.ts';
import {
  type ConversationDigest,
  ConversationDigestError,
  type ConversationMessage,
  type PinnedTranscriptDigests,
  sameConversationMessagePoint,
  type TransferAttachmentView,
} from '../../../../daemon/lib/transfer/ports.ts';
import { TransferImportError, TransferPrepareError } from '../../../../daemon/lib/transfer/types.ts';
import { WARDEN_LABEL } from '../../../../daemon/lib/session/peers/warden-lifecycle.ts';
import { harnessCatalogs } from '../../../unit/daemon/session/runtime-control/harness-fixture/catalogs.ts';
import { planRuntimeSwitch } from '../../../unit/daemon/session/runtime-control/harness-fixture/runtime-switch.ts';
import { diskPaths } from '@ferretry/kernel/testing';
import { memoryStorage } from '../../../support/daemon/storage.ts';
import {
  AT,
  SOURCE_ID,
  account,
  cleanup,
  harnessFacts,
  MemoryAttachmentStore,
  memoryEffectLedger,
  openStorage,
  planner,
  realTemporaryDirectory,
  runtimeEffectFingerprint,
} from './fixtures.ts';

/**
 * ONE FORK, END TO END, OVER THE PRODUCTION COMPOSITION — the kernel's state port, the real preparer and its facet
 * contributors, the real receipt store, target plan store, envelope/brief/attachment writers, the real binder, and the
 * real service driving all of them.
 *
 * WHY THIS FILE IS A COMPOSITION AND NOT A UNIT. Every adapter suite beside it proves its own bytes against a fixture
 * written to expect them, and each of those fixtures is a second statement of a layout, a point or a plan. What a fork
 * actually promises are properties of the COMPOSITION, and none of them is visible in any single adapter: that the
 * message a caller pointed at is the one that crosses, that the session it was read from is byte-for-byte as it was
 * afterwards, that a process boundary anywhere in the sequence finishes THAT fork rather than starting a second one,
 * and that a target something else damaged is refused rather than launched. A fake preparer or a fake binder proves
 * only that this file agrees with itself.
 *
 * WHAT IS STUBBED, AND WHY NONE OF IT IS THE SUBJECT. Everything Ferrets does not own is a structural port with a small
 * stand-in, because core imports no plugin:
 *
 *   - the TRANSCRIPT READER (`PinnedTranscriptDigests`, the conversation plugin's): a stand-in that reads the seeded
 *     JSONL itself, byte offsets included, and authenticates the raw prefix of the record it was cut at. It is the
 *     plugin's parser that a real deployment exercises; what is exercised here is that every fork decision is taken from
 *     its answer;
 *   - the SELECTION BINDING (`ForkSelectionTokens`, the conversation plugin's message-token codec): a keyed hash of the
 *     exact source, transcript and raw prefix, which accepts exactly what it issued;
 *   - the TRANSCRIPT CAPTURE (`ForkTranscriptCaptures`, the harness plugins'): the Claude arm mints an id and names the
 *     file, the Codex arm declares a correlation token, both with the launch argv that makes the record true;
 *   - the attachment owner's store (an in-memory `TransferAttachmentStore`), the fleet's account resolution, the live
 *     Codex catalogue, and the terminal launcher.
 *
 * Two one-shot levers reproduce crashes without crashing: the source transcript may be mutated between preparation and
 * import, which is the race a frozen plan exists for, and the target's transcript capture may be made to throw, which
 * is a death between recording `imported` and capturing the target's own identity. Everything the fork itself decides
 * or writes is the shipped code, over the kernel's own state port.
 *
 * THE CUT IS AN EXACT BYTE OFFSET IN A TRANSCRIPT. The seeded transcript's second record begins at byte 512 exactly,
 * and that record carries TWO content blocks — so `{ v: 1, byteOffset: 512, blockIndex: 0 }` names one message and
 * `blockIndex: 1` names a different one. A journey that carried "everything up to the last record" would satisfy every
 * other assertion here and fail that.
 */

const CUT: ConversationMessagePoint = { v: 1, byteOffset: 512, blockIndex: 0 };
const DESCENDANT_ID = '20260806-descendant';
const FIRST_TARGET = '20260806-target-1';
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

/** Everything the source side holds, as hex-encoded bytes keyed by where it lives: bytes, never parsed values. */
type Snapshot = Record<string, string>;

/** The same snapshot with the transcript blanked, for a case that rewrote the transcript itself. */
function besideTheTranscript(snapshot: Snapshot): Snapshot {
  return { ...snapshot, transcript: '' };
}

const hex = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString('hex');

/** The one transcript path the source's provenance pins. A name, never a place on disk. */
const TRANSCRIPT_FILE = '/fleet/homes/source/projects/source.jsonl';
const TARGET_HARNESS_HOME = '/fleet/homes/zelda';

// ─── the conversation owner's side, over the seeded transcript ──────────────────────────────────

interface Carried extends ConversationMessage {
  /** Where this message's physical record ends, so the raw prefix an authentication covers is exact. */
  readonly recordEnd: number;
}

/** The messages of a Claude-shaped JSONL transcript, each at the byte offset of its record and its block index. */
function readTranscript(text: string): readonly Carried[] {
  const found: Carried[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const length = Buffer.byteLength(line);
    if (line !== '') {
      const record = JSON.parse(line) as {
        type: 'user' | 'assistant';
        timestamp: string;
        message: { content: readonly { text: string }[] };
      };
      record.message.content.forEach((block, blockIndex) => {
        found.push({
          point: { v: 1, byteOffset: offset, blockIndex },
          role: record.type,
          text: block.text,
          timestamp: record.timestamp,
          recordEnd: offset + length + 1,
        });
      });
    }
    offset += length + 1;
  }
  return found;
}

/** The exact bytes of the physical record a cut was made at and everything before it. */
function rawPrefixOf(text: string, recordEnd: number): Uint8Array {
  return new Uint8Array(createHash('sha256').update(Buffer.from(text).subarray(0, recordEnd)).digest());
}

/**
 * The conversation plugin's pinned digest, over the one seeded transcript.
 *
 * It answers `undefined` for a file nobody named and refuses a cut that addresses nothing, as the plugin's does; the
 * messages it hands back are the prefix through the cut, and the raw-prefix evidence is the digest of the bytes up to
 * the end of the cut's record.
 */
function transcriptOwner(read: () => string): PinnedTranscriptDigests {
  return {
    digest: async (target, file, through): Promise<ConversationDigest | undefined> => {
      if (file !== TRANSCRIPT_FILE) return undefined;
      const text = read();
      const messages = readTranscript(text);
      const index = messages.findIndex(message => sameConversationMessagePoint(message.point, through));
      const cut = messages[index];
      if (cut === undefined)
        throw new ConversationDigestError(
          'target_not_found',
          `no message at byte ${through.byteOffset} block ${through.blockIndex}`,
        );
      return {
        sessionId: target.sessionId,
        through,
        messages: messages
          .slice(0, index + 1)
          .map(({ point, role, text: said, timestamp }) => ({ point, role, text: said, timestamp })),
        omissions: [],
        selectionEvidence: { point: through, rawPrefix: rawPrefixOf(text, cut.recordEnd) },
      };
    },
  };
}

/**
 * The selection binding the read surface issues and a fork verifies: a hash of the exact source, transcript, point and
 * raw prefix. It accepts exactly what it issued, so a replaced row or an earlier record rewritten under it is stale.
 */
function bindingFor(evidence: {
  readonly sourceSessionId: string;
  readonly sourceIncarnation: string;
  readonly transcriptProvenance: { readonly file?: string | undefined };
  readonly through: ConversationMessagePoint;
  readonly rawPrefix: Uint8Array;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        evidence.sourceSessionId,
        evidence.sourceIncarnation,
        evidence.transcriptProvenance.file ?? null,
        evidence.through,
        hex(evidence.rawPrefix),
      ]),
    )
    .digest('hex');
}

/** The vault's one-open batch read, with a redactor that can be told to scrub. */
function redaction(scrub: (text: string) => string): Pick<Redaction, 'read'> {
  return { read: async work => await work({ text: scrub, cells: grid => grid, lines: lines => lines }) };
}

/** The attachment inventory over the attachment owner's store: what a manifest holds, and whether it is encrypted. */
function inventoryOf(store: MemoryAttachmentStore): {
  list(sessionId: string): Promise<readonly TransferAttachmentView[]>;
} {
  return {
    list: async sessionId => {
      const views: TransferAttachmentView[] = [];
      for (const key of store.files.keys()) {
        const [session, attachment, file] = key.split('/');
        if (session !== sessionId || file !== 'manifest' || attachment === undefined) continue;
        const bytes = await store.read(session, attachment, 'manifest');
        if (bytes === undefined) continue;
        views.push(JSON.parse(new TextDecoder().decode(bytes)) as TransferAttachmentView);
      }
      return views;
    },
  };
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
  readonly redact?: (text: string) => string;
}

interface Journey {
  readonly cwd: string;
  readonly agent: string;
  readonly model: string;
  /** The absolute wrapper the target account is launched through. */
  readonly executable: string;
  readonly transcriptFile: string;
  /** Opaque evidence issued by an initial transcript read, standing in for the read surface's message token. */
  readonly selectionBinding: string;
  /** Everything the preparer, the launcher and the runtime path were observed doing, in order. */
  readonly happened: string[];
  /** Every target id this fork's id factory was asked for. A second entry is a second target. */
  readonly minted: string[];
  fork(key: SessionForkKey, command: SessionForkCommand): Promise<SessionForkResult>;
  /** A process boundary: a fresh session store (and the loss of its in-memory index) over the very same state. */
  restart(): Promise<void>;
  storage(): DaemonStorage;
  directory(id: string): string;
  /** Where the target's opening-turn document is, as the brief writer names it. */
  briefPath(id: string): string;
  /** The attachment owner's store: the source's originals are read from it and the target's written into it. */
  readonly attachments: MemoryAttachmentStore;
  /** Rewrites the source transcript ONCE, after preparation has frozen its plan and before import. */
  moveSourceAfterPrepare(text: string): void;
  /** Makes the target's transcript capture throw, reproducing a death just after the import. */
  breakCapture(broken: boolean): void;
  writeTranscript(text: string): void;
  snapshotSource(): Promise<Snapshot>;
  /** The durable event pointers of the source and its descendant, resolved through the index. */
  pointers(): Promise<string>;
  receipt(requestId: string): Promise<Record<string, unknown>>;
  hasReceipt(requestId: string): Promise<boolean>;
  /** The plan copy beneath the target, which exists from `plan_persisted` onwards. */
  targetPlan(id: string): string;
  /** Replaces the plan copy beneath the target with a different decision under the same id. */
  replaceTargetPlan(id: string, change: (held: SessionTransferPlan) => SessionTransferPlan): void;
  target(id: string): Promise<{
    readonly config: Record<string, unknown>;
    readonly plan: string;
    readonly brief: string;
  }>;
}

async function journey(label: string, options: JourneyOptions = {}): Promise<Journey> {
  const targetHarness = options.targetHarness ?? 'claude';
  const cwd = await realTemporaryDirectory(`fy-journey-${label}-cwd-`);
  const opened = await openStorage(label);
  const folder: MemoryStateFolder = opened.folder;
  let storage = opened.storage;
  const attachments = new MemoryAttachmentStore();
  const happened: string[] = [];
  const minted: string[] = [];
  const environments = new Map<string, Readonly<Record<string, string>>>();
  const effects = memoryEffectLedger();
  let transcript = '';
  let brokenCapture = false;
  let moveAfterPrepare: string | undefined;
  let harnessSessions = 0;
  let terminalAlive = false;
  let loseRuntimeOutcome = options.loseRuntimeOutcomeOnce === true;
  let loseImportStamp = options.loseImportStampOnce === true;

  /** The published fleet: two accounts, as the fleet manifest declares them. */
  const claudeExecutable = '/fleet/bin/claude-auto-zelda';
  const codexExecutable = '/fleet/bin/codex-auto-terra';
  const published: readonly SessionForkTargetAccount[] = [
    { account: account({ wrapper: claudeExecutable }), executable: claudeExecutable },
    {
      account: account({
        id: 'acct-codex',
        agent: 'codex-auto-terra',
        kind: 'codex',
        wrapper: codexExecutable,
        home: TARGET_HARNESS_HOME,
        displayName: 'Terra',
        defaultModel: 'gpt-5.6-terra',
        models: [{ id: 'gpt-5.6-terra', available: true }],
      }),
      executable: codexExecutable,
    },
  ];
  const chosen = published[targetHarness === 'claude' ? 0 : 1];
  if (chosen === undefined) throw new Error('the journey fleet is missing its target account');

  const directory = (id: string): string => opened.sessionDirectory(id);
  const redactor = redaction(options.redact ?? (text => text));
  const owner = transcriptOwner(() => transcript);
  const conversation = new StorageTransferConversationReader(owner, redactor);

  /** The composition root's own start-account resolution, over the two published accounts. */
  async function resolveAccount(agent: string): Promise<SessionForkTargetAccount> {
    const found = published.find(candidate => candidate.account.agent === agent);
    if (found === undefined)
      throw Object.assign(new Error(`no account is published as ${JSON.stringify(agent)}`), {
        failure: 'unknown_agent',
      });
    return found;
  }

  // ONE brief writer and ONE copier, handed to the import half as writers and to the proof half as readers: two
  // instances over one layout would be two answers to where the target's bytes are.
  const brief = new FileSessionTransferBriefWriter(opened.briefs);
  const copier = new FileSessionAttachmentCopier(attachments);
  const plans = new FileSessionTransferTargetPlanStore(opened.state);

  /** The lifecycle every other create goes through, with only its terminal seam replaced. */
  function lifecycle(id: SessionId, envelope?: SessionProtocolEnvelope): SessionLifecycleService {
    return new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(storage, envelope),
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
        // The lifecycle's turn-one document IS the brief file: both are the one document the new agent is pointed at.
        tasks: { writeAssignedTask: async (held, document) => await brief.write(held, document) },
        effects,
        directories: new NodeWorkingDirectoryResolver(diskPaths()),
        ids: {
          next: () => {
            happened.push(`create:${id}`);
            return id;
          },
        },
        clock: { now: () => AT },
        serial: new KeyedSerialExecutor(),
        // The binder proves the record's hash against the credential really held before it launches anything.
        credentials: {
          issue: () => ({
            capability: `capability-${id}`,
            hash: createHash('sha256').update(`capability-${id}`).digest('hex'),
          }),
        },
        environment: {
          write: async (held, variables) => {
            environments.set(held, { ...variables });
          },
          read: async held => environments.get(held) ?? {},
        },
      },
      defaultSessionLifecycleSettings,
    );
  }

  /** The conversation plugin's capture, Claude arm and Codex arm, with the argv that makes each record true. */
  const capture = async (request: {
    readonly harness: 'claude' | 'codex';
    readonly cwd: string;
    readonly correlationToken: string;
  }): Promise<{
    provenance: SessionView['config']['transcript'];
    launchArguments: readonly string[];
  }> => {
    if (request.harness === 'codex')
      return {
        provenance: {
          v: 1,
          home: TARGET_HARNESS_HOME,
          identity: 'undiscovered',
          correlationToken: request.correlationToken,
        },
        launchArguments: codexCorrelationArguments(request.correlationToken),
      };
    harnessSessions += 1;
    const harnessSessionId = `harness-target-${String(harnessSessions)}`;
    return {
      provenance: {
        v: 1,
        home: TARGET_HARNESS_HOME,
        harnessSessionId,
        identity: 'minted',
        file: harnessFacts.claudeTranscriptFile(TARGET_HARNESS_HOME, request.cwd, harnessSessionId),
        resolvedAt: AT,
      },
      launchArguments: claudeSessionArguments(harnessSessionId),
    };
  };

  const codexCatalog: CodexRuntimeCatalogCache = { get: async () => CODEX_CATALOG };

  /** The one place the production adapter set is built, so a restart rebuilds all of it. */
  function ports(): SessionForkPorts {
    const preparer = new SessionTransferPreparer({
      source: new StorageTransferSourceReader(storage),
      selection: { verifySelection: async (evidence, binding) => bindingFor(evidence) === binding },
      contributors: {
        conversation: new ConversationFacetContributor(conversation, redactor),
        attachments: new AttachmentFacetContributor(new SessionAttachmentTransferReader(inventoryOf(attachments))),
        references: new ReferenceFacetContributor(),
        workspace: new WorkspaceFacetContributor({ probe: async () => ({ head: null, status: null }) }),
        lineage: new LineageFacetContributor(),
      },
    });
    const resolver = new SessionForkTargetResolver({
      accounts: resolveAccount,
      planner: planner(),
      harness: { planSwitch: planRuntimeSwitch },
      catalog: codexCatalog,
      catalogs: harnessCatalogs,
      harnessFacts,
    });
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
        // The crash lever: a fork that died between recording `imported` and capturing the target's own transcript
        // identity. Everything either side of it is the capture.
        capture: async request => {
          if (brokenCapture) throw new Error('the harness home could not be read');
          return await capture(request);
        },
      },
      importPorts: { envelope: new StorageTransferEnvelopeWriter(storage), brief, attachments: copier, conversation },
      // The same two writers, read-only: a later phase proves the brief and the copied original are still what the
      // receipt claimed rather than repairing either just before a launch.
      imported: { brief, attachments: copier },
      environment: { read: async id => environments.get(id) ?? {} },
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
      view: async id => await view(storage, directory, id).catch(() => undefined),
      sessionDirectory: id => directory(id),
      harnessFacts,
      readableHandoffs: id => [`${directory(id)}/turns`],
      clock: { now: () => AT },
    });
    const queue = new KeyedSerialExecutor();
    const receipts = new StateSessionForkReceiptStore(opened.state);
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
          // The source moves on between the decision and the import, which is precisely the race a frozen plan and
          // the import's re-read exist to survive. One shot, so the retry is clean.
          if (moveAfterPrepare !== undefined) {
            transcript = moveAfterPrepare;
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
   * The source, its descendant, its journal, its locked attachment and its transcript.
   *
   * Written through the production stores, so the snapshot a later assertion compares is a snapshot of documents this
   * daemon really produces rather than of literals this file invented.
   */
  async function seed(): Promise<void> {
    const source = parseSessionId(SOURCE_ID);
    const descendant = parseSessionId(DESCENDANT_ID);
    const warden = options.warden === true;
    transcript = sourceTranscript();
    await storage.writeConfig(
      source,
      sourceConfiguration({ id: SOURCE_ID, cwd, transcriptFile: TRANSCRIPT_FILE, warden }),
    );
    await storage.writeState(source, sessionState(SOURCE_ID));
    await storage.append(source, 'session.created', { agent: 'claude-auto-source' });
    await storage.append(source, 'session.turn', { turn: 12 });
    // A descendant of the source, so "a fork never restamps the tree hanging off what it read" has something real to
    // be true about.
    await storage.writeConfig(descendant, {
      ...sourceConfiguration({ id: DESCENDANT_ID, cwd, transcriptFile: TRANSCRIPT_FILE, warden }),
      parent: SOURCE_ID,
      teammate: 'savana',
    });
    await storage.writeState(descendant, sessionState(DESCENDANT_ID));
    await storage.append(descendant, 'session.created', { parent: SOURCE_ID });
    // The source's own first turn, in the very file the target's opening turn is written to under ITS id.
    await brief.write(parseSessionId(SOURCE_ID), '# The source own first turn\n');
    // The locked original and its manifest, in the attachment owner's store.
    const sha256 = createHash('sha256').update(LOCKED_PDF).digest('hex');
    const id = `att_${sha256}`;
    await attachments.write(
      SOURCE_ID,
      id,
      'manifest',
      new TextEncoder().encode(
        JSON.stringify({
          id,
          filename: 'brief.pdf',
          mime: 'application/pdf',
          size: LOCKED_PDF.byteLength,
          sha256,
          createdAt: AT,
          encrypted: { kind: 'pdf' },
        }),
      ),
    );
    await attachments.write(SOURCE_ID, id, 'original', LOCKED_PDF);
  }

  /**
   * What a real GET messages read would hand back for the cut: one transcript pass, then one opaque tag. The raw
   * prefix never leaves this helper.
   */
  async function issueInitialSelectionBinding(): Promise<string> {
    const config = SessionConfigSchema.parse(await storage.readConfig(parseSessionId(SOURCE_ID)));
    const provenance = config.transcript;
    if (provenance === undefined || provenance.identity === 'undiscovered')
      throw new Error('the source fixture must carry completed transcript provenance');
    const digest = await conversation.digest({
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
    return bindingFor({
      sourceSessionId: SOURCE_ID,
      sourceIncarnation: config.incarnation,
      transcriptProvenance: provenance,
      through: CUT,
      rawPrefix: evidence.rawPrefix,
    });
  }

  await seed();
  const selectionBinding = await issueInitialSelectionBinding();

  const planText = (id: string): string => {
    const held = folder.raw(TransferPlanFiles, id);
    if (held === undefined) throw new Error(`target ${id} holds no plan copy`);
    return held;
  };
  /** The plan copy as the plan, without the state document's own format stamp. */
  const planOf = (id: string): SessionTransferPlan => {
    const { format: _format, ...held } = JSON.parse(planText(id)) as Record<string, unknown>;
    return held as unknown as SessionTransferPlan;
  };

  return {
    cwd,
    agent: chosen.account.agent,
    model: chosen.account.defaultModel ?? '',
    executable: chosen.executable,
    transcriptFile: TRANSCRIPT_FILE,
    selectionBinding,
    happened,
    minted,
    fork: async (held, command_) => await new SessionForkService(ports()).fork(held, command_),
    restart: async () => {
      // A process boundary forgets every in-memory index; the state it was a cache of is all that survives.
      for (const database of folder.databases.keys()) folder.databases.delete(database);
      storage = (await memoryStorage({ folder, clock: { now: () => AT } })).storage;
    },
    storage: () => storage,
    directory,
    briefPath: id => brief.file(parseSessionId(id)),
    attachments,
    moveSourceAfterPrepare: text => {
      moveAfterPrepare = text;
    },
    breakCapture: broken => {
      brokenCapture = broken;
    },
    writeTranscript: text => {
      transcript = text;
    },
    snapshotSource: async () => {
      const into: Snapshot = { transcript: hex(transcript) };
      for (const [key, text] of folder.files)
        if (key.startsWith(`${SOURCE_ID}/`) || key.startsWith(`${DESCENDANT_ID}/`)) into[key] = hex(text);
      for (const [key, bytes] of folder.bytes)
        if (key.startsWith(`${SOURCE_ID}/`) || key.startsWith(`${DESCENDANT_ID}/`)) into[key] = hex(bytes);
      for (const [key, bytes] of attachments.files)
        if (key.startsWith(`${SOURCE_ID}/`)) into[`attachments/${key}`] = hex(bytes);
      return into;
    },
    pointers: async () =>
      JSON.stringify([
        await storage.replay(parseSessionId(SOURCE_ID)),
        await storage.replay(parseSessionId(DESCENDANT_ID)),
      ]),
    receipt: async requestId =>
      JSON.parse(folder.raw(ForkFiles, forkReceiptName({ sourceSessionId: SOURCE_ID, requestId })) ?? 'null') as Record<
        string,
        unknown
      >,
    hasReceipt: async requestId =>
      folder.raw(ForkFiles, forkReceiptName({ sourceSessionId: SOURCE_ID, requestId })) !== undefined,
    targetPlan: id => JSON.stringify(planOf(id)),
    replaceTargetPlan: (id, change) => {
      const held = JSON.parse(planText(id)) as Record<string, unknown>;
      folder.plant(TransferPlanFiles, `${JSON.stringify({ ...held, ...change(planOf(id)) })}\n`, id);
    },
    target: async id => ({
      config: (await storage.readConfig(parseSessionId(id))) as Record<string, unknown>,
      plan: JSON.stringify(planOf(id)),
      brief: opened.briefText(id) ?? '',
    }),
  };
}

async function view(
  storage: DaemonStorage,
  sessionDirectory: (id: string) => string,
  id: SessionId,
): Promise<SessionView> {
  return {
    config: SessionConfigSchema.parse(await storage.readConfig(id)),
    state: SessionStateSchema.parse(await storage.readState(id)),
    directory: sessionDirectory(id),
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
    // The waiters, channel and attention files belong to other modules and are not part of this state; what a fork
    // could touch of the source is its documents, its journal, its first turn, its attachments and its transcript.
    should(Object.keys(before)).containDeep([
      'transcript',
      `${SOURCE_ID}/config.json`,
      `${SOURCE_ID}/state.json`,
      `${SOURCE_ID}/history.jsonl`,
      `${DESCENDANT_ID}/config.json`,
      `${DESCENDANT_ID}/state.json`,
      `${DESCENDANT_ID}/history.jsonl`,
    ]);
    should(Object.keys(before).filter(path => path.startsWith(`${SOURCE_ID}/`) && path.includes('turn'))).have.length(
      1,
    );
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
      // Its own turn documents, readable without a permission prompt, ahead of the operator's flags.
      `--allowedTools=Read(/${subject.directory(outcome.targetSessionId)}/turns/**)`,
      SOURCE_FLAG,
      ...harnessFacts.startupModelArguments('claude-opus-5'),
      ...claudeSessionArguments('harness-target-1'),
    ]);

    // Assert: the frozen plan and the deterministic opening brief are durable beneath the target.
    should((JSON.parse(held.plan) as SessionTransferPlan).planId).equal(outcome.plan.planId);
    should(JSON.parse(held.plan)).eql(outcome.plan);
    should(held.brief).equal(assignedTaskDocument(forkOpeningTurn(outcome.plan)));
    should(held.brief).match(/Prior context carried into this session by a fork/u);
    should(held.brief).match(new RegExp(CARRIED, 'u'));
    should(outcome.report.briefPath).equal(subject.briefPath(outcome.targetSessionId));

    // Assert: the locked original is copied byte for byte into the tree the store itself reads.
    const attachmentId = outcome.plan.facets.attachments.attachments[0]?.id ?? '';
    should(outcome.report.copiedAttachmentIds).eql([attachmentId]);
    const copied = await subject.attachments.read(outcome.targetSessionId, attachmentId, 'original');
    should(copied).eql(LOCKED_PDF);
    const manifest = await subject.attachments.read(outcome.targetSessionId, attachmentId, 'manifest');
    should(JSON.parse(new TextDecoder().decode(manifest)).encrypted).eql({ kind: 'pdf' });
    should(outcome.plan.notCarried.filter(omission => omission.reason === 'credential')).have.length(1);
    // Same family, so the operator's own launch arguments cross rather than being dropped.
    should(outcome.plan.notCarried.filter(omission => omission.reason === 'harness_incompatible')).eql([]);

    // Assert: the source, its descendant, its waiters, its journal, its attachment and its transcript
    // are byte-for-byte what they were, and its durable event pointers still resolve identically.
    should(await subject.snapshotSource()).eql(before);
    should(await subject.pointers()).equal(pointersBefore);
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
    // The wrapper, the resolved model and the correlation root that lets the target prove its own
    // rollout: Codex has no remote-control surface and names its own session, so neither the Claude
    // remote-control arguments nor a minted `--session-id` reach it, and the dropped Claude flag is not
    // translated into one it might accept.
    should(held.config.command).eql([
      subject.executable,
      ...harnessFacts.startupModelArguments('gpt-5.6-terra'),
      ...codexCorrelationArguments(subject.directory(outcome.targetSessionId)),
    ]);
    should(subject.happened.filter(step => step.startsWith('runtime:'))).eql([
      `runtime:{"action":"model","model":"gpt-5.6-terra","effort":"high"}:${outcome.plan.planId}:startup-runtime`,
    ]);
    should(times(subject, 'launch')).equal(1);
    should(held.brief).equal(assignedTaskDocument(forkOpeningTurn(outcome.plan)));

    // Assert: the source it read is untouched by having been read across families.
    should(await subject.snapshotSource()).eql(before);
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
    subject.writeTranscript(truncatedTranscript());
    await subject.restart();

    // Act
    const replay = await subject.fork(key('lost-import-stamp'), command(subject));

    // Assert: the deterministic report is reconstructed from the exact target evidence, then the
    // remaining capture/start phases run once. Nothing is prepared, created or imported into a
    // second target, and source loss cannot undo an import whose durable outputs all survived.
    should(replay.targetSessionId).equal(targetId);
    should(replay.plan).eql(frozen);
    should(replay.report).eql({
      briefPath: subject.briefPath(targetId),
      copiedAttachmentIds: frozen.facets.attachments.attachments.map(attachment => attachment.id),
    });
    should((await subject.receipt('lost-import-stamp')).phase).equal('completed');
    should(subject.minted).eql([targetId]);
    should(times(subject, 'prepare')).equal(1);
    should(times(subject, 'create')).equal(1);
    should(times(subject, 'launch')).equal(1);
    should(times(subject, 'deliver')).equal(1);
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
  });

  it('should stale same-point and earlier-prefix replacements before claiming a receipt or minting a target', async () => {
    // Arrange: the binding was issued by journey() over the original real transcript and durable
    // key. Nothing has been prepared or claimed yet.
    const subject = await journey('selection-stale', { warden: true });
    const before = await subject.snapshotSource();

    // Act: first replace the selected row at the same durable point, then restore that row while
    // replacing only an earlier record. Both still parse and both still contain CUT.
    subject.writeTranscript(rewrittenTranscript());
    const samePoint = await refused(subject.fork(key('selection-same-point'), command(subject)));
    subject.writeTranscript(earlierRewrittenTranscript());
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
  });

  it('should refuse while the pinned message has been rewritten or removed, and reserve one target', async () => {
    // Arrange: the plan is frozen against the transcript as it was, and the record then moves under
    // it before the import can be applied.
    const subject = await journey('rewritten', { warden: true });
    const before = await subject.snapshotSource();
    subject.moveSourceAfterPrepare(rewrittenTranscript());

    // Act
    const rewritten = await refused(subject.fork(key('moving'), command(subject)));
    subject.writeTranscript(truncatedTranscript());
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
  });

  it('should complete the same fork once the source has only been appended to beyond the cut', async () => {
    // Arrange: a fork stopped at its import, exactly as a moved source leaves one.
    const subject = await journey('appended', { warden: true });
    subject.moveSourceAfterPrepare(rewrittenTranscript());
    await refused(subject.fork(key('growing'), command(subject)));
    should((await subject.receipt('growing')).phase).equal('plan_persisted');

    // Act: the pinned prefix reads as it always did, and the session has kept talking past it.
    subject.writeTranscript(appendedTranscript());
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
  });

  it('should refuse a replay whose persisted target plan was replaced after it was recorded', async () => {
    // Arrange: a fork stopped at `plan_persisted`, whose plan copy is then a DIFFERENT decision
    // written under the very same derived id.
    const subject = await journey('plan-substituted', { warden: true });
    subject.moveSourceAfterPrepare(rewrittenTranscript());
    await refused(subject.fork(key('substituted'), command(subject)));
    const before = await subject.snapshotSource();
    subject.replaceTargetPlan(FIRST_TARGET, held => ({
      ...held,
      facets: { ...held.facets, workspace: { ...held.facets.workspace, head: '0'.repeat(40) } },
    }));

    // Act: the pinned cut reads honestly again, so the substituted plan is the only thing left wrong.
    subject.writeTranscript(sourceTranscript());
    await subject.restart();
    const rejected = await refused(subject.fork(key('substituted'), command(subject)));

    // Assert: a derived plan id is not an identity, so the whole value is compared.
    should(rejected).be.instanceOf(SessionForkTargetBindingError);
    should((rejected as Error).message).match(/is a DIFFERENT decision under the same id/u);
    should(subject.minted).eql([FIRST_TARGET]);
    should(times(subject, 'launch')).equal(0);
    should((await subject.receipt('substituted')).phase).equal('plan_persisted');
    should(besideTheTranscript(await subject.snapshotSource())).eql(besideTheTranscript(before));
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
  });

  it('redacts transcript text in the durable plan, receipt and imported opening document', async () => {
    const subject = await journey('redacted-artifacts', {
      redact: text => text.replace(CARRIED, '[redacted:SECRET]'),
    });

    const outcome = await subject.fork(key('redacted'), command(subject));
    const held = await subject.target(outcome.targetSessionId);
    const receipt = await subject.receipt('redacted');
    should(receipt.phase).equal('completed');
    const serialized = `${JSON.stringify(outcome.plan)}${held.plan}${JSON.stringify(receipt)}${held.brief}`;

    should(serialized).not.containEql(CARRIED);
    should(serialized).containEql('[redacted:SECRET]');
  });
});
