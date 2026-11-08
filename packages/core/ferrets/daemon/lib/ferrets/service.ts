import { posix } from 'node:path';
import type { AsksApi } from '@ferretry/core-asks/contract';
import type { ChildEnvironment, VaultApi } from '@ferretry/core-vault/contract';
import type { FencedPath, HookDecision, InstructionEntry } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { err, type Instant, ok, type Result } from '@ferretry/std';
import { KeyedSerialExecutor } from './serial.ts';
import type {
  DeliveryOutcome,
  FerretChangedPayload,
  FerretEndCause,
  FerretHarness,
  FerretTurnAuthor,
  FerretTurnDocument,
  FerretTurns,
  HarnessDeliveryFailure,
  HarnessInterrupted,
  HarnessRefusal,
  RunnerDeliveryFailure,
  MoveFailure,
  MoveOptions,
  ResumeOptions,
  RunnerDelivery,
  TranscriptReader,
  FerretStartedPayload,
  FerretId,
  FerretRecord,
  FerretsApi,
  FerretState,
  FerretSummary,
  Harness,
  HarnessKey,
  LaunchPart,
  LaunchPartSource,
  LaunchSpec,
  ManagedWorktreeSummary,
  PackId,
  QueueOutcome,
  Runner,
  RunnerHandle,
  Sitrep,
  SitrepLine,
  SitrepLineSource,
  StartDecideInput,
  StartFailure,
  StartRequest,
} from '../../../contract/index.ts';
import { claimStartName, displayAgentName, type SessionNameClaims } from '../names/session-names.ts';
import { normalizeCallsign } from '../names/policy.ts';
import type { NameAllocationErrorCode } from '../names/types.ts';
import type { SystemCallsignPrefix } from '../protocol/system-callsigns.ts';
import {
  diedParked,
  FerretDetailsSchema,
  FerretRecordSchema,
  HARNESS_KEYS,
  REAL_HARNESS_REFUSED,
  runnerDeliveryFailure,
  StartRefusalCodeSchema,
  type FerretDetails,
} from '../../../contract/index.ts';
import type { FerretRegistry, FerretFilter } from '../registry/registry.ts';
import { resumeUnderCutOff } from '../session/resume/cut-off.ts';
import { resumeTurnAuthor } from '../session/resume/policy.ts';
import type { ResumeActor } from '../session/resume/types.ts';
import type { SessionEffectAdmission } from '../session/effects/types.ts';
import { SessionMoveError } from '../runtime/mounts/session-move.ts';
import {
  type AgentControl,
  effectiveAgentControl,
  type LimitsFile,
  NO_AGENT_CONTROL,
} from '../../../contract/index.ts';
import { type FerretTokenDirectory, issueToken, type TokenEntry } from '../tokens/tokens.ts';
import type { SessionSpawnRequest } from '../session/provenance/types.ts';
import { type LaunchEnvironmentRecord, recordedSwitches } from '../agent-control/launch-environment.ts';

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

/** The reason a stop records when its caller gave none (today's lifecycle `defaultStopReason`). */
const DEFAULT_STOP_REASON = 'stopped by client';

/** Everything the service reaches outside its own memory. The daemon half binds these to kernel ports. */
export interface FerretsPorts {
  /** Resolves once the held ferret records are loaded (a read before then would see no ferret). */
  ready?(): Promise<void>;
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
  harness(key: HarnessKey): Harness | undefined;
  harnessKeys(): readonly HarnessKey[];
  runner(): Runner | undefined;
  decide(input: StartDecideInput): Promise<HookDecision>;
  launchParts(): readonly LaunchPartSource[];
  sitrepSources(): readonly SitrepLineSource[];
  instructions(): readonly InstructionEntry[];
  /** The folder fenced by the kernel's `work` root, or why not. */
  folder(path: string): Result<FencedPath, string>;
  changed(payload: FerretChangedPayload): void;
  /** A stop of this ferret is being attempted (`ferret.stopping`), before anything in it can fail. */
  stopping?(ferret: FerretId): void;
  /** `ferret.started` (additive, D2 #12): told once a start's record is written, before its launch. */
  started?(payload: FerretStartedPayload): void;
  /** Writes a ferret's `details.json` (its start options and title). */
  saveDetails?(ferret: FerretId, details: FerretDetails): Promise<void>;
  /** A stopped ferret holds no declared wait: ended when the ferret is settled as stopped. */
  endWait?(ferret: FerretId): Promise<void>;
  /** Appends one event to the ferret's `history.jsonl` (today's journal event shape). */
  history?(ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  /**
   * The real path of a ferret's folder through ITS fenced `work` root (`RootHandle.realPath`); `undefined` when it
   * cannot be resolved. Unbound, no work folder is answered.
   */
  realPath?(ferret: FerretId, folder: string): Promise<string | undefined>;
  /** Where a launch records the switches it handed the pane (`instructions` reads them back). Unbound: none is kept. */
  launchEnvironment?: Pick<LaunchEnvironmentRecord, 'write'>;
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
  vault: Pick<VaultApi, 'childEnvironment'>;
  asks: Pick<AsksApi, 'open'>;
}

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
 */
export interface FerretSessionPort {
  prepare(ferret: FerretId): Promise<void>;
  stamp(request: SessionSpawnRequest): Promise<void>;
  carry(ferret: FerretId): Promise<void>;
  /**
   * A start's prompt, written as the ferret's assigned task (`turns/turn-001.md`), after `prepare` and before the stamp,
   * so the ferret's session document counts the turn it already holds. Answers the pointer typed into the new pane once
   * it is up (today's `firstTurnInstruction`). Unbound: no turn document is written and nothing is typed.
   */
  assign?(ferret: FerretId, prompt: string): Promise<string>;
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
   * The absolute folders of THIS ferret's own session folder its agent may read without asking
   * (`FERRET_READABLE_FOLDERS`, today's `handoffFolders`), handed to the harness as `LaunchSpec.readable`. Unbound:
   * nothing is pre-allowed.
   */
  readable?(ferret: FerretId): Promise<readonly FencedPath[]>;
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

/** Tells a resume's caller what it decided; a caller's own failure there never changes the resume. */
function tellDecided(options: ServiceResumeOptions | undefined, disposition: 'running' | 'relaunching'): void {
  try {
    options?.decided?.(disposition);
  } catch {
    // The caller's bookkeeping; the resume goes on as decided.
  }
}

/**
 * Who may ask for a START (`StartRequest.by`), as a closed table checked at run time. A resume is not here: it goes
 * through `resume()`, which asks `start.decide` itself with `by: 'resume'`.
 */
const START_ASKERS = { owner: true, ferret: true, pack: true, board: true } as const satisfies Record<
  StartRequest['by'],
  true
>;
const START_ASKER_REFUSAL =
  'a start is asked for by the owner, a ferret, a pack or the board; a resume is asked for through resume';

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

/** A valid ferret id that is never minted (minted ids are `<base36>-<8 hex>`): the harness is asked for its home. */
const PROBE_FERRET = 'home-probe' as FerretId;

/**
 * Where a move relaunches a ferret: everything the move restamps — the runtime it moved onto, the harness that runtime
 * is, the conversation it resumes and the model it runs. The previous login never carries over (a runtime is one
 * credential, and the moves module records none).
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
   * through the ordinary launch (new token, harness home, environment). Only a move sets it.
   */
  readonly replaceLiveTerminal?: boolean;
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
  private readonly serial = new KeyedSerialExecutor();
  /**
   * The pin-marked summary made from one registry summary, so the same summary with the same pin answers the same
   * object (R501: the fleet read reuses its body while nothing moved). Held weakly by the input summary.
   */
  private readonly marked = new WeakMap<
    FerretSummary,
    { readonly pinnedAt: string; readonly summary: FerretSummary }
  >();

  constructor(
    private readonly registry: FerretRegistry,
    private readonly tokens: FerretTokenDirectory,
    private readonly ports: FerretsPorts,
  ) {}

  async get(ferret: FerretId): Promise<FerretSummary | undefined> {
    const summary = this.registry.summary(ferret);
    return summary === undefined ? undefined : this.mark(summary, await this.pins());
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

  mayTouch(caller: FerretId, target: FerretId): boolean {
    return this.registry.mayTouch(caller, target);
  }

  children(ferret: FerretId): readonly FerretId[] {
    return this.registry.children(ferret);
  }

  harnesses(): readonly HarnessKey[] {
    return this.ports.harnessKeys();
  }

  /** The handle `ferret.json` keeps while the ferret runs; a stop clears it. */
  async handle(ferret: FerretId): Promise<RunnerHandle | undefined> {
    await this.ports.ready?.();
    return this.registry.get(ferret)?.handle as RunnerHandle | undefined;
  }

  async start(request: StartRequest): Promise<Result<FerretId, StartFailure>> {
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
      const result = await this.startNamed(id, named.value, request);
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

  private async startNamed(id: FerretId, name: string, request: StartRequest): Promise<Result<FerretId, StartFailure>> {
    // A work folder replaces the folder the ferret works in; it is canonical and goes through the same folder check.
    const anchor = this.ports.folder(request.folder);
    if (!anchor.ok) return failed('folder', anchor.error);
    if (request.workFolder !== undefined && !canonicalFolder(request.workFolder))
      return failed('folder', 'the work folder must be an absolute path with no . or .. segment');
    const folder = request.workFolder === undefined ? anchor : this.ports.folder(request.workFolder);
    if (!folder.ok) return failed('folder', folder.error);
    const harnessKey = request.harness ?? this.ports.harnessKeys()[0];
    if (harnessKey === undefined || !(HARNESS_KEYS as readonly string[]).includes(harnessKey))
      return failed('harness_unavailable', 'no harness plugin is on');
    const role = request.role ?? (request.parent === undefined ? 'lead' : 'helper');
    const decision = await this.ports.decide({
      ferret: id,
      name,
      role,
      ...(request.parent === undefined ? {} : { parent: request.parent }),
      ...(request.pack === undefined ? {} : { pack: request.pack }),
      harness: harnessKey,
      ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
      ...(request.login === undefined ? {} : { login: request.login }),
      folder: folder.value,
      by: request.by,
      ...(request.options?.model === undefined ? {} : { model: request.options.model }),
      ...(request.options?.fast === undefined ? {} : { fast: request.options.fast }),
    });
    // A refusal here is BEFORE the first write (details, record, token): `start()` gives the name back.
    if (!decision.allow) return refusedBy(decision);
    if (request.options !== undefined) {
      const { title, ...options } = request.options;
      await this.saveDetails(id, {
        ...(Object.keys(options).length === 0 ? {} : { options }),
        ...(title === undefined ? {} : { title }),
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
      mode: request.options?.mode ?? 'auto',
      runner: 'tmux',
      ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
      ...(request.login === undefined ? {} : { login: request.login }),
      folder: folder.value,
      state: 'starting',
      ...(request.harnessConversation === undefined ? {} : { harnessConversation: request.harnessConversation }),
      createdAt: at,
      stateAt: at,
    };
    return await this.serial.run(id, async () => {
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
      return await this.launch(record, request.prompt, record.harnessConversation, 'start');
    });
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

  private async stopHeld(
    ferret: FerretId,
    how: 'polite' | 'now',
    reason: string | undefined,
    cause: FerretEndCause,
  ): Promise<void> {
    await this.ports.ready?.();
    const record = this.registry.get(ferret);
    if (record === undefined || record.state === 'stopped') return;
    this.ports.stopping?.(ferret);
    const harness = this.ports.harness(record.harness);
    const runner = this.ports.runner();
    if (record.handle !== undefined && (harness === undefined || runner === undefined))
      throw new ApiError(503, 'the harness or runner needed to stop this ferret is unavailable', 'plugin_unavailable');
    if (record.handle !== undefined && harness !== undefined && runner !== undefined)
      await harness.stop(ferret, record.handle as RunnerHandle, runner, how);
    await this.settle(record, 'stopped', 'stopped', cause);
    // Today's `session.stopped` journal event, with the reason the caller gave or the lifecycle default.
    await this.ports.history?.(ferret, 'session.stopped', { reason: reason?.trim() || DEFAULT_STOP_REASON });
  }

  /**
   * Revives a stopped ferret. A `message` is recorded with today's `session.resumed` event; delivering it into the
   * conversation is the Conversation's (not wired in this build).
   */
  async resume(
    ferret: FerretId,
    message?: string,
    options?: ServiceResumeOptions,
  ): Promise<Result<FerretId, StartFailure>> {
    const confirmRestore = options?.confirmRestore;
    return await this.serial.run(ferret, async () => {
      await this.ports.ready?.();
      this.requireTokens();
      try {
        return await resumeUnderCutOff(
          this.tokens.isCutOff(ferret) ? 'restore' : 'proceed',
          {
            confirm: confirmRestore,
            unconfirmed: () =>
              new ResumeRefusal({
                code: 'refused',
                reason: 'only a confirmed owner resume may restore a cut-off ferret',
              }),
            restore: async () => {
              this.tokens.restore(ferret);
              try {
                await this.ports.saveTokens(this.tokens.snapshot());
              } catch (error) {
                this.tokens.cutOff(ferret, this.ports.now());
                await this.ports.saveTokens(this.tokens.snapshot());
                throw error;
              }
            },
            markAgain: async () => {
              this.tokens.cutOff(ferret, this.ports.now());
              await this.ports.saveTokens(this.tokens.snapshot());
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

  private async resumeHeld(
    ferret: FerretId,
    message: string | undefined,
    options: ServiceResumeOptions | undefined,
  ): Promise<Result<FerretId, StartFailure>> {
    await this.ports.ready?.();
    const found = this.registry.get(ferret);
    if (found === undefined) return failed('refused', `no ferret ${ferret}`);
    // A plain resume of a running ferret is the send shortcut: nothing to relaunch. Only a move gives it up, and then
    // the live pane is stopped first (never a second pane beside it).
    const replacing = found.state !== 'stopped';
    if (replacing && options?.replaceLiveTerminal !== true) {
      tellDecided(options, 'running');
      return ok(ferret);
    }
    // The record the relaunch is on: the move's target when it has one. Everything that can refuse WITHOUT launching —
    // the target itself, the start gate and the launch's own preconditions — is judged on it BEFORE the live pane is
    // stopped, so a refusal leaves a working ferret working with the same handle.
    const target = options?.target;
    const retargeted = target === undefined ? found : this.retarget(found, target);
    if (typeof retargeted === 'string') return failed('refused', retargeted);
    const decision = await this.ports.decide({
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
    });
    if (!decision.allow) return refusedBy(decision);
    if (replacing) {
      const ready = await this.launchable(retargeted);
      if (!ready.ok) return ready;
    }
    const settled = replacing ? await this.releaseLive(found) : found;
    // The target is written with the record's `starting` state, then launched: one owner of the runtime, login and harness.
    const record = target === undefined ? settled : (this.retarget(settled, target) as FerretRecord);
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
    const author = resumeTurnAuthor(options?.actor ?? 'unknown');
    const resumed = await this.launch(starting, undefined, record.harnessConversation, 'resume', {
      ...(message === undefined ? {} : { message }),
      mode: starting.mode ?? 'auto',
      ...(author === undefined ? {} : { by: author }),
    });
    if (resumed.ok) {
      const text = message?.trim();
      await this.ports.history?.(ferret, 'session.resumed', {
        ...(text === undefined || text === '' ? {} : { message: text }),
        ...(options?.automatic === true ? { automatic: true } : {}),
        ...(options?.replaceLiveTerminal === true ? { replacedLiveTerminal: true } : {}),
      });
    }
    return resumed;
  }

  /**
   * Adopts a live process by its runner handle WITHOUT restarting it (spine D15): the runner confirms the handle is
   * a live ferret pane, and the record takes the handle and `working`. No token is issued: the adopted process keeps
   * the bearer it was started with, which `tokens.json` already holds.
   */
  async attach(ferret: FerretId, handle: RunnerHandle): Promise<Result<FerretId, StartFailure>> {
    const record = this.registry.get(ferret);
    if (record === undefined) return failed('refused', `no ferret ${ferret}`);
    const runner = this.ports.runner();
    if (runner === undefined) return failed('runner_unavailable', 'no runner plugin is on');
    const adopted = await runner.attach(handle);
    if (!adopted.ok) return failed('failed', `the runner would not adopt ${handle}: ${adopted.error}`);
    // A stopped ferret's end cause goes with the stop: the cause is present only while the state is stopped.
    const { cause: _ended, ...revived } = record;
    const working: FerretRecord = {
      ...revived,
      state: 'working',
      handle: adopted.value.handle,
      stateAt: this.ports.now(),
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
    if (title !== undefined) await this.saveDetails(ferret, { ...this.registry.detailsOf(ferret), title });
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
   * What a ferret may control (today's `AccountModelAgentControlPolicy`, over `limits.yaml`): read fresh for every
   * call, so a change applies to its very next action with no restart and no cache. An unknown ferret controls nothing.
   */
  async agentControl(ferret: FerretId): Promise<AgentControl> {
    await this.ports.ready?.();
    if (this.registry.get(ferret) === undefined) return NO_AGENT_CONTROL;
    return effectiveAgentControl(this.ports.limits?.());
  }

  /** Revokes a ferret's token (owner only at the route); it can no longer call the daemon until it restarts. */
  async revokeToken(ferret: FerretId): Promise<boolean> {
    return await this.serial.run(ferret, async () => {
      await this.ports.ready?.();
      this.requireTokens();
      const revoked = this.tokens.holds(ferret);
      this.tokens.cutOff(ferret, this.ports.now());
      await this.ports.saveTokens(this.tokens.snapshot());
      return revoked;
    });
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
      !(HARNESS_KEYS as readonly string[]).includes(target.harness)
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
    const before = this.registry.detailsOf(ferret);
    const { effort: _effort, fast: _fast, ...kept } = before?.options ?? {};
    const options = {
      ...kept,
      ...(target.model === undefined ? {} : { model: target.model }),
      ...(target.effort === undefined ? {} : { effort: target.effort }),
    };
    if (JSON.stringify(options) === JSON.stringify(before?.options ?? {})) return;
    await this.saveDetails(ferret, { ...before, options });
  }

  /**
   * What a launch would refuse for without starting anything, asked before a live pane is given up: a cut-off ferret, a
   * harness or runner that is off, a home the harness will not name (or names for another ferret). None of it writes.
   */
  private async launchable(record: FerretRecord): Promise<Result<void, StartFailure>> {
    this.requireTokens();
    if (this.tokens.isCutOff(record.id))
      return failed('refused', 'the owner cut off this ferret; a confirmed owner resume is required');
    const harness = this.ports.harness(record.harness);
    if (harness === undefined) return failed('harness_unavailable', `${record.harness} is off`);
    if (this.ports.runner() === undefined) return failed('runner_unavailable', 'no runner plugin is on');
    const home = await this.home(record, harness);
    return home.ok ? ok(undefined) : home;
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
    if (record.handle !== undefined && harness !== undefined && runner !== undefined)
      await harness.stop(record.id, record.handle as RunnerHandle, runner, 'now');
    await this.settle(record, 'stopped', 'stopped', { kind: 'stopped' });
    return this.registry.get(record.id) as FerretRecord;
  }

  /** A caller that is a ferret reaches only itself and its helpers (the same rule as stop and resume). */
  private requireMayTouch(caller: FerretId | undefined, target: FerretId): void {
    if (caller !== undefined && !this.registry.mayTouch(caller, target))
      throw new ApiError(403, `a ferret acts only on itself and its helpers, and ${target} is neither`, 'forbidden');
  }

  async harness(ferret: FerretId, caller?: FerretId): Promise<FerretHarness | undefined> {
    await this.ports.ready?.();
    if (this.registry.get(ferret) === undefined) return undefined;
    this.requireMayTouch(caller, ferret);
    /** The ferret's pane and runner NOW, or why there is nothing to write to. */
    const pane = (): Result<{ readonly handle: RunnerHandle; readonly runner: Runner }, HarnessRefusal> => {
      const handle = this.registry.get(ferret)?.handle as RunnerHandle | undefined;
      const runner = this.ports.runner();
      if (handle === undefined) return err({ refused: 'no_pane' });
      if (runner === undefined) return err({ refused: 'plugin_unavailable' });
      return ok({ handle, runner });
    };
    /**
     * One of the runner's own writes (deliver, queue), answered as the closed failure its rejection carries. None is
     * wrapped in an act here: the runner acts on the ferret's pane (op `keys`) for each write it makes, so an outer act
     * would wait on the inner one and neither would ever settle. A rejection that carries no closed failure is a failure
     * nobody could classify, and it rejects as it came.
     */
    const written = async <T>(write: () => Promise<T>): Promise<Result<T, HarnessDeliveryFailure>> => {
      try {
        return ok(await write());
      } catch (error) {
        const failure = runnerDeliveryFailure(error);
        if (failure === undefined) throw error;
        return err(harnessDeliveryFailure(failure));
      }
    };
    const reader = (): TranscriptReader => {
      const record = this.registry.get(ferret);
      const harness = record === undefined ? undefined : this.ports.harness(record.harness);
      if (harness === undefined)
        throw new ApiError(503, 'the harness that wrote this conversation is off', 'plugin_unavailable');
      return harness.transcript;
    };
    return {
      deliver: async (delivery: RunnerDelivery): Promise<Result<DeliveryOutcome, HarnessDeliveryFailure>> => {
        const found = pane();
        if (!found.ok) return found;
        // The runner guards each write with kernel.act on this pane itself; a hold it meets types nothing.
        return await written(async () => await found.value.runner.deliver(found.value.handle, delivery));
      },
      queue: async (text: string): Promise<Result<QueueOutcome, HarnessDeliveryFailure>> => {
        const found = pane();
        if (!found.ok) return found;
        const { handle, runner } = found.value;
        const queue = runner.queue?.bind(runner);
        if (queue === undefined) return err({ refused: 'plugin_unavailable' });
        // As `deliver`: the runner acts on this pane for each write it makes, so it is NOT wrapped in a second act here.
        return await written(async () => await queue(handle, text));
      },
      interrupt: async (): Promise<Result<HarnessInterrupted, HarnessRefusal>> => {
        const found = pane();
        if (!found.ok) return found;
        const { handle, runner } = found.value;
        const record = this.registry.get(ferret);
        // The harness names its own stop key; the runner's raw signal (`C-c`) is never the fallback: it quits Codex.
        const stop = record === undefined ? undefined : this.ports.harness(record.harness)?.turnStop;
        const stopTurn = runner.stopTurn?.bind(runner);
        if (stop === undefined || stopTurn === undefined) return err({ refused: 'plugin_unavailable' });
        // Today's `shouldPressStopKey`: idle, the key is pressed only at an interactive pane whose harness it cannot harm.
        const whenIdle = record?.mode === 'interactive' && stop.safeWhenIdle;
        try {
          // As `deliver`: the runner acts on this pane for its one keystroke, so it is NOT wrapped in a second act here.
          return ok(await stopTurn(handle, { key: stop.key, whenIdle }));
        } catch (error) {
          const failure = runnerDeliveryFailure(error);
          if (failure?.kind === 'held') return err({ refused: failure.code });
          if (failure?.kind === 'not_ready' && failure.why === 'exited') return err({ refused: 'no_pane' });
          throw error;
        }
      },
      // Bound to the ferret this seam was opened for: there is no target to name, so it cannot read another ferret's.
      transcript: {
        read: async (after, limit) => await reader().read(ferret, after, limit),
        follow: signal => reader().follow(ferret, signal),
        find: async entry => await reader().find(ferret, entry),
      },
    };
  }

  /**
   * A ferret's turn documents, bound to that ferret (`FerretsApi.turns`). The same `mayTouch` rule as `harness`: a
   * ferret reads only its own and its helpers', so no agent reads another's turns. Unbound session files: none.
   */
  async turns(ferret: FerretId, caller?: FerretId): Promise<FerretTurns | undefined> {
    await this.ports.ready?.();
    if (this.registry.get(ferret) === undefined) return undefined;
    this.requireMayTouch(caller, ferret);
    return {
      list: async options => (await this.ports.session?.turns?.(ferret, { strict: options?.strict === true })) ?? [],
    };
  }

  async move(
    ferret: FerretId,
    runtime: string,
    options: MoveOptions = {},
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

  private async saveDetails(ferret: FerretId, details: FerretDetails): Promise<void> {
    await this.ports.saveDetails?.(ferret, details);
    this.registry.putDetails(ferret, details);
  }

  private async launch(
    record: FerretRecord,
    prompt: string | undefined,
    conversation: string | undefined,
    kind: 'start' | 'resume',
    revive?: ReviveTurnRequest,
  ): Promise<Result<FerretId, StartFailure>> {
    const created = new Set<RunnerHandle>();
    let runner: Runner | undefined;
    let failure: StartFailure;
    let turn: PendingTurn | undefined;
    try {
      const session = await this.sessionStep(record, kind, prompt, revive);
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
      const result = await this.launchAttempt(record, prompt, conversation, tracked);
      if (!result.ok) failure = result.error;
      else if (turn === undefined) return result;
      else if (turn.kind === 'revive') return await this.deliverTurn(record.id, runner, turn.turn);
      else {
        // Today's `deliverFirstTurn`: a start whose task never arrives is an agent sitting at an idle prompt, so a
        // first turn that does not land fails the start (the pane is stopped and the credential revoked below).
        const first = await this.deliverFirstTurn(record.id, runner, turn);
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
        await runner.stop(handle, 'now');
      } catch {
        // Keep the handle recoverable by stop; a failed cleanup never claims the process stopped.
        await this.write({ ...record, handle }, record.state, 'state');
        return failed('runner_unavailable', 'the failed launch still has a process that could not be stopped');
      }
    }
    return await this.abandon(record, failure.code, failure.reason);
  }

  private async launchAttempt(
    record: FerretRecord,
    prompt: string | undefined,
    conversation: string | undefined,
    runner: Runner,
  ): Promise<Result<FerretId, StartFailure>> {
    this.requireTokens();
    if (this.tokens.isCutOff(record.id))
      return failed('refused', 'the owner cut off this ferret; a confirmed owner resume is required');
    const harness = this.ports.harness(record.harness);
    if (harness === undefined) return failed('harness_unavailable', `${record.harness} is off`);
    const home = await this.home(record, harness);
    if (!home.ok) return home;
    const issued = issueToken(record.id, this.ports.now());
    this.tokens.add(issued.entry);
    await this.ports.saveTokens(this.tokens.snapshot());
    // Today's read allowance for what the ferret is sent (`handoffFolders` → `--allowedTools=Read(…)`): its own session
    // folder's hand-off folders only. One that cannot be named pre-allows nothing (the agent asks), never more.
    const readable = (await this.ports.session?.readable?.(record.id).catch(() => undefined)) ?? [];
    const base: Omit<LaunchSpec, 'parts'> = {
      ferret: record.id,
      name: record.name,
      role: record.role,
      ...(record.parent === undefined ? {} : { parent: record.parent }),
      ...(record.pack === undefined ? {} : { pack: record.pack as PackId }),
      harness: record.harness,
      ...(record.runtime === undefined ? {} : { runtime: record.runtime }),
      ...(record.login === undefined ? {} : { login: record.login }),
      ...launchOptions(this.registry.detailsOf(record.id)?.options),
      folder: record.folder as FencedPath,
      home: home.value,
      instructions: this.ports
        .instructions()
        .filter(
          entry =>
            (entry.when.role === undefined || entry.when.role === 'any' || entry.when.role === record.role) &&
            (entry.when.harness === undefined || entry.when.harness === record.harness),
        ),
      ...(prompt === undefined ? {} : { prompt }),
      ...(conversation === undefined ? {} : { harnessConversation: conversation }),
      ...(readable.length === 0 ? {} : { readable }),
    };
    const parts = (
      await Promise.all(
        this.ports.launchParts().map(source => source.parts(base).catch(() => [] as readonly LaunchPart[])),
      )
    ).flat();
    const spec: LaunchSpec = { ...base, parts };
    // Today's order: the home is written (and made private) before the environment is resolved and the runner asked.
    try {
      await harness.prepareHome(spec);
    } catch {
      return failed(
        'failed',
        `the ${record.harness} harness could not prepare this ferret's home, so it was not started`,
      );
    }
    const env = await this.environment(record.id, issued.token, parts);
    if (!env.ok) return failed('login_unavailable', env.error);
    const started =
      conversation === undefined
        ? await harness.start(spec, runner, env.value)
        : await harness.resume(spec, runner, env.value, conversation);
    if (!started.ok) {
      // A test-mode daemon refused to reach a real harness: the closed code becomes a sentence a test log can act on.
      if (started.error === 'real_harness') return failed('refused', REAL_HARNESS_REFUSED);
      const code = started.error === 'unavailable' ? 'runner_unavailable' : 'failed';
      return failed(code, `the harness could not start: ${started.error}`);
    }
    const working: FerretRecord = {
      ...record,
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
   * The ferret's private session files and spawn stamp, settled before the harness is asked for anything. The folder
   * is made (or narrowed to `0700`) first, so nothing written for this launch lands in a readable one. Port errors are
   * never quoted: they can sit beside a credential.
   */
  private async sessionStep(
    record: FerretRecord,
    kind: 'start' | 'resume',
    prompt: string | undefined,
    revive: ReviveTurnRequest | undefined,
  ): Promise<Result<PendingTurn | undefined, StartFailure>> {
    const session = this.ports.session;
    if (session === undefined) return ok(undefined);
    try {
      await session.prepare(record.id);
    } catch {
      return failed('failed', "the ferret's private session folder could not be made private, so it was not started");
    }
    if (kind === 'start') {
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
      };
      try {
        await session.stamp(request);
      } catch {
        return failed('failed', 'where this ferret came from could not be recorded, so it was not started');
      }
      return ok(first);
    } else {
      // A resume that cannot bring the stamp forward leaves the one on disk exactly as it was (it only ever strengthens).
      await session.carry(record.id).catch(() => undefined);
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
   * before the relaunch (today's order), so a delivery that does not land leaves the ferret running with its turn
   * counted and its document on disk; the next revive takes the next number. The failure is said, never quoted.
   */
  private async deliverTurn(
    ferret: FerretId,
    runner: Runner,
    turn: ReviveTurn,
  ): Promise<Result<FerretId, StartFailure>> {
    const handle = this.registry.get(ferret)?.handle as RunnerHandle | undefined;
    try {
      if (handle === undefined) throw new Error('no pane');
      await runner.deliver(handle, { text: turn.instruction });
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
      await runner.deliver(handle, {
        text: turn.instruction,
        beforeWrite: async () => {
          admission = await admit(ferret, turn.prompt);
          // `settled` aborts this delivery at the exact pre-write boundary: a replay, never a second typing.
          if (admission !== 'perform') throw new FirstTurnNotPerformed();
        },
      });
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
      return failed('failed', (await this.startExplained(ferret, runner, handle)) ?? untyped);
    }
    return await this.settleStartup(ferret, runner, handle);
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
  ): Promise<Result<FerretId, StartFailure>> {
    if (runner.settled === undefined) return ok(ferret);
    try {
      await runner.settled(handle);
    } catch (error) {
      const ran = diedParked(error) ? FIRST_TURN_NEVER_RAN : FIRST_TURN_MAYBE_RAN;
      const why = (await this.startExplained(ferret, runner, handle)) ?? STARTUP_EXITED;
      return failed('failed', `${why}${ran}`);
    }
    return ok(ferret);
  }

  /**
   * The harness's own sentence for a start that failed at its first turn (today's `RuntimeSupervisedLauncher`), read
   * off what the pane last showed; `undefined` when the harness has none, cannot be asked or does not recognise the
   * screen. The screen goes to the harness only and is dropped here: only the harness's fixed sentence is kept.
   */
  private async startExplained(ferret: FerretId, runner: Runner, handle: RunnerHandle): Promise<string | undefined> {
    const key = this.registry.get(ferret)?.harness;
    const harness = key === undefined ? undefined : this.ports.harness(key);
    if (harness?.startFailure === undefined || runner.lastScreen === undefined) return undefined;
    try {
      const sentence = harness.startFailure(await runner.lastScreen(handle));
      return typeof sentence === 'string' && sentence !== '' ? sentence : undefined;
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

  private async environment(
    ferret: FerretId,
    token: string,
    parts: readonly LaunchPart[],
  ): Promise<Result<ChildEnvironment, string>> {
    const env: Record<string, string> = {};
    for (const part of parts) if (part.kind === 'env' || part.kind === 'shell') Object.assign(env, part.env);
    env[FERRET_ID_VARIABLE] = ferret;
    env[FERRET_TOKEN_VARIABLE] = token;
    const resolved = await this.ports.vault.childEnvironment(ferret, env);
    if (!resolved.ok) return err(`unknown secrets: ${resolved.error.unknown.join(', ')}`);
    // What this launch told the ferret, kept for `instructions` (persisted, so a restart changes no answer): only the
    // switches, after the launch can no longer be refused. A store that fails never fails the launch.
    await this.ports.launchEnvironment?.write(ferret, recordedSwitches(env)).catch(() => undefined);
    return ok(resolved.value);
  }

  private async abandon(
    record: FerretRecord,
    code: StartFailure['code'],
    reason: string,
  ): Promise<Result<FerretId, StartFailure>> {
    await this.settle(record, 'stopped', 'stopped', { kind: 'start_failed' });
    return failed(code, reason);
  }

  private async settle(
    record: FerretRecord,
    state: FerretState,
    change: FerretChangedPayload['change'],
    cause?: FerretEndCause,
  ): Promise<void> {
    if (this.tokens.revoke(record.id)) await this.ports.saveTokens(this.tokens.snapshot());
    const { handle: _handle, cause: _before, ...rest } = record;
    await this.write(
      { ...rest, state, stateAt: this.ports.now(), ...(state === 'stopped' && cause !== undefined ? { cause } : {}) },
      record.state,
      change,
    );
    if (state === 'stopped') await this.ports.endWait?.(record.id).catch(() => undefined);
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

/**
 * A runner's closed failure in the harness seam's words: a refusal (nothing typed) keeps its kind and fields, and a
 * typed-but-unproven write becomes {@link HarnessUnconfirmed}, a different shape, so it is never read as a refusal.
 */
function harnessDeliveryFailure(failure: RunnerDeliveryFailure): HarnessDeliveryFailure {
  switch (failure.kind) {
    case 'not_ready':
      return { refused: 'not_ready', why: failure.why };
    case 'composer_occupied':
      return { refused: 'composer_occupied', draft: failure.draft };
    case 'composer_unreadable':
      return { refused: 'composer_unreadable' };
    case 'held':
      return { refused: failure.code };
    case 'unconfirmed':
      return { unconfirmed: true, stranded: failure.stranded };
  }
}

/**
 * The launch spec's share of a ferret's start options: `model` and `effort` on their own fields (where the harness
 * already reads them), and the rest whole, so a harness, runner or supervisor reads today's start fields from the spec.
 */
function launchOptions(options: FerretDetails['options']): Pick<LaunchSpec, 'model' | 'effort' | 'options'> {
  if (options === undefined) return {};
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    options,
  };
}
