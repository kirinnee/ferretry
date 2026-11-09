import {
  type FencedPath,
  type FerretId,
  type InstructionEntry,
  REFUSAL_CODES,
  type RefusalCode,
  type SharedTree,
} from '@ferretry/kernel/contract';
import { z } from 'zod';
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
  /**
   * The absolute folders, all inside THIS ferret's own session folder (`FERRET_READABLE_FOLDERS`), its agent is pointed
   * into to read what it was sent. Set by Ferrets only (never a `launch.parts` taker), so no plugin can widen what an
   * agent reads without asking. A harness that asks before reading outside the work folder lets its agent READ these
   * (and only read) without asking, in its own spelling (Claude: `--allowedTools=Read(//<folder>/**)`); one whose
   * sandbox already reads anywhere (Codex) adds nothing. Absent: nothing is pre-allowed.
   */
  readonly readable?: readonly FencedPath[];
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
  | {
      readonly kind: 'skill';
      readonly name: string;
      readonly path: FencedPath;
      /**
       * The skill folder, shared by the plugin that holds it (`kernel.roots.share`, Skills) for the harness that
       * materializes it in the ferret home (`RootHandle.copyShared`). Unforgeable and valid for this launch: it
       * serialises as its folder name only, so a part read back from a record carries no usable tree.
       */
      readonly tree?: SharedTree;
    }
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
/** What a pane that never came to a prompt was doing instead (today's `SendNotReadyCause`): at work, behind a dialog, gone. */
export const PANE_NOT_READY_REASONS = ['busy', 'dialog', 'exited'] as const;
export type PaneNotReadyReason = (typeof PANE_NOT_READY_REASONS)[number];

/**
 * Why a runner's delivery, queue or stop did not do what was asked, CLOSED (today's `SendComposerOccupied`,
 * `SendComposerUnreadable`, `SendPaneNotReady` and `SendLandingUnconfirmed`, plus the hold the runner's own act met).
 * Every kind but `unconfirmed` typed NOTHING of the message, so the same message may go again; `unconfirmed` typed it and
 * nothing proved it landed (`stranded`: it is still in the composer after every Enter), so it must never be typed again.
 * `draft` is what the person had in the composer, carried only so a refusal can show it back to them as today does.
 */
export type RunnerDeliveryFailure =
  | { readonly kind: 'not_ready'; readonly why: PaneNotReadyReason }
  | { readonly kind: 'composer_occupied'; readonly draft: string }
  | { readonly kind: 'composer_unreadable' }
  | { readonly kind: 'held'; readonly code: RefusalCode }
  | { readonly kind: 'unconfirmed'; readonly stranded: boolean };

const RunnerDeliveryFailureSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_ready'), why: z.enum(PANE_NOT_READY_REASONS) }),
  z.strictObject({ kind: z.literal('composer_occupied'), draft: z.string() }),
  z.strictObject({ kind: z.literal('composer_unreadable') }),
  z.strictObject({ kind: z.literal('held'), code: z.enum(REFUSAL_CODES) }),
  z.strictObject({ kind: z.literal('unconfirmed'), stranded: z.boolean() }),
]);

/**
 * The closed failure a runner's rejection carries on its `deliveryFailure` field, or `undefined` for any other
 * rejection (one that says nothing about whether keys went). Parsed, never trusted: a field that is not exactly one of
 * the closed kinds reads as no answer at all, so a runner can never mint a reason (as {@link diedParked} reads `parked`).
 */
export function runnerDeliveryFailure(error: unknown): RunnerDeliveryFailure | undefined {
  if (typeof error !== 'object' || error === null || !('deliveryFailure' in error)) return undefined;
  const parsed = RunnerDeliveryFailureSchema.safeParse(error.deliveryFailure);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The stop keys a runner may press for a harness, CLOSED: `Escape` ends the current turn in both harness TUIs. `C-c`
 * is deliberately absent — it is the QUIT path (Codex exits on it at an idle prompt), so no harness can ask for it.
 */
export const HARNESS_STOP_KEYS = ['Escape'] as const;
export type HarnessStopKey = (typeof HARNESS_STOP_KEYS)[number];

/** How a harness's turn is stopped: its key, and whether that key is harmless at an idle prompt. */
export interface HarnessStop {
  readonly key: HarnessStopKey;
  /**
   * The key does nothing harmful at an idle prompt (Claude Code: it clears a half-typed composer or closes a menu,
   * which is what "stop" means to the person at an interactive pane). `false` for Codex, which can QUIT on it there.
   */
  readonly safeWhenIdle: boolean;
}

/** One stop a runner is asked to press: the key, and whether it may be pressed at a pane that shows no active work. */
export interface RunnerStop {
  readonly key: HarnessStopKey;
  readonly whenIdle: boolean;
}

/** What a stop did: whether the key was pressed, and whether the pane still showed active work after (unread: absent). */
export interface RunnerStopOutcome {
  readonly pressed: boolean;
  readonly working?: boolean;
}

/**
 * Today's `shouldPressStopKey`, the rule every stop obeys: press only while the pane shows active work, or where the
 * key is harmless at an idle prompt. IT IS A SAFETY RULE: a stop key sent to a pane that was merely believed to be working
 * can QUIT the agent it was asked to pause.
 */
export function shouldPressStopKey(working: boolean, stop: RunnerStop): boolean {
  return working || stop.whenIdle;
}

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
  /**
   * A raw process signal: `interrupt` is the runner's own interrupt key (tmux: `C-c`), which can QUIT a harness at an
   * idle prompt. Never a harness's turn stop: that is {@link Runner.stopTurn}.
   */
  signal(handle: RunnerHandle, signal: 'interrupt' | 'terminate'): Promise<void>;
  /**
   * Delivers one message into the ferret's pane (today's tmux paste-and-keys delivery, which Conversation and the
   * harnesses call). A handle with nothing behind it rejects; it never starts anything. A rejection that knows what
   * happened carries a {@link RunnerDeliveryFailure} on its `deliveryFailure` field (read it with
   * {@link runnerDeliveryFailure}): every kind but `unconfirmed` typed nothing of the message.
   */
  deliver(handle: RunnerHandle, delivery: RunnerDelivery): Promise<DeliveryOutcome>;
  /**
   * Additive (U3): puts one message into a BUSY pane's own queue (today's tmux `TmuxPaneQueue`), so the harness takes
   * it when its turn ends. Like `deliver`, the runner guards EVERY write it makes with `kernel.act` on that pane itself,
   * so a caller must not wrap it in a second act (the two would wait on each other). A handle with nothing behind it
   * rejects; it never starts anything. Absent: the runner cannot queue, and the harness seam answers `plugin_unavailable`.
   * Its rejections carry a {@link RunnerDeliveryFailure} exactly as `deliver`'s do.
   */
  queue?(handle: RunnerHandle, text: string): Promise<QueueOutcome>;
  /**
   * Additive (harness-refusals, today's `TmuxSendTerminal.pressStopKey` under `shouldPressStopKey`): reads the ferret's
   * pane ONCE and presses `stop.key` — exactly one keystroke, never `C-c`, never retried — only when
   * {@link shouldPressStopKey} says so for what it read; then reads the pane again for `working`. Like `deliver`, the
   * runner guards the write with `kernel.act` on that pane itself, so a caller must not wrap it in a second act. A pane
   * that is gone rejects with `not_ready`/`exited`, a hold its act meets with `held` (nothing pressed), both on
   * `deliveryFailure`. Absent: the runner cannot stop a turn safely, and the harness seam refuses `plugin_unavailable`.
   */
  stopTurn?(handle: RunnerHandle, stop: RunnerStop): Promise<RunnerStopOutcome>;
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
  /**
   * Additive (U4, today's `StorageTurnPorts.pane` over `PaneFrames`): ONE look at the live ferret pane behind `handle`,
   * read as turn evidence, for Ferrets' turn watch. The runner reads the pane inside `kernel.act(terminal %n, 'read')`
   * itself (a Vault hold refuses it: `undefined`, nothing read), masks the screen inside one `Redaction.read` before it
   * parses it, and keeps no unmasked text in what it answers. It only reads: no key is typed, no size changed. A handle
   * with nothing live behind it, or a pane that is not a ferret's own, answers `undefined`. Absent: the runner cannot be
   * watched, and the ferret's turn is decided from what else is known.
   */
  look?(handle: RunnerHandle): Promise<RunnerLook | undefined>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.observe`): ONE read of what the ferret's pane shows for a send to
   * decide where a message may go (type it, queue it, revive first). Reads only: no key is typed. The runner reads
   * inside the pane's own binding and masks `blockingPrompt` before it leaves; `draft` is the person's OWN unsent text
   * (as `composer_occupied` carries it) and goes only to the send that must refuse around it. A handle with nothing
   * live behind it answers `undefined`. Absent: the runner cannot be read, so a send cannot prove a pane safe to type
   * into and Conversation refuses (`plugin_unavailable`).
   */
  observe?(handle: RunnerHandle): Promise<RunnerPaneObservation | undefined>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.heldAt`): where the pane still shows `text` held, in the composer or
   * in the harness's visible queue and nowhere else on screen; `undefined` when it shows it in neither. REJECTS when the
   * pane cannot be read, or its queue runs past what the pane shows: an unread pane proves nothing, and "not held" is
   * what licenses typing a message again. Reads only.
   */
  heldAt?(handle: RunnerHandle, text: string): Promise<RunnerHeldAt | undefined>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.clearComposer`): erases `text` from the composer ONLY when the
   * composer holds exactly that and nothing else, one `C-u` at a time, reading the composer before each key; a person's
   * own draft is never erased (`foreign`). Like `deliver`, the runner guards every write with `kernel.act` on that pane
   * itself, so a caller must not wrap it in a second act. Its rejections carry a {@link RunnerDeliveryFailure}.
   */
  clearComposer?(handle: RunnerHandle, text: string): Promise<RunnerComposerCleared>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.submitComposer`): presses Enter ONCE, only when the composer holds
   * exactly `text` at a pane that is not mid-turn or behind a prompt (`strict` also refuses a clipped drawing of it),
   * then watches it leave or not. Guarded and rejecting as {@link Runner.clearComposer} is.
   */
  submitComposer?(handle: RunnerHandle, text: string, strict?: boolean): Promise<RunnerComposerSubmitted>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.stopActiveTurn`, the send-now's stop): presses the harness's stop
   * key under {@link shouldPressStopKey} exactly as {@link Runner.stopTurn} does, waits boundedly for the pane to come
   * back to a prompt (a wait that gives up is not a failure: the answer is what a READ afterwards shows) and answers that
   * read, or `undefined` when the pane could not be read. Guarded and rejecting as `stopTurn` is.
   */
  stopActiveTurn?(handle: RunnerHandle, stop: RunnerStop): Promise<RunnerPaneObservation | undefined>;
  /**
   * Additive (W2-a, today's `TmuxSessionExitObserver.exitOf` `gone` proof): whether the runner PROVES that `ferret`'s own
   * terminal is not there at all (tmux: the ferret's session cannot be found, or the private server is not running,
   * which takes every pane with it). `false` for a live terminal, one tmux kept dead with an exit status (an agent that
   * ended on its own), and for ANY answer that proves nothing (a refused socket, a server that went away mid-request).
   * Asked by the ferret, never by a handle, because a handle can name another pane after the server restarted. It only
   * asks: nothing is started, typed or killed. Absent: nothing is ever proven gone, so nothing is auto-resumed.
   */
  gone?(ferret: FerretId): Promise<boolean>;
}

/**
 * What one {@link Runner.look} saw, already parsed and masked (today's `TurnPaneEvidence` plus the frame it was read
 * from). `request` and `dialog` are the runner's parse of a tool-permission prompt and a harness dialog, as plain data:
 * Ferrets parses them again at its boundary and drops what does not parse, so a runner cannot put an arbitrary value
 * into a ferret's state.
 */
export interface RunnerLook {
  /**
   * A digest of the masked screen this look was read from. Two looks with the same `frame` read the same screen: the
   * turn watch reads an unchanged frame as an idle pane and looks at it less often. Never the text itself.
   */
  readonly frame: string;
  /** The harness's own working line: spinner, elapsed clock, token counter or interrupt hint. */
  readonly working: boolean;
  /** `working` rests on a spinner-shaped line alone. */
  readonly spinnerOnly?: boolean;
  /** An idle prompt the harness would accept a message at. */
  readonly atPrompt: boolean;
  /** A permission (or other choice) prompt nothing moves past until a person answers. */
  readonly permission: boolean;
  /** A harness dialog the ferret is parked on, as the (masked) words a person is shown for it. */
  readonly prompt?: string;
  /** The tool-permission prompt on screen, read as data (masked). */
  readonly request?: JsonValue;
  /** The harness's own dialog on screen, read as data (masked). */
  readonly dialog?: JsonValue;
  /**
   * Additive (U5): the LAST lines of the masked frame (at most {@link RUNNER_LOOK_STATUS_LINES} lines and
   * {@link RUNNER_LOOK_STATUS_BYTES} characters), where a harness paints its status line. The live readout reads its verb
   * and a compaction's progress from it and from nothing else, and re-masks the verb before it leaves; it is never kept,
   * logged, journalled or sent as text. Absent: the runner offers no status lines.
   */
  readonly status?: string;
}

/**
 * What one {@link Runner.observe} read of a ferret's pane (today's `SendPaneObservation`), as plain data. Every text in it
 * was read from a masked screen: `blockingPrompt` is masked again by the runner. `draft` is NOT masked: it is the
 * person's own unsent words exactly as the pane shows them (as today's 409 `composer_occupied` carries them), so a
 * secret the person pasted there is in it. It must never be logged, stored or journalled by a caller.
 */
export interface RunnerPaneObservation {
  readonly alive: boolean;
  /** The pane exists but its process is gone: a shell that outlived its agent. */
  readonly dead: boolean;
  /** The harness is at a prompt and will accept typed input. */
  readonly promptReady: boolean;
  /** The harness is visibly mid-turn (a half-typed draft is neither this nor prompt-ready). */
  readonly activeWork: boolean;
  /** Codex accepted a submission and PARKED it until its startup ends: the composer text is not a draft. */
  readonly startupParked?: boolean;
  /** A harness dialog, permission prompt or picker the pane is parked on, in the words a person is shown for it. */
  readonly blockingPrompt?: string;
  /** Input typed in the composer and not submitted: anything typed now would be submitted joined to it. */
  readonly draft?: string;
}

/** Where a pane shows a message held: typed in the composer, or in the harness's own queue (today's `SendHeldAt`). */
export type RunnerHeldAt = 'composer' | 'queue';
/** What erasing a message from the composer did (today's `ComposerClearOutcome`). */
export type RunnerComposerCleared = 'cleared' | 'absent' | 'foreign' | 'stuck';
/** What pressing Enter on a message in the composer did (today's `ComposerSubmitOutcome`). */
export type RunnerComposerSubmitted = 'submitted' | 'holding' | 'absent';

/** How many of a frame's last lines {@link RunnerLook.status} carries (the live readout's status window). */
export const RUNNER_LOOK_STATUS_LINES = 25;
/** The most characters {@link RunnerLook.status} carries, counted from its end. */
export const RUNNER_LOOK_STATUS_BYTES = 4_096;

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

// ─── transcript tail (U5): what the turn watch and the live readout read from a conversation ─────────────────────────

/**
 * One record of a harness's conversation as the turn watch and the live readout read it: WHAT happened and WHEN, never
 * what was said. No record carries message, reasoning or tool text, so nothing here needs masking; the one sentence a
 * record may carry is a usage-limit `notice`, already masked and bounded by the harness.
 */
export type HarnessTailRecord =
  | {
      /** A message. `inputSource` marks one the harness itself wrote into the user channel (never something the owner said). */
      readonly kind: 'message';
      readonly role: 'user' | 'assistant' | 'developer' | 'system';
      readonly at?: Instant;
      readonly inputSource?: 'native-queue' | 'harness';
    }
  | {
      /** Reasoning, a tool call or a tool result: the agent is mid-turn. */
      readonly kind: 'work';
      readonly at?: Instant;
    }
  | { readonly kind: 'turn'; readonly state: 'started' | 'completed' | 'aborted'; readonly at?: Instant }
  | {
      /** One model call's spend. `call` names the call when the harness writes several records for one. */
      readonly kind: 'usage';
      readonly at?: Instant;
      readonly call?: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly cacheCreationInputTokens?: number;
      readonly contextTokens?: number;
    }
  | {
      readonly kind: 'compaction';
      readonly at?: Instant;
      readonly trigger?: 'manual' | 'auto';
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
    }
  | {
      /** A turn's error. `code` is the harness's own; `notice` is its first sentence, masked and short. */
      readonly kind: 'error';
      readonly at?: Instant;
      readonly code?: string;
      readonly notice?: string;
    };

/**
 * The transcript a harness proved to be one ferret's, as a stat: `file` names it (compared, never opened by Ferrets and
 * never leaving the daemon), and the pair `size`/`mtimeMs` moves whenever the harness writes to it.
 */
export interface HarnessTranscriptStamp {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** The newest records of a ferret's transcript, oldest first. `unresolved`: no transcript is proved to be this ferret's yet. */
export type HarnessTranscriptTail =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly records: readonly HarnessTailRecord[] };

// ─── launch settings (W2-c): whether a relaunch would run a ferret on other harness settings ──────────────────────────

/**
 * The parts of a harness's own launch settings it compares, by NAME only: the permission mode, the fixed layer it adds
 * to every launch, and (Claude Code) the settings and hooks items it writes into the home. A closed list, so an answer
 * can never carry anything but one of these words.
 */
export const HARNESS_LAUNCH_SECTIONS = ['permission-mode', 'fixed-layer', 'settings', 'hooks'] as const;
export type HarnessLaunchSection = (typeof HARNESS_LAUNCH_SECTIONS)[number];

/**
 * Whether the settings the harness launched a ferret under differ from the ones it would launch it under now (today's
 * `FileLaunchSettingsDigest` comparison, taken by the harness over its OWN files and configuration). Values-free by
 * construction: `drifted` names sections and nothing else; no setting value, hash, path or environment value leaves
 * the harness. `unknown` when nothing was recorded at the launch, or what was recorded cannot be read: a stale-settings
 * claim made without evidence would be a guess.
 */
export type HarnessLaunchSettings =
  | { readonly kind: 'current' }
  | { readonly kind: 'drifted'; readonly sections: readonly HarnessLaunchSection[] }
  | { readonly kind: 'unknown' };

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
  /**
   * Additive (harness-refusals): how this harness's turn is stopped — the key (today's `Escape` in both TUIs) and
   * whether it is harmless at an idle prompt (today's `STOP_KEY_SAFE_WHEN_IDLE`, Claude Code only). Absent: the harness
   * names no safe stop, and an interrupt is refused rather than guessed.
   */
  readonly turnStop?: HarnessStop;
  /**
   * Additive (U5): one stat of the transcript this harness proved to be the ferret's own (the same file `transcript` and
   * `usage` read), or `undefined` while none is proved or the file cannot be read. Cheap by contract: the live readout
   * and the transcript-change signal ask it every half second to learn whether the file was written. Absent: the
   * harness offers no transcript tail, and the ferret's turn is decided from its pane alone.
   */
  transcriptStamp?(ferret: FerretId): Promise<HarnessTranscriptStamp | undefined>;
  /**
   * Additive (U5): the newest `limit` records of that transcript as {@link HarnessTailRecord}s: kinds, roles and
   * instants, never message text. Ferrets asks only when the stamp moved. Absent: see {@link transcriptStamp}.
   */
  transcriptTail?(ferret: FerretId, limit: number): Promise<HarnessTranscriptTail>;
  /**
   * Additive (W2-c, RULING #27 Q9): whether a relaunch of this ferret would run on other settings of this harness's own
   * than its last start or resume did. The harness records what it launched under (in its own state, never in the
   * ferret's home) and compares it with its configuration now; Ferrets never reads a harness's files. Total: a damaged
   * or missing record is `unknown`, never a throw. Absent: Ferrets claims nothing about this harness's settings.
   */
  launchSettings?(ferret: FerretId): Promise<HarnessLaunchSettings>;
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
