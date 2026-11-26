import { posix } from 'node:path';
import type { AsksApi } from '@ferretry/core-asks/contract';
import type { ChildEnvironment, VaultApi } from '@ferretry/core-vault/contract';
import type { FencedPath, HookDecision, InstructionEntry, SharedCredential } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { applicableInstructions, sectionDigests } from './launch-sections.ts';
import { err, type Instant, ok, type Result } from '@ferretry/std';
import { openHarness } from './harness-facade.ts';
import { type DecidedFast, decideResume, launchFastOf, launchOptions } from './launch-options.ts';
import type { FerretsCore } from './core.ts';
import { compactAt, setCompactAt } from './compact-at.ts';
import { agentControl, effectiveLimits, revokeToken, turnUsage } from './insights.ts';
import { accountOf, repointRuntime, runtimeRecords } from './runtime-records.ts';
import { lastSnapshot, prompt, turnObserved, turns } from './turns.ts';
import { endOfExit } from './exit-cause.ts';
import { KeyedSerialExecutor } from './serial.ts';
import { typePointer } from './pointer-retry.ts';
import type { SerialExecutor } from '../ports.ts';
import { claimConversationLease, conversationLeaseGuard } from './conversation-lease-guard.ts';
import type { FerretLaunchLeases } from './launch-leases.ts';
import { beforePane, type LaunchGuard, type LaunchSteps, paneOpened, paneVariables, released } from './launch-steps.ts';
import { paneEnvironment } from './pane-env.ts';
import type { SessionCutOffMark } from '../tokens/cut-off-mark.ts';
import { ambiguousAgentAddressMessage, resolveAgentAddress } from '../../../contract/agent-address.ts';
import {
  type FerretBirth,
  DAEMON_ORIGIN,
  FerretTitleSchema,
  LaunchRefusal,
  type LaunchOrigin,
  birthOf,
  launchIsFenced,
  originIsAgent,
  RUNTIME_START_DEADLINE_MS,
  START_EXPLAINED_MAX,
} from '../../../contract/index.ts';
import type {
  FerretChangedPayload,
  FerretEndCause,
  FerretHarness,
  ConversationImport,
  FerretTurnAuthor,
  FerretTurnDocument,
  FerretTurnWritten,
  FerretTurns,
  FerretPrompt,
  MoveFailure,
  MoveOptions,
  ResumeOptions,
  FerretStartedPayload,
  FerretId,
  FerretRecord,
  FerretRuntimeRecord,
  FerretRuntimeRename,
  RunnerExit,
  FerretAddress,
  FerretsApi,
  FerretState,
  FerretSummary,
  Harness,
  HarnessHistorySource,
  HarnessKey,
  LaunchPart,
  LaunchPartSource,
  OpeningAttachmentsSource,
  ConversationStageSource,
  LaunchSpec,
  LoginCredentialAnswer,
  ManagedWorktreeSummary,
  PackId,
  Runner,
  RunnerHandle,
  LoginStartResolution,
  RuntimeStartResolution,
  Sitrep,
  SitrepLine,
  TurnUsage,
  SitrepLineSource,
  StartDecideInput,
  StartFailure,
  StartOptions,
  StartRequest,
} from '../../../contract/index.ts';
import type { CompactAt } from '../../../contract/view/compact-at.ts';
import { claimStartName, displayAgentName, type SessionNameClaims } from '../names/session-names.ts';
import { formatSessionTitle, normalizeCallsign } from '../names/policy.ts';
import type { NameAllocationErrorCode } from '../names/types.ts';
import type { SystemCallsignPrefix } from '../protocol/system-callsigns.ts';
import {
  diedParked,
  FerretDetailsSchema,
  FerretRecordSchema,
  REAL_HARNESS_REFUSED,
  StartRefusalCodeSchema,
  TranscriptProvenanceSchema,
  type FerretDetails,
} from '../../../contract/index.ts';
import { effectiveMode, type FerretRegistry, type FerretFilter } from '../registry/registry.ts';
import { launchMode } from '../session/peers/fleet.ts';
import { STOP_UNCONFIRMED, withStampedLabel } from './restart-guards.ts';
import { defaultHarnessKey } from './default-harness.ts';
import { runnerRefusal } from './runner-refusal.ts';
import { resumeUnderCutOff } from '../session/resume/cut-off.ts';
import { resumeTurnAuthor } from '../session/resume/policy.ts';
import type { LaunchGate, ResumeActor } from '../session/resume/types.ts';
import type { SessionId } from '../session-id.ts';
import type { SessionEffectAdmission } from '../session/effects/types.ts';
import { SessionMoveError } from '../runtime/mounts/session-move.ts';
import type { AgentControl, LimitsFile } from '../../../contract/index.ts';
import { type FerretTokenDirectory, issueToken, type TokenEntry } from '../tokens/tokens.ts';
import type { SessionSpawnRequest } from '../session/provenance/types.ts';
import {
  type LaunchEnvironmentRecord,
  modeSwitchDefaults,
  recordedSwitches,
  sessionModeSwitch,
  subFerretSwitch,
} from '../agent-control/launch-environment.ts';
import { STATE_HOME_UNRESOLVED, stateHomeSentence } from '../route-security/state-home.ts';

/**
 * THE FERRETS PORT (§2.2): who each ferret is and its state, and the launch pipeline. Starting and stopping are
 * done by a harness plugin through a runner; this asks `start.decide` takers first, then the harness, with the
 * Vault's child environment and what `launch.parts` takers add. Identity, lineage and the token are decided here.
 *
 * Order of a start (today's `session/lifecycle` service, reduced to the 5.0 kinds): mint the id, claim the name,
 * check the folder, ask `start.decide`, issue the token and record `starting` (so a crash leaves a record a resume
 * can find), then hand the harness its launch; on success the record is `working` with its runner handle, on any
 * failure `stopped` with its token revoked.
 */

/** Today's launch variables: the ferret's own bearer and id, read by `fy` inside the pane. */
const FERRET_TOKEN_VARIABLE = 'FY_SESSION_TOKEN';
const FERRET_ID_VARIABLE = 'FY_SESSION_ID';
export { MEDIA_FOLDER_VARIABLE, QUESTION_FILE_VARIABLE } from './session-stores/pane-files.ts';

/** The reason a stop records when its caller gave none (today's lifecycle `defaultStopReason`). */
const DEFAULT_STOP_REASON = 'stopped by client';

/**
 * The end causes of today's `failed` phase (the Warden's `FAILED_ENDS`, the same five): an end NOBODY CHOSE (the
 * terminal vanished, a signal, a non-zero exit) or a launch that never ran. Only the daemon itself writes one, never a
 * caller's stop, and the auto-resume and the Warden read the first four as a death still owed a revive. A stop of a
 * ferret stopped for one of these is written over it, as today's stop of a `failed` session went through.
 */
const FAILED_ENDS: ReadonlySet<FerretEndCause['kind']> = new Set([
  'tmux_crashed',
  'terminal_gone',
  'signal',
  'agent_crashed',
  'start_failed',
]);

/** Why a held (daemon-origin) launch will not revive a ferret that ended on purpose. */
const ENDED_ON_PURPOSE =
  'this ferret was stopped on purpose or finished its work, so only a deliberate resume revives it';

/** An end somebody chose: the owner's stop, or the ferret's own `signal done`. A crash, a lost terminal and the rest were nobody's choice. */
function endedOnPurpose(record: FerretRecord): boolean {
  return record.state === 'stopped' && (record.cause?.kind === 'stopped' || record.cause?.kind === 'completed');
}

/** Everything the service reaches outside its own memory. The daemon half binds these to kernel ports. */
export interface FerretsPorts {
  /** Resolves once the held ferret records are loaded (a read before then would see no ferret). */
  ready?(): Promise<void>;
  /** Whether the held records have finished loading AND every one was read whole: a synchronous flag, `false` until the load settles (never waits). Unbound: it is. */
  wholeRoster?(): boolean;
  now(): Instant;
  /** A fresh, server-minted ferret id; a request never names one (today's `TimeSessionIdFactory`). */
  newId(): FerretId;
  /**
   * The callsign claim ledger (`names.json`): a start and a rename take their name through it. Unbound, names are
   * checked against the running fleet alone.
   */
  claims?: SessionNameClaims;
  /** Issues the callsign of a session Ferretry starts itself; unbound, none can be issued. */
  systemCallsign?(prefix: SystemCallsignPrefix): Promise<string>;
  /** A name nobody running holds, when the request named none. */
  newName(taken: (name: string) => boolean): string;
  save(record: FerretRecord): Promise<void>;
  saveTokens(entries: readonly TokenEntry[]): Promise<void>;
  /**
   * The ONE per-ferret mutation queue the whole daemon shares (`SessionFiles.serial`): a start, a stop, a resume and a
   * token cut-off run on it, so a lifecycle launching the same ferret is never interleaved with them. Unbound only in a
   * unit fixture, which gets a queue of its own.
   */
  serial?: Pick<SerialExecutor, 'run'>;
  /**
   * The ONE in-memory launch gate the daemon shares (`SessionFiles.launchGate`): every launch this service makes (a start
   * or a resume) is registered in it from before the pane is asked for until the launch has settled, success or failure, so
   * the lifecycle's stop wait and the interrupted-launch reconciler see THIS process's launches. Unbound only in a unit
   * fixture, where nothing is registered.
   */
  launches?: Pick<LaunchGate, 'register'>;
  /**
   * The session document's half of the owner's cut-off (`credentialRevoked`), kept in step with the token directory's:
   * a ferret is cut off when EITHER says so, and a cut-off or a restore is written to BOTH. Unbound only in a unit
   * fixture, where the token directory alone is the fact.
   */
  cutOffMark?: SessionCutOffMark;
  /**
   * Whether the ferret's session document says its last stop was never confirmed (`kill_failed`): its old pane may
   * still be alive, so a resume refuses until a stop succeeds (`restart-guards.ts`). A read that fails rejects, and the
   * resume refuses. Unbound only in a unit fixture, where no document says so.
   */
  stopUnconfirmed?(ferret: FerretId): Promise<boolean>;
  harness(key: HarnessKey): Harness | undefined;
  harnessKeys(): readonly HarnessKey[];
  runner(): Runner | undefined;
  decide(input: StartDecideInput): Promise<HookDecision>;
  /**
   * Which harness and login a runtime starts with (Runtimes' `runtime.start`). Unbound only in a unit fixture; the daemon
   * always binds it, and with no provider it answers a refusal, so a runtime-named start never launches signed out.
   */
  runtimeStart?(runtime: string, harness?: string): Promise<RuntimeStartResolution>;
  /**
   * The machine's default runtime, or `undefined` when it has none (Runtimes' `runtime.start`, `defaultRuntime`). A start
   * that names no runtime, login or harness starts on it. Unbound in a unit fixture: such a start is then as it was.
   */
  defaultRuntime?(): Promise<string | undefined>;
  /**
   * Whether a login named WITHOUT a runtime (`--login`, or the one a stored record holds) may be spent now (Runtimes'
   * `runtime.start`, `login`): switched off or over its budget is refused. Unbound only in a unit fixture.
   */
  loginStart?(login: string, harness?: string): Promise<LoginStartResolution>;
  /**
   * Runs `fire` once after `delayMs` on the kernel clock and returns how to cancel it. It bounds Runtimes' answers
   * ({@link RUNTIME_START_DEADLINE_MS}); unbound only in a unit fixture whose answers settle, where nothing is bounded.
   */
  after?(delayMs: number, fire: () => void): () => void;
  launchParts(): readonly LaunchPartSource[];
  /** The daemon's own `PATH` (asked only when a part prepends and the pane has none of its own), the base a `pane-env` `pathPrepend` is put in front of (r9 B10). Unbound: the system folders. */
  daemonPath?(): string | undefined;
  /** The ONE provider that plans the files a start was given (`start -f`); unbound or none: a start that carries attachments is refused. */
  openingAttachments?(): OpeningAttachmentsSource | undefined;
  /**
   * The ONE provider that stages a past conversation's transcript (`conversation.stage`). None (Conversation off): nothing
   * is staged, and the launch still refuses a conversation the harness proves absent. The daemon always binds it.
   */
  conversationStage?(): ConversationStageSource | undefined;
  sitrepSources(): readonly SitrepLineSource[];
  instructions(): readonly InstructionEntry[];
  /** The folder fenced by the kernel's `work` root, or why not. */
  folder(path: string): Result<FencedPath, string>;
  /**
   * Binds the launch folder's identity where it is first checked (the kernel's `bindDirectory`): what it really is, and
   * whether it lies inside the state home. Unbound, the identity is not carried (a unit fixture); the daemon always binds.
   */
  bindFolder?(path: string): Promise<Result<BoundLaunchFolder, string>>;
  /**
   * The state home a folder is in (the kernel's identity fence: name, link hops, real path), `undefined` when it is in
   * none; it throws when the fence cannot be built. Asked for a start BY A FERRET, on the folder the ferret will really
   * work in (v4 `refuseStateHomeStart`). Unbound: an agent start is refused (fail closed).
   */
  stateHomeHolding?(path: string): Promise<string | undefined>;
  changed(payload: FerretChangedPayload): void;
  /** Ferrets typed into this ferret's pane (a delivery or a queued line landed): the turn watch looks again soon. */
  delivered?(ferret: FerretId): void;
  /** A stop of this ferret is being attempted (`ferret.stopping`), before anything in it can fail. */
  stopping?(ferret: FerretId): void;
  /**
   * Keeps the ferret's last screen (`last-snapshot.txt`, today's `launcher.snapshot`) just before its pane is stopped
   * or replaced: masked, bounded, best effort. It never rejects and never holds a stop past its own bound. Unbound:
   * nothing is kept. `deadPane`: the pane is one the runner proved dead and kept, read through `Runner.deadScreen`
   * (a look never reads a dead pane); the screen goes to the same stored file and nowhere else.
   */
  lastSnapshot?(ferret: FerretId, runner: Runner, handle: RunnerHandle, deadPane?: boolean): Promise<void>;
  /** `ferret.started` (additive, D2 #12): told once a start's record is written, before its launch. */
  started?(payload: FerretStartedPayload): void;
  /** Writes a ferret's `details.json` (its start options and title). */
  saveDetails?(ferret: FerretId, details: FerretDetails): Promise<void>;
  /** A stopped ferret holds no declared wait: ended when the ferret is settled as stopped. */
  endWait?(ferret: FerretId): Promise<void>;
  /**
   * One live writer per harness conversation: every pane this service opens holds its conversation's lease from before the
   * pane exists until the ferret is settled stopped. Unbound (a unit fixture): no pane is leased.
   */
  leases?: FerretLaunchLeases;
  /**
   * What features add to every launch: one declared pane variable each (the question file, the media folder). Unbound (a
   * unit fixture): the list is sealed and empty, so a launch sets none.
   */
  launchSteps?: LaunchSteps;
  /** Appends one event to the ferret's `history.jsonl` (today's journal event shape). */
  history?(ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  /**
   * The real path of a ferret's folder through ITS fenced `work` root (`RootHandle.realPath`); `undefined` when it
   * cannot be resolved. Unbound, no work folder is answered.
   */
  realPath?(ferret: FerretId, folder: string): Promise<string | undefined>;
  /** Where a launch records the switches it handed the pane (`instructions` reads them back). Unbound: none is kept. */
  launchEnvironment?: Pick<LaunchEnvironmentRecord, 'write'>;
  /**
   * Where a launch records the instruction sections it told the pane, by id and fingerprint, so a ferret whose words
   * changed since can be told apart (`outdated`). Unbound, or a write that fails: none is kept and the ferret is never
   * marked out of date — a failed write `forget`s the PREVIOUS launch's record, so a resumed ferret is never compared
   * against what an earlier launch told it.
   */
  launchSections?: {
    write(ferret: FerretId, sections: Readonly<Record<string, string>>): Promise<void>;
    forget(ferret: FerretId): Promise<void>;
  };
  /** `limits.yaml` as it is now (the kernel's config port), read fresh for every agent-control answer. */
  limits?(): LimitsFile | undefined;
  /** Ferret id → the instant the owner pinned it (`agent-pins.json`). */
  pinnedAt?(): Promise<ReadonlyMap<string, string>>;
  /** A ferret's `summary.md` (what its `signal done` wrote), or `undefined` when it has none. */
  summaryText?(ferret: FerretId): Promise<string | undefined>;
  /** The managed worktree registry's durable facts (`ManagedWorktreeService.records()`). Unbound: none. */
  managedWorktrees?(): Promise<readonly ManagedWorktreeSummary[]>;
  /**
   * The moves module's flow (today's move of a session) for one ferret onto `runtime`. Its relaunch is a resume of this service
   * with `replaceLiveTerminal`. Unbound, a move answers `plugin_unavailable`.
   */
  move?(ferret: FerretId, runtime: string, options: MoveOptions): Promise<unknown>;
  /**
   * The ferret's private session folder on the internal `sessions` root and its spawn stamp (U2). Unbound, neither
   * is done and a launch goes on as before.
   */
  session?: FerretSessionPort;
  /**
   * Additive (U4): the prompt state the turn watch recorded in the ferret's state document, already masked inside one
   * `Redaction.read` (`FerretsApi.prompt`). Unbound: nothing is asked.
   */
  promptState?(ferret: FerretId): Promise<FerretPrompt>;
  /**
   * The ferret's stored last screen (`last-snapshot.txt`), MASKED AGAIN with the Vault's values now; `undefined` when
   * there is none, it cannot be read or it cannot be masked. Unbound: no stored screen is answered.
   */
  storedLastSnapshot?(ferret: FerretId): Promise<string | undefined>;
  /**
   * The environment the named login defines for `harness` (`LoginKind.env` of the kind that holds it): literal settings
   * and `${secret:NAME}` references, never a value read from the Vault. An error is a sentence for the owner (no such
   * login, or none can be read) and refuses the start as `login_unavailable`; it never quotes a port error, which can
   * sit beside a credential. Unbound: a login contributes no environment.
   */
  loginEnv?(login: string, harness: HarnessKey): Promise<Result<Readonly<Record<string, string>>, string>>;
  /**
   * What Ferretry sets so the harness is SIGNED IN on the named login (`LoginKind.launchEnvironment`): for a Claude
   * sign-in kept in Ferretry's store, the variable that points Claude at that store. Not what the login file declares
   * (that is {@link loginEnv}). An error is a sentence and refuses the start as `login_unavailable`: no pane starts
   * signed out. Unbound: none.
   */
  loginLaunchEnv?(login: string, harness: HarnessKey): Promise<Result<Readonly<Record<string, string>>, string>>;
  /**
   * The login's sign-in FILE for `harness` (`LoginKind.credential` of the kind that holds it): a kernel-shared credential
   * the harness links into its home (`LaunchSpec.credential`), `none` when the login arrives as environment, or one
   * sentence when the file cannot be used. `unavailable` refuses the start as `login_unavailable` BEFORE a token or a pane
   * exists, so no ferret starts signed out. Asked on every launch (start, resume, revive): a credential is minted per
   * launch and never kept. A port that throws is `unavailable` with a fixed sentence (a Logins error can sit beside a
   * credential and is never quoted). Unbound: no credential.
   */
  loginCredential?(login: string, harness: HarnessKey): Promise<LoginCredentialAnswer>;
  vault: Pick<VaultApi, 'childEnvironment'>;
  asks: Pick<AsksApi, 'open'>;
}

/**
 * Names a login's environment may never set: the harness's own home, and every variable Ferrets owns for the launch.
 * A login defines a provider (a base URL, a token); it never moves the ferret's home or forges its identity.
 */
const LOGIN_ENV_RESERVED: ReadonlySet<string> = new Set(['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
const loginEnvAllowed = (name: string): boolean => !LOGIN_ENV_RESERVED.has(name) && !name.startsWith('FY_');

/**
 * What a launch asks of the ferret's private session files, before the harness is asked for anything.
 *
 * `prepare` makes the ferret's folder on the `sessions` root and narrows an existing one to `0700`; a refusal stops
 * the launch, because the credential and the effect ledger would then land in a folder others can read. `stamp`
 * records WHO CAUSED the ferret (provenance) at a start, and `carry` brings that stamp forward at a resume: a start
 * that cannot record it is refused (a ferret nobody can place is the one the warden shield exists for), while a
 * resume that cannot leaves the stamp already on disk exactly as it was.
 *
 * `carry` is handed the ferret's id and NOTHING the registry says about it: the label and parent a resume restamps
 * from are the ones the ferret's own session document holds (today's `recordRelaunchProvenance`), because a move, a
 * handover or an owner's edit may have changed either there since the record was written.
 *
 * Both answer the label the stamp FORCED onto the ferret (the Warden's, for everything below it: today's
 * `resolveSpawnLabel`), or nothing when none was; the launch carries it to the ferret's record (`withStampedLabel`).
 */
export interface FerretSessionPort {
  prepare(ferret: FerretId): Promise<void>;
  stamp(request: SessionSpawnRequest): Promise<string | undefined | void>;
  carry(ferret: FerretId): Promise<string | undefined | void>;
  /**
   * A start's prompt, written as the ferret's assigned task (`turns/turn-001.md`), after `prepare` and before the stamp,
   * so the ferret's session document counts the turn it already holds. Answers the pointer typed into the new pane once
   * it is up (today's `firstTurnInstruction`). Unbound: no turn document is written and nothing is typed.
   */
  assign?(ferret: FerretId, prompt: string): Promise<string>;
  /**
   * Additive (`start -f`, today's `initialAttachments`): the absolute path of THIS ferret's own `attachments/` folder
   * (one of `FERRET_READABLE_FOLDERS`), where the opening message's files are planned. Names the path only; {@link attach}
   * makes it. Unbound: a start that carries attachments is refused.
   */
  attachmentsFolder?(ferret: FerretId): Promise<string>;
  /**
   * Additive: writes the planned files into the ferret's `attachments/` folder (`0700`, files `0600`) before `assign`; a bare `name`.
   */
  attach?(ferret: FerretId, files: readonly OpeningFile[]): Promise<void>;
  /** Additive: a plugin's made files into the ferret's own `media/` folder (`FY_MEDIA_DIR`), written as {@link attach} writes. */
  media?(ferret: FerretId, files: readonly OpeningFile[]): Promise<void>;
  /**
   * The effect ledger's admission of the ONE first turn a start may type (today's `turn-1` effect, keyed beneath the
   * ferret and fingerprinted by its assigned task), asked by the runner immediately before its first write into the
   * pane: `perform` types it, `settled` is a replay that types nothing, `conflict` or `unsettled` refuses. Bound
   * together with {@link settleFirstTurn}.
   */
  admitFirstTurn?(ferret: FerretId, prompt: string): Promise<SessionEffectAdmission>;
  /** The first turn landed: its effect is settled, so a replay of this start never types it again. */
  settleFirstTurn?(ferret: FerretId, prompt: string): Promise<void>;
  /**
   * A revive's new turn (today's revive, U3): the numbered turn document (`turns/turn-NNN.md`, its author beside it as
   * `turn-NNN.by.json`) written durably, the completion markers a previous turn left (`done`, `needs-help`,
   * `process-exit`) cleared, and the session document's turn counter saved — all BEFORE the relaunch, in today's
   * order. Answers the pointer to type into the new pane, or `undefined` when the revive invents no turn (an
   * interactive ferret resumed with no message). Every attempt takes a fresh number, after the higher of the counter
   * and the documents on disk; only a turn written but never counted, whose words and author are exactly the new ones,
   * is handed over again as it is (proved in place).
   */
  revive?(ferret: FerretId, request: ReviveTurnRequest): Promise<ReviveTurn | undefined>;
  /** The ferret's turn documents, oldest first (`FerretsApi.turns`). */
  turns?(ferret: FerretId, options: { readonly strict: boolean }): Promise<readonly FerretTurnDocument[]>;
  /**
   * Additive (ruling #45, today's `writeQueuedPayload`): writes a message too long to type into a busy pane to THIS
   * ferret's own `channel/queued-<send id>.md` (durably, `0600`, through a temporary file, so an agent that opens it the
   * instant it is told never reads half of it; the same id rewrites the same file) and answers its absolute path. An
   * absent or out-of-grammar `sendId` takes a fresh id. Written before any key, so it is the message's only copy if the
   * transport then goes wrong. Unbound: a long queued message is refused, never typed inline.
   */
  queued?(ferret: FerretId, payload: string, sendId?: string): Promise<string>;
  /**
   * Additive (#45 BG-051, `FerretTurns.write`): the next numbered turn document of THIS ferret, written durably with its
   * author beside it and counted, as a revive's turn is. Answers its number and absolute path.
   */
  writeTurn?(ferret: FerretId, document: string, by?: FerretTurnAuthor): Promise<FerretTurnWritten>;
  /** Additive (#45 BG-051, `FerretTurns.clearMarkers`): clears the completion markers a previous turn left. */
  clearMarkers?(ferret: FerretId): Promise<void>;
  /**
   * The absolute folders of THIS ferret's own session folder its agent may read without asking
   * (`FERRET_READABLE_FOLDERS`, today's `handoffFolders`), handed to the harness as `LaunchSpec.readable`. Unbound:
   * nothing is pre-allowed.
   */
  readable?(ferret: FerretId): Promise<readonly FencedPath[]>;
  /**
   * The ferret's OWN compaction choice recorded in its session config (what the compact-at action edits), or `undefined`
   * when it recorded none or the document is unreadable (the launch then follows the start options, then the login).
   */
  compactAt?(ferret: FerretId): Promise<'auto' | number | undefined>;
  /**
   * The fast mode a (re)launch of this ferret should ask for: the harness's own report when it is newer than the last
   * decision (an owner's live `/fast`), else what the session was launched with (`currentLaunchFast`). `undefined` when
   * neither was ever decided, or the documents are unreadable: the launch then follows the start options.
   */
  launchFast?(ferret: FerretId): Promise<boolean | undefined>;
  /**
   * Records (or, for `undefined`, drops) the ferret's own compaction choice in its session config, keeping every other field
   * and writing atomically. The value reaching it has already been parsed by the service.
   */
  setCompactAt?(ferret: FerretId, value: 'auto' | number | undefined): Promise<void>;
  /**
   * Sets (or, for `false`, takes off) the `stalled` health mark in the ferret's state document under the storage's locked
   * read-modify-write, changing no other field. Answers whether the document changed.
   */
  markStalled?(ferret: FerretId, stalled: boolean): Promise<boolean>;
  /**
   * What the session config says about the runtime this ferret launched as (`agent`, `command[0]`), or `undefined` when
   * the document is missing or is not an object. Rejects when it cannot be read.
   */
  runtimeFacts?(ferret: FerretId): Promise<{ readonly agent?: string; readonly executable?: string } | undefined>;
  /**
   * Re-points the session config's `agent` and `command[0]` from the old runtime to the new one under the storage's
   * locked read-modify-write, keeping every other field. Answers whether the config named the old runtime (and so moved).
   */
  repointRuntime?(ferret: FerretId, rename: FerretRuntimeRename): Promise<boolean>;
  /**
   * Additive (structured questions): THIS ferret's `question-asked.json` as the hook left it (raw text, bounded) and its
   * modification time; `undefined` when absent, unreadable or over the bound. Reads only. Unbound: no question is seen.
   */
  askedQuestion?(ferret: FerretId): Promise<{ readonly payload: string; readonly writtenAt: Instant } | undefined>;
  /**
   * Port-only (not on the contract): whether a ferret started under `parent` would be stamped into the Warden's
   * lineage, decided from the SAME source and rule the start's stamp uses (the session documents, `resolveWardenLineage`),
   * not from the registry summary, which does not carry the stamp. Throws when the documents cannot be read; the caller
   * refuses then. A session port that binds `stamp` must bind this too: `FerretsService.inWardenLineage` rejects (fails
   * closed) when it is absent, never answering `false`. With no session port at all the stamp is not written either, so
   * there is no lineage to ask.
   */
  inWardenLineage?(parent: FerretId): Promise<boolean>;
}

/** One file of a start's opening attachments, as the ferret's `attachments/` folder holds it. */
export interface OpeningFile {
  readonly name: string;
  /** A bare folder name inside `attachments/` that holds the file (a send's per-attachment folder); none for a start's. */
  readonly folder?: string;
  readonly contents: Uint8Array | string;
}

/** The optional tail of a launch (internal, not a contract): a start's opening files, a revive's carried-turn callback. */
/** A launch folder as it was when it was first checked: re-verified as the last step before the harness is asked to start. */
export interface BoundLaunchFolder {
  /** The folder is (or is reached through a link into) the daemon's state home: an agent never starts there. */
  readonly insideStateHome: boolean;
  /** The directory the launch will really be in, every link resolved (what `start.decide` judges WHERE by). */
  readonly realPath?: string | undefined;
  /** Ok while it is still the folder that was checked (same directory, same side of the state home); never throws. */
  verify(): Promise<Result<void, string>>;
}

interface LaunchExtras {
  readonly bound?: BoundLaunchFolder | undefined;
  readonly attached?: readonly OpeningFile[] | undefined;
  readonly carried?: ResumeOptions['onCarried'] | undefined;
  readonly notInWardenTree?: true | undefined;
  readonly fast?: DecidedFast | undefined;
}

/**
 * What the port that admitted a start tells the service about it (internal, not a contract; the route passes none):
 * `notInWardenTree` is set for a start the port let through as outside the Warden's tree, so the spawn stamp can refuse
 * when lineage resolves true after all (the port's parent check and the stamp read the ancestry separately).
 */
export interface StartAdmission {
  readonly notInWardenTree?: true;
}

/** What a revive's turn is made from: the message (none: the mode's default), the ferret's mode and who asked. */
export interface ReviveTurnRequest {
  readonly message?: string;
  readonly mode: 'auto' | 'interactive';
  readonly by?: FerretTurnAuthor;
}

/** A revive's turn, written: its number and the one line typed into the new pane so the agent reads it. */
export interface ReviveTurn {
  readonly turn: number;
  /** The absolute path of the numbered document the agent is pointed at. */
  readonly file: string;
  readonly instruction: string;
}

/** What a launch types into the new pane once it is up: a start's assigned task, or a revive's new turn. */
type PendingTurn =
  | { readonly kind: 'first'; readonly prompt: string; readonly instruction: string }
  | { readonly kind: 'revive'; readonly turn: ReviveTurn };

/** The ledger did not admit the first turn's write; thrown from `beforeWrite`, so the runner types no key. */
class FirstTurnNotPerformed extends Error {}

/**
 * Today's start-failure endings (the session lifecycle's `FIRST_TURN_NEVER_RAN` / `FIRST_TURN_MAYBE_RAN`),
 * word for word: what a start whose pane died while its harness was still starting says of its first turn.
 */
const FIRST_TURN_NEVER_RAN = '; its first turn was never run, so start a new session rather than reviving this one';
const FIRST_TURN_MAYBE_RAN = '; its first turn may not have run, so start a new session rather than reviving this one';
/** The fixed sentence when the harness has no explanation of its own: the pane's own words are never quoted. */
const STARTUP_EXITED = "the ferret's pane exited while its harness was still starting";

/** What `start.failed` says when a detached launch threw: fixed words, never the port's own error text. */
const DETACHED_LAUNCH_FAILED = 'the launch failed after the start was answered';

/** Tells a resume's caller what it decided; a caller's own failure there never changes the resume. */
function tellDecided(options: ServiceResumeOptions | undefined, disposition: 'running' | 'relaunching'): void {
  try {
    options?.decided?.(disposition);
  } catch {
    // The caller's bookkeeping; the resume goes on as decided.
  }
}

/** Tells a resume's caller what was typed for its message; a caller's own failure there never changes the resume. */
function tellCarried(
  carried: ResumeOptions['onCarried'],
  typed: { readonly text: string; readonly turn: number; readonly file: string },
): void {
  try {
    carried?.(typed);
  } catch {
    // The caller's bookkeeping; the pointer is typed all the same.
  }
}

/**
 * Who may ask for a START (`StartRequest.by`), as a closed table checked at run time. A resume is not here: it goes
 * through `resume()`, which asks `start.decide` itself with `by: 'resume'`.
 */
const START_ASKERS = { owner: true, ferret: true, pack: true, board: true, warden: true } as const satisfies Record<
  StartRequest['by'],
  true
>;
const START_ASKER_REFUSAL =
  'a start is asked for by the owner, a ferret, a pack, the board or the Warden; a resume is asked for through resume';

const failed = (code: StartFailure['code'], reason: string): Result<never, StartFailure> =>
  err({ code, reason } as StartFailure);

/**
 * A `start.decide` taker's `no` as a start failure. The taker's `code` is read through Ferrets' own closed list; an
 * unknown one (or none) is a plain `refused`, never passed through.
 */
const refusedBy = (decision: { readonly reason: string; readonly code?: string }): Result<never, StartFailure> => {
  const code = StartRefusalCodeSchema.safeParse(decision.code);
  return failed(code.success ? code.data : 'refused', decision.reason);
};

/** Every code unit is ASCII, so no Unicode normalization form can make two spellings name one folder. */
const isAscii = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
};

/**
 * A home answer Ferrets can judge by spelling: an ASCII absolute path that `posix.normalize` leaves unchanged (no `.`
 * or `..` segment, no doubled `/`), with no trailing `/`, no NUL, and not `/` itself. Checked, never normalized.
 */
const canonicalHome = (home: unknown): home is FencedPath =>
  typeof home === 'string' &&
  home.startsWith('/') &&
  home !== '/' &&
  !home.endsWith('/') &&
  !home.includes('\0') &&
  isAscii(home) &&
  posix.normalize(home) === home;

/** An absolute path with no NUL and no `.`, `..` or empty segment (so no trailing or doubled `/`, and not `/` itself). */
const canonicalFolder = (path: string): boolean =>
  path.startsWith('/') &&
  !path.includes('\0') &&
  path
    .slice(1)
    .split('/')
    .every(segment => segment !== '' && segment !== '.' && segment !== '..');

/** The harness and login a runtime launches with, as Runtimes resolved them. */
interface RuntimeAccount {
  readonly harness: HarnessKey;
  readonly login: string;
}

/** The record signed in on `login`: the one login a launch reads. */
function withLogin(record: FerretRecord, login: string): FerretRecord {
  const { login: _before, ...rest } = record;
  return { ...rest, login };
}

/** A valid ferret id that is never minted (minted ids are `<base36>-<8 hex>`): the harness is asked for its home. */
const PROBE_FERRET = 'home-probe' as FerretId;

/**
 * Where a move relaunches a ferret: everything the move restamps — the runtime it moved onto, the harness that runtime
 * is, the conversation it resumes and the model it runs. The previous login never carries over (a runtime is one
 * credential, and the moves module records none): the target runtime is resolved by the SAME `resolveRuntime` a start
 * uses, which gives it its own login (or refuses before the live pane is released).
 */
export interface ResumeTarget {
  readonly runtime: string;
  readonly harness: HarnessKey;
  /**
   * The harness conversation the relaunch resumes. Absent means a fresh start: the previous conversation belongs to the
   * runtime moved off and is never resumed by the target.
   */
  readonly conversation?: string;
  /** The model the relaunch runs; absent leaves the start options' model as it is. */
  readonly model?: string;
  /**
   * The effort the relaunch runs on, as the move recorded it. Absent means none: the target starts on its own login's
   * setting (effort vocabularies differ between harnesses), never the previous runtime's effort.
   */
  readonly effort?: string;
}

/**
 * The port's resume options plus what only this service's callers set (never on the port): the owner's confirmation a
 * route supplies for a cut-off ferret, and what a MOVE sets — replacing a live pane, and the {@link ResumeTarget} the
 * relaunch is on.
 */
export interface ServiceResumeOptions extends Omit<ResumeOptions, 'actor'> {
  readonly confirmRestore?: () => void;
  /**
   * Replace a LIVE pane instead of keeping the ferret running as it is: the pane is stopped and the ferret relaunched
   * through the ordinary launch (new token, harness home, environment). A move sets it, and so does the Warden's own
   * resume (`ResumeOptions.replaceLiveTerminal`, checked at the port).
   */
  readonly replaceLiveTerminal?: boolean;
  /**
   * The caller delivers the ferret's turn itself (the lifecycle's first turn): the relaunch invents none, writes no
   * revive document and records no `session.resumed` (the lifecycle journals its own events).
   */
  readonly noTurn?: true;
  /**
   * The runtime, login and harness the relaunch is on, written onto the ferret's record before it launches (the record is
   * their one owner), so the start gate and the launch both see the target and never the previous runtime.
   */
  readonly target?: ResumeTarget;
  /**
   * Who asked, for the author recorded beside the revive's turn document (today's `resumeTurnAuthor`): ATTRIBUTION only,
   * never authority. Absent: `unknown`, so the turn names no author.
   */
  readonly actor?: ResumeActor;
  /**
   * The state the ferret must STILL be in, judged under its own queue before anything is decided (today's auto-resume
   * `expectedStatus: 'failed'`): false refuses the resume with nothing written or launched. The auto-resume sets it, so
   * a person who stopped, resumed or archived the ferret in the meantime wins (W2-a).
   */
  readonly expect?: (record: FerretRecord) => boolean;
  /**
   * Called once everything that can refuse WITHOUT launching has passed (the target, the start gate, the launch's own
   * preconditions) and BEFORE the live pane is released or anything is written to the record: a move writes its own
   * documents here, so a refusal leaves them as they were, byte for byte. A throw refuses the resume with the pane unchanged.
   */
  readonly committed?: () => Promise<void>;
}

/** Why a resume that found the ferret no longer in the state its caller expected was refused (W2-a). */
const NO_LONGER_OWED = 'it is no longer owed this resume: it was stopped, resumed or ended by something else first';

/**
 * A relaunch's conversation is proved absent, so a new one was started: fixed text naming BOTH causes, which the daemon
 * cannot tell apart (Claude's `--session-id` is recorded before a word is written, so a pane that died at once left none).
 */
export const CONVERSATION_NOT_FOUND =
  'Your earlier conversation could not be resumed: this machine has no transcript of it (the earlier launch may have ended before anything was said in it, or the ferret was moved from Ferretry 4 and left its old chats behind), so this is a NEW conversation and you remember nothing from before it. Your assigned task is turn-001.md in the same folder as the turn file below: read it and the turns after it before you go on.';

/**
 * What a relaunch typed ahead of its turn when it had NO conversation to resume: the machine never recorded which one was
 * the ferret's (a Codex ferret stopped before its launch provably wrote a rollout, see `withProvedConversation`; a v4
 * ferret whose rollout v4 never found was converted without one), so a new one was started and the agent is told it
 * remembers nothing. Fixed text.
 */
export const CONVERSATION_UNKNOWN =
  'Your earlier conversation was not resumed: this machine never recorded which conversation was yours (a Codex ferret, or one moved from Ferretry 4, can be without one), so this is a NEW conversation and you remember nothing from before it. Your assigned task is turn-001.md in the same folder as the turn file below: read it and the turns after it before you go on.';

/** A launch asked before the features finished registering what it hands the pane (insurance: boot seals right after). */
export const LAUNCH_STEPS_UNSEALED =
  'the ferret was not started: the daemon had not finished setting up what a launch hands a pane';

/** What one launch attempt found that its caller must say (filled in by `launchAttempt`). */
interface LaunchSaid {
  /** Set by a START: a conversation it names that the harness proves absent REFUSES the launch instead of starting a new one. */
  requireConversation?: true;
  /** The conversation the launch was to resume, which the harness proved it does not have: a new one was started. */
  conversationNotFound?: string;
  /** A resume that had no conversation to resume at all (none was ever recorded): a new one was started. */
  conversationUnknown?: true;
  /** The harness's own sentence for a first turn that failed to start ({@link Harness.startFailure}), when it fits the cause. */
  explained?: string;
}

class ResumeRefusal extends Error {
  constructor(readonly failure: StartFailure) {
    super(failure.reason);
  }
}

/** Why a rename was refused: the route answers each with its own status (today's `SessionRenameFailure`). */
export type RenameFailure = 'invalid' | 'not_found' | 'taken' | 'unavailable' | 'failed';

export interface RenameRefusal {
  readonly failure: RenameFailure;
  readonly message: string;
}

/** How each allocation refusal reads as a rename refusal (today's table): a requested name never falls back. */
const RENAME_REFUSALS: Readonly<Record<NameAllocationErrorCode, RenameFailure>> = {
  invalid_callsign: 'invalid',
  callsign_taken: 'taken',
  pool_exhausted: 'failed',
  claim_store_failed: 'unavailable',
  random_source_failed: 'failed',
};

/** The HTTP status and code each rename refusal answers with (today's `REFUSALS` table). */
export const RENAME_HTTP: Readonly<Record<RenameFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  not_found: { status: 404, code: 'not-found' },
  taken: { status: 409, code: 'name_taken' },
  unavailable: { status: 503, code: 'name_unavailable' },
  failed: { status: 500, code: 'session_rename_failed' },
};

export class FerretsService implements FerretsApi {
  /** Today's lifecycle gate: read the current record only after acquiring its key. */
  private readonly serial: Pick<SerialExecutor, 'run'>;
  /**
   * One write queue per ferret for `details.json`: every read-then-write of the details (a title's rename or adoption, a
   * move's options, a carried label) runs on it, so two writers that start together each read what the other left. It is
   * NOT `serial`: a start, stop or resume holds that queue for as long as it runs and some of them write details.
   */
  private readonly detailsQueue = new KeyedSerialExecutor();
  /**
   * The pin-marked summary made from one registry summary, so the same summary with the same pin answers the same
   * object (R501: the fleet read reuses its body while nothing moved). Held weakly by the input summary.
   */
  private readonly marked = new WeakMap<
    FerretSummary,
    { readonly pinnedAt: string; readonly summary: FerretSummary }
  >();

  /** What the members that live outside this file (`runtime-records.ts`, `compact-at.ts`, `turns.ts`, `insights.ts`) read. */
  readonly core: FerretsCore;

  /** The guards the service owns (the conversation lease): never registered by a feature, so they run innermost. */
  private readonly builtInGuards: readonly LaunchGuard[];

  constructor(
    private readonly registry: FerretRegistry,
    private readonly tokens: FerretTokenDirectory,
    private readonly ports: FerretsPorts,
  ) {
    this.serial = ports.serial ?? new KeyedSerialExecutor();
    this.builtInGuards = ports.leases === undefined ? [] : [conversationLeaseGuard(ports.leases)];
    this.core = {
      registry,
      tokens,
      ports,
      serial: this.serial,
      requireMayTouch: (caller, target) => this.requireMayTouch(caller, target),
      requireTokens: () => this.requireTokens(),
      write: async (record, previous, change) => await this.write(record, previous, change),
      saveDetails: async (ferret, details) => await this.saveDetails(ferret, details),
    };
  }

  /**
   * Whether the owner cut `ferret` off: the token directory says so, OR the session document's mark does (so a cut-off
   * written by only one of the two, or by the lifecycle's own revoke, is never read as "not cut off"). A document that
   * cannot be read throws, so the launch refuses rather than guessing.
   */
  private async isCutOff(ferret: FerretId): Promise<boolean> {
    return this.tokens.isCutOff(ferret) || (await this.ports.cutOffMark?.isCutOff(ferret)) === true;
  }

  async get(ferret: FerretId): Promise<FerretSummary | undefined> {
    const summary = this.registry.summary(ferret);
    return summary === undefined ? undefined : this.mark(summary, await this.pins());
  }

  /** The ferret an id or a callsign addresses (the protocol's one rule: `resolveAgentAddress`). */
  async resolve(reference: string): Promise<FerretAddress> {
    await this.ports.ready?.();
    const resolution = resolveAgentAddress(
      reference,
      this.registry.list().map(ferret => ({ id: ferret.id, name: ferret.name, status: ferret.state })),
    );
    if (resolution.kind === 'session') return { kind: 'ferret', id: resolution.id as FerretId };
    if (resolution.kind === 'ambiguous')
      return { kind: 'ambiguous', message: ambiguousAgentAddressMessage(resolution.name, resolution.candidates) };
    return { kind: 'unknown' };
  }

  /**
   * Whether the roster {@link list} answers is the whole truth: the records finished loading AND every one the state lists was
   * read. It NEVER waits: `false` while the load has not settled (a synchronous flag, `FerretsPorts.wholeRoster`), after a load
   * that failed, or with a record left out. `list` itself is unchanged.
   */
  async rosterComplete(): Promise<boolean> {
    return this.ports.wholeRoster?.() ?? true;
  }

  async list(filter?: FerretFilter): Promise<readonly FerretSummary[]> {
    const pins = await this.pins();
    return this.registry.list(filter).map(summary => this.mark(summary, pins));
  }

  /**
   * The folder a ferret was started in, as its REAL path (today's `secrets/sign-in-context.ts` `folderOf`). The
   * recorded folder is already a real path (resolved when the ferret was started), so it must still BE its own real
   * path now: a folder since swapped for a symlink to another folder resolves elsewhere and answers nothing, as does
   * a failed resolve or an unknown ferret.
   */
  async workFolder(ferret: FerretId): Promise<{ readonly folder: string } | undefined> {
    await this.ports.ready?.();
    const record = this.registry.get(ferret);
    if (record === undefined || this.ports.realPath === undefined) return undefined;
    const folder = await this.ports.realPath(ferret, record.folder).catch(() => undefined);
    return folder === undefined || folder !== record.folder ? undefined : { folder };
  }

  /**
   * Today's `pack.result` read of `summary.md` (fyd.ts): a ferret this daemon does not know has none, and neither has
   * one that has not finished — a revived ferret's previous `summary.md` is not its report while it works on.
   */
  async summary(ferret: FerretId): Promise<string | undefined> {
    await this.ports.ready?.();
    if (this.registry.get(ferret)?.state !== 'stopped' || this.ports.summaryText === undefined) return undefined;
    return await this.ports.summaryText(ferret);
  }

  /** The managed worktree registry, durable facts only (the contract's `managedWorktrees()`). */
  async managedWorktrees(): Promise<readonly ManagedWorktreeSummary[]> {
    return (await this.ports.managedWorktrees?.()) ?? [];
  }

  /**
   * Port-only (not a {@link FerretsApi} member): whether a start under `parent` would be stamped into the Warden's
   * lineage, as the session documents say. `false` with the session port unbound (nothing is stamped then). Rejects when
   * the documents cannot be read, and when a bound session port (which stamps) has no way to answer: a stamp written
   * with the lineage check silently off would be the unsafe reading, so the question fails closed.
   */
  async inWardenLineage(parent: FerretId): Promise<boolean> {
    const session = this.ports.session;
    if (session === undefined) return false;
    if (session.inWardenLineage === undefined)
      throw new Error('the session port stamps but cannot say whether a parent is in the Warden’s tree');
    return await session.inWardenLineage(parent);
  }

  mayTouch(caller: FerretId, target: FerretId): boolean {
    return this.registry.mayTouch(caller, target);
  }

  children(ferret: FerretId): readonly FerretId[] {
    return this.registry.children(ferret);
  }

  harnesses(): readonly HarnessKey[] {
    return this.ports.harnessKeys();
  }
  harnessFacts = (key: HarnessKey): Harness['facts'] | undefined => this.ports.harness(key)?.facts;

  /** The harness's own copy of one conversation of the owner's history, in its shared pool (`Harness.importConversation`). */
  async importConversation(
    key: HarnessKey,
    input: ConversationImport,
  ): Promise<Result<void, { readonly reason: string }>> {
    const harness = this.ports.harness(key);
    if (harness === undefined)
      return err({ reason: `The ${key} harness is off, so its conversation cannot be copied.` });
    if (harness.importConversation === undefined)
      return err({ reason: `The ${key} harness keeps no shared copy of a conversation.` });
    try {
      return await harness.importConversation(input);
    } catch {
      return err({ reason: 'The conversation could not be copied.' });
    }
  }

  /** What each harness that answered holds of past conversations (maybe none: its switch is off); one that fails is left out. */
  async historySources(): Promise<
    readonly { readonly harness: HarnessKey; readonly sources: readonly HarnessHistorySource[] }[]
  > {
    const found: { readonly harness: HarnessKey; readonly sources: readonly HarnessHistorySource[] }[] = [];
    for (const key of this.ports.harnessKeys()) {
      const harness = this.ports.harness(key);
      if (harness?.historySources === undefined) continue;
      // A harness that answered with nothing is listed (the index then forgets what it read from it); one that threw is not.
      const sources = await harness.historySources().catch(() => undefined);
      if (sources !== undefined) found.push({ harness: key, sources });
    }
    return found;
  }

  /**
   * The Warden's stalled mark (`FerretsApi.markStalled`), on a ferret that is running only: a stopped or unknown one is a
   * no-op. Answers whether the state document changed; a Ferrets with no session files marks nothing.
   */
  async markStalled(ferret: FerretId, stalled: boolean): Promise<boolean> {
    await this.ports.ready?.();
    const record = this.registry.get(ferret);
    if (record === undefined || record.state === 'stopped') return false;
    return (await this.ports.session?.markStalled?.(ferret, stalled)) ?? false;
  }

  /**
   * `FerretsApi.exclusive`: `work` on the ferret's one mutation queue (the same one a start, stop and resume run on), after the
   * service is ready. Not re-entrant.
   */
  async exclusive<T>(ferret: FerretId, work: () => Promise<T>): Promise<T> {
    await this.ports.ready?.();
    return await this.serial.run(ferret, work);
  }

  /** The handle `ferret.json` keeps while the ferret runs; a stop clears it. */
  async handle(ferret: FerretId): Promise<RunnerHandle | undefined> {
    await this.ports.ready?.();
    return this.registry.get(ferret)?.handle as RunnerHandle | undefined;
  }

  async start(
    request: StartRequest,
    origin: LaunchOrigin,
    admission: StartAdmission = {},
  ): Promise<Result<FerretId, StartFailure>> {
    // `by` is closed by the port's type only, and a plugin's cast is not checked by it. A start that reached
    // `start.decide` as `by: 'resume'` would be answered without Packs' limits, so any other `by` is refused here.
    if (!Object.hasOwn(START_ASKERS, request.by)) return failed('refused', START_ASKER_REFUSAL);
    if (!FerretRecordSchema.shape.harnessConversation.safeParse(request.harnessConversation).success)
      return failed('refused', 'the harness conversation id must contain between 1 and 256 characters');
    if (request.parent !== undefined && this.registry.get(request.parent) === undefined)
      return failed('refused', `no ferret ${request.parent} to be the lead of this one`);
    const id = this.ports.newId();
    const named = await this.takeName(id, request);
    if (!named.ok) return named;
    const giveBack = async () => {
      // A start that never wrote its record gives the reservation back; a written one keeps it, as today.
      if (this.registry.get(id) === undefined) await this.ports.claims?.release(named.value, id).catch(() => undefined);
    };
    try {
      const result = await this.startNamed(id, named.value, request, origin, admission);
      if (!result.ok) await giveBack();
      return result;
    } catch (error) {
      await giveBack();
      throw error;
    }
  }

  /** A system callsign (`learning-000001`) for a helper the daemon starts itself, issued by the bound issuer. */
  async systemCallsign(prefix: SystemCallsignPrefix): Promise<string> {
    await this.ports.ready?.();
    if (this.ports.systemCallsign === undefined) throw new Error('system callsigns are not bound');
    return await this.ports.systemCallsign(prefix);
  }

  private nowMs(): number {
    // The kernel clock answers a valid ISO instant, so the parse is total.
    return Date.parse(this.ports.now());
  }

  /**
   * The callsign a start answers to, taken through the claim ledger BEFORE the record exists (today's
   * `claimStartName`). The registry stays the one owner of "a running ferret holds this name"; the ledger adds the
   * reservations of starts in flight and the window a stopped ferret's name is kept. A REQUESTED name is refused when
   * taken, unless the caller allowed the fallback (a free pool name instead). An AUTOMATIC one never costs the start:
   * when the ledger cannot reserve one (spent pool, unreadable ledger, failed draw) the ferret answers to its own id,
   * as today's unnamed session did; a pool name there would be unreserved and two starts could pick the same one.
   */
  private async takeName(id: FerretId, request: StartRequest): Promise<Result<string, StartFailure>> {
    const requested = request.name?.trim();
    if (requested) {
      const fallback = request.options?.teammateFallback === true;
      // The ledger already holds running names through `nameClaims`; with the fallback on it decides, not this sentence.
      const holder = fallback ? undefined : this.registry.nameHolder(requested);
      if (holder !== undefined) return failed('refused', `the name ${requested} is held by running ferret ${holder}`);
      if (this.ports.claims === undefined) return ok(requested);
      const claim = await claimStartName(
        this.ports.claims,
        id,
        { teammate: requested, ...(fallback ? { teammateFallback: true } : {}) },
        this.nowMs(),
      );
      if (claim.ok) return ok(claim.callsign ?? requested);
      return failed('refused', claim.error.message);
    }
    if (this.ports.claims !== undefined) {
      const claim = await claimStartName(this.ports.claims, id, {}, this.nowMs());
      if (claim.ok && claim.callsign !== undefined) return ok(claim.callsign);
    }
    // The ledger could not reserve: the ferret answers to its id (the unnamed shape `takeName` documents).
    if (this.ports.claims !== undefined) return ok(id);
    const name = this.ports.newName(candidate => this.registry.nameHolder(candidate) !== undefined);
    const holder = this.registry.nameHolder(name);
    if (holder !== undefined) return failed('refused', `the name ${name} is held by running ferret ${holder}`);
    return ok(name);
  }

  /**
   * The opening message a start hands its ferret (today's `composeOpeningMessage`): the prompt itself, or, when the start
   * carried files (`start -f`), the prompt followed by the section the attachment owner words, with the files to write
   * first. Planned BEFORE the first write of a start, so a refusal (no owner for attachments, nothing to attach them to,
   * too many files, a file too large, an unsafe name) leaves nothing behind and gives the callsign back. Attachments
   * with no opening message are refused rather than invented into one: there would be no document for them to live in.
   */
  private async openingFor(
    id: FerretId,
    prompt: string | undefined,
    attachments: StartOptions['initialAttachments'],
  ): Promise<Result<{ readonly prompt: string | undefined; readonly files: readonly OpeningFile[] }, StartFailure>> {
    if (attachments === undefined || attachments.length === 0) return ok({ prompt, files: [] });
    if (prompt === undefined || prompt.trim() === '')
      return failed(
        'refused',
        'attachments belong to an opening message: start with a prompt, or start bare without files',
      );
    const source = this.ports.openingAttachments?.();
    const session = this.ports.session;
    if (source === undefined || session?.attachmentsFolder === undefined || session.attach === undefined)
      return failed('refused', 'this daemon cannot take attachments with a start: the plugin that owns them is off');
    let directory: string;
    try {
      directory = await session.attachmentsFolder(id);
    } catch {
      return failed('failed', "this ferret's attachments folder could not be named, so it was not started");
    }
    const planned = source.plan({ attachments, directory });
    if (!planned.ok) return failed('refused', planned.error);
    const files: OpeningFile[] = [];
    for (const planFile of planned.value.files) {
      // Every planned file lies DIRECTLY in the folder named: a name that climbs out of it, or into a sub-folder, is refused.
      const name = posix.relative(directory, planFile.file);
      if (name === '' || name === '..' || posix.isAbsolute(name) || name.includes('/'))
        return failed('refused', "an attachment would be written outside the ferret's attachments folder");
      files.push({ name, contents: planFile.contents });
    }
    return ok({ prompt: `${prompt}\n${planned.value.section}`, files });
  }

  /**
   * "Continue a past conversation": the transcript a start names is put where the harness finds it (the one
   * `conversation.stage` provider: the existing indexed copy-on-link). Nothing to stage when no conversation is named; a
   * refusal refuses the start with its reason. With NO provider (Conversation is off) nothing is copied and nothing is
   * refused here: a transcript the pool already holds is resumed, and the launch refuses one the harness proves absent
   * (`requireConversation`), so a continue is never quietly a fresh conversation either way (E17).
   * ONLY THE OWNER'S start stages: the transcript comes from the owner's own computer, and a ferret (or a pack, board or
   * warden) must never be able to pull a host conversation into the pool by naming it. Any other asker resumes a
   * conversation the pool already holds, and the launch refuses one it does not.
   */
  private async stageConversation(
    harness: HarnessKey,
    conversation: string | undefined,
    by: StartRequest['by'],
  ): Promise<Result<void, StartFailure>> {
    const source = conversation === undefined || by !== 'owner' ? undefined : this.ports.conversationStage?.();
    if (conversation === undefined || source === undefined) return ok(undefined);
    const staged = await source
      .stage({ harness, conversation })
      .catch(
        (): Awaited<ReturnType<ConversationStageSource['stage']>> =>
          err({ code: 'failed', reason: 'the conversation could not be staged' }),
      );
    return staged.ok
      ? ok(undefined)
      : failed('refused', `${staged.error.reason} The ferret was not started, so nothing was resumed.`);
  }

  /** An agent may start nothing in the state home; a fence that cannot be built refuses too (never a lexical guess). */
  private async stateHomeRefusal(folder: string): Promise<Result<never, StartFailure> | undefined> {
    if (this.ports.stateHomeHolding === undefined) return failed('state_home_unresolved', STATE_HOME_UNRESOLVED);
    try {
      const home = await this.ports.stateHomeHolding(folder);
      return home === undefined ? undefined : failed('state_home', stateHomeSentence(home));
    } catch {
      return failed('state_home_unresolved', STATE_HOME_UNRESOLVED);
    }
  }

  private async startNamed(
    id: FerretId,
    name: string,
    request: StartRequest,
    origin: LaunchOrigin,
    admission: StartAdmission,
  ): Promise<Result<FerretId, StartFailure>> {
    // A work folder replaces the folder the ferret works in; it is canonical and goes through the same folder check.
    const anchor = this.ports.folder(request.folder);
    if (!anchor.ok) return failed('folder', anchor.error);
    if (request.workFolder !== undefined && !canonicalFolder(request.workFolder))
      return failed('folder', 'the work folder must be an absolute path with no . or .. segment');
    const folder = request.workFolder === undefined ? anchor : this.ports.folder(request.workFolder);
    if (!folder.ok) return failed('folder', folder.error);
    if (request.by === 'ferret') {
      const fenced = await this.stateHomeRefusal(folder.value);
      if (fenced !== undefined) return fenced;
    }
    // A start naming a runtime launches with THAT runtime's harness and login (Runtimes answers), resolved before any write:
    // a runtime that cannot serve refuses here, never launched signed out. A start naming no runtime, login or harness is on
    // the machine's DEFAULT runtime (v4 parity) and its login gate; with none, `defaultHarnessKey` picks the harness.
    const runtimeName = request.runtime ?? (await this.defaultRuntimeFor(request));
    const resolved = await this.resolveRuntime(runtimeName, { harness: request.harness, login: request.login });
    if (!resolved.ok) return resolved;
    const login = resolved.value?.login ?? request.login;
    const harnessKey = resolved.value?.harness ?? request.harness ?? defaultHarnessKey(this.ports.harnessKeys());
    if (harnessKey === undefined) return failed('harness_unavailable', 'no harness plugin is on');
    if (this.ports.harness(harnessKey) === undefined)
      return failed('harness_not_installed', `no harness ${harnessKey} is installed on this machine`);
    // The folder's identity is captured HERE, before any taker is asked, and re-verified as the last step before the
    // harness starts: a swap in between (a link into the state home put where the project was) cannot be launched in.
    const bound = await this.bindLaunchFolder(folder.value, origin, birthOf(origin));
    if (!bound.ok) return bound;
    // ONE RULE: a ferret with a parent is never a lead (v4 derived the role from the parent alone). A start that POSTs
    // `role: lead` beside a parent is recorded as a helper, so lead-only instruction sections never reach a sub-ferret.
    const role = request.parent !== undefined ? 'helper' : (request.role ?? 'lead');
    const decision = await this.ports.decide({
      ferret: id,
      name,
      role,
      ...(request.parent === undefined ? {} : { parent: request.parent }),
      ...(request.pack === undefined ? {} : { pack: request.pack }),
      harness: harnessKey,
      ...(runtimeName === undefined ? {} : { runtime: runtimeName }),
      ...(login === undefined ? {} : { login }),
      folder: folder.value,
      ...(bound.value?.realPath === undefined ? {} : { realFolder: bound.value.realPath }),
      by: request.by,
      ...(request.options?.model === undefined ? {} : { model: request.options.model }),
      ...(request.options?.fast === undefined ? {} : { fast: request.options.fast }),
      // A start's own compaction trigger is judged by the taker that knows the model's window; a relaunch asks none.
      ...(request.options?.compactAt === undefined ? {} : { compactAt: request.options.compactAt }),
      ...(request.options?.allowScratch === undefined ? {} : { allowScratch: request.options.allowScratch }),
    });
    // A refusal here is BEFORE the first write (details, record, token): `start()` gives the name back.
    if (!decision.allow) return refusedBy(decision);
    // A start that names a past conversation REQUIRES its transcript: staged before the first write, or refused here.
    const staged = await this.stageConversation(harnessKey, request.harnessConversation, request.by);
    if (!staged.ok) return staged;
    // The opening message with its attachments planned, still before the first write: a refusal leaves nothing behind.
    const opening = await this.openingFor(id, request.prompt, request.options?.initialAttachments);
    if (!opening.ok) return opening;
    if (request.options !== undefined) {
      // The opening attachments are this start's request alone: their bytes are never written into `details.json`.
      const { title, initialAttachments: _attached, allowScratch: _scratch, ...options } = request.options;
      await this.saveDetails(id, {
        ...(Object.keys(options).length === 0 ? {} : { options }),
        ...(title === undefined ? {} : { title, titleSource: 'owner' as const }),
      });
    }
    const at = this.ports.now();
    const record: FerretRecord = {
      format: 1,
      id,
      name,
      ...(request.parent === undefined ? {} : { parent: request.parent }),
      ...(request.pack === undefined ? {} : { pack: request.pack }),
      role,
      harness: harnessKey,
      mode: launchMode(request.options?.mode),
      birth: birthOf(origin),
      runner: 'tmux',
      ...(runtimeName === undefined ? {} : { runtime: runtimeName }),
      ...(login === undefined ? {} : { login }),
      folder: folder.value,
      state: 'starting',
      ...(request.harnessConversation === undefined ? {} : { harnessConversation: request.harnessConversation }),
      createdAt: at,
      stateAt: at,
    };
    // `--detach` answers when the ferret is recorded, not when it has launched: `recorded` settles at that point.
    let recordedOk: () => void = () => undefined;
    let recordedFailed: (error: unknown) => void = () => undefined;
    const recorded = new Promise<void>((resolve, reject) => {
      recordedOk = resolve;
      recordedFailed = reject;
    });
    recorded.catch(() => undefined); // read below only when detached; otherwise the start's own result carries the failure
    const launched = this.serial.run(id, async () => {
      try {
        await this.write(record, undefined, 'started');
        this.ports.started?.({
          ferret: id,
          name,
          role,
          ...(request.parent === undefined ? {} : { parent: request.parent }),
          ...(request.pack === undefined ? {} : { pack: request.pack }),
          folder: folder.value,
          by: request.by,
          ...(request.prompt === undefined || request.prompt === '' ? {} : { brief: request.prompt }),
          ...(request.options?.label === undefined ? {} : { label: request.options.label }),
          ...(request.options?.card === undefined ? {} : { card: request.options.card }),
        });
      } catch (error) {
        recordedFailed(error);
        throw error;
      }
      recordedOk();
      return await this.launch(record, opening.value.prompt, record.harnessConversation, 'start', undefined, {
        attached: opening.value.files,
        bound: bound.value,
        ...(admission.notInWardenTree === true ? { notInWardenTree: true as const } : {}),
      });
    });
    if (request.detach !== true) return await launched;
    // The ferret is recorded and acknowledged; the launch is no caller's to await any more, so its END is handled here:
    // a failed Result and a rejection alike are settled and said (a plain start hands both to its caller).
    // Observed BEFORE any await: when the record cannot be saved, `launched` rejects with the error `recorded` hands the
    // caller below, and a rejection nobody had attached to yet would be unhandled (it can end the daemon).
    launched.catch(() => undefined);
    await recorded;
    void this.finishDetached(id, launched);
    return ok(id);
  }

  /**
   * The end of a launch whose start was acknowledged before it ran (`fy start --detach`). A launch that succeeded needs
   * nothing. A failure, whether it came back as a failed Result or as a thrown error, is never swallowed:
   *  - a ferret the launch already settled `stopped` (`start_failed`) needs only the diagnostic;
   *  - one left `starting` WITHOUT a handle (the stopped-record write itself failed) is settled `stopped` now, on its own
   *    lane, once more;
   *  - one left `starting` WITH a handle keeps it: a pane that could not be stopped is still alive and stays reachable by
   *    `stop`, and it is never marked stopped falsely.
   * Whatever happened, `start.failed` is written to the ferret's history with a closed code and a fixed sentence. A port's
   * own error text is never quoted (it can sit beside a credential).
   */
  private async finishDetached(id: FerretId, launched: Promise<Result<FerretId, StartFailure>>): Promise<void> {
    let failure: { readonly code: StartFailure['code']; readonly reason: string } | undefined;
    try {
      const result = await launched;
      if (!result.ok) failure = result.error;
    } catch {
      failure = { code: 'failed', reason: DETACHED_LAUNCH_FAILED };
    }
    if (failure === undefined) return;
    let settled: boolean;
    try {
      settled = await this.serial.run(id, async () => {
        const current = this.registry.get(id);
        if (current === undefined || current.state !== 'starting') return current?.state === 'stopped';
        if (current.handle !== undefined) return false;
        await this.settle(current, 'stopped', 'stopped', { kind: 'start_failed' });
        return true;
      });
    } catch {
      settled = false;
    }
    try {
      await this.ports.history?.(id, 'start.failed', {
        code: failure.code,
        reason: failure.reason,
        settled,
      });
    } catch {
      // The diagnostic is best effort: a journal that cannot be written must not become an unhandled rejection.
    }
  }

  /** `cause` is why it ended when that is not simply "stopped" (`signal done` says `completed`). */
  async stop(
    ferret: FerretId,
    how: 'polite' | 'now',
    reason?: string,
    cause: FerretEndCause = { kind: 'stopped' },
  ): Promise<void> {
    return await this.serial.run(ferret, () => this.stopHeld(ferret, how, reason, cause));
  }

  /**
   * A stop for a caller that ALREADY HOLDS this ferret's key on the shared queue (the lifecycle's stop does): the same
   * stop {@link stop} makes, minus acquiring the key it would otherwise wait on forever.
   */
  async stopHeld(
    ferret: FerretId,
    how: 'polite' | 'now',
    reason: string | undefined,
    cause: FerretEndCause,
  ): Promise<void> {
    await this.ports.ready?.();
    const record = this.registry.get(ferret);
    if (record === undefined) return;
    if (record.state === 'stopped') return await this.restateStop(record, reason, cause);
    this.ports.stopping?.(ferret);
    const harness = this.ports.harness(record.harness);
    const runner = this.ports.runner();
    if (record.handle !== undefined && (harness === undefined || runner === undefined))
      throw new ApiError(503, 'the harness or runner needed to stop this ferret is unavailable', 'plugin_unavailable');
    if (record.handle !== undefined && harness !== undefined && runner !== undefined) {
      // Its own terminal already gone: the handle the record kept names nobody (or, after a server restart, another
      // ferret's pane), so there is nothing to read or stop.
      if (!(await this.terminalGone(ferret, runner))) {
        await this.keepLastScreen(ferret, runner, record.handle as RunnerHandle);
        await harness.stop(ferret, record.handle as RunnerHandle, runner, how);
      }
    }
    await this.settle(record, 'stopped', 'stopped', cause);
    // Today's `session.stopped` journal event, with the reason the caller gave or the lifecycle default.
    await this.ports.history?.(ferret, 'session.stopped', { reason: reason?.trim() || DEFAULT_STOP_REASON });
    // Once stopped, the conversation its launch provably wrote is recorded (Codex), so the id is on the record before any
    // resume asks for it. Best effort: a stop never fails over it.
    const stopped = this.registry.get(ferret);
    if (stopped !== undefined) await this.withProvedConversation(stopped).catch(() => undefined);
  }

  /**
   * A stop of a ferret that is already stopped. When it ended FAILED ({@link FAILED_ENDS}: the boot pass's
   * `terminal_gone`, a crash, a launch that never ran), this stop is the caller's decision and its cause is written over
   * that one, with today's `session.stopped` event: today's stop of a `failed` session went through and left it
   * `stopped`. Otherwise the auto-resume (during its pass, or from a ledger that outlived a crash mid-pass) and the Warden
   * would still read the death as owed a revive and relaunch the ferret against the stop. Nothing is killed (there is no
   * pane) and no token is left to revoke. An end somebody already decided (`stopped`, `completed`), a clean exit and a
   * stopped record with no cause stand: nothing is written, as today's stop of a `stopped` session changed nothing.
   */
  private async restateStop(record: FerretRecord, reason: string | undefined, cause: FerretEndCause): Promise<void> {
    if (record.cause === undefined || !FAILED_ENDS.has(record.cause.kind)) return;
    await this.settle(record, 'stopped', 'stopped', cause);
    await this.ports.history?.(record.id, 'session.stopped', { reason: reason?.trim() || DEFAULT_STOP_REASON });
  }

  /**
   * Settles a ferret whose terminal the runner PROVED gone (W2-a, today's `TmuxSessionExitObserver.settle` for a `gone`
   * pane): stopped, its end cause `terminal_gone`, and today's `session.exited` journal event after the record is
   * durable. A COMPARE-AND-SET under the ferret's own queue: only while it is still live on exactly `handle`. Anything
   * that moved in between (a stop, a resume that relaunched it on another pane) wins, and false is answered. Nothing is
   * killed or launched: the pane is already gone. Its attachments are released as a stop releases them.
   *
   * `handle` is `undefined` for a live record that holds NO handle (a converted v4 ferret: a handle without proof of its
   * pane is dropped), which has no pane id to compare and could never be settled otherwise: the compare-and-set then
   * lands only while the record STILL holds none. A record that gained a handle meanwhile was relaunched, which wins.
   */
  async settleGone(
    ferret: FerretId,
    handle: string | undefined,
    exited: { readonly from: string; readonly reason: string },
    /**
     * Asked INSIDE the ferret's queue, after the compare-and-set: whether the terminal is STILL proven gone. A pane id is
     * not an incarnation (a private tmux server hands `%0` out again), so a proof taken before the queue was reached can
     * be about a pane a relaunch has since replaced on the very same handle. Absent: the caller's own proof stands (the
     * boot pass, which runs before anything can relaunch).
     */
    stillGone?: () => Promise<boolean>,
  ) {
    return await this.serial.run(ferret, async () => {
      await this.ports.ready?.();
      const record = this.registry.get(ferret);
      if (record === undefined || (record.state !== 'working' && record.state !== 'idle') || record.handle !== handle)
        return false;
      if (stillGone !== undefined && !(await stillGone().catch(() => false))) return false;
      this.ports.stopping?.(ferret);
      await this.settle(record, 'stopped', 'stopped', { kind: 'terminal_gone' });
      await this.ports.history?.(ferret, 'session.exited', {
        reason: exited.reason,
        from: exited.from,
        status: 'failed',
        pane: 'gone',
        exitCode: null,
        signal: null,
      });
      return true;
    });
  }

  /**
   * Settles a ferret whose pane the runner PROVED dead but KEPT (`Runner.exited`: `remain-on-exit`, `pane_dead` 1), the
   * way {@link FerretsService.settleGone} settles a vanished one: a COMPARE-AND-SET under the ferret's own queue, only
   * while it is still live on exactly `handle`, and `stillExited` asked AGAIN inside the queue (a relaunch that ran
   * while this waited may have put a live pane on the same handle). An owner's stop wins by construction: it runs in the
   * same queue and leaves the record `stopped`, so this answers false. The end is {@link endOfExit}: its cause carries
   * the exit status or signal only, and the journal says the same: what the pane showed is kept as the ferret's stored
   * last screen (read back only through `lastSnapshot`), never on either. Nothing is killed or launched; the dead pane is cleared by the next launch. True only when it landed.
   */
  async settleExited(
    ferret: FerretId,
    handle: string,
    exit: RunnerExit,
    from: string,
    stillExited: () => Promise<boolean>,
  ) {
    const end = endOfExit(exit);
    return await this.serial.run(ferret, async () => {
      await this.ports.ready?.();
      const record = this.registry.get(ferret);
      if (record === undefined || (record.state !== 'working' && record.state !== 'idle') || record.handle !== handle)
        return false;
      if (!(await stillExited().catch(() => false))) return false;
      this.ports.stopping?.(ferret);
      // What the pane still shows is kept as the stored last screen (0600, its own folder, masked again on every read),
      // never on the cause or in the journal: both are served to every caller. Best effort and bounded, like a stop's.
      const runner = this.ports.runner();
      if (runner !== undefined) await this.keepLastScreen(ferret, runner, handle as RunnerHandle, true);
      await this.settle(record, 'stopped', 'stopped', end.cause);
      await this.ports.history?.(ferret, 'session.exited', {
        reason: end.reason,
        from,
        status: end.status,
        pane: 'dead',
        exitCode: exit.status ?? null,
        signal: exit.signal ?? null,
      });
      return true;
    });
  }

  /**
   * Whether this ferret's runtime can start NOW, without touching it: its runtime (or the login it names) resolves and may
   * be spent, its harness and runner are on, and its login is usable (signed in, readable). A restart asks this BEFORE it
   * replaces a live pane, so a login that needs sign-in leaves the ferret running and the restart waits for the owner to
   * sign it in, instead of stopping a harness that could not start again. Only reads.
   */
  async startable(ferret: FerretId): Promise<Result<void, StartFailure>> {
    const found = this.registry.get(ferret);
    if (found === undefined) return failed('failed', `no ferret `);
    const account = await this.resolveRuntime(found.runtime, { harness: found.harness }, found.login);
    if (!account.ok) return account;
    const record = account.value === undefined ? found : withLogin(found, account.value.login);
    if (this.ports.harness(record.harness) === undefined) return failed('harness_unavailable', ` is off`);
    if (this.ports.runner() === undefined) return failed('runner_unavailable', 'no runner plugin is on');
    return await this.loginUsable(record);
  }

  /**
   * Revives a stopped ferret. A `message` is recorded with today's `session.resumed` event; delivering it into the
   * conversation is the Conversation's (not wired in this build).
   */
  async resume(
    ferret: FerretId,
    message: string | undefined,
    options: ServiceResumeOptions,
  ): Promise<Result<FerretId, StartFailure>> {
    const confirmRestore = options.confirmRestore;
    return await this.serial.run(ferret, async () => {
      await this.ports.ready?.();
      this.requireTokens();
      try {
        return await resumeUnderCutOff(
          (await this.isCutOff(ferret)) ? 'restore' : 'proceed',
          {
            confirm: confirmRestore,
            unconfirmed: () =>
              new ResumeRefusal({
                code: 'refused',
                reason: 'only a confirmed owner resume may restore a cut-off ferret',
              }),
            // The document's mark is cleared FIRST: one that fails leaves the directory's mark in place (still cut off).
            restore: async () => {
              await this.ports.cutOffMark?.restore(ferret);
              this.tokens.restore(ferret);
              try {
                await this.ports.saveTokens(this.tokens.snapshot());
              } catch (error) {
                this.tokens.cutOff(ferret, this.ports.now());
                await this.ports.saveTokens(this.tokens.snapshot());
                await this.ports.cutOffMark?.cutOff(ferret);
                throw error;
              }
            },
            markAgain: async () => {
              this.tokens.cutOff(ferret, this.ports.now());
              await this.ports.saveTokens(this.tokens.snapshot());
              await this.ports.cutOffMark?.cutOff(ferret);
            },
          },
          async () => {
            const result = await this.resumeHeld(ferret, message, options);
            if (!result.ok) throw new ResumeRefusal(result.error);
            return result;
          },
        );
      } catch (error) {
        if (error instanceof ResumeRefusal) return err(error.failure);
        throw error;
      }
    });
  }

  /**
   * A launch for a caller that ALREADY HOLDS this ferret's key on the shared queue (the lifecycle's start does): the
   * relaunch {@link resume} makes with NO turn (the lifecycle types its own), as the DAEMON (so the fence follows the
   * record's own birth), and with NO restore authority. A ferret the owner cut off is refused here, whatever else says it may launch; only a confirmed
   * owner {@link resume} clears a cut-off. A ferret the registry does not hold is refused, never made.
   */
  async launchHeld(ferret: FerretId): Promise<Result<FerretId, StartFailure>> {
    await this.ports.ready?.();
    this.requireTokens();
    if (await this.isCutOff(ferret))
      return failed('refused', 'the owner cut off this ferret; a confirmed owner resume is required');
    // The launch is the DAEMON's, with no `expect` to judge the ferret's standing, so a stop its owner chose, or an end
    // that finished its work, is checked here: this method never revives what somebody ended on purpose.
    const held = this.registry.get(ferret);
    if (held !== undefined && endedOnPurpose(held)) return failed('refused', ENDED_ON_PURPOSE);
    return await this.resumeHeld(ferret, undefined, { origin: DAEMON_ORIGIN, noTurn: true });
  }

  /**
   * Why a lifecycle start of this ferret must be refused BEFORE it changes anything (its record, its credential, its
   * conversation lease), or `undefined` when {@link launchHeld} will open a pane. The lifecycle asks it ahead of the
   * launch because the launch would otherwise do nothing AFTER the credential was re-issued: a ferret the registry
   * calls live but whose terminal this daemon cannot see (no handle, or the runner is off) answers "already running"
   * without launching, and a hash rotated over a pane that still runs cuts that pane off from Ferretry.
   */
  async heldLaunchRefusal(ferret: FerretId): Promise<string | undefined> {
    await this.ports.ready?.();
    this.requireTokens();
    const held = this.registry.get(ferret);
    if (held === undefined) return `no ferret ${ferret}`;
    if (await this.isCutOff(ferret)) return 'the owner cut off this ferret; a confirmed owner resume is required';
    if (endedOnPurpose(held)) return ENDED_ON_PURPOSE;
    if (held.state !== 'stopped')
      return `ferret ${ferret} is recorded as ${held.state}, so a launch would open no pane and only re-issue its credential: stop it first`;
    if (this.ports.runner() === undefined) return 'no runner plugin is on';
    return undefined;
  }

  /** Why a resume is refused over a stop nobody confirmed (`restart-guards.ts`), or `undefined`: a read that fails refuses too. */
  private async stopUnconfirmedRefusal(ferret: FerretId): Promise<string | undefined> {
    try {
      return (await this.ports.stopUnconfirmed?.(ferret)) === true ? STOP_UNCONFIRMED(ferret) : undefined;
    } catch {
      return `whether the last stop of ${ferret} was confirmed could not be read, so it was not resumed`;
    }
  }

  private async resumeHeld(
    ferret: FerretId,
    message: string | undefined,
    options: ServiceResumeOptions,
  ): Promise<Result<FerretId, StartFailure>> {
    await this.ports.ready?.();
    const found = this.registry.get(ferret);
    if (found === undefined) return failed('refused', `no ferret ${ferret}`);
    if (options.expect !== undefined && !options.expect(found)) return failed('refused', NO_LONGER_OWED);
    const unconfirmed = await this.stopUnconfirmedRefusal(ferret);
    if (unconfirmed !== undefined) return failed('refused', unconfirmed);
    // A plain resume of a running ferret is the send shortcut: nothing to relaunch. Only a move gives it up, and then
    // the live pane is stopped first (never a second pane beside it).
    const replacing = found.state !== 'stopped';
    if (replacing && options.replaceLiveTerminal !== true) {
      tellDecided(options, 'running');
      return ok(ferret);
    }
    // The record the relaunch is on: the move's target when it has one. Everything that can refuse WITHOUT launching —
    // the target itself, the start gate and the launch's own preconditions — is judged on it BEFORE the live pane is
    // stopped, so a refusal leaves a working ferret working with the same handle.
    const target = options.target;
    const retargetedRecord = target === undefined ? found : this.retarget(found, target);
    if (typeof retargetedRecord === 'string') return failed('refused', retargetedRecord);
    // A record that has a runtime is relaunched the way a start by that runtime is: the SAME resolution gives the
    // harness and login (a converted record carries a runtime and no login), so a relaunch is never signed out and a
    // runtime that cannot serve refuses by name BEFORE a working pane is released.
    const account = await this.resolveRuntime(
      retargetedRecord.runtime,
      { harness: retargetedRecord.harness },
      retargetedRecord.login,
    );
    if (!account.ok) return account;
    const onAccount = (record: FerretRecord): FerretRecord =>
      account.value === undefined ? record : withLogin(record, account.value.login);
    const retargeted = onAccount(retargetedRecord);
    // The folder is bound NOW, and an agent's resume gets the verdict an agent's start gets: `verify()` below only proves
    // this binding held, which a folder already swapped into the state home satisfies.
    const bound = await this.bindLaunchFolder(retargeted.folder, options.origin, found.birth);
    if (!bound.ok) return bound;
    const { decision, fast } = await decideResume(
      input => this.ports.decide(input),
      {
        ferret,
        name: retargeted.name,
        role: retargeted.role,
        ...(retargeted.parent === undefined ? {} : { parent: retargeted.parent }),
        ...(retargeted.pack === undefined ? {} : { pack: retargeted.pack }),
        harness: retargeted.harness,
        ...(retargeted.runtime === undefined ? {} : { runtime: retargeted.runtime }),
        ...(retargeted.login === undefined ? {} : { login: retargeted.login }),
        folder: retargeted.folder,
        by: 'resume',
      },
      target === undefined
        ? { live: this.ports.session?.launchFast?.(ferret), recorded: this.registry.detailsOf(ferret)?.options }
        : undefined,
    );
    if (!decision.allow) return refusedBy(decision);
    if (replacing) {
      const ready = await this.launchable(retargeted);
      if (!ready.ok) return ready;
    }
    await options.committed?.();
    const settled = replacing ? await this.releaseLive(found) : found;
    // The target is written with the record's `starting` state, then launched: one owner of the runtime, login and harness.
    const record =
      target === undefined
        ? // A plain resume or Restart of a ferret whose harness names its conversation after launch (Codex): the one its
          // last launch provably wrote is recorded first, so this relaunch resumes it instead of starting anew. A move
          // names its own conversation (or chose a fresh one) and is never given one this way.
          await this.withProvedConversation(onAccount(settled))
        : onAccount(this.retarget(settled, target) as FerretRecord);
    const { cause: _ended, ...revived } = record;
    const starting: FerretRecord = { ...revived, state: 'starting', stateAt: this.ports.now() };
    // The move's model and effort are start options, so details own them (the record keeps the ones it restamped, and the
    // fast mode is dropped as the move drops it). They are written with the target, and a failed launch leaves them with
    // it, as the moves module leaves its own document: a plain resume or Restart relaunches on the target.
    if (target !== undefined) await this.moveOptions(ferret, target);
    await this.write(starting, settled.state, 'state');
    // Said once the relaunch is committed (the record is `starting`), still under this ferret's queue: the message, if
    // any, is the relaunch's own turn from here on.
    tellDecided(options, 'relaunching');
    const author = resumeTurnAuthor(options.actor ?? 'unknown');
    const resumed = await this.launch(
      starting,
      undefined,
      record.harnessConversation,
      'resume',
      options.noTurn === true
        ? undefined
        : {
            ...(message === undefined ? {} : { message }),
            mode: launchMode(starting.mode),
            ...(author === undefined ? {} : { by: author }),
          },
      { carried: options.onCarried, bound: bound.value, fast: { value: fast } },
    );
    if (resumed.ok && options.noTurn !== true) {
      const text = message?.trim();
      await this.ports.history?.(ferret, 'session.resumed', {
        ...(text === undefined || text === '' ? {} : { message: text }),
        ...(options.automatic === true ? { automatic: true } : {}),
        ...(options.replaceLiveTerminal === true ? { replacedLiveTerminal: true } : {}),
      });
    }
    return resumed;
  }

  /**
   * Adopts a live process by its runner handle WITHOUT restarting it (spine D15): the runner confirms the handle is
   * a live ferret pane, and the record takes the handle and `working`. No token is issued: the adopted process keeps
   * the bearer it was started with, which `tokens.json` already holds. It launches nothing, and it may only TIGHTEN the
   * record's birth, never loosen it (the admitted caller's origin is required, no default):
   *  - a birth already on the record is kept, whoever attaches: it is the one fact every later launch is fenced on;
   *  - a record with no birth attached by an AGENT origin is stamped `agent`;
   *  - a record with no birth attached by a PERSON or the DAEMON stays without one, so it stays fenced (a doubt fences).
   */
  async attach(ferret: FerretId, handle: RunnerHandle, origin: LaunchOrigin): Promise<Result<FerretId, StartFailure>> {
    const record = this.registry.get(ferret);
    if (record === undefined) return failed('refused', `no ferret ${ferret}`);
    const runner = this.ports.runner();
    if (runner === undefined) return failed('runner_unavailable', 'no runner plugin is on');
    const adopted = await runner.attach(handle, record.harness);
    if (!adopted.ok) return failed('failed', `the runner would not adopt ${handle}: ${adopted.error}`);
    // A stopped ferret's end cause goes with the stop: the cause is present only while the state is stopped.
    const { cause: _ended, ...revived } = record;
    const working: FerretRecord = {
      ...revived,
      state: 'working',
      handle: adopted.value.handle,
      stateAt: this.ports.now(),
      ...(record.birth === undefined && originIsAgent(origin) ? { birth: birthOf(origin) } : {}),
    };
    await this.write(working, record.state, 'state');
    return ok(ferret);
  }

  async sitrep(ferret: FerretId): Promise<Sitrep | undefined> {
    const summary = this.registry.summary(ferret);
    if (summary === undefined) return undefined;
    const sources = this.ports.sitrepSources();
    const lines = (
      await Promise.all(sources.map(source => source.lines(ferret).catch(() => [] as readonly SitrepLine[])))
    ).flat();
    const blockers = await this.ports.asks
      .open({ ferret } as Parameters<AsksApi['open']>[0])
      .then(open => open.map(ask => ask.id as string))
      .catch(() => [] as string[]);
    return { ferret: summary, lines, blockers };
  }

  /**
   * Renames a ferret (today's `SessionRenameService`, reduced to the record and its details): a new first name, a new
   * task title, or both. A running ferret's name is unique; the title is free-form and kept in `details.json`.
   */
  async rename(
    ferret: FerretId,
    change: { readonly name?: string; readonly title?: string },
  ): Promise<Result<FerretSummary, RenameRefusal>> {
    const record = this.registry.get(ferret);
    if (record === undefined) return err({ failure: 'not_found', message: `no ferret ${ferret}` });
    const name = change.name?.trim();
    let claimed: string | undefined;
    let keep = false;
    if (name !== undefined) {
      const holder = this.registry.nameHolder(name);
      if (holder !== undefined && holder !== ferret)
        return err({ failure: 'taken', message: `the name ${name} is held by running ferret ${holder}` });
      // Renaming to the callsign the ferret already answers to is a no-op claim (it keeps its current name); any other
      // name, a non-canonical one included, goes through the ledger, which refuses an invalid one.
      const canonical = normalizeCallsign(name);
      const unchanged = canonical !== null && canonical === normalizeCallsign(record.name);
      if (unchanged) keep = true;
      else if (this.ports.claims !== undefined) {
        const allocated = await this.ports.claims.allocate({ ownerId: ferret, nowMs: this.nowMs(), requested: name });
        if (!allocated.ok)
          return err({
            failure: RENAME_REFUSALS[allocated.error.code],
            message:
              allocated.error.code === 'callsign_taken'
                ? `another agent on this machine is already called ${displayAgentName(normalizeCallsign(name) ?? name)} — choose a different name`
                : allocated.error.message,
          });
        claimed = allocated.claim.callsign;
      }
    }
    const title = change.title?.trim();
    if (title !== undefined) {
      // An emptied title clears the task (and who chose it); any other one is the owner's and nothing replaces it.
      await this.updateDetails(ferret, current => {
        const { title: _before, titleSource: _by, ...rest } = current ?? {};
        return title === '' ? rest : { ...rest, title, titleSource: 'owner' };
      });
    }
    if (name !== undefined) {
      try {
        await this.write({ ...record, name: claimed ?? (keep ? record.name : name) }, record.state, 'renamed');
      } catch (error) {
        // The reservation was taken for a rename that never landed; holding it would park the name.
        if (claimed !== undefined) await this.ports.claims?.release(claimed, ferret).catch(() => undefined);
        throw error;
      }
    } else this.ports.changed({ ferret, state: record.state, previous: record.state, change: 'renamed' });
    return ok((await this.get(ferret)) as FerretSummary);
  }

  /**
   * Offers a title made from the conversation (`LifecycleApi.adoptTitle`): written only while the ferret's title is not
   * the owner's, and recorded as `auto`. In-process only (no route). Control characters and length are normalized exactly
   * as a title is anywhere else, so what is stored is what `formatSessionTitle` would show.
   */
  async adoptTitle(ferret: FerretId, offered: string): Promise<'adopted' | 'kept'> {
    const record = this.registry.get(ferret);
    if (record === undefined) return 'kept';
    const parsed = FerretTitleSchema.safeParse(formatSessionTitle(offered));
    if (!parsed.success) return 'kept';
    // The owner check and the write are one step on the details queue: a Rename that started first has landed by now.
    const written = await this.updateDetails(ferret, details => {
      if (details?.title !== undefined && (details.titleSource ?? 'owner') === 'owner') return undefined;
      if (parsed.data === details?.title) return undefined;
      return { ...details, title: parsed.data, titleSource: 'auto' };
    });
    if (!written) return 'kept';
    this.ports.changed({ ferret, state: record.state, previous: record.state, change: 'renamed' });
    return 'adopted';
  }

  /** What a ferret may control: `limits.yaml` read fresh (the body is in `insights.ts`). */
  async agentControl(ferret: FerretId): Promise<AgentControl> {
    return await agentControl(this.core, ferret);
  }

  /** What a ferret spent, through its harness; PARTIAL (`undefined`), never zero (`insights.ts`). */
  async turnUsage(ferret: FerretId, since?: Instant): Promise<readonly TurnUsage[] | undefined> {
    return await turnUsage(this.core, ferret, since);
  }

  /** `limits.yaml` as it is in effect now (`insights.ts`). */
  async effectiveLimits(): Promise<LimitsFile> {
    return await effectiveLimits(this.core);
  }

  /** Revokes a ferret's token (owner only at the route; `insights.ts`). */
  async revokeToken(ferret: FerretId): Promise<boolean> {
    return await revokeToken(this.core, ferret);
  }

  /**
   * The record on the move's target: its runtime, harness and conversation (a fresh start has none), with the previous
   * login and conversation gone, or why the target cannot be recorded.
   */
  private retarget(record: FerretRecord, target: ResumeTarget): FerretRecord | string {
    const runtime = FerretRecordSchema.shape.runtime.safeParse(target.runtime);
    const conversation = FerretRecordSchema.shape.harnessConversation.safeParse(target.conversation);
    const startOptions = FerretDetailsSchema.shape.options.unwrap().shape;
    const model = startOptions.model.safeParse(target.model);
    const effort = startOptions.effort.safeParse(target.effort);
    if (
      !runtime.success ||
      !conversation.success ||
      !model.success ||
      !effort.success ||
      this.ports.harness(target.harness) === undefined
    )
      return 'the runtime this ferret is moving onto is not one Ferrets can record';
    const { login: _previous, harnessConversation: _before, ...rest } = record;
    return {
      ...rest,
      harness: target.harness,
      ...(runtime.data === undefined ? {} : { runtime: runtime.data }),
      ...(conversation.data === undefined ? {} : { harnessConversation: conversation.data }),
    };
  }

  /**
   * Writes a move's start options into the ferret's details: the target's model (absent leaves the options' model) and
   * effort together (absent drops the previous runtime's effort), and no fast mode — the move drops it with the effort's
   * launch record, because the target is another login whose model may have none.
   */
  private async moveOptions(ferret: FerretId, target: ResumeTarget): Promise<void> {
    await this.updateDetails(ferret, before => {
      const { effort: _effort, fast: _fast, ...kept } = before?.options ?? {};
      const options = {
        ...kept,
        ...(target.model === undefined ? {} : { model: target.model }),
        ...(target.effort === undefined ? {} : { effort: target.effort }),
      };
      if (JSON.stringify(options) === JSON.stringify(before?.options ?? {})) return undefined;
      return { ...before, options };
    });
  }

  /**
   * What a launch would refuse for without starting anything, asked before a live pane is given up: a cut-off ferret, a
   * harness or runner that is off, a home the harness will not name (or names for another ferret). None of it writes.
   */
  private async launchable(record: FerretRecord): Promise<Result<void, StartFailure>> {
    this.requireTokens();
    if (await this.isCutOff(record.id))
      return failed('refused', 'the owner cut off this ferret; a confirmed owner resume is required');
    const harness = this.ports.harness(record.harness);
    if (harness === undefined) return failed('harness_unavailable', `${record.harness} is off`);
    if (this.ports.runner() === undefined) return failed('runner_unavailable', 'no runner plugin is on');
    const home = await this.home(record, harness);
    if (!home.ok) return home;
    return await this.loginUsable(record);
  }

  /**
   * The login reads a launch makes AFTER a live pane is gone, made first (they only read): a login that cannot be used
   * refuses a relaunch while the old harness still runs, never once it is stopped. Nothing with no login.
   */
  private async loginUsable(record: FerretRecord): Promise<Result<void, StartFailure>> {
    for (const read of [
      async () => await this.loginEnvironment(record),
      async () => await this.loginLaunchEnvironment(record),
      async () => await this.loginCredential(record),
    ]) {
      const answer = await read();
      if (!answer.ok) return failed('login_unavailable', answer.error);
    }
    return ok(undefined);
  }

  /**
   * The record with the conversation its harness PROVES its last launch wrote (`Harness.provedConversation`: Codex names
   * its conversation after launch, so a start records none), written as `harnessConversation` and a `correlated`
   * transcript so the next resume names it. Idempotent: a record that already names one is returned as it is, and so is
   * one whose harness proves nothing (Claude Code names its conversation at launch) or cannot tell (any doubt, an error,
   * an id or a transcript that does not parse). The id is journalled once, as `session.conversation_recorded`.
   */
  private async withProvedConversation(record: FerretRecord): Promise<FerretRecord> {
    if (record.harnessConversation !== undefined) return record;
    const found = await this.ports
      .harness(record.harness)
      ?.provedConversation?.(record.id)
      .catch(() => undefined);
    if (found === undefined) return record;
    const id = FerretRecordSchema.shape.harnessConversation.safeParse(found.id);
    const transcript = TranscriptProvenanceSchema.safeParse({
      v: 1,
      home: found.home,
      harnessSessionId: found.id,
      identity: 'correlated',
      file: found.file,
      resolvedAt: this.ports.now(),
    });
    if (!id.success || id.data === undefined || !transcript.success) return record;
    const recorded: FerretRecord = { ...record, harnessConversation: id.data, transcript: transcript.data };
    await this.write(recorded, record.state, 'state');
    await this.ports
      .history?.(record.id, 'session.conversation_recorded', { conversation: id.data })
      .catch(() => undefined);
    return recorded;
  }

  /**
   * Stops a LIVE ferret's pane so a move can relaunch it (never a second pane beside the first): the same harness stop
   * as `stop`, settled as stopped. Refuses, leaving the ferret as it was, when the harness or runner to stop it is off.
   */
  private async releaseLive(record: FerretRecord): Promise<FerretRecord> {
    this.ports.stopping?.(record.id);
    const harness = this.ports.harness(record.harness);
    const runner = this.ports.runner();
    if (record.handle !== undefined && (harness === undefined || runner === undefined))
      throw new ApiError(
        503,
        'the harness or runner needed to replace this ferret\x27s pane is unavailable',
        'plugin_unavailable',
      );
    if (record.handle !== undefined && harness !== undefined && runner !== undefined) {
      // A record whose own terminal is already gone (a converted v4 ferret's pane id, one from before a server restart)
      // has nothing to stop: its handle can now name ANOTHER ferret's pane, which a stop through it would end.
      if (!(await this.terminalGone(record.id, runner))) {
        await this.keepLastScreen(record.id, runner, record.handle as RunnerHandle);
        await harness.stop(record.id, record.handle as RunnerHandle, runner, 'now');
      }
    }
    // The conversation's lease is HANDED to the ferret, never freed: between this pane's death and the relaunch's claim a
    // terminal's `claude --resume` could otherwise take the conversation and leave two writers (a failed relaunch
    // releases it, as a stop does).
    await this.settle(record, 'stopped', 'stopped', { kind: 'stopped' }, true);
    if (record.harnessConversation !== undefined && this.ports.leases !== undefined)
      await claimConversationLease(this.ports.leases, record.id, record.harnessConversation);
    return this.registry.get(record.id) as FerretRecord;
  }

  /** Whether the runner PROVES this ferret's own terminal is not there. Anything that proves nothing is `false`. */
  private async terminalGone(ferret: FerretId, runner: Runner): Promise<boolean> {
    return (await runner.gone?.(ferret).catch(() => false)) === true;
  }

  /**
   * Today's order: the final frame is captured first, then the pane is stopped (every stop, `signal done`'s completion,
   * a Warden or budget stop and a pane a move replaces all come through here). Best effort: whatever the capture does,
   * the stop goes on.
   */
  private async keepLastScreen(
    ferret: FerretId,
    runner: Runner,
    handle: RunnerHandle,
    deadPane = false,
  ): Promise<void> {
    await this.ports.lastSnapshot?.(ferret, runner, handle, deadPane).catch(() => undefined);
  }

  /** A caller that is a ferret reaches only itself and its helpers (the same rule as stop and resume). */
  private requireMayTouch(caller: FerretId | undefined, target: FerretId): void {
    if (caller !== undefined && !this.registry.mayTouch(caller, target))
      throw new ApiError(403, `a ferret acts only on itself and its helpers, and ${target} is neither`, 'forbidden');
  }

  /** The harness seam: the pane side of message delivery, built in `harness-facade.ts` from what Ferrets holds here. */
  async harness(ferret: FerretId, caller?: FerretId): Promise<FerretHarness | undefined> {
    return await openHarness(this.core, ferret, caller);
  }

  /** A ferret's turn documents, bound to it (`turns.ts`). */
  async turns(ferret: FerretId, caller?: FerretId): Promise<FerretTurns | undefined> {
    return await turns(this.core, ferret, caller);
  }

  /** What the ferret's pane is asking right now (`turns.ts`). */
  async prompt(ferret: FerretId, caller?: FerretId): Promise<FerretPrompt | undefined> {
    return await prompt(this.core, ferret, caller);
  }

  /** A ferret's OWN compaction trigger (`compact-at.ts`). */
  async compactAt(ferret: FerretId, caller?: FerretId): Promise<CompactAt | undefined> {
    return await compactAt(this.core, ferret, caller);
  }

  /** Records a ferret's own compaction trigger (`compact-at.ts`). */
  async setCompactAt(ferret: FerretId, value: unknown, caller?: FerretId): Promise<void> {
    await setCompactAt(this.core, ferret, value, caller);
  }

  /** Every ferret and the runtime it launched as (`runtime-records.ts`). */
  async runtimeRecords(): Promise<readonly FerretRuntimeRecord[]> {
    return await runtimeRecords(this.core);
  }

  /** Re-points every ferret on a renamed runtime (`runtime-records.ts`). */
  async repointRuntime(rename: FerretRuntimeRename): Promise<number> {
    return await repointRuntime(this.core, rename);
  }

  /** The ferret's stored last screen, masked again on this read (`turns.ts`). */
  async lastSnapshot(ferret: FerretId, caller?: FerretId): Promise<string | undefined> {
    return await lastSnapshot(this.core, ferret, caller);
  }

  /** The turn watch recorded a turn change (`turns.ts`). */
  async turnObserved(ferret: FerretId, turn: 'working' | 'your-turn' | 'needs-input'): Promise<void> {
    await turnObserved(this.core, ferret, turn);
  }

  async move(
    ferret: FerretId,
    runtime: string,
    options: MoveOptions,
    caller?: FerretId,
  ): Promise<Result<FerretSummary, MoveFailure>> {
    await this.ports.ready?.();
    if (this.registry.get(ferret) === undefined) return err({ code: 'not_found', reason: `no ferret ${ferret}` });
    this.requireMayTouch(caller, ferret);
    if (this.ports.move === undefined)
      return err({
        code: 'plugin_unavailable',
        reason: 'Moving a ferret is not built yet in this version of Ferretry.',
      });
    try {
      await this.ports.move(ferret, runtime, options);
    } catch (error) {
      if (error instanceof SessionMoveError) return err({ code: error.failure, reason: error.message });
      if (error instanceof ApiError && error.code === 'plugin_unavailable')
        return err({ code: 'plugin_unavailable', reason: error.message });
      throw error;
    }
    // Read back through the same reader every other surface uses.
    return ok((await this.get(ferret)) as FerretSummary);
  }

  private requireTokens(): void {
    if (!this.tokens.isAvailable())
      throw new ApiError(503, 'the ferret credential state cannot be read safely', 'credential_state_unavailable');
  }

  /** The owner's pins; a pin list that cannot be read is "nothing pinned" (the mark is a preference). */
  private async pins(): Promise<ReadonlyMap<string, string>> {
    return (await this.ports.pinnedAt?.().catch(() => undefined)) ?? new Map<string, string>();
  }

  private mark(summary: FerretSummary, pins: ReadonlyMap<string, string>): FerretSummary {
    const pinnedAt = pins.get(summary.id);
    if (pinnedAt === undefined) return summary;
    const known = this.marked.get(summary);
    if (known !== undefined && known.pinnedAt === pinnedAt) return known.summary;
    const marked: FerretSummary = { ...summary, pinnedAt: pinnedAt as Instant };
    this.marked.set(summary, { pinnedAt, summary: marked });
    return marked;
  }

  /** The label the spawn stamp forced is the record's too (`withStampedLabel`); a ferret that already says it is left alone. */
  private async carryLabel(ferret: FerretId, label: string | undefined | void): Promise<void> {
    await this.updateDetails(ferret, current => withStampedLabel(current, label ?? undefined));
  }

  /**
   * One read-modify-write of a ferret's details, on its details queue: `change` sees the details as the writer before it
   * left them and returns what to store, or `undefined` to store nothing. True when something was written.
   */
  private async updateDetails(
    ferret: FerretId,
    change: (current: FerretDetails | undefined) => FerretDetails | undefined,
  ): Promise<boolean> {
    return await this.detailsQueue.run(ferret, async () => {
      const next = change(this.registry.detailsOf(ferret));
      if (next === undefined) return false;
      await this.saveDetails(ferret, next);
      return true;
    });
  }

  private async saveDetails(ferret: FerretId, details: FerretDetails): Promise<void> {
    await this.ports.saveDetails?.(ferret, details);
    this.registry.putDetails(ferret, details);
  }

  /** One launch, registered in the shared launch gate for as long as it runs and released however it ends. */
  private async launch(
    record: FerretRecord,
    prompt: string | undefined,
    conversation: string | undefined,
    kind: 'start' | 'resume',
    revive?: ReviveTurnRequest,
    extras: LaunchExtras = {},
  ): Promise<Result<FerretId, StartFailure>> {
    const registration = this.ports.launches?.register(record.id as unknown as SessionId);
    try {
      return await this.launchUngated(record, prompt, conversation, kind, revive, extras);
    } finally {
      registration?.release();
    }
  }

  private async launchUngated(
    record: FerretRecord,
    prompt: string | undefined,
    conversation: string | undefined,
    kind: 'start' | 'resume',
    revive?: ReviveTurnRequest,
    extras: LaunchExtras = {},
  ): Promise<Result<FerretId, StartFailure>> {
    const { attached = [], carried, notInWardenTree, bound, fast } = extras;
    const created = new Set<RunnerHandle>();
    let runner: Runner | undefined;
    let failure: StartFailure;
    let turn: PendingTurn | undefined;
    // A START that names a conversation is an explicit continue: it never falls back to a fresh conversation.
    const said: LaunchSaid = kind === 'start' ? { requireConversation: true } : {};
    try {
      const session = await this.sessionStep(record, kind, prompt, revive, attached, notInWardenTree);
      if (!session.ok) return await this.abandon(record, session.error.code, session.error.reason);
      turn = session.value;
      runner = this.ports.runner();
      if (runner === undefined) return await this.abandon(record, 'runner_unavailable', 'no runner plugin is on');
      const tracked = new Proxy(runner, {
        get(target, property) {
          if (property === 'start' || property === 'resume')
            return async (...args: Parameters<Runner['resume']>) => {
              const result = property === 'start' ? await target.start(args[0]) : await target.resume(...args);
              if (result.ok) created.add(result.value.handle);
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const result = await this.launchAttempt(record, prompt, conversation, tracked, bound, said, fast);
      // A RESUME with no conversation to resume starts a new one just as a missing one does, and is said the same way: a
      // ferret that silently forgot everything (proof run 8, a converted Codex ferret) is the defect this names.
      if (kind === 'resume' && conversation === undefined) said.conversationUnknown = true;
      if (result.ok && said.conversationNotFound !== undefined)
        // A history that cannot be written never undoes a launch that started (this is inside the launch's cleanup).
        await this.ports
          .history?.(record.id, 'session.conversation_not_found', { conversation: said.conversationNotFound })
          .catch(() => undefined);
      if (result.ok && said.conversationUnknown === true)
        await this.ports
          .history?.(record.id, 'session.conversation_not_found', { unknown: true })
          .catch(() => undefined);
      if (!result.ok) failure = result.error;
      else if (turn === undefined) return result;
      else if (turn.kind === 'revive')
        return await this.deliverTurn(
          record.id,
          runner,
          said.conversationNotFound !== undefined
            ? { ...turn.turn, instruction: `${CONVERSATION_NOT_FOUND} ${turn.turn.instruction}` }
            : said.conversationUnknown === true
              ? { ...turn.turn, instruction: `${CONVERSATION_UNKNOWN} ${turn.turn.instruction}` }
              : turn.turn,
          carried,
        );
      else {
        // Today's `deliverFirstTurn`: a start whose task never arrives is an agent sitting at an idle prompt, so a
        // first turn that does not land fails the start (the pane is stopped and the credential revoked below).
        const first = await this.deliverFirstTurn(record.id, runner, turn, said);
        if (first.ok) return first;
        failure = first.error;
      }
    } catch {
      // Port errors can contain launch environment values: never return their text to a caller.
      failure = { code: 'failed', reason: 'a launch dependency failed before the ferret could start' };
    }
    if (this.tokens.revoke(record.id)) {
      try {
        await this.ports.saveTokens(this.tokens.snapshot());
      } catch {
        // Revocation persistence failing must not bypass process cleanup. Deny credential use and rotation
        // until the state can be loaded safely; recovery still records the stopped process below.
        this.tokens.unavailable();
        failure = { code: 'failed', reason: 'the launch failed and its credential revocation could not be saved' };
      }
    }
    for (const handle of created) {
      try {
        // A handle is only ever tracked through a runner, so one is always here; none is a cleanup that cannot run.
        if (runner === undefined) throw new Error('no runner to stop the failed launch with');
        await runner.stop(handle, 'now', record.id);
      } catch {
        // Keep the handle recoverable by stop; a failed cleanup never claims the process stopped.
        await this.write({ ...record, handle }, record.state, 'state');
        return failed('runner_unavailable', 'the failed launch still has a process that could not be stopped');
      }
    }
    return await this.abandon(record, failure.code, failure.reason, said.explained);
  }

  /**
   * Binds the launch folder, or refuses with a sentence. A FENCED launch never binds a folder inside the state home (it
   * holds this machine's credentials). A launch is fenced when this call's origin is an agent, OR the ferret was first
   * started by an agent, OR its birth is missing: a ferret an agent started stays fenced on every relaunch, whoever
   * triggers it (a person, the boot recovery, the Warden, a restart, a move). The origin AND the stored birth are
   * required: there is no caller, and no record, that is not asked who it acts for.
   * Without the port nothing is carried.
   */
  private async bindLaunchFolder(
    folder: string,
    origin: LaunchOrigin,
    birth: FerretBirth | undefined,
  ): Promise<Result<BoundLaunchFolder | undefined, StartFailure>> {
    if (this.ports.bindFolder === undefined) return ok(undefined);
    const bound = await this.ports.bindFolder(folder).catch(() => err('the launch folder could not be checked'));
    if (!bound.ok) return failed('folder', bound.error);
    if (launchIsFenced(origin, birth) && bound.value.insideStateHome)
      return failed(
        'refused',
        origin.kind === 'agent'
          ? "a ferret never starts a session inside this daemon's state home: choose a project folder"
          : birth === undefined
            ? "this ferret's record does not say who first started it, so it is treated as started by another ferret and never launches inside this daemon's state home: move it to a project folder"
            : "this ferret was first started by another ferret, so it never launches inside this daemon's state home, whoever asks: move it to a project folder",
      );
    return ok(bound.value);
  }

  private async launchAttempt(
    record: FerretRecord,
    prompt: string | undefined,
    conversation: string | undefined,
    runner: Runner,
    bound: BoundLaunchFolder | undefined,
    said: LaunchSaid = {},
    decidedFast?: DecidedFast,
  ): Promise<Result<FerretId, StartFailure>> {
    this.requireTokens();
    if (await this.isCutOff(record.id))
      return failed('refused', 'the owner cut off this ferret; a confirmed owner resume is required');
    const harness = this.ports.harness(record.harness);
    if (harness === undefined) return failed('harness_unavailable', `${record.harness} is off`);
    const home = await this.home(record, harness);
    if (!home.ok) return home;
    // Before a token is issued: a login that cannot be read refuses the start with nothing to undo.
    const login = await this.loginEnvironment(record);
    if (!login.ok) return failed('login_unavailable', login.error);
    const signedIn = await this.loginLaunchEnvironment(record);
    if (!signedIn.ok) return failed('login_unavailable', signedIn.error);
    const credential = await this.loginCredential(record);
    if (!credential.ok) return failed('login_unavailable', credential.error);
    const issued = issueToken(record.id, this.ports.now());
    this.tokens.add(issued.entry);
    await this.ports.saveTokens(this.tokens.snapshot());
    // Today's read allowance for what the ferret is sent (`handoffFolders` → `--allowedTools=Read(…)`): its own session
    // folder's hand-off folders only. One that cannot be named pre-allows nothing (the agent asks), never more.
    const readable = (await this.ports.session?.readable?.(record.id).catch(() => undefined)) ?? [];
    // The ferret's own compaction choice: its session config (a later edit) over what its start asked.
    const ownCompactAt =
      (await this.ports.session?.compactAt?.(record.id).catch(() => undefined)) ??
      this.registry.detailsOf(record.id)?.options?.compactAt;
    // Resolved ONCE (the record's own, else a converted ferret's persisted start option, else `auto`: `launchMode` owns
    // that default): the harness's question tool, the pane's FY_SESSION_MODE and the derived launch switches all read
    // this one fact, so a record with no mode at all is told `auto` and gets the autonomous layer.
    const mode = launchMode(effectiveMode(record, this.registry.detailsOf(record.id)));
    // Fast mode is what the session is ON (the chip's answer): a live `/fast` after the start wins over the start's own.
    const liveFast = await this.ports.session?.launchFast?.(record.id).catch(() => undefined);
    const base: Omit<LaunchSpec, 'parts'> = {
      ferret: record.id,
      name: record.name,
      role: record.role,
      ...(record.parent === undefined ? {} : { parent: record.parent }),
      ...(record.pack === undefined ? {} : { pack: record.pack as PackId }),
      harness: record.harness,
      ...(record.runtime === undefined ? {} : { runtime: record.runtime }),
      ...(record.login === undefined ? {} : { login: record.login }),
      // Set from the login only, never by a launch part: the spec field has no other writer.
      ...(credential.value === undefined ? {} : { credential: credential.value }),
      ...launchOptions(this.registry.detailsOf(record.id)?.options, launchFastOf(decidedFast, liveFast)),
      ...(mode === undefined ? {} : { mode }),
      ...(ownCompactAt === undefined ? {} : { compactAt: ownCompactAt }),
      folder: record.folder as FencedPath,
      home: home.value,
      instructions: applicableInstructions(this.ports.instructions(), record),
      ...(prompt === undefined ? {} : { prompt }),
      ...(conversation === undefined ? {} : { harnessConversation: conversation }),
      ...(readable.length === 0 ? {} : { readable }),
    };
    // A `launch.parts` taker is handed the spec WITHOUT the sign-in credential: only the harness asks the kernel to link it.
    const { credential: _kept, ...forTakers } = base;
    const collected = await this.collectParts(forTakers);
    if (!collected.ok) return collected;
    const parts = collected.value;
    const spec: LaunchSpec = { ...base, parts };
    // Today's order: the home is written (and made private) before the environment is resolved and the runner asked.
    try {
      await harness.prepareHome(spec);
    } catch (error) {
      return failed(
        'failed',
        error instanceof LaunchRefusal
          ? error.message
          : `the ${record.harness} harness could not prepare this ferret's home, so it was not started`,
      );
    }
    const env = await this.environment(
      record.id,
      mode,
      record.role,
      record.parent,
      issued.token,
      parts,
      login.value,
      signedIn.value,
      record.harness,
    );
    if (!env.ok)
      return typeof env.error === 'string'
        ? failed('login_unavailable', env.error)
        : failed('refused', 'OpenCode refuses Anthropic subscription credentials; choose an API key or endpoint login');
    // The LAST step before the harness: the folder is still the one that was checked. Anything else (a swap, a doubt)
    // starts nothing. (Remaining window: the instant between this check and the child's own chdir; docs/secrets.md.)
    // A conversation the harness PROVES it does not have is not resumed: a real harness asked to would fail the launch
    // ("No conversation found…"). A ferret converted from v4 names one whose transcript was left behind (!A516). It
    // starts a new conversation instead, and the caller says so; any doubt resumes as asked.
    const resumable =
      conversation === undefined || harness.hasConversation === undefined
        ? conversation
        : (await harness.hasConversation(spec, conversation).catch(() => undefined)) === false
          ? undefined
          : conversation;
    if (conversation !== undefined && resumable === undefined) {
      if (said.requireConversation === true)
        return failed(
          'refused',
          `the ${record.harness} conversation ${conversation} was not found, so the ferret was not started (only the owner's start copies one in from this computer, and only while the Conversations plugin is on)`,
        );
      said.conversationNotFound = conversation;
    }
    if (bound !== undefined) {
      const held = await bound.verify().catch(() => err('the launch folder could not be checked again'));
      if (!held.ok) return failed('refused', held.error);
    }
    // Before any pane exists: the launch guards are asked (the conversation lease, innermost: a conversation another live
    // writer holds is refused here, never taken over). One snapshot of the list serves this launch's both phases.
    const guards = this.guards();
    const claimed = await beforePane(guards, { record, conversation: resumable });
    if (!claimed.ok) return err(claimed.error);
    let started: Awaited<ReturnType<Harness['start']>>;
    try {
      started =
        resumable === undefined
          ? await harness.start(spec, runner, env.value)
          : await harness.resume(spec, runner, env.value, resumable);
    } catch (error) {
      if (error instanceof LaunchRefusal) return failed('failed', error.message);
      throw error;
    }
    if (!started.ok) {
      // A test-mode daemon refused to reach a real harness: the closed code becomes a sentence a test log can act on.
      if (started.error === 'real_harness') return failed('refused', REAL_HARNESS_REFUSED);
      return runnerRefusal(started.error);
    }
    // The pane is open: its conversation moves onto the pane's own pid. FAIL CLOSED: the caller's cleanup stops the
    // pane (keeping its handle, and so this lease, when it cannot) before anything else can write the conversation.
    const held = await paneOpened(guards, {
      record,
      conversation: started.value.harnessConversation ?? resumable,
      pid: started.value.running.pid,
    });
    if (!held.ok) return err(held.error);
    // What this launch told the ferret, kept for the out-of-date check; only once the harness really started.
    // A write that fails leaves no record at all (never the previous launch's), so nothing is compared against it.
    const told = this.ports.launchSections;
    await told
      ?.write(record.id, sectionDigests(base.instructions))
      .catch(async () => await told.forget(record.id))
      .catch(() => undefined);
    // A new conversation in place of a missing one: the old conversation id and the transcript it pointed at are no
    // longer this ferret's, so neither is kept (a later resume would name the missing one again).
    const { harnessConversation: _missing, transcript: _gone, ...unbound } = record;
    const working: FerretRecord = {
      ...(said.conversationNotFound === undefined ? record : unbound),
      state: 'working',
      handle: started.value.running.handle,
      ...(started.value.harnessConversation === undefined
        ? {}
        : { harnessConversation: started.value.harnessConversation }),
      stateAt: this.ports.now(),
    };
    await this.write(working, record.state, 'state');
    return ok(record.id);
  }

  /**
   * What a launch asks around its pane, outermost first: the guards features registered, then the built-in conversation
   * lease (innermost, so no other check can refuse while the daemon's pid holds the conversation).
   */
  private guards(): readonly LaunchGuard[] {
    return [...(this.ports.launchSteps?.guards() ?? []), ...this.builtInGuards];
  }

  /**
   * What `launch.parts` takers add. A source that is only an addition and fails is skipped; a REQUIRED one (a login's
   * pinned environment) that fails refuses the launch, because skipping it would start the ferret without the protection
   * it exists to give. Nothing is started either way a refusal is returned.
   */
  private async collectParts(base: Omit<LaunchSpec, 'parts'>): Promise<Result<readonly LaunchPart[], StartFailure>> {
    const answers = await Promise.all(
      this.ports.launchParts().map(async source => {
        try {
          return { ok: true as const, parts: await source.parts(base) };
        } catch (error) {
          return { ok: false as const, required: source.required === true, error };
        }
      }),
    );
    const refused = answers.find(answer => !answer.ok && answer.required);
    if (refused !== undefined && !refused.ok)
      return failed(
        'failed',
        refused.error instanceof LaunchRefusal
          ? refused.error.message
          : 'a part of this launch that must be checked could not be read, so the ferret was not started',
      );
    return ok(answers.flatMap(answer => (answer.ok ? answer.parts : [])));
  }

  /**
   * The ferret's private session files and spawn stamp, settled before the harness is asked for anything. The folder
   * is made (or narrowed to `0700`) first, so nothing written for this launch lands in a readable one. Port errors are
   * never quoted: they can sit beside a credential.
   */
  private async sessionStep(
    record: FerretRecord,
    kind: 'start' | 'resume',
    prompt: string | undefined,
    revive: ReviveTurnRequest | undefined,
    attached: readonly OpeningFile[] = [],
    notInWardenTree?: true,
  ): Promise<Result<PendingTurn | undefined, StartFailure>> {
    const session = this.ports.session;
    if (session === undefined) return ok(undefined);
    try {
      await session.prepare(record.id);
    } catch {
      return failed('failed', "the ferret's private session folder could not be made private, so it was not started");
    }
    if (kind === 'start') {
      // The opening attachments are on disk before the task that names them (their folder is the ferret's own, `0700`).
      if (attached.length > 0)
        try {
          if (session.attach === undefined) throw new Error('no attachment writer is bound');
          await session.attach(record.id, attached);
        } catch {
          return failed('failed', "this ferret's attachments could not be written, so it was not started");
        }
      // The assigned task is on disk before the stamp, so the session document counts the turn the ferret holds.
      let first: PendingTurn | undefined;
      if (prompt !== undefined && prompt.trim() !== '' && session.assign !== undefined)
        try {
          first = { kind: 'first', prompt, instruction: await session.assign(record.id, prompt) };
        } catch {
          return failed('failed', "this ferret's assigned task could not be written, so it was not started");
        }
      // A start is the one moment the request IS the fact: what was asked for, before any document says otherwise.
      const label = this.registry.detailsOf(record.id)?.options?.label;
      const request: SessionSpawnRequest = {
        id: record.id,
        ...(label === undefined ? {} : { label }),
        ...(record.parent === undefined ? {} : { parent: record.parent }),
        requestedByHuman: record.parent === undefined,
        ...(notInWardenTree === true ? { notInWardenTree: true as const } : {}),
      };
      let forced: string | undefined | void;
      try {
        forced = await session.stamp(request);
      } catch {
        return failed('failed', 'where this ferret came from could not be recorded, so it was not started');
      }
      // The document is the label's authority; a record that cannot take it now takes it at the next resume.
      await this.carryLabel(record.id, forced).catch(() => undefined);
      return ok(first);
    } else {
      // A resume that cannot bring the stamp forward leaves the one on disk exactly as it was (it only ever strengthens).
      await session
        .carry(record.id)
        .then(async label => await this.carryLabel(record.id, label))
        .catch(() => undefined);
      // The new turn is durable and the old turn's markers are gone BEFORE the relaunch (today's revive): a `done` left
      // by the previous turn would end the new one the moment it started.
      if (revive !== undefined && session.revive !== undefined)
        try {
          const turn = await session.revive(record.id, revive);
          return ok(turn === undefined ? undefined : { kind: 'revive', turn });
        } catch {
          return failed('failed', 'a new turn could not be written for this ferret, so it was not relaunched');
        }
    }
    return ok(undefined);
  }

  /**
   * Types the revive's pointer into the new pane (today's revive delivers after the relaunch). Through the runner's own
   * `deliver`, which acts on the pane for each write itself, so it is NOT wrapped in a second act. The turn was counted
   * before the relaunch (today's order). A pane that was not ready for it is probed again and the pointer typed again,
   * a bounded number of times ({@link typePointer}, today's revive); one that never takes it leaves the ferret running with
   * its turn counted and its document on disk, and the next revive takes the next number. The failure is said, never quoted.
   */
  private async deliverTurn(
    ferret: FerretId,
    runner: Runner,
    turn: ReviveTurn,
    carried: ResumeOptions['onCarried'],
  ): Promise<Result<FerretId, StartFailure>> {
    const handle = this.registry.get(ferret)?.handle as RunnerHandle | undefined;
    try {
      if (handle === undefined) throw new Error('no pane');
      await typePointer(
        runner,
        handle,
        turn.instruction,
        () => this.registry.get(ferret)?.handle === handle,
        ms => this.pause(ms),
        ferret,
      );
      tellCarried(carried, { text: turn.instruction, turn: turn.turn, file: turn.file });
    } catch {
      return failed(
        'failed',
        'the ferret was relaunched, but its new turn could not be typed into its pane; stop and resume it to hand it a turn again',
      );
    }
    return ok(ferret);
  }

  /**
   * Today's `deliverFirstTurn`: the start's pointer to its assigned task is typed into the new pane, for EVERY
   * harness (today put no prompt on any harness's argv), through the runner's own `deliver` (not wrapped in a second
   * act). The effect ledger admits the write at the runner's last step before its first composer write: `perform`
   * types it and is then settled; a `settled` replay aborts before any key and is a success; `conflict` and
   * `unsettled` refuse. Any other failure fails the start, with the harness's own explanation when it has one
   * ({@link startExplained}). A typed first turn is then waited on until the harness has started ({@link settleStartup}).
   * Nothing a port or the pane says is quoted.
   */
  private async deliverFirstTurn(
    ferret: FerretId,
    runner: Runner,
    turn: Extract<PendingTurn, { kind: 'first' }>,
    said: LaunchSaid,
  ): Promise<Result<FerretId, StartFailure>> {
    const session = this.ports.session;
    const admit = session?.admitFirstTurn;
    const handle = this.registry.get(ferret)?.handle as RunnerHandle | undefined;
    const untyped = "the ferret's assigned task could not be typed into its pane, so it was not started";
    const notTyped = failed('failed', untyped);
    if (session === undefined || admit === undefined || session.settleFirstTurn === undefined)
      return failed('failed', "the ferret's first turn has no durable effect record, so it was not started");
    if (handle === undefined) return notTyped;
    let admission: SessionEffectAdmission | undefined;
    try {
      await runner.deliver(
        handle,
        {
          text: turn.instruction,
          beforeWrite: async () => {
            admission = await admit(ferret, turn.prompt);
            // `settled` aborts this delivery at the exact pre-write boundary: a replay, never a second typing.
            if (admission !== 'perform') throw new FirstTurnNotPerformed();
          },
        },
        ferret,
      );
      // A runner that typed without asking first has typed a turn no ledger admitted: refused, never counted.
      if (admission !== 'perform') return notTyped;
      await session.settleFirstTurn(ferret, turn.prompt);
    } catch {
      // Any admission but `perform` threw from `beforeWrite`, so the runner typed no key (it is read from the
      // admission, not the error, which a runner may wrap).
      if (admission === 'settled') return ok(ferret);
      if (admission !== undefined && admission !== 'perform')
        return failed(
          'failed',
          admission === 'conflict'
            ? "the ferret's first-turn record is held for a different task, so it was not started"
            : "the ferret's first turn began but never settled; it was not typed again, so the ferret was not started",
        );
      return failed('failed', (await this.startExplained(ferret, runner, handle, said)) ?? untyped);
    }
    return await this.settleStartup(ferret, runner, handle, said);
  }

  /**
   * Today's `settleStartup`: waits, boundedly, for the harness to finish its own startup once its first turn is in.
   *
   * Delivery is not startup — Codex parks a first turn until its account check answers — so a pane that dies in that
   * window fails THIS start (its pane stopped and its credential revoked by the launch's cleanup) with the harness's
   * own explanation when it has one, rather than reporting a working ferret whose task never ran. A wait that runs out
   * its bound is not a failure. The first turn stays settled, as today: a replay still types nothing. A parked Codex
   * never ran it, and reviving would resume a conversation that was never given its assignment; a pane that died
   * before any park was seen may have run it, so that is not claimed. Nothing the runner or the pane says is quoted.
   */
  private async settleStartup(
    ferret: FerretId,
    runner: Runner,
    handle: RunnerHandle,
    said: LaunchSaid,
  ): Promise<Result<FerretId, StartFailure>> {
    if (runner.settled === undefined) return ok(ferret);
    try {
      await runner.settled(handle, ferret);
    } catch (error) {
      const ran = diedParked(error) ? FIRST_TURN_NEVER_RAN : FIRST_TURN_MAYBE_RAN;
      const why = (await this.startExplained(ferret, runner, handle, said)) ?? STARTUP_EXITED;
      return failed('failed', `${why}${ran}`);
    }
    return ok(ferret);
  }

  /**
   * The harness's own sentence for a start that failed at its first turn (today's `RuntimeSupervisedLauncher`), read
   * off what the pane last showed; `undefined` when the harness has none, cannot be asked or does not recognise the
   * screen. The screen goes to the harness only and is dropped here: only the harness's fixed sentence is kept, and
   * it is also put on `said` (when it fits the cause) so the stopped record can say it.
   */
  private async startExplained(
    ferret: FerretId,
    runner: Runner,
    handle: RunnerHandle,
    said: LaunchSaid,
  ): Promise<string | undefined> {
    const key = this.registry.get(ferret)?.harness;
    const harness = key === undefined ? undefined : this.ports.harness(key);
    if (harness?.startFailure === undefined || runner.lastScreen === undefined) return undefined;
    try {
      const sentence = harness.startFailure(await runner.lastScreen(handle, ferret));
      if (typeof sentence !== 'string' || sentence === '') return undefined;
      if (sentence.length <= START_EXPLAINED_MAX) said.explained = sentence;
      return sentence;
    } catch {
      return undefined;
    }
  }

  /**
   * The ferret's home, as its harness names it (`Harness.homeFor`): Ferrets never builds a home path. Refused, before
   * any token is issued or file written, when the harness throws, answers a path that is not canonical and absolute
   * (relative, NUL, `/` itself, a trailing or doubled `/`, a `.` or `..` segment), or answers a home another harness
   * names for this ferret or this harness names for another ferret (equal, or one inside the other) — a shared home
   * would let one ferret read or rewrite another's sign-in and transcript. The overlap test compares spellings (ASCII
   * lowercase forms, so a case-insensitive filesystem cannot make two homes one), so only a canonical answer can be
   * judged by it; anything else — this ferret's own, or another harness's or ferret's — is refused rather than
   * normalized (no path building). The first ferret on a harness is also checked against that harness's answer for a
   * fixed id that is never minted, so a harness cannot name its whole agent-homes folder as one ferret's home.
   */
  private async home(record: FerretRecord, harness: Harness): Promise<Result<FencedPath, StartFailure>> {
    const unnamed = `the ${record.harness} harness did not name a home of its own for this ferret, so it was not started`;
    const home = await harness.homeFor(record.id).catch(() => undefined);
    if (!canonicalHome(home)) return failed('harness_unavailable', unnamed);
    const mine = home.toLowerCase();
    /** Another answer that cannot be judged (it threw, or is not canonical) counts as an overlap: fail closed. */
    const overlaps = (other: unknown): boolean => {
      if (!canonicalHome(other)) return true;
      const theirs = other.toLowerCase();
      return theirs === mine || theirs.startsWith(`${mine}/`) || mine.startsWith(`${theirs}/`);
    };
    /** A harness this daemon does not have cannot name a home here, so it is skipped; any other answer is judged. */
    const clashes = async (key: HarnessKey, ferret: FerretId): Promise<boolean> => {
      const other = this.ports.harness(key);
      if (other === undefined) return false;
      return overlaps(await other.homeFor(ferret).catch(() => undefined));
    };
    for (const key of this.ports.harnessKeys())
      if (key !== record.harness && (await clashes(key, record.id)))
        return failed(
          'refused',
          `the ${record.harness} harness named a home that the ${key} harness also names for this ferret, or the ${key} harness gave no usable home for it, so it was not started`,
        );
    let companion = false;
    for (const other of this.registry.list()) {
      if (other.id === record.id) continue;
      if (other.harness === record.harness) companion = true;
      if (await clashes(other.harness, other.id))
        return failed(
          'refused',
          `the ${record.harness} harness named a home that ferret ${other.id} also has, or its harness gave no usable home for it, so it was not started`,
        );
    }
    if (!companion && record.id !== PROBE_FERRET && (await clashes(record.harness, PROBE_FERRET)))
      return failed(
        'refused',
        `the ${record.harness} harness named a home that holds the homes of other ferrets, so it was not started`,
      );
    return ok(home);
  }

  /** Waits `ms` on the kernel clock; resolves at once where no clock is bound (a unit fixture). */
  private pause(ms: number): Promise<void> {
    const after = this.ports.after;
    return after === undefined ? Promise.resolve() : new Promise(resolve => void after(ms, resolve));
  }

  /**
   * `answer`, or `late` when it has not settled within {@link RUNTIME_START_DEADLINE_MS}. A late answer is dropped (the
   * caller has already refused, so nothing launches on it) and the wait ends, so a serial queue held across it is released.
   */
  private async withinDeadline<T>(answer: Promise<T>, late: T): Promise<T> {
    const after = this.ports.after;
    if (after === undefined) return await answer;
    let cancel: () => void = () => {};
    const expired = new Promise<T>(resolve => {
      cancel = after(RUNTIME_START_DEADLINE_MS, () => {
        resolve(late);
      });
    });
    try {
      return await Promise.race([answer, expired]);
    } finally {
      cancel();
    }
  }

  /** The machine's default runtime when this start chose nothing of its own (no runtime, login or harness), else none. */
  private async defaultRuntimeFor(request: StartRequest): Promise<string | undefined> {
    if (request.login !== undefined || request.harness !== undefined || this.ports.defaultRuntime === undefined)
      return undefined;
    return await this.withinDeadline(
      this.ports.defaultRuntime().catch(() => undefined),
      undefined,
    );
  }

  /**
   * The ONE resolution of a runtime into the harness and login a launch spends, used by a start AND by every relaunch of a
   * stored record (resume, restart, automatic resume, a move's target). The runtime IS the account (v4 parity): it names
   * its harness and its login, and Runtimes answers (via `ports.runtimeStart`). `undefined` when no runtime is named, or
   * in a unit fixture with no Runtimes bound: the caller's own fields stand.
   *
   * What the caller asked for may only agree with the runtime: a harness that is not the runtime's, or an explicit login
   * that is not the runtime's login, is refused in one plain sentence (a disabled or other login can never be spent
   * through a runtime). A runtime that cannot serve (unknown, off, login missing or needing sign-in, no provider) is a
   * plain refusal too, never a signed-out launch.
   */
  private async resolveRuntime(
    runtime: string | undefined,
    asked: { readonly harness?: HarnessKey | undefined; readonly login?: string | undefined },
    stored?: string,
  ): Promise<Result<RuntimeAccount | undefined, StartFailure>> {
    if (runtime === undefined) {
      // No runtime: the login the caller named (or the one the stored record holds) is spent as it is, but it is the SAME
      // check of whether it may be spent at all, so a login switched off or over its budget is refused on this path too.
      const direct = asked.login ?? stored;
      if (direct !== undefined && this.ports.loginStart !== undefined) {
        const spendable = await this.withinDeadline(
          this.ports.loginStart(direct, asked.harness ?? defaultHarnessKey(this.ports.harnessKeys())).catch(
            (): LoginStartResolution => ({
              ok: false,
              sentence: `login ${direct} could not be checked, so the ferret was not started`,
            }),
          ),
          { ok: false, sentence: `could not check login ${direct} in time; try again` },
        );
        if (!spendable.ok) return failed('refused', spendable.sentence);
      }
      return ok(undefined);
    }
    if (this.ports.runtimeStart === undefined) return ok(undefined);
    const answer = await this.withinDeadline(
      this.ports.runtimeStart(runtime, asked.harness).catch(
        (): RuntimeStartResolution => ({
          ok: false,
          sentence: `runtime ${runtime} could not be checked, so the ferret was not started`,
        }),
      ),
      { ok: false, sentence: `could not check runtime ${runtime} in time; try again` },
    );
    if (!answer.ok) return failed('refused', answer.sentence);
    if (asked.harness !== undefined && asked.harness !== answer.harness)
      return failed(
        'refused',
        `runtime ${runtime} runs the ${answer.harness} harness, not ${asked.harness}, so the ferret was not started`,
      );
    if (asked.login !== undefined && asked.login !== answer.login)
      return failed(
        'refused',
        `runtime ${runtime} signs in with its own login, not ${asked.login}, so the ferret was not started`,
      );
    return accountOf(answer, stored, reason => failed('refused', reason));
  }

  /** The ferret's login's environment for its harness, minus the names a login may never set. Empty with no login. */
  private async loginEnvironment(record: FerretRecord): Promise<Result<Readonly<Record<string, string>>, string>> {
    if (record.login === undefined || this.ports.loginEnv === undefined) return ok({});
    const found = await this.ports
      .loginEnv(record.login, record.harness)
      .catch(() => err(`the login ${record.login} could not be read, so the ferret was not started`));
    if (!found.ok) return found;
    return ok(Object.fromEntries(Object.entries(found.value).filter(([name]) => loginEnvAllowed(name))));
  }

  /** The login's sign-in file for the ferret's harness, shared by the kernel, or why none can be used. None with no login. */
  private async loginCredential(record: FerretRecord): Promise<Result<SharedCredential | undefined, string>> {
    if (record.login === undefined || this.ports.loginCredential === undefined) return ok(undefined);
    const answer = await this.ports.loginCredential(record.login, record.harness).catch(
      (): LoginCredentialAnswer => ({
        kind: 'unavailable',
        sentence: `the login ${record.login} could not be checked, so the ferret was not started`,
      }),
    );
    if (answer.kind === 'unavailable') return err(answer.sentence);
    return ok(answer.kind === 'file' ? answer.credential : undefined);
  }

  /** What Ferretry sets so the ferret is signed in on its login (the Claude store variable), minus the reserved names. */
  private async loginLaunchEnvironment(
    record: FerretRecord,
  ): Promise<Result<Readonly<Record<string, string>>, string>> {
    if (record.login === undefined || this.ports.loginLaunchEnv === undefined) return ok({});
    const found = await this.ports
      .loginLaunchEnv(record.login, record.harness)
      .catch(() => err(`the login ${record.login} could not be read, so the ferret was not started`));
    if (!found.ok) return found;
    return ok(Object.fromEntries(Object.entries(found.value).filter(([name]) => loginEnvAllowed(name))));
  }

  private async environment(
    ferret: FerretId,
    mode: FerretRecord['mode'],
    role: FerretRecord['role'],
    parent: FerretRecord['parent'],
    token: string,
    parts: readonly LaunchPart[],
    login: Readonly<Record<string, string>>,
    signedIn: Readonly<Record<string, string>>,
    harness: HarnessKey,
  ): Promise<Result<ChildEnvironment, string | { readonly kind: 'subscription_login' }>> {
    // Login, mode defaults, then owner parts; FY_* switches keep final precedence.
    const env: Record<string, string> = { ...login, ...modeSwitchDefaults(mode) };
    for (const part of parts) if (part.kind === 'env' || part.kind === 'shell') Object.assign(env, part.env);
    // What a plugin gives THIS pane (the Git account's ssh-agent and git settings): judged by name, refused naming the plugin.
    // A `pathPrepend` goes in front of the PATH this pane ALREADY has (a login's, or a shell part's: the devshell's tools), and only
    // when it has none, in front of the daemon's own.
    const contributed = paneEnvironment(parts, () => {
      const own = env['PATH'];
      return own === undefined || own === '' ? this.ports.daemonPath?.() : own;
    });
    if (!contributed.ok) return err(contributed.error);
    // Git applies GIT_CONFIG_PARAMETERS last, in order: a part's entries are APPENDED to the pane's own, never replacing them.
    const priorParameters = env['GIT_CONFIG_PARAMETERS'];
    Object.assign(env, contributed.value);
    if (
      priorParameters !== undefined &&
      priorParameters !== '' &&
      contributed.value['GIT_CONFIG_PARAMETERS'] !== undefined
    )
      env['GIT_CONFIG_PARAMETERS'] = `${priorParameters} ${contributed.value['GIT_CONFIG_PARAMETERS']}`;
    // Mode comes from the record, after parts. Clear any part's value before applying the wrapper's auto-only switch.
    delete env['FY_SESSION_MODE'];
    Object.assign(env, sessionModeSwitch(mode));
    Object.assign(env, subFerretSwitch(role, parent));
    // Parts cannot move the sign-in store. The kernel inherits only PATH and HOME.
    Object.assign(env, signedIn);
    env[FERRET_ID_VARIABLE] = ferret;
    env[FERRET_TOKEN_VARIABLE] = token;
    // Feature pane variables are last; refuse an incompletely registered launch.
    const steps = this.ports.launchSteps;
    if (steps !== undefined && !steps.sealed()) return err(LAUNCH_STEPS_UNSEALED);
    Object.assign(env, await paneVariables(steps?.stores() ?? [], ferret));
    const resolved = await this.ports.vault.childEnvironment(ferret, env, harness);
    if (!resolved.ok)
      return err(
        resolved.error.code === 'subscription_login'
          ? { kind: 'subscription_login' as const }
          : `unknown secrets: ${resolved.error.unknown.join(', ')}`,
      );
    // Persist only switches for `instructions`, after refusal is impossible. A record failure never fails the launch.
    await this.ports.launchEnvironment?.write(ferret, recordedSwitches(env)).catch(() => undefined);
    return ok(resolved.value);
  }

  private async abandon(
    record: FerretRecord,
    code: StartFailure['code'],
    reason: string,
    explained?: string,
  ): Promise<Result<FerretId, StartFailure>> {
    await this.settle(record, 'stopped', 'stopped', {
      kind: 'start_failed',
      ...(explained === undefined ? {} : { explained }),
    });
    return failed(code, reason);
  }

  private async settle(
    record: FerretRecord,
    state: FerretState,
    change: FerretChangedPayload['change'],
    cause?: FerretEndCause,
    keepLease = false,
  ): Promise<void> {
    if (this.tokens.revoke(record.id)) await this.ports.saveTokens(this.tokens.snapshot());
    const { handle: _handle, cause: _before, ...rest } = record;
    await this.write(
      { ...rest, state, stateAt: this.ports.now(), ...(state === 'stopped' && cause !== undefined ? { cause } : {}) },
      record.state,
      change,
    );
    if (state === 'stopped') {
      await this.ports.endWait?.(record.id).catch(() => undefined);
      // A lease that cannot be freed only delays a terminal claim: the daemon already reads a stopped session's as stale.
      if (!keepLease) await released(this.guards(), record.id);
    }
  }

  private async write(
    record: FerretRecord,
    previous: FerretState | undefined,
    change: FerretChangedPayload['change'],
  ): Promise<void> {
    await this.ports.save(record);
    this.registry.put(record);
    this.ports.changed({
      ferret: record.id,
      state: record.state,
      ...(previous === undefined ? {} : { previous }),
      change,
    });
  }
}
