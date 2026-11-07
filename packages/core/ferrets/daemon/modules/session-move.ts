import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessKind } from '@ferretry/fleet';
import {
  type AskToStopJobsResult,
  type ConversionPreview,
  type ConversionSummary as ConversionSummaryView,
  type Harness,
  type MigrationConversation,
  SessionConfigSchema,
  SessionStateSchema,
  type SessionView,
  type TranscriptProvenance,
} from '@ferretry/protocol';
import type { z } from 'zod';
import { deliverStopSignal, KeyedSerialExecutor, type SystemClock, BunProcessProbe } from '../../src/adapters/index.ts';
import { FileConversationFiles } from '../../src/adapters/migrate/file-conversation-files.ts';
import { FileMigrationReportStore } from '../../src/adapters/migrate/file-migration-report.ts';
import { readPersistedReasoningEffort } from '../../src/adapters/session/harness/index.ts';
import { lifecycleConfigDocument } from '../../src/adapters/session/lifecycle/index.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import { CliConversionCheck, CliHarnessVersion } from '../../src/adapters/transcript/conversion-check.ts';
import { CliRolloutFormatProbe } from '../../src/adapters/transcript/rollout-format-probe.ts';
import { resolveStartAccount } from '../../src/lib/fleet/start-resolution.ts';
import {
  HANDOFF_READ_MAX_BYTES,
  type HandoffDocuments,
  isReadableHandoff,
} from '../../src/lib/imports/conversation-text.ts';
import {
  type AccountInventoryPort,
  type AgentJobControl,
  AgentJobStopper,
  agentJobsMessage,
  agentJobsMessageId,
  authorizeSessionCommand,
  buildLaunchArgv,
  type CodexRolloutIndex,
  type ConversationConvert,
  type ConversationFilesPort,
  type ConversionCheckPort,
  type ConversionSummary as ConvertedConversationSummary,
  canServeModel,
  codexModelProvider,
  contextWindowForSession,
  createSessionPaths,
  currentLaunchCompactAt,
  currentLaunchEffort,
  currentLaunchModel,
  declaredModel,
  defaultSessionLifecycleSettings,
  type ExecutableResolverPort,
  type FoundationPaths,
  findAccountByAgent,
  type HarnessVersionPort,
  handoffPointerPaths,
  harnessConversionRefusal,
  harnessMigrationRefusal,
  jsonObject,
  type MigrationPreflight,
  type MigrationReportStore,
  needsRolloutFormatProbe,
  type ObservedSession,
  type ProcRow,
  planConversationCarry,
  planConversationConvert,
  previousConversation,
  ResumeRefused,
  type RolloutFormatPort,
  SessionControlError,
  type SessionControlFailure,
  type SessionDirectorySubsystem,
  type SessionId,
  type SessionLaunchService,
  SessionLifecycleConfigSchema,
  SessionMigrateError,
  type SessionMigrateFailure,
  type SessionMigrateSubsystem,
  type SessionPlanner,
  type SessionResumeService,
  type SessionTranscriptReader,
  type TranscriptProvenanceCapture,
  transcriptLaunchArguments,
  tryParseSessionId,
} from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { sessionMigrateContribution } from '../../src/lib/runtime/mounts/session-migrate.ts';
import {
  restoreRestamped,
  settleRejectedRelaunch,
  settleUnrevivedRelaunch,
} from '../../src/lib/session/resume/unrevived-relaunch.ts';

/**
 * Moving a live session onto another account: `POST /v1/sessions/:sessionId/migrate`, its safety gate, the conversion
 * preview, the relaunch settings and the "ask the agent to stop its background jobs" route, over the service that drives
 * them ({@link createSessionMigrateSubsystem}).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the process probe, the report store, the conversation files, the conversion checks and the serial
 * executor are fixed production adapters; every owner the migration borrows is a need), no jobs, no releases of its own and
 * no protocol features: every constructor in the build is pure, so the single build sits where the migration was always
 * assembled.
 *
 * Session lifecycle, launch, resume and account resolution are session code that stays in `fyd.ts` (the session-resume PR
 * moves restart/resume), so they reach this module only as typed {@link SessionMigrateNeeds}: the very locals the old call
 * passed. Every value the old code read LATE (the queue, the pane registration, the launch settings, the harness discovery)
 * is a closure written at the call site in `fyd.ts`, so each is read at the same moment it always was.
 *
 * What it provides is the service itself: the restart service and the Warden call it directly, and its four routes are the
 * module's contribution.
 */

/** What the session-migrate module is built from. */
export interface SessionMigrateNeeds {
  /** The state home's directories: the report store and a session's private directory are beneath them. */
  readonly paths: FoundationPaths;
  readonly storage: DaemonStorage;
  readonly sessions: SessionDirectorySubsystem;
  /** The SAME service the revive uses — see `createSessionResume` in `fyd.ts`. */
  readonly resume: SessionResumeService;
  readonly preflight: MigrationPreflight;
  /** Puts one Ferretry-authored message in the session's queue (a closure over the queue and its deliverer). */
  readonly askAgent: SessionMigrateParts['askAgent'];
  readonly planner: SessionPlanner;
  readonly accounts: AccountInventoryPort;
  readonly executables: ExecutableResolverPort;
  readonly clock: SystemClock;
  /** The transcript reader factory the daemon builds each reader from (`createTranscriptReader` in `fyd.ts`). */
  readonly createTranscriptReader: (storage: DaemonStorage) => SessionTranscriptReader;
  readonly transcriptProvenance: TranscriptProvenanceCapture;
  /** The Codex rollout index the conversation files correlate a rollout by. */
  readonly codexRollouts: CodexRolloutIndex;
  /** The harness CLI itself, discovered the SAME way a start's readiness check and the doctor do. */
  readonly locateHarness: SessionMigrateParts['locateHarness'];
  readonly readableHandoffs: SessionMigrateParts['readableHandoffs'];
  readonly fixedSettings: SessionMigrateParts['fixedSettings'];
  readonly paneIdentity: SessionMigrateParts['paneIdentity'];
  /** The launch-service factory the daemon builds each launch service from (`createSessionLaunch` in `fyd.ts`). */
  readonly createSessionLaunch: (storage: DaemonStorage) => SessionLaunchService;
  /** The binary name a person drives, which an account resolution is typed with (`CLIENT_NAME` in `fyd.ts`). */
  readonly clientName: string;
}

/** What other code uses of the session-migrate module. */
export type SessionMigrateProvides = SessionMigrateSubsystem & AgentJobControl;

/** The collaborators a migration needs. Grouped because eight positional arguments in the order the
 *  flow happens to use them is a call site nobody can check. */
interface SessionMigrateParts {
  readonly storage: DaemonStorage;
  /** Pids read wherever they are on the host, for following a stopped job out of its pane (`migrate/stop-jobs.ts`). */
  readonly processes: { lookup(pids: readonly number[]): Promise<ReadonlyMap<number, ProcRow>> };
  readonly sessions: SessionDirectorySubsystem;
  /** The SAME service the revive uses — see `createSessionResumeSubsystem`. */
  readonly resume: SessionResumeService;
  readonly preflight: MigrationPreflight;
  /**
   * Puts one Ferretry-authored message in the session's queue — the only thing a refused migration's
   * "ask the agent to stop its background jobs" does. `created` is false when `messageId` was queued before.
   */
  readonly askAgent: (id: SessionId, message: { readonly id: string; readonly text: string }) => Promise<boolean>;
  readonly reports: MigrationReportStore;
  readonly planner: SessionPlanner;
  readonly accounts: AccountInventoryPort;
  readonly executables: ExecutableResolverPort;
  readonly clock: SystemClock;
  /**
   * The session's own transcript, which is what the preflight joins its open tool ids against.
   *
   * Until a session recorded its transcript this was an EMPTY array and every open tool was
   * classified `unknown`, which the gate refuses on — the daemon knew a tool was running and not
   * what it was. With provenance persisted the join has real evidence, and a session that still has
   * no locatable transcript degrades to exactly the previous behaviour rather than to a guess.
   */
  readonly transcripts: SessionTranscriptReader;
  /** The target account's own transcript evidence, taken before the relaunch argv is authorized. */
  readonly transcriptProvenance: TranscriptProvenanceCapture;
  /** The transcripts a migration reads and carries into the target login's home. */
  readonly conversationFiles: ConversationFilesPort;
  /** The validation run a converted conversation must pass before a cross-harness move switches. */
  readonly conversionCheck: ConversionCheckPort;
  /** The version each harness CLI reports, which the converter is gated on. */
  readonly harnessVersion: HarnessVersionPort;
  /** The rollout format an untested Codex version writes, which lets the converter accept it. */
  readonly rolloutFormat: RolloutFormatPort;
  /** The harness CLI itself — the binary a target runtime's wrapper runs — or nothing when absent. */
  readonly locateHarness: (kind: HarnessKind) => string | undefined;
  /** A fresh harness conversation id for a converted conversation. */
  readonly conversationId: () => string;
  /** The session's own private directory, which is what a Codex rollout is correlated by. */
  readonly sessionDirectory: (id: SessionId) => string;
  /** The folders the agent is pointed into to read what it was sent (`handoffFolders`). */
  readonly readableHandoffs: (id: SessionId) => readonly string[];
  /** The text of the fixed `--settings` file a Claude wrapper launches under, which a compaction trigger replaces. */
  readonly fixedSettings: (executable: string, harness: HarnessKind) => Promise<string | undefined>;
  /** The registered pane's identity (pane id, pid, process start), or nothing when none can be read. */
  readonly paneIdentity: (id: SessionId) => Promise<string | undefined>;
  /** Serializes whole migrations of one session, so two cannot restamp the same document. */
  readonly serial: KeyedSerialExecutor;
  /** The SAME rebuild a revive runs, asked whether it would change anything. */
  readonly launch: SessionLaunchService;
  /** The binary name a person drives, which an account resolution is typed with. */
  readonly clientName: string;
}

/** The documents a migration reasons about, parsed by the schemas that govern them. */
interface MigrateSubject {
  readonly config: z.infer<typeof SessionConfigSchema>;
  readonly state: z.infer<typeof SessionStateSchema>;
  readonly tmuxSession: string;
}

/** How each account-resolution refusal is restated in the migration's own taxonomy. The resolver is
 *  shared with the start, and its vocabulary is the start's. */
const MIGRATE_RESOLUTION_REFUSALS: Partial<Record<SessionControlFailure, SessionMigrateFailure>> = {
  unknown_agent: 'unknown_agent',
  unavailable: 'unavailable',
};

/** How each resume refusal is restated once a migration is the thing that asked for the relaunch. */
function migrateRelaunchRefusal(error: unknown): never {
  // A guard or a dedupe conflict cannot reach here: the migration states its own policy, which sets
  // neither an expected status nor the dedupe heuristic. Everything the domain refuses is therefore
  // the session's own condition — a live pane holding an unanswered question, an unconfirmed kill.
  if (error instanceof ResumeRefused) throw new SessionMigrateError('refused', error.message);
  throw new SessionMigrateError('failed', error instanceof Error ? error.message : String(error));
}

/**
 * The window this session is running in today.
 *
 * The observed model is deliberately carried through: aliases are configured
 * names, whereas a context override describes the model the harness actually
 * serves.  The core projection also retains a configured `[1m]` selector that
 * harness output strips away.
 */
export function currentContextWindow(
  config: z.infer<typeof SessionConfigSchema>,
  state: z.infer<typeof SessionStateSchema>,
  declaredWindow?: number,
) {
  return contextWindowForSession({
    configuredModel: config.model,
    modelHint: config.modelHint,
    observedModel: state.observedModel,
    reportedWindow: state.contextWindow,
    ...(declaredWindow === undefined ? {} : { declaredWindow }),
  });
}

/** What a migration's relaunch is bound to: a carried conversation, a fresh one, or a refusal. */
type RelaunchConversation =
  | {
      readonly kind: 'carry';
      readonly provenance: TranscriptProvenance;
      readonly copy?: { readonly from: string; readonly to: string };
      readonly launchArguments: readonly string[];
    }
  | {
      readonly kind: 'fresh';
      readonly provenance?: TranscriptProvenance;
      readonly copy?: undefined;
      readonly launchArguments: readonly string[];
    }
  | {
      readonly kind: 'convert';
      readonly provenance: TranscriptProvenance;
      readonly copy?: undefined;
      readonly launchArguments: readonly string[];
      /** The converted transcript, written into the target home before the record points at it. */
      readonly transcript: { readonly file: string; readonly text: string };
      /** Attachments the converted history references, saved first. */
      readonly files: readonly { readonly file: string; readonly data: string }[];
      readonly summary: ConvertedConversationSummary;
      /** The conversation it was converted from, which stays on disk. */
      readonly from: { readonly harness: Harness; readonly conversationId: string; readonly file: string };
      /** The target conversation's fresh id. */
      readonly conversationId: string;
    }
  | {
      readonly kind: 'unresumable';
      readonly reason: string;
      readonly provenance?: undefined;
      readonly copy?: undefined;
    };

/** The most of a source transcript a conversion reads. A larger one is refused rather than cut. */
const CONVERSION_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
/** The most of a Codex `config.toml` read for its model provider. */
const CODEX_CONFIG_MAX_BYTES = 256 * 1024;

/** What a conversion needs to know about the move it is part of. */
interface ConversionSubject {
  readonly id: SessionId;
  readonly config: z.infer<typeof SessionConfigSchema>;
  readonly harness: HarnessKind;
  readonly executable: string;
  readonly targetAgent: string;
  readonly targetModel: string;
  readonly targetWindow: number;
}

/**
 * The conversation converted for a cross-harness move, from reads alone — the source transcript, the
 * hand-off documents its pointers name inside the session's own folder, the target home and its CLI's
 * version. Shared by the preview and the move, so what a person confirms is what is written.
 */
async function planConversion(
  parts: SessionMigrateParts,
  subject: ConversionSubject,
  nativeShell = true,
): Promise<ConversationConvert> {
  const { id, config, harness, executable } = subject;
  const source = config.transcript;
  const sourceText =
    source?.file === undefined
      ? undefined
      : await parts.conversationFiles.read(source.file, CONVERSION_SOURCE_MAX_BYTES);
  if (source?.file !== undefined && sourceText === undefined && (await parts.conversationFiles.written(source.file)))
    return {
      kind: 'unconvertible',
      reason: `The conversation file ${source.file} couldn't be read whole (the converter reads at most 512 MB), so it can't be converted. Nothing was changed.`,
    };
  const sessionDirectory = parts.sessionDirectory(id);
  const documents = new Map<string, string>();
  for (const path of handoffPointerPaths(sourceText ?? '')) {
    // Only this session's own hand-off documents: the transcript is the agent's, and the agent does
    // not get to choose what the daemon reads.
    if (!isReadableHandoff(path, { roots: [sessionDirectory], coordinatorHomes: [] })) continue;
    const document = await parts.conversationFiles.read(path, HANDOFF_READ_MAX_BYTES);
    if (document !== undefined) documents.set(path, document);
  }
  const targetHome = await parts.transcriptProvenance.home(harness, executable);
  const binary = parts.locateHarness(harness);
  const targetVersion = binary === undefined ? undefined : await parts.harnessVersion.version(binary);
  const targetFormat =
    binary !== undefined && needsRolloutFormatProbe(harness, targetVersion)
      ? await parts.rolloutFormat.classify(binary, targetVersion)
      : undefined;
  const targetModelProvider =
    harness === 'codex' && targetHome !== undefined
      ? codexModelProvider(await parts.conversationFiles.read(join(targetHome, 'config.toml'), CODEX_CONFIG_MAX_BYTES))
      : undefined;
  return planConversationConvert({
    sourceHarness: config.harness,
    targetHarness: harness,
    source,
    sourceText,
    documents: documents satisfies HandoffDocuments,
    targetHome,
    targetVersion,
    ...(targetFormat === undefined ? {} : { targetFormat }),
    ...(targetModelProvider === undefined ? {} : { targetModelProvider }),
    targetAgent: subject.targetAgent,
    targetModel: subject.targetModel,
    targetWindow: subject.targetWindow,
    // Resolved: the CLI derives where a conversation lives from its resolved working directory, so a
    // converted Claude file written under a symlinked spelling (macOS `/tmp`, `/var`) is never found.
    cwd: await realpath(config.cwd).catch(() => config.cwd),
    sessionDirectory,
    conversationId: parts.conversationId(),
    at: parts.clock.now(),
    ...(nativeShell ? {} : { nativeShell: false }),
  });
}

/**
 * A conversion, proven: planned, then resumed by the target CLI in a throwaway home before anything is
 * switched. Any doubt is `unresumable` with the reason, and the session is left exactly as it was.
 */
async function convertRelaunchConversation(
  parts: SessionMigrateParts,
  subject: ConversionSubject,
): Promise<RelaunchConversation> {
  const native = await planConversion(parts, subject);
  if (native.kind === 'unconvertible') return { kind: 'unresumable', reason: native.reason };
  const binary = parts.locateHarness(subject.harness);
  const source = subject.config.transcript;
  // A plan exists only for a located CLI and an identified source; this restates that for the types.
  if (binary === undefined || source?.file === undefined || source.harnessSessionId === undefined)
    return { kind: 'unresumable', reason: 'The conversion could not be checked. Nothing was changed.' };
  const check = async (plan: ConversationConvert & { readonly kind: 'convert' }) =>
    await parts.conversionCheck.check({
      harness: subject.harness,
      executable: binary,
      model: subject.targetModel,
      render: plan.render,
    });
  let planned = native;
  let verdict = await check(native);
  // A CLI that does not declare its shell tool for this model gets the shell commands as text instead,
  // checked again: a lossier history is better than no move, and the summary says which it was.
  if (!verdict.ok && verdict.missingTools !== undefined) {
    const textual = await planConversion(parts, subject, false);
    if (textual.kind === 'convert') {
      planned = textual;
      verdict = await check(textual);
    }
  }
  if (!verdict.ok) return { kind: 'unresumable', reason: `${verdict.reason} Nothing was changed.` };
  return {
    kind: 'convert',
    provenance: planned.provenance,
    launchArguments: transcriptLaunchArguments(subject.harness, planned.provenance, []),
    transcript: planned.transcript,
    files: planned.files,
    summary: planned.summary,
    from: { harness: subject.config.harness, conversationId: source.harnessSessionId, file: source.file },
    conversationId: planned.conversationId,
  };
}

/** A conversion's own account, in the protocol's words. */
function conversionSummaryView(summary: ConvertedConversationSummary): ConversionSummaryView {
  return {
    converter: summary.converter,
    sourceHarness: summary.source.harness,
    ...(summary.source.version === undefined ? {} : { sourceVersion: summary.source.version }),
    targetHarness: summary.target.harness,
    targetVersion: summary.target.version,
    turns: summary.turns,
    keptTurns: summary.keptTurns,
    omittedTurns: summary.omittedTurns,
    cutNewest: summary.cutNewest,
    messages: summary.messages,
    nativeToolCalls: summary.nativeToolCalls,
    toolCallsAsText: summary.toolCallsAsText,
    attachments: summary.attachments,
    dropped: summary.dropped,
    estimatedTokens: summary.estimatedTokens,
    budgetTokens: summary.budgetTokens,
    ...(summary.formatNote === undefined ? {} : { formatNote: summary.formatNote }),
  };
}

/**
 * The conversation a migration relaunches into, decided from reads alone.
 *
 * `fresh` is the person's explicit choice and captures the target's evidence as a start would.
 * `resume` carries the bound conversation ({@link planConversationCarry}); `previous` first rebinds
 * to the newest other transcript in the session's home that names its directory
 * ({@link previousConversation}) — the repair for a session an earlier Restart moved onto an empty one.
 */
async function decideRelaunchConversation(
  parts: SessionMigrateParts,
  subject: {
    readonly id: SessionId;
    readonly config: z.infer<typeof SessionConfigSchema>;
    readonly harness: HarnessKind;
    readonly executable: string;
    readonly targetAgent: string;
    readonly targetModel: string;
    readonly targetWindow: number;
    readonly conversation: MigrationConversation;
  },
): Promise<RelaunchConversation> {
  const { id, config, harness, executable } = subject;
  if (subject.conversation === 'convert') return await convertRelaunchConversation(parts, subject);
  const at = parts.clock.now();
  if (subject.conversation === 'fresh') {
    const captured = await parts.transcriptProvenance.capture({
      harness,
      executable,
      cwd: config.cwd,
      correlationToken: parts.sessionDirectory(id),
      at,
    });
    return {
      kind: 'fresh',
      ...(captured.provenance === undefined ? {} : { provenance: captured.provenance }),
      launchArguments: captured.launchArguments,
    };
  }
  let source = config.transcript;
  if (subject.conversation === 'previous' && source !== undefined) {
    const rebound = previousConversation({
      harness,
      current: source,
      home: source.home,
      candidates: await parts.conversationFiles.prior(harness, source.home, config.cwd, parts.sessionDirectory(id)),
      at,
    });
    if (rebound.kind === 'unresumable') return rebound;
    source = rebound.provenance;
  }
  const planned = planConversationCarry({
    harness,
    source,
    sourceWritten: source?.file !== undefined && (await parts.conversationFiles.written(source.file)),
    targetHome: await parts.transcriptProvenance.home(harness, executable),
    targetAgent: subject.targetAgent,
    cwd: config.cwd,
  });
  if (planned.kind === 'unresumable') return planned;
  return { ...planned, launchArguments: transcriptLaunchArguments(harness, planned.provenance, []) };
}

/**
 * Moving one session onto another account, over the preflight that was built for exactly this and
 * never called.
 *
 * WHAT A MIGRATION IS MADE OF, and why each part is where it is:
 *
 *   * THE GATE RUNS FIRST AND WRITES NOTHING. `MigrationPreflight` inventories the pane's process
 *     tree, the codex footer and the session's own open tools, and refuses work it cannot show will
 *     survive the kill. Nothing above it is allowed to mutate the session, so a refused migration
 *     leaves a session exactly as it found it.
 *   * THE REPORT IS WRITTEN BEFORE THE PANE DIES, because it is the only account of what the kill
 *     destroyed and the pane is the evidence. It is also what the replacement agent is handed: the
 *     handoff message names the file.
 *   * THE DOCUMENT IS RESTAMPED, NOT REPLACED. `updateConfig` merges over what is on disk, so the
 *     session keeps its id, directory, journal, callsign and history and changes only the account,
 *     the model, the argv the relaunch will run, and the incarnation counting the relaunches.
 *   * THE RELAUNCH IS THE REVIVE, with one policy field flipped. Everything a safe replacement needs
 *     — snapshot before kill, journalled composer discard, the turn document, the launch gate, the
 *     per-session queue — is the resume domain's, already built and tested. `replaceLiveTerminal`
 *     is what stops it taking its send shortcut and typing the handoff into the agent being replaced.
 *
 * ONLY `revived` IS A MIGRATION. The resume domain answers three other dispositions, and two of them
 * are relaunch failures that do NOT throw: `preserved` means the replacement reported failure while
 * the OLD harness was still at a prompt, and `retry-scheduled` means the relaunch failed and a retry
 * was booked. Both leave the session on the account it started on while its record already names the
 * new one, so both settle the report as a FAILURE. Treating the absence of an exception as success
 * here is precisely how a migration reports a move that did not happen.
 *
 * THE CONFIGURATION IS NOT ROLLED BACK when the relaunch fails, and the report says so in those
 * words. A rollback is a second write that can fail on its own, and it would race whatever the resume
 * domain did next — it may have preserved a live harness or scheduled a retry that will relaunch from
 * this very document. Reporting "left staged on the target" is a fact; reporting a rollback that was
 * attempted and not verified would not be.
 */
function createSessionMigrateSubsystem(parts: SessionMigrateParts): SessionMigrateSubsystem & AgentJobControl {
  /** The preflight's look at a session, shared by the move and by the ask that clears its way. */
  const inspect = async (id: SessionId, { config, state, tmuxSession }: MigrateSubject) =>
    await parts.preflight.inspect(
      {
        sessionId: id,
        harness: config.harness,
        tmuxSession,
        status: state.status,
        turn: state.turn,
        // The state document's own record of the tool calls this session has open.
        openTools: state.openTools ?? [],
        ...(state.subprocessSince === undefined ? {} : { subprocessSince: state.subprocessSince }),
      },
      // The session's OWN transcript, resolved from the provenance its start recorded. A session
      // with none reads as an empty tail, which classifies every open tool `unknown` and refuses
      // the migration — the same fail-closed answer this call gave before, now reached only when
      // the evidence is genuinely absent rather than always.
      await parts.transcripts.tail({ sessionId: id, harness: config.harness === 'codex' ? 'codex' : 'claude' }),
    );

  /** Both documents plus the tmux address, or a stated refusal. A session whose pair does not parse
   *  is one nothing may restamp: the write would merge new fields over a document already broken. */
  const subject = async (id: SessionId): Promise<MigrateSubject> => {
    const raw = await parts.storage.readConfig(id);
    const config = SessionConfigSchema.safeParse(raw);
    const state = SessionStateSchema.safeParse(await parts.storage.readState(id));
    if (!config.success || !state.success)
      throw new SessionMigrateError('unusable', `the documents for session ${id} do not satisfy the protocol`);
    // The tmux address lives in the lifecycle's half of the same document, and it is what every
    // signal the preflight reads is addressed by.
    const lifecycle = SessionLifecycleConfigSchema.safeParse(lifecycleConfigDocument(raw));
    if (!lifecycle.success)
      throw new SessionMigrateError('unusable', `session ${id} records no terminal this daemon could inspect`);
    return { config: config.data, state: state.data, tmuxSession: lifecycle.data.tmuxSession };
  };

  /** The view of a session this mount just moved. A document it cannot read back is a wiring fault. */
  const view = async (id: SessionId, when: string): Promise<SessionView> => {
    const found = await parts.sessions.get(id).catch(() => undefined);
    if (found === undefined) throw new SessionMigrateError('failed', `session ${id} ${when} but cannot be read back`);
    return found;
  };

  /** What the session looks like after a failed attempt, for the outcome section. An unreadable one
   *  is reported as absent rather than guessed at — the renderer says UNKNOWN, which is the truth. */
  const observed = async (id: SessionId): Promise<ObservedSession | undefined> => {
    const found = await parts.sessions.get(id).catch(() => undefined);
    if (found === undefined) return undefined;
    return {
      binary: found.config.agent,
      ...(found.config.model === undefined ? {} : { model: found.config.model }),
      status: found.state.status,
    };
  };

  /** The account a move names, resolved with the start's own rule, its refusals in the move's words. */
  const resolveTarget = async (agent: string) =>
    await resolveStartAccount(parts.accounts, agent, parts.executables, parts.clientName).catch((error: unknown) => {
      if (!(error instanceof SessionControlError)) throw error;
      const failure = MIGRATE_RESOLUTION_REFUSALS[error.failure];
      if (failure === undefined) throw error;
      throw new SessionMigrateError(failure, error.message);
    });

  /**
   * The model a move plans on the target — the same planner the start uses, so the model a migration
   * records and the window it is measured against come from the one decision rather than two that can
   * disagree. Shared by the move and the conversion preview, so the window a person was shown is the
   * window the move fits.
   */
  const planModel = (
    id: SessionId,
    config: z.infer<typeof SessionConfigSchema>,
    state: z.infer<typeof SessionStateSchema>,
    account: Awaited<ReturnType<typeof resolveTarget>>['account'],
    requestedModel: string | undefined,
  ) => {
    const shape = {
      id,
      account,
      mode: config.mode,
      ...(config.teammate === undefined ? {} : { teammate: config.teammate }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.parent === undefined ? {} : { parent: config.parent }),
    };
    // A RESTART KEEPS THE MODEL THE SESSION IS ON. A request that names no model used to plan the
    // target's default, so Restart CLI — a migration onto the same account — quietly moved a session
    // the owner had switched to another model back onto the default. The model it is on now is asked
    // for instead; only when the target cannot serve it does the target's default decide, as before.
    const current = currentLaunchModel(config, state, model => canServeModel(account, model));
    const keep =
      requestedModel === undefined && current !== undefined
        ? parts.planner.plan({ ...shape, requestedModel: current })
        : undefined;
    const planned =
      keep?.kind === 'planned'
        ? keep
        : parts.planner.plan({ ...shape, ...(requestedModel === undefined ? {} : { requestedModel }) });
    return { keep, planned };
  };

  const migrate = async (
    id: SessionId,
    request: Parameters<SessionMigrateSubsystem['migrate']>[1],
  ): Promise<SessionView> => {
    const { config, state, tmuxSession } = await subject(id);
    const { account, executable } = await resolveTarget(request.agent);
    // SAME-KIND, ENFORCED HERE — the first thing decided once both families are known, and before any
    // other work at all. Everything below it either reads the host or writes the session: the planner,
    // the transcript capture that inspects the target's harness home, the report, the restamp and the
    // kill. Refusing at this point is what makes the refusal cost nothing and leave nothing behind, so
    // the caller may present the same request id again against an account of the right family.
    // A CONVERSION IS THE ONE WAY ACROSS: `conversation: 'convert'` rewrites the conversation in the
    // target's format, so it is refused the other way round — onto the session's own family.
    const converting = request.conversation === 'convert';
    const families = { sourceHarness: config.harness, targetHarness: account.kind, targetAgent: account.agent };
    const mismatch = converting ? harnessConversionRefusal(families) : harnessMigrationRefusal(families);
    if (mismatch !== undefined) throw new SessionMigrateError('harness_mismatch', mismatch);
    const { keep, planned } = planModel(id, config, state, account, request.model);
    // And the effort it is on, which no request names — unless the move crosses harnesses, whose effort
    // vocabularies differ: the target then starts on its own login's setting.
    const effort = converting ? undefined : currentLaunchEffort(config, state);
    // A MIGRATION ONTO A MODEL THE TARGET DOES NOT SERVE IS REFUSED, for the same reason the start
    // refuses it and with more at stake: a migration that quietly landed on the account's default
    // would move a live conversation into a different model and a different context window while the
    // report handed back named the one that was asked for. Refused at the same point the family
    // mismatch is, so the refusal costs nothing and leaves the session exactly where it was.
    if (planned.kind === 'unservable-model') throw new SessionMigrateError('unservable_model', planned.reason);
    const plan = planned.plan;
    // Rebuilt rather than patched: the remote-control arguments are the TARGET harness's, and a
    // codex session inheriting a claude session's flags would relaunch into an argument error.
    //
    // AUTHORIZED with the start's own rule, because a migration does not go through the lifecycle
    // service that applies it. The relaunch reads this argv straight out of the document written
    // below, so without this check a fleet manifest publishing something that is not an auto wrapper
    // would be launchable by a migrate and refused by a start.
    //
    // THE CONVERSATION GOES WITH THE SESSION. A Restart, or a move onto another login of the same
    // harness, relaunches the CLI into the conversation it is bound to — the transcript carried into
    // the target's home and resumed by its own id — rather than into a fresh one: re-capturing here
    // used to mint a new Claude id, so every Restart opened an empty conversation. Decided now, from
    // reads only; a conversation that cannot be carried is refused below, once the in-flight gate has
    // had its say, and before anything is written.
    const relaunchConversation = await decideRelaunchConversation(parts, {
      id,
      config,
      harness: account.kind,
      executable,
      targetAgent: account.agent,
      targetModel: plan.model,
      targetWindow: plan.contextWindow,
      conversation: request.conversation ?? 'resume',
    });
    // The compaction trigger travels with the session (its own choice stays on the document), else the TARGET
    // login's default. Claude carries it in the replacement `--settings`, so that overlay is read now.
    const compactAt = currentLaunchCompactAt(config, account.compactAt, plan.contextWindow);
    const fixedSettings =
      account.kind === 'claude' && compactAt !== undefined ? await parts.fixedSettings(executable, account.kind) : '';
    if (fixedSettings === undefined)
      throw new SessionMigrateError(
        'unavailable',
        `${account.agent}'s fixed settings could not be read, so its compaction trigger cannot be applied`,
      );
    const command = ((): readonly string[] => {
      try {
        return authorizeSessionCommand(
          executable,
          buildLaunchArgv({
            harness: account.kind,
            executable,
            remoteControl: config.remoteControl ? plan.extraArgs : [],
            transcript: relaunchConversation.kind === 'unresumable' ? [] : relaunchConversation.launchArguments,
            readableFolders: parts.readableHandoffs(id),
            model: plan.model,
            ...(effort === undefined ? {} : { effort }),
            ...(compactAt === undefined ? {} : { compactAt, fixedSettings }),
            // The owner's extra flags are the source CLI's; the other harness would refuse them.
            harnessFlags: converting ? [] : config.harnessFlags,
          }),
          defaultSessionLifecycleSettings,
        );
      } catch (error) {
        throw new SessionMigrateError('unavailable', error instanceof Error ? error.message : String(error));
      }
    })();
    // The window the session runs in, read the way the plan reads the target's: the harness's own report, the
    // selector in its configured model, then what its account's catalog declares for it.
    const sourceAccount = findAccountByAgent(await parts.accounts.accounts(), config.agent);
    const window = currentContextWindow(
      config,
      state,
      sourceAccount === undefined ? undefined : declaredModel(sourceAccount, config.model ?? '')?.context,
    );
    // A RESTART IS NEVER A DOWNGRADE. The same model on the same account relaunches into the window it already
    // has; a plan that disagrees is a catalog or selector gap, and refusing would make Restart impossible.
    const relaunchesSameModel =
      request.model === undefined && keep?.kind === 'planned' && account.agent === config.agent;
    // A CONVERSION FITS THE TARGET BY CONSTRUCTION: it keeps the newest history the target's window can
    // hold, tells the target how much it left out, and the preview the person confirmed said so.
    if (plan.contextWindow < window && !request.allowContextDowngrade && !relaunchesSameModel && !converting)
      throw new SessionMigrateError(
        'context_downgrade',
        `${account.agent} serves ${plan.model} with a ${plan.contextWindow}-token window and this session is ` +
          `running in ${window}, so part of this conversation would be cut off. ` +
          'Re-run with --allow-context-downgrade to accept that.',
        { downgrade: { model: plan.model, targetWindow: plan.contextWindow, currentWindow: window } },
      );
    const report = await inspect(id, { config, state, tmuxSession });
    const decision = parts.preflight.gate(report, { force: request.forceInflight });
    if (!decision.proceed)
      throw new SessionMigrateError('refused', `${decision.reason}\n${parts.preflight.summarize(report)}`, {
        inflight: parts.preflight.describe(report),
      });
    // NEVER A SILENT NEW CONVERSATION. Still before the first write, so a refusal leaves the session
    // exactly as it was and the person can choose to start fresh.
    if (relaunchConversation.kind === 'unresumable')
      throw new SessionMigrateError('unresumable', relaunchConversation.reason);
    const at = parts.clock.now();
    if (decision.forced)
      await parts.storage.append(id, 'session.migrate_forced', {
        to: account.agent,
        verdict: report.worstVerdict,
        went_past: parts.preflight
          .describe(report)
          .items.filter(item => item.blocks)
          .map(item => ({ title: item.title, ...(item.detail === undefined ? {} : { detail: item.detail }) })),
      });
    const reportPath = await parts.reports.write(
      id,
      parts.preflight.document(report, {
        sessionId: id,
        targetAgent: account.agent,
        targetModel: plan.model,
        forced: decision.forced,
        at,
      }),
    );
    const from = config.agent;
    const generation = config.runtimeGeneration + 1;
    // The level the session is on carries over; with none known, the target's own settings decide.
    const launchEffort =
      effort ?? (await readPersistedReasoningEffort(account.kind, relaunchConversation.provenance?.home));
    // A converted conversation, written before the record that points at it: its attachments first,
    // then the transcript the target CLI already accepted in the validation run.
    if (relaunchConversation.kind === 'convert') {
      const converted = relaunchConversation;
      try {
        for (const attachment of converted.files)
          await parts.conversationFiles.write(attachment.file, Buffer.from(attachment.data, 'base64'));
        await parts.conversationFiles.write(converted.transcript.file, converted.transcript.text);
      } catch (error) {
        throw new SessionMigrateError(
          'failed',
          `the converted conversation could not be written into ${account.agent}'s home (${converted.transcript.file}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    // The target login's copy of the conversation, written before the record that points at it.
    const carried = relaunchConversation.copy;
    if (carried !== undefined)
      await parts.conversationFiles.copy(carried.from, carried.to).catch((error: unknown) => {
        throw new SessionMigrateError(
          'failed',
          `the conversation could not be copied into ${account.agent}'s home (${carried.to}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      });
    // The record as it stood, to put back if the old harness is still the one serving after a failed relaunch.
    let recordBefore: Readonly<Record<string, unknown>> = {};
    await parts.storage.updateConfig(id, current => {
      recordBefore = jsonObject(current) ?? {};
      // The previous account's transcript record is REMOVED rather than merged over: a target that
      // declares no resolvable home must leave the session with no transcript, and a merge would
      // silently keep the old harness's file under the new harness's name.
      // Fast mode is dropped with the effort's launch record: the target is another login, often
      // another harness, and a model there may have none. It starts on that login's own setting.
      // The conversion lineage goes with the conversation it describes: a new conversion replaces it,
      // a resume of the same conversation keeps it, and a fresh or an earlier conversation drops it.
      const {
        transcript: _replaced,
        launchReasoningEffort: _previousEffort,
        launchFast: _previousFast,
        conversion: previousLineage,
        ...retained
      } = jsonObject(current) ?? {};
      const lineage =
        relaunchConversation.kind === 'convert'
          ? {
              v: 1,
              converter: relaunchConversation.summary.converter,
              fromHarness: relaunchConversation.from.harness,
              fromConversation: relaunchConversation.from.conversationId,
              fromFile: relaunchConversation.from.file,
              toHarness: account.kind,
              toConversation: relaunchConversation.conversationId,
              at,
              keptTurns: relaunchConversation.summary.keptTurns,
              omittedTurns: relaunchConversation.summary.omittedTurns,
            }
          : (request.conversation ?? 'resume') === 'resume'
            ? previousLineage
            : undefined;
      return {
        ...retained,
        ...(lineage === undefined ? {} : { conversion: lineage }),
        ...(converting ? { harnessFlags: [] } : {}),
        ...(launchEffort === undefined ? {} : { launchReasoningEffort: launchEffort }),
        agent: account.agent,
        harness: account.kind,
        model: plan.model,
        modelHint: request.model ?? account.defaultModel ?? '',
        command: [...command],
        incarnation: `${id}-${generation}`,
        runtimeGeneration: generation,
        migration: { from, to: account.agent, at },
        // The whole history, for the spend meter: the last 999 earlier moves and this one.
        migrations: [...priorMigrations(retained).slice(-999), { from, to: account.agent, at }],
        ...(relaunchConversation.provenance === undefined ? {} : { transcript: relaunchConversation.provenance }),
        updatedAt: at,
      };
    });
    const by = request.movedBy ?? 'owner';
    await parts.storage.append(id, 'session.migrating', {
      from,
      to: account.agent,
      by,
      model: plan.model,
      conversation:
        relaunchConversation.kind === 'fresh'
          ? 'fresh'
          : relaunchConversation.kind === 'convert'
            ? 'converted'
            : 'resumed',
      ...(relaunchConversation.kind === 'convert'
        ? {
            convertedFrom: {
              harness: relaunchConversation.from.harness,
              conversation: relaunchConversation.from.conversationId,
              file: relaunchConversation.from.file,
            },
            conversion: conversionSummaryView(relaunchConversation.summary),
          }
        : {}),
      ...(relaunchConversation.provenance?.harnessSessionId === undefined
        ? {}
        : { harnessSessionId: relaunchConversation.provenance.harnessSessionId }),
      report: reportPath,
      verdict: report.worstVerdict,
    });
    const settle = async (ok: boolean, detail?: string): Promise<void> => {
      const record = await observed(id);
      await parts.reports.append(
        id,
        parts.preflight.settle({
          ok,
          from,
          targetAgent: account.agent,
          targetModel: plan.model,
          at: parts.clock.now(),
          ...(detail === undefined ? {} : { detail }),
          ...(record === undefined ? {} : { observed: record }),
        }),
      );
      await parts.storage.append(id, ok ? 'session.migrated' : 'session.migrate_failed', {
        from,
        to: account.agent,
        by,
        ...(detail === undefined ? {} : { detail }),
      });
    };
    const paneBefore = await parts.paneIdentity(id);
    const rollBack = async (): Promise<void> => {
      await parts.storage.updateConfig(id, current => restoreRestamped(recordBefore, jsonObject(current) ?? {}));
    };
    const outcome = await parts.resume
      .resume({
        id,
        // Neither an expected status nor the dedupe heuristic: an operator asked for THIS session by
        // id, and the preflight above is the guard a migration has.
        policy: { automatic: false, dedupeSharedRecoveryScope: false, replaceLiveTerminal: true },
        // A move the Warden made is drawn as Ferretry · Warden on the turn it hands over, and opens with why.
        ...(request.actor === undefined ? {} : { actor: request.actor }),
        message:
          request.note === undefined
            ? parts.preflight.handoff(report, reportPath, config.mode)
            : `${request.note}\n\n${parts.preflight.handoff(report, reportPath, config.mode)}`,
      })
      .catch(async (error: unknown) => {
        const rolledBack = await settleRejectedRelaunch({
          from,
          paneBefore,
          paneNow: await parts.paneIdentity(id),
          rollBack,
        });
        await settle(false, (error instanceof Error ? error.message : String(error)) + rolledBack);
        migrateRelaunchRefusal(error);
      });
    if (outcome.disposition !== 'revived') {
      const detail = await settleUnrevivedRelaunch({
        disposition: outcome.disposition,
        from,
        to: account.agent,
        paneBefore,
        paneNow: await parts.paneIdentity(id),
        rollBack,
      });
      await settle(false, detail);
      throw new SessionMigrateError('failed', detail);
    }
    await settle(true);
    // Read back through the SAME reader the list and the single read serve, so a migration answers
    // with the view those surfaces will show rather than a projection of its own writes.
    return await view(id, 'was migrated');
  };

  /**
   * What converting onto an account would carry — the same plan the move makes, minus the validation
   * run and every write. A refusal is an answer here, not an error: it is what the sheet shows in place
   * of the confirm button.
   */
  const conversionPreview = async (
    id: SessionId,
    request: { readonly agent: string; readonly model?: string },
  ): Promise<ConversionPreview> => {
    const { config, state } = await subject(id);
    const { account, executable } = await resolveTarget(request.agent);
    const refused = (reason: string): ConversionPreview => ({ kind: 'refused', targetAgent: account.agent, reason });
    const mismatch = harnessConversionRefusal({
      sourceHarness: config.harness,
      targetHarness: account.kind,
      targetAgent: account.agent,
    });
    if (mismatch !== undefined) return refused(mismatch);
    const { planned } = planModel(id, config, state, account, request.model);
    if (planned.kind === 'unservable-model') return refused(planned.reason);
    const conversion = await planConversion(parts, {
      id,
      config,
      harness: account.kind,
      executable,
      targetAgent: account.agent,
      targetModel: planned.plan.model,
      targetWindow: planned.plan.contextWindow,
    });
    if (conversion.kind === 'unconvertible') return refused(conversion.reason);
    return {
      kind: 'ready',
      targetAgent: account.agent,
      targetModel: planned.plan.model,
      summary: conversionSummaryView(conversion.summary),
    };
  };

  /** The id a caller named, parsed, of a session that exists — or the refusal saying which it is not. */
  const existing = (reference: string): SessionId => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionMigrateError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    if (parts.storage.findSession(id) === undefined)
      throw new SessionMigrateError('not_found', `no session ${reference}`);
    return id;
  };

  /**
   * LOOKS AGAIN rather than trusting the refusal the person saw: jobs finish, and the agent must be told
   * about the ones running now. It asks about the agent's own blocking jobs only, and queues nothing at all
   * when there are none — a message about work that already ended would only confuse the agent.
   */
  const askToStopJobs = async (id: SessionId): Promise<AskToStopJobsResult> => {
    const report = await inspect(id, await subject(id));
    const jobs = parts.preflight.agentJobs(report);
    if (jobs.length === 0)
      throw new SessionMigrateError(
        'no_jobs',
        'none of the agent’s own background jobs is in the way any more — run the safety check again',
      );
    const messageId = agentJobsMessageId(jobs);
    const created = await parts.askAgent(id, { id: messageId, text: agentJobsMessage(jobs) });
    return { messageId, jobs: [...jobs], alreadyAsked: !created };
  };

  return {
    // The Warden's own reach into a move's way (`warden/auto-migrate-service.ts`); no route serves either.
    blockingJobs: async reference => {
      const id = existing(reference);
      return parts.preflight.agentJobs(await inspect(id, await subject(id)));
    },
    // Serialized with migrations of the same session, so a move never reads the tree while it is being cleared.
    stopAgentJobs: async reference => {
      const id = existing(reference);
      const target = await subject(id);
      return await parts.serial.run(
        id,
        async () =>
          await new AgentJobStopper({
            inspect: async () => await inspect(id, target),
            lookup: async pids => await parts.processes.lookup(pids),
            signal: deliverStopSignal,
            // Never these, whatever a pane's tree claims: init, this daemon, and what started it.
            protectedPids: new Set([1, process.pid, process.ppid]),
            sleep: async milliseconds => await Bun.sleep(milliseconds),
            nowMs: () => Date.now(),
          }).stop(),
      );
    },
    askToStopJobs: async reference => await askToStopJobs(existing(reference)),
    conversionPreview: async (reference, request) => await conversionPreview(existing(reference), request),
    migrate: async (reference, request) => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionMigrateError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (parts.storage.findSession(id) === undefined)
        throw new SessionMigrateError('not_found', `no session ${reference}`);
      // WHOLE migrations serialize, not just their writes: the gate reads a pane, the restamp writes
      // the document that pane's replacement is launched from, and a second migration interleaving
      // between the two would relaunch the first one's target under the second one's account.
      return await parts.serial.run(id, async () => await migrate(id, request));
    },
    relaunchSettings: async reference => {
      const id = tryParseSessionId(reference);
      if (id === undefined)
        throw new SessionMigrateError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
      if (parts.storage.findSession(id) === undefined)
        throw new SessionMigrateError('not_found', `no session ${reference}`);
      return await parts.launch.drift(id);
    },
  };
}

/**
 * A session's moves before this one, oldest first: its `migrations` list, or — on a session that predates it —
 * the single `migration` it carries. Read from the raw config, so a malformed entry is dropped, not thrown.
 */
function priorMigrations(config: Readonly<Record<string, unknown>>): { from: string; to: string; at: string }[] {
  const parsed = SessionConfigSchema.pick({ migration: true, migrations: true }).safeParse(config);
  if (!parsed.success) return [];
  if (parsed.data.migrations !== undefined) return [...parsed.data.migrations];
  return parsed.data.migration === undefined ? [] : [parsed.data.migration];
}

export const sessionMigrateModule: DaemonModule<void, SessionMigrateNeeds, SessionMigrateProvides> = {
  id: 'sessionMigrate',
  build: (needs, _seams, _lifecycle) => {
    const {
      paths,
      storage,
      sessions,
      resume,
      preflight,
      askAgent,
      planner,
      accounts,
      executables,
      clock,
      createTranscriptReader,
      transcriptProvenance,
      codexRollouts,
      locateHarness,
      readableHandoffs,
      fixedSettings,
      paneIdentity,
      createSessionLaunch,
      clientName,
    } = needs;
    // Hoisted so the handover and restart subsystems share this exact migrator.
    const sessionMigrate = createSessionMigrateSubsystem({
      storage,
      processes: new BunProcessProbe(Bun.which('ps') ?? undefined),
      sessions,
      resume,
      preflight,
      askAgent,
      reports: new FileMigrationReportStore(id => createSessionPaths(paths, id).directory),
      planner,
      accounts,
      executables,
      clock,
      transcripts: createTranscriptReader(storage),
      transcriptProvenance,
      conversationFiles: new FileConversationFiles(codexRollouts),
      conversionCheck: new CliConversionCheck(),
      harnessVersion: new CliHarnessVersion(),
      rolloutFormat: new CliRolloutFormatProbe(),
      locateHarness,
      conversationId: () => crypto.randomUUID(),
      sessionDirectory: id => createSessionPaths(paths, id).directory,
      readableHandoffs,
      fixedSettings,
      paneIdentity,
      // Its own queue: a migration holds its lock across a pane kill and a relaunch, and must not
      // make every unrelated document write in the process wait behind it.
      serial: new KeyedSerialExecutor(),
      launch: createSessionLaunch(storage),
      clientName,
    });
    return {
      id: 'sessionMigrate',
      provides: sessionMigrate,
      jobs: {},
      contributes: sessionMigrateContribution(sessionMigrate),
    };
  },
};
