import type { FencedPath, FerretId, InstructionEntry } from '@ferretry/kernel/contract';
import type { ChildEnvironment, InputRequestId } from '@ferretry/core-vault/contract';
import type { Brand, Instant, JsonValue, Result } from '@ferretry/std';
import type { FerretRole, HarnessKey, LoginKindKey, PackId, RunnerKey } from './ids.ts';
import type { StartOptions } from './port.ts';

/**
 * The kinds Ferrets offers (§4.3 harness, §4.4 login, §4.6 runner): the interfaces a plugin's provide hook value
 * implements. Each has a conformance suite in `@ferretry/core-ferrets/contract/testing`. A harness never reads its
 * own sign-in files; a runner never sees a secret value (the Vault resolves `${secret:…}` into a `ChildEnvironment`).
 */

// ─── launch ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Everything one start of one ferret is: identity, where, which harness and login, and what plugins added. */
export interface LaunchSpec {
  readonly ferret: FerretId;
  readonly name: string;
  readonly role: FerretRole;
  readonly parent?: FerretId;
  readonly pack?: PackId;
  readonly harness: HarnessKey;
  readonly runtime?: string;
  readonly login?: string;
  readonly model?: string;
  readonly effort?: string;
  /** The work folder, fenced (`WorkFolders`). */
  readonly folder: FencedPath;
  /** The ferret's home under the harness's own `agent-homes` root: the harness's `homeFor` answer, unchanged. */
  readonly home: FencedPath;
  /** Instructions from the post-build snapshot, filtered by `when`, ordered. */
  readonly instructions: readonly InstructionEntry[];
  /** What `launch.parts` takers added for this ferret. */
  readonly parts: readonly LaunchPart[];
  /** The first message, when the owner gave one. */
  readonly prompt?: string;
  readonly harnessConversation?: string;
  /**
   * The start's options as they were given (today's start fields: harness flags, fast, remote control, the supervision
   * timers, …), kept in `details.json` so every resume launches with the same ones. `model` and `effort` are also
   * lifted to their own fields above.
   */
  readonly options?: Omit<StartOptions, 'title'>;
}

/** One piece a plugin adds to a launch (`launch.parts`): an MCP server, a skill, a shell, an instruction, env. */
export type LaunchPart =
  | { readonly kind: 'mcp'; readonly name: string; readonly config: JsonValue }
  | { readonly kind: 'skill'; readonly name: string; readonly path: FencedPath }
  | { readonly kind: 'shell'; readonly name: string; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: 'instruction'; readonly id: string; readonly text: string }
  /** Names and `${secret:NAME}` references only; never a value. */
  | { readonly kind: 'env'; readonly env: Readonly<Record<string, string>> };

/** What a `launch.parts` taker contributes: a source asked per launch (a contribute item is static; the parts are not). */
export interface LaunchPartSource {
  parts(spec: Omit<LaunchSpec, 'parts'>): Promise<readonly LaunchPart[]>;
}

// ─── runner (§4.6, spine D15) ─────────────────────────────────────────────────────────────────────────────────────

/** Where a running ferret is, as its runner names it (Terminals: the tmux pane id, `%12`). Not a secret. */
export type RunnerHandle = Brand<string, 'RunnerHandle'>;

/** What a runner starts: the harness's command, in the work folder, with the Vault-resolved environment. */
export interface RunSpec {
  readonly ferret: FerretId;
  readonly command: readonly string[];
  readonly cwd: FencedPath;
  readonly env: ChildEnvironment;
  /** The ferret's limits (`limits.yaml`), as the kernel's spawn port applies them. */
  readonly limits?: JsonValue;
}

export interface RunningFerret {
  readonly handle: RunnerHandle;
  readonly pid?: number;
  readonly startedAt: Instant;
}

/**
 * Why a runner did not start a ferret: CLOSED, so a runner can never mint a reason. `real_harness` is a daemon a test
 * booted refusing a launch that would reach (or could not be proved not to reach) the owner's real Claude Code or
 * Codex; Ferrets answers it with {@link REAL_HARNESS_REFUSED} as the start's reason.
 */
export type StartRefusal = 'unavailable' | 'failed' | 'limits' | 'real_harness';

/** The start failure's reason for a `real_harness` refusal; the runner logs the harness and the path it found. */
export const REAL_HARNESS_REFUSED =
  'test mode refused to launch a real claude/codex: a test must put a fake claude/codex first on the daemon PATH, ' +
  'and set no PATH of its own, before it starts a session';

/**
 * One message for a running ferret's pane (today's `TmuxPaneDelivery.deliver`): the text pasted and submitted, the
 * answer to Claude Code's large-session resume gate (`full`, the default, keeps fidelity; `summary` saves quota;
 * option 3 is never chosen), and an optional step run immediately before the write lands.
 */
export interface RunnerDelivery {
  readonly text: string;
  readonly resumeMenuChoice?: 'full' | 'summary';
  readonly beforeWrite?: () => Promise<void>;
}

/** Today's `InjectionOutcome`: the text started a turn, or the harness handled it locally (a slash command). */
export type DeliveryOutcome = 'turn-started' | 'handled-local';

/**
 * What putting a message into a BUSY pane's own queue proved (today's `PaneQueueOutcome`): `held`, the harness shows it
 * in its queue; `typed`, it is still in the composer after the submit and queue keys (a TUI will not send it on its own
 * when the turn ends); `left`, it left the composer and no queue shows it, so only the transcript can say where it went.
 */
export type QueueOutcome = 'held' | 'typed' | 'left';
/** Why `attach` would not adopt a handle: nothing there, not a ferret of ours, or not the ferret named. */
export type AttachRefusal = 'gone' | 'not-a-ferret' | 'mismatch' | 'unsupported';

/**
 * The value of `runners:<key>`. `attach` adopts an existing live process or pane by its handle WITHOUT restarting it
 * (spine D15): the 5.0 switch hands v5 the handles of running ferrets from outside the product.
 */
export interface Runner {
  readonly key: RunnerKey;
  start(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>>;
  stop(handle: RunnerHandle, how: 'polite' | 'now'): Promise<void>;
  resume(spec: RunSpec, harnessConversationId: string): Promise<Result<RunningFerret, StartRefusal>>;
  attach(handle: RunnerHandle): Promise<Result<RunningFerret, AttachRefusal>>;
  alive(handle: RunnerHandle): Promise<boolean>;
  signal(handle: RunnerHandle, signal: 'interrupt' | 'terminate'): Promise<void>;
  /**
   * Delivers one message into the ferret's pane (today's tmux paste-and-keys delivery, which Conversation and the
   * harnesses call). A handle with nothing behind it rejects; it never starts anything.
   */
  deliver(handle: RunnerHandle, delivery: RunnerDelivery): Promise<DeliveryOutcome>;
  /**
   * Additive (U3): puts one message into a BUSY pane's own queue (today's tmux `TmuxPaneQueue`), so the harness takes
   * it when its turn ends. Like `deliver`, the runner guards EVERY write it makes with `kernel.act` on that pane itself,
   * so a caller must not wrap it in a second act (the two would wait on each other). A handle with nothing behind it
   * rejects; it never starts anything. Absent: the runner cannot queue, and the harness seam answers `plugin_unavailable`.
   */
  queue?(handle: RunnerHandle, text: string): Promise<QueueOutcome>;
  /**
   * Additive (U3, today's `SessionLifecycleLauncher.settled`): waits, boundedly, until the harness has finished its OWN
   * startup after the first turn was delivered. Delivery is not startup: Codex takes a submission while it is still
   * starting and parks it until its account check answers. Answers `settled` when the harness is up and `timed-out`
   * when the bound passes first (not a failure). Rejects when the pane dies first, with an error that carries
   * `parked: true` (see {@link diedParked}) when a frame showed the first turn parked before the pane died. It only
   * reads: no key is ever written. Absent: the runner cannot tell, and a start does not wait.
   */
  settled?(handle: RunnerHandle): Promise<'settled' | 'timed-out'>;
  /**
   * Additive (U3, today's `PaneScreenReader.text`): what the pane behind `handle` last showed, dead or alive, so a
   * harness can explain a start that failed ({@link Harness.startFailure}). It only reads, and the text is handed to the
   * harness only: it is never logged, stored or quoted in any answer. A handle with nothing behind it answers `''`.
   */
  lastScreen?(handle: RunnerHandle): Promise<string>;
}

/**
 * Whether a rejection of {@link Runner.settled} says the first turn was seen parked behind the harness's startup
 * before the pane died (today's `diedParked`). Only that proves the turn never ran; any other failure leaves it unknown.
 */
export function diedParked(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'parked' in error && error.parked === true;
}

// ─── harness (§4.3) ───────────────────────────────────────────────────────────────────────────────────────────────

export type HarnessInstall = { readonly found: true; readonly binary: string; readonly version: string };
export type HarnessMissing = { readonly found: false; readonly reason: string };
export type UpdateResult = { readonly updated: boolean; readonly version?: string; readonly sentence: string };

/** What `prepareHome` wrote, inside the ferret's home only. */
export interface HomePlan {
  readonly files: readonly FencedPath[];
  /** Extra argv the harness's command takes for what it wrote (a system prompt flag). */
  readonly args: readonly string[];
}

export interface Started {
  readonly running: RunningFerret;
  readonly harnessConversation?: string;
}

/** A turn in a ferret's conversation, as a harness names it. */
export interface TurnRef {
  readonly turn: number;
  readonly entry?: string;
}

export interface ForkPlan {
  readonly from: FerretId;
  readonly at?: TurnRef;
  readonly harnessConversation: string;
}

/** A message to a ferret. Idempotent by `id`: delivering one id twice delivers it once. */
export interface OutboundMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments?: readonly FencedPath[];
}

export type Delivery =
  | { readonly status: 'delivered' | 'queued'; readonly id: string }
  | { readonly status: 'refused'; readonly id: string; readonly reason: string };

/** One transcript entry, already masked when it leaves the reader. */
export interface TranscriptEntry {
  readonly id: string;
  readonly at: Instant;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly text?: string;
  readonly data?: JsonValue;
}

export interface TranscriptReader {
  read(ferret: FerretId, after?: string, limit?: number): Promise<readonly TranscriptEntry[]>;
  follow(ferret: FerretId, signal: AbortSignal): AsyncIterable<TranscriptEntry>;
  find(ferret: FerretId, entry: string): Promise<TranscriptEntry | undefined>;
}

/**
 * A {@link TranscriptReader} bound to one ferret: the harness seam hands it out for the ferret it was opened for, and it
 * takes no ferret argument, so it can read no other ferret's conversation.
 */
export interface BoundTranscriptReader {
  read(after?: string, limit?: number): Promise<readonly TranscriptEntry[]>;
  follow(signal: AbortSignal): AsyncIterable<TranscriptEntry>;
  find(entry: string): Promise<TranscriptEntry | undefined>;
}

export interface TurnUsage {
  readonly turn: number;
  readonly at: Instant;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface UsageReader {
  turns(ferret: FerretId, since?: Instant): Promise<readonly TurnUsage[]>;
}

/** A permission prompt or question the harness shows, with its choices. */
export interface HarnessDialog {
  readonly id: string;
  readonly kind: 'permission' | 'question' | 'harness';
  readonly prompt: string;
  readonly choices: readonly string[];
}

export interface DialogReader {
  current(ferret: FerretId): Promise<HarnessDialog | undefined>;
  answer(ferret: FerretId, dialog: string, choice: string): Promise<Delivery>;
}

/** One of the harness's own conversations on this machine (§6.2), for import as a link. */
export interface FoundConversation {
  readonly id: string;
  readonly folder: string;
  readonly title?: string;
  readonly updatedAt: Instant;
}

export interface ConversationFinder {
  list(folder?: FencedPath): Promise<readonly FoundConversation[]>;
}

/** The value of `harnesses:<key>` (§4.3). */
export interface Harness {
  readonly key: HarnessKey;
  /** Binary and version; never reads its sign-in files. */
  discover(): Promise<HarnessInstall | HarnessMissing>;
  update?(): Promise<UpdateResult>;
  /** Which login kinds it can spend. */
  readonly accepts: readonly LoginKindKey[];
  /**
   * The ferret's home, which only the harness can name: it resolves its own `state/<harness>/agent-homes/<ferret>`
   * through its OWN `agent-homes` root (scope `{ ferret, subfolder: ferret }`), never a path Ferrets built. The answer
   * is a canonical absolute ASCII path: already normalized, no `.` or `..` segment, no doubled or trailing `/`, and
   * never `/` itself. Ferrets asks for it before every start and launches with exactly this answer in `LaunchSpec.home`;
   * a harness that throws or answers any other spelling is not started (fail closed). It must also answer a plain
   * probe id (`home-probe`, never minted) with a home that neither equals, holds nor sits inside the ferret's own.
   * Resolving names a path only: the folder is created and narrowed (0700) by `prepareHome`.
   */
  homeFor(ferret: FerretId): Promise<FencedPath>;
  /**
   * Writes instructions, MCP config and skills in its own format, inside the ferret's home only, after creating or
   * narrowing that home privately. Refuses a `spec.home` that is not its own `homeFor` answer. Ferrets calls it
   * before every start and resume, before the runner is asked for anything.
   */
  prepareHome(spec: LaunchSpec): Promise<HomePlan>;
  start(spec: LaunchSpec, runner: Runner, env: ChildEnvironment): Promise<Result<Started, StartRefusal>>;
  resume(
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    harnessConversation: string,
  ): Promise<Result<Started, StartRefusal>>;
  fork?(from: FerretId, at?: TurnRef): Promise<ForkPlan>;
  stop(ferret: FerretId, handle: RunnerHandle, runner: Runner, how: 'polite' | 'now'): Promise<void>;
  deliver(ferret: FerretId, handle: RunnerHandle, message: OutboundMessage): Promise<Delivery>;
  /**
   * Additive (U3, today's `RuntimeSupervisedLauncher` explanation): the sentence a person can act on for a start whose
   * first turn could not be typed or whose pane died while starting, read off what the pane last showed
   * ({@link Runner.lastScreen}), or `undefined` when the screen says nothing this harness recognises. The answer is a
   * FIXED sentence of the harness's own: it never quotes the screen. Absent: no harness explanation.
   */
  startFailure?(screen: string): string | undefined;
  readonly transcript: TranscriptReader;
  readonly usage: UsageReader;
  readonly dialogs?: DialogReader;
  readonly conversations: ConversationFinder;
}

// ─── login (§4.4) ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LoginField {
  readonly id: string;
  readonly label: string;
  /** A secret field is asked on an input card and lives only in the Vault. */
  readonly secret: boolean;
}

/** How a sign-in proceeds: a browser OAuth page, a device code on a card, or a key typed on an input card. */
export type SignInFlow =
  | { readonly kind: 'browser'; readonly url: string }
  | { readonly kind: 'device-code'; readonly url: string; readonly code: string }
  | { readonly kind: 'input'; readonly request: InputRequestId }
  | { readonly kind: 'done' };

export type LoginStatus =
  | { readonly state: 'signed-in'; readonly refreshDue?: Instant }
  | { readonly state: 'signed-out' | 'expired'; readonly sentence: string };

export interface LoginQuota {
  readonly fiveHourPercent?: number;
  readonly weeklyPercent?: number;
  readonly resetsAt?: Instant;
}

/** The value of `logins:<kind>` (§4.4). Values live only in the Vault; `env` returns `${secret:NAME}` references. */
export interface LoginKind {
  readonly key: LoginKindKey;
  readonly fields: readonly LoginField[];
  /** Which harnesses can spend it. */
  readonly harnesses: readonly HarnessKey[];
  signIn(login: string): Promise<SignInFlow>;
  status(login: string): Promise<LoginStatus>;
  refresh?(login: string): Promise<LoginStatus>;
  quota?(login: string): Promise<LoginQuota | undefined>;
  /** The environment or config the harness needs, values as `${secret:NAME}` only. */
  env(login: string, harness: HarnessKey): Promise<Readonly<Record<string, string>>>;
}

// ─── sitrep ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One line of a ferret's sitrep from a plugin (`sitrep.lines`). Blockers come from the Asks port, not from here. */
export interface SitrepLine {
  readonly kind: 'doing' | 'card' | 'turn' | 'note';
  readonly text: string;
  /** A reference the app renders (`&F12`, `!A3`). */
  readonly ref?: string;
  readonly at?: Instant;
}

export interface SitrepLineSource {
  lines(ferret: FerretId): Promise<readonly SitrepLine[]>;
}
