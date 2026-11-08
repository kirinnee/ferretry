import { defineEvent, definePort, type FerretId, type RefusalCode } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import {
  FerretCardIdSchema,
  type FerretRole,
  type FerretState,
  type FerretSummary,
  FerretTitleSchema,
  FerretStateSchema,
  type HarnessKey,
  type PackId,
} from './ids.ts';
import type {
  DeliveryOutcome,
  PaneNotReadyReason,
  QueueOutcome,
  RunnerDelivery,
  RunnerHandle,
  SitrepLine,
  BoundTranscriptReader,
} from './kinds.ts';
import type { AgentControl, LimitsFile } from './state.ts';

/**
 * The most free-form harness flags one start may carry, and the longest one may be (today's `protocol/src/lib/
 * session.ts`, unchanged).
 *
 * Generous on purpose: a `--settings` overlay is JSON and can run to a few kilobytes. The bounds exist
 * so a body cannot hand the launch argv an unbounded list, never to judge which flags are wise.
 */
export const MAX_HARNESS_FLAGS = 64;
export const MAX_HARNESS_FLAG_LENGTH = 16_384;

/**
 * One caller-supplied harness flag, bounded and free of control characters.
 *
 * A control character has no business in an argv element a human typed: a newline or an escape in
 * one is either a mistake or an attempt to make the recorded command read differently from the one
 * that ran.
 */
export const HarnessFlagSchema = z
  .string()
  .max(MAX_HARNESS_FLAG_LENGTH)
  .refine(value => !/\p{Cc}/u.test(value), 'a harness flag may not contain a control character');

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();

/**
 * How a ferret is started beyond who and where: today's `StartSessionBaseSchema` fields (and `fy new`'s model
 * routing) that are not the ferret's identity. Every field is optional and bounded as today. Ferrets records them in
 * the ferret's `details.json` and shows `model`, `card` and `title` in its summary; the harness, runner and
 * supervision owners read the rest.
 */
export const StartOptionsSchema = z.strictObject({
  /** A task title, free-form (today's `start --name <title>` / `new --name <title>`). */
  title: FerretTitleSchema.optional(),
  /** An ownership label (`start --label`). */
  label: z.string().min(1).optional(),
  /** An EXISTING card the new ferret works on (`start --card`, `new --card`): assigned to it, no second card made. */
  card: FerretCardIdSchema.optional(),
  /** The model, as the runtime lists it (alias or full id). */
  model: z.string().min(1).optional(),
  /**
   * Opaque startup reasoning choice. The selected account's live runtime decision validates the
   * value; the protocol deliberately does not own a second harness effort enum.
   */
  effort: z.string().min(1).optional(),
  /** Launch in the harness's fast mode. Refused when the chosen model has none; omitted leaves it off. */
  fast: z.boolean().optional(),
  /** `auto` for an autonomous teammate (needs a prompt), `interactive` for a human terminal. */
  mode: z.enum(['auto', 'interactive']).optional(),
  /**
   * `fy new --auto`: let Ferretry choose — the models the routing prompt names, in its order, then the ready one with
   * the most headroom. Never together with a named runtime.
   */
  auto: z.boolean().optional(),
  intervalSeconds: PositiveIntegerSchema.optional(),
  timeoutSeconds: NonNegativeIntegerSchema.optional(),
  nudgeAfterSeconds: NonNegativeIntegerSchema.optional(),
  killAfterSeconds: NonNegativeIntegerSchema.optional(),
  directSendMaxChars: NonNegativeIntegerSchema.optional(),
  resumeMenuChoice: z.enum(['full', 'summary']).optional(),
  maxSnapshots: PositiveIntegerSchema.optional(),
  harnessFlags: z.array(HarnessFlagSchema).max(MAX_HARNESS_FLAGS).optional(),
  remoteControl: z.boolean().optional(),
  /** With a name: take a free callsign instead of failing when the name is held. */
  teammateFallback: z.boolean().optional(),
});
export type StartOptions = z.infer<typeof StartOptionsSchema>;

/** A request to start a ferret (from the owner's route, a pack, the board, or a lead for its helper). */
export interface StartRequest {
  readonly name?: string;
  readonly parent?: FerretId;
  readonly pack?: PackId;
  readonly role?: FerretRole;
  readonly harness?: HarnessKey;
  readonly runtime?: string;
  readonly login?: string;
  readonly folder: string;
  /**
   * The folder the ferret WORKS in, when it is not `folder` (a Warden investigator's own folder): an absolute, canonical
   * path (no `.`, `..` or empty segment, no trailing `/`) that the folder check accepts, or the start is refused with
   * `{ code: 'folder' }`. It is recorded as the ferret's folder in place of `folder`. Its report is read back with
   * `summary(ferret)`. Only trusted plugin code passes it; no route takes it.
   */
  readonly workFolder?: string;
  readonly prompt?: string;
  /** Start bound to an existing harness conversation (§6.2). */
  readonly harnessConversation?: string;
  readonly by: 'owner' | 'ferret' | 'pack' | 'board';
  /** How to start it beyond who and where ({@link StartOptionsSchema}). */
  readonly options?: StartOptions;
}

export type StartFailure =
  | { readonly code: 'refused' | 'unservable_model'; readonly reason: string } // a start.decide taker said no, or a test-mode runner refused a real harness (`real_harness`) (`unservable_model`: what the start asked of its model cannot be given)
  | { readonly code: 'folder'; readonly reason: string } // WorkFolders refused the folder
  | { readonly code: 'harness_unavailable' | 'runner_unavailable' | 'login_unavailable'; readonly reason: string }
  | { readonly code: 'failed'; readonly reason: string };

/**
 * One checkout in the managed worktree registry (`<home>-worktrees`, `state/ferrets/worktrees.json`): the durable
 * facts of today's `ManagedWorktreeView` (`protocol/src/lib/worktrees.ts`), copied. Live Git state, the removal
 * verdict and who stands in it are left out — reading them runs Git. `projectId` is not here: Ferrets is core and
 * cannot read Projects (§2.1), so a reader joins `commonDirectory` to a project's own (today's `projectForWorktree`).
 */
export interface ManagedWorktreeSummary {
  readonly path: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  /** The repository's common directory: what joins a checkout to its project. */
  readonly commonDirectory: string;
  /** Where inside the source checkout the fork was taken from; the empty string is its root. */
  readonly relativeCwd: string;
  readonly createdAt: string;
  readonly initialHead: string;
  readonly branchPreexisted: boolean;
  readonly removedAt?: string;
  /** Why this row is not a finished checkout: a creation declared and never finished (today's `unresolved`). */
  readonly unresolved?: string;
}

/**
 * How a resume differs from a person's plain one (today's `ResumePolicy.automatic`, copied). It defaults to `false`: an
 * explicit resume by a person is not automatic. Replacing a LIVE pane is not on the port: only a move does it, through
 * Ferrets' own service.
 */
export interface ResumeOptions {
  /**
   * Automated recovery rather than a person asking (the Warden's revive, a restart drain): recorded with the
   * `session.resumed` event so history tells the two apart.
   */
  readonly automatic?: boolean;
  /**
   * Additive (U3 fix1): who asked, for the author recorded beside the revive's turn document — the Warden's revive is
   * Ferretry's Warden (today's `resumeTurnAuthor('warden')`), so its words are never drawn as the owner's. ATTRIBUTION
   * only, never authority: it changes no policy, admission or refusal. Absent: the turn names no author.
   */
  readonly actor?: 'warden';
  /**
   * Additive (U3 fix2): told, ONCE and under the ferret's own queue, what this resume decided — `running`: the ferret
   * was not stopped, so nothing was relaunched and a message was NOT handed over (the send shortcut); `relaunching`: it
   * was stopped and is being relaunched, with a message as its own turn. A caller that must hand a message over itself
   * decides from this answer, never from an earlier read of the ferret's state that a start or stop in between could
   * make wrong (today's one resume decided send vs. relaunch under the session lock). Not called for a resume refused
   * before it decided. Attribution of nothing: it changes no policy, admission or refusal.
   */
  readonly decided?: (disposition: 'running' | 'relaunching') => void;
}

/**
 * Why a harness-seam action did NOTHING, CLOSED: a hold the act runner applied (the kernel's `RefusalCode`: `held`,
 * `quarantined`, `input_pending`, …), nothing to act on (`no_pane`), or no plugin able to do it (`plugin_unavailable`).
 */
export type HarnessRefusal = { readonly refused: RefusalCode | 'no_pane' | 'plugin_unavailable' };

/**
 * Why a delivery or queue typed NOTHING of the message, CLOSED, so the same message may go again (today's
 * `SendPaneNotReady`, `SendComposerOccupied` and `SendComposerUnreadable`): every {@link HarnessRefusal}, a pane that never
 * came to a prompt (`not_ready`: still at work, behind a dialog, or gone), a composer that already held the person's
 * own text (`composer_occupied`, with that `draft`, which today's refusal shows back to the person and nothing else
 * does), or a composer that could not be read to prove it empty (`composer_unreadable`). None quotes the screen.
 */
export type HarnessDeliveryRefusal =
  | HarnessRefusal
  | { readonly refused: 'not_ready'; readonly why: PaneNotReadyReason }
  | { readonly refused: 'composer_occupied'; readonly draft: string }
  | { readonly refused: 'composer_unreadable' };

/**
 * The message WAS typed and nothing proved it landed (today's `SendLandingUnconfirmed`): neither a refusal nor a loss,
 * so it must never be typed again. `stranded`: it is still in the composer after every Enter. A DIFFERENT SHAPE from a
 * refusal on purpose (no `refused`), so no `switch` over refusals can treat it as one.
 */
export interface HarnessUnconfirmed {
  readonly unconfirmed: true;
  readonly stranded: boolean;
}

/** Everything a delivery or queue can answer instead of an outcome. A rejection is a failure nobody could classify. */
export type HarnessDeliveryFailure = HarnessDeliveryRefusal | HarnessUnconfirmed;

/**
 * What an interrupt did (today's `interruptLocked`): whether the harness's stop key was pressed — it is NOT at a pane
 * that shows no active work unless the key is harmless there ({@link shouldPressStopKey}) — and whether the pane
 * still showed active work afterwards (absent when it could not be read), so the caller can tell a pane handed back
 * to its person from a turn that was interrupted.
 */
export interface HarnessInterrupted {
  readonly pressed: boolean;
  readonly working?: boolean;
}

/**
 * The harness seam (decision #18): what Conversation needs to type into a ferret, interrupt it and read its transcript.
 * Every write goes through `kernel.act(<the ferret's terminal pane>, 'keys')`, so Vault's input holds and the guarded
 * write apply exactly as for `terminal_send`; there is no raw pane write here. `deliver`, `queue` and `interrupt` are
 * the runner's own, which acts on that pane for each write it makes, so none of them is wrapped in a second act here
 * (an outer act would wait on the inner one and neither would settle); a hold the runner meets types NOTHING and is
 * answered as its `RefusalCode`. The pane is read when the write is made, so a ferret that stopped since answers
 * `no_pane`. Every answer is a closed code or a fixed shape: none carries pane text, a credential or an environment
 * value — only `composer_occupied` carries the person's own draft, as today's refusal does.
 */
export interface FerretHarness {
  /**
   * Types one message. Answers its outcome, a {@link HarnessDeliveryRefusal} (nothing typed), or
   * {@link HarnessUnconfirmed} (typed, not proven); rejects only for a failure the runner could not classify.
   */
  deliver(delivery: RunnerDelivery): Promise<Result<DeliveryOutcome, HarnessDeliveryFailure>>;
  /**
   * Additive (U3): puts `text` into the ferret's BUSY pane's own queue (the runner's `queue`). Exactly like `deliver`, it
   * is NOT wrapped in a second act here: the runner acts on the pane for each write it makes, and an outer act would
   * wait on the inner one so that neither ever settled. A runner that cannot queue answers `plugin_unavailable`; its
   * other answers are `deliver`'s.
   */
  queue(text: string): Promise<Result<QueueOutcome, HarnessDeliveryFailure>>;
  /**
   * Stops the current turn with the HARNESS's stop key (its `turnStop.key`, today's `Escape`; never the runner's raw
   * `C-c`, which quits an idle Codex), pressed by the runner's `stopTurn` only under {@link shouldPressStopKey}: at a
   * pane that shows active work, or an interactive ferret whose harness's key is harmless when idle. Refused
   * `plugin_unavailable` when the harness names no stop or the runner cannot stop a turn; `no_pane` when the ferret has
   * no live pane; a hold as its `RefusalCode`, pressing nothing. The caller still owns what only it knows: a pending
   * structured question (a stop would answer it by accident) is refused BEFORE this is called.
   */
  interrupt(): Promise<Result<HarnessInterrupted, HarnessRefusal>>;
  /**
   * The seam's own ferret's transcript through its harness, already masked (rejects with 503 while the harness is off).
   * It is bound to that ferret and names no other.
   */
  readonly transcript: BoundTranscriptReader;
}

/**
 * Who a turn document is from, as Ferretry recorded it BESIDE the document (`turn-NNN.by.json`, today's `QueueAuthor`):
 * the owner, a ferret (by callsign) or a part of Ferretry (by feature). Metadata only; the document never carries it.
 */
export interface FerretTurnAuthor {
  readonly kind: 'owner' | 'ferret' | 'ferretry';
  readonly name?: string;
  readonly feature?: string;
  readonly sections?: string[];
}

/** One of a ferret's turn documents (`turns/turn-NNN.md`) and, when Ferretry wrote one beside it, who it is from. */
export interface FerretTurnDocument {
  readonly turn: number;
  readonly text: string;
  readonly by?: FerretTurnAuthor;
}

/**
 * A ferret's turn documents, read back by the store that writes them (additive, U3; Conversation's `TurnDocuments`).
 * Bound to the one ferret it was opened for, so it can read no other's. A STRICT read rejects anything unreadable (a
 * document that vanished mid-read, an author record that does not parse); a best-effort one skips what it cannot read.
 */
export interface FerretTurns {
  list(options?: { readonly strict?: boolean }): Promise<readonly FerretTurnDocument[]>;
}

/** Why a move did not happen (today's `SessionMoveFailure` words and sentence). */
export interface MoveFailure {
  readonly code: string;
  readonly reason: string;
}

/** What a move may carry beyond where it goes (today's move request, minus what only the route sets). */
export interface MoveOptions {
  readonly model?: string;
  readonly allowContextDowngrade?: boolean;
  readonly forceInflight?: boolean;
  readonly conversation?: 'resume' | 'fresh' | 'previous' | 'convert';
  /** Words that open the turn the relaunched ferret is handed: why it was moved. */
  readonly note?: string;
  /** `warden` for the Warden's own moves, so the turn is drawn as theirs. */
  readonly actor?: 'warden';
  /** Who asked, as history records it: `owner`, `session:<id>`, or `warden`. */
  readonly movedBy?: string;
}

/** A ferret's whole status: its state, its turn, what plugins add, and its blockers from the Asks port. */
export interface Sitrep {
  readonly ferret: FerretSummary;
  readonly lines: readonly SitrepLine[];
  /** Open asks about this ferret (ids, `!A3`). */
  readonly blockers: readonly string[];
}

/**
 * The Ferrets port (§2.2): who each ferret is, its lineage, its state; start, stop and resume through the harness
 * and runner plugins. "A ferret touches only its own; a lead also its helpers'" is `mayTouch`, decided here and
 * nowhere else.
 */
export interface FerretsApi {
  /** The effective `limits.yaml` settings, read fresh; absent until Ferrets supplies this configuration read. */
  effectiveLimits?(): Promise<LimitsFile>;
  get(ferret: FerretId): Promise<FerretSummary | undefined>;
  list(filter?: {
    readonly state?: FerretState;
    readonly parent?: FerretId;
    readonly pack?: PackId;
  }): Promise<readonly FerretSummary[]>;
  /** Synchronous, memory-only: whether `caller` may act on `target` (itself, or a helper of its own lineage). */
  mayTouch(caller: FerretId, target: FerretId): boolean;
  children(ferret: FerretId): readonly FerretId[];
  /** The harness keys currently provided under `harnesses` (a plugin off is absent). */
  harnesses(): readonly HarnessKey[];
  start(request: StartRequest): Promise<Result<FerretId, StartFailure>>;
  /** Stops a ferret; `reason` is recorded in its history (today's default: "stopped by client"). */
  stop(ferret: FerretId, how: 'polite' | 'now', reason?: string): Promise<void>;
  /**
   * Revives a stopped ferret with its conversation. `message` is recorded in its history; delivering it into the
   * conversation is the Conversation's.
   */
  resume(ferret: FerretId, message?: string, options?: ResumeOptions): Promise<Result<FerretId, StartFailure>>;
  /** Adopts a live process by its runner handle without restarting it (spine D15). */
  attach(ferret: FerretId, handle: RunnerHandle): Promise<Result<FerretId, StartFailure>>;
  /**
   * The runner handle of a running ferret (Terminals: its tmux pane id), as `ferret.json` keeps it, so a harness finds
   * the ferret's pane after a daemon restart. `undefined` for a stopped or unknown ferret. Not a secret.
   */
  handle(ferret: FerretId): Promise<RunnerHandle | undefined>;
  /**
   * The folder a ferret was started in (its work folder), for Accounts' sign-in ordering, as its REAL path resolved
   * through Ferrets' fenced `work` root. The recorded folder must still be its own real path (today's
   * `sign-in-context.ts` `folderOf`): a folder swapped for a symlink elsewhere, a failed resolve or an unknown ferret
   * answers `undefined`. Accounts compares the folder under the owner's home (kernel `paths.home()`). The PROJECT is
   * not Ferrets': today it came from the Board (`projectOf(session)`), and core cannot import Board or Projects, so
   * Accounts gets it from the Board.
   */
  workFolder(ferret: FerretId): Promise<{ readonly folder: string } | undefined>;
  sitrep(ferret: FerretId): Promise<Sitrep | undefined>;
  /**
   * What a finished ferret handed back with `signal done`: its `summary.md` as it wrote it (today's session
   * `summary.md`), or `undefined` when there is no such ferret, it has not finished (is not `stopped`), or it wrote
   * none. NOT masked: a reader that shows it
   * masks it inside one `Redaction.read`. Read only.
   */
  summary(ferret: FerretId): Promise<string | undefined>;
  /**
   * The managed worktree registry as it is now (today's `ManagedWorktreeService.list()` rows, durable facts only):
   * every recorded checkout, removed ones included with `removedAt`, then every interrupted creation with
   * `unresolved`. MCP reads it to map a managed worktree to its project, as today's `mcpInventoryFolders`. Read only;
   * no Git inspection (only the registry's own settling, as `list()`). Optional, so it is additive: absent reads as no
   * managed worktree.
   */
  managedWorktrees?(): Promise<readonly ManagedWorktreeSummary[]>;
  /**
   * The next free callsign of a session Ferretry starts ITSELF (additive; today's `SystemCallsignIssuer`): the
   * Learning miner and Pack clean-up take `learning-000001` / `pack-00002A`, never a pool name. The counter is
   * persisted (`system-callsigns.json`) and skips every id the running fleet still holds.
   */
  systemCallsign?(prefix: 'warden' | 'learning' | 'pack'): Promise<string>;
  /**
   * What this ferret may control right now (today's "What agents may control"): `limits.yaml`'s `agentControl` over
   * today's defaults, read fresh on every call so a change applies to the ferret's very next action. A ferret this
   * daemon does not know may control nothing.
   */
  agentControl(ferret: FerretId): Promise<AgentControl>;
  /**
   * The harness seam (decision #18, additive): deliver, interrupt and the transcript of one ferret. `undefined` for a
   * ferret this daemon does not know. With `caller` (a ferret acting), only itself and its helpers are reachable, by
   * the same `mayTouch` rule as stop and resume: anyone else is refused with a 403 `forbidden`.
   */
  harness?(ferret: FerretId, caller?: FerretId): Promise<FerretHarness | undefined>;
  /**
   * A ferret's turn documents (additive, U3): what a start and every revive handed it, oldest first. `undefined` for a
   * ferret this daemon does not know. With `caller` (a ferret acting), only itself and its helpers are reachable, by the
   * same `mayTouch` rule as `harness`: anyone else is refused with a 403 `forbidden`, so no agent reads another's turns.
   */
  turns?(ferret: FerretId, caller?: FerretId): Promise<FerretTurns | undefined>;
  /**
   * Moves a ferret onto another runtime (decision #19, additive; today's move of a session): the moves module's flow, whose
   * relaunch is a resume that replaces the live pane through the ordinary launch. Same `mayTouch` rule as above.
   */
  move?(
    ferret: FerretId,
    runtime: string,
    options?: MoveOptions,
    caller?: FerretId,
  ): Promise<Result<FerretSummary, MoveFailure>>;
}

export const FerretsPort = definePort<FerretsApi>('ferrets');

/**
 * A ferret was added, changed state, or went away. A wake-up for views; the truth is `FerretsPort`.
 * State and absence also let Vault end its input values without a needs cycle back to Ferrets (I108).
 * Missing state says nothing about whether the ferret ended: readers keep masking until they know.
 */
export const FerretsChanged = defineEvent(
  'ferrets.changed',
  z.strictObject({
    ferret: z.string().min(1),
    generation: z.number().int(),
    state: FerretStateSchema.optional(),
    gone: z.literal(true).optional(),
  }),
);
