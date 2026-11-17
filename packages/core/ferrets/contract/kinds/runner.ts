import { type FencedPath, type FerretId, REFUSAL_CODES, type RefusalCode } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import type { Brand, Instant, JsonValue, Result } from '@ferretry/std';
import type { RunnerKey } from '../ids.ts';

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
/** The pane behind a handle, as {@link Runner.identify} reads it. Values-free: ids and instants, no path, no text. */
export interface RunnerPaneIdentity {
  readonly handle: RunnerHandle;
  /** The pane's root process; absent for a dead pane the runner keeps. */
  readonly pid?: number;
  /** That root's start (procfs starttime, or `ps` lstart): with the handle and pid it is the pane's identity. */
  readonly processStart?: string;
}

/**
 * A pane id is not an identity (see {@link Runner.stop}). Every member below that reads, types, presses a key at, or
 * answers about the pane behind a handle takes the `ferret` it is for as its LAST argument: given, the runner acts ONLY
 * when the pane's session is that ferret's own and otherwise does what it does for a pane that is gone (a rejection with
 * `not_ready`/`exited` for a write, `undefined`/`''`/`false` for a read) with NOTHING typed, pressed or read. Omitted, the
 * handle alone is trusted (a launch that has just made the pane). Every caller that holds a ferret passes it.
 */
export interface Runner {
  readonly key: RunnerKey;
  start(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>>;
  /**
   * Stops the pane behind `handle`. A pane id is not an identity: a private tmux server hands `%0` out again after it
   * restarts, so a handle a record kept (a converted v4 ferret's, one from before a restart) can name ANOTHER ferret's
   * pane. With `ferret` the runner stops the pane ONLY when it is that ferret's own and otherwise stops nothing; without
   * it the handle alone is trusted (a launch cleanup that has just made the pane). Every caller that holds a ferret passes it.
   */
  stop(handle: RunnerHandle, how: 'polite' | 'now', ferret?: FerretId): Promise<void>;
  resume(spec: RunSpec, harnessConversationId: string): Promise<Result<RunningFerret, StartRefusal>>;
  attach(handle: RunnerHandle): Promise<Result<RunningFerret, AttachRefusal>>;
  alive(handle: RunnerHandle, ferret?: FerretId): Promise<boolean>;
  /**
   * A raw process signal: `interrupt` is the runner's own interrupt key (tmux: `C-c`), which can QUIT a harness at an
   * idle prompt. Never a harness's turn stop: that is {@link Runner.stopTurn}.
   */
  signal(handle: RunnerHandle, signal: 'interrupt' | 'terminate', ferret?: FerretId): Promise<void>;
  /**
   * Delivers one message into the ferret's pane (today's tmux paste-and-keys delivery, which Conversation and the
   * harnesses call). A handle with nothing behind it rejects; it never starts anything. A rejection that knows what
   * happened carries a {@link RunnerDeliveryFailure} on its `deliveryFailure` field (read it with
   * {@link runnerDeliveryFailure}): every kind but `unconfirmed` typed nothing of the message.
   */
  deliver(handle: RunnerHandle, delivery: RunnerDelivery, ferret?: FerretId): Promise<DeliveryOutcome>;
  /**
   * Additive (U3): puts one message into a BUSY pane's own queue (today's tmux `TmuxPaneQueue`), so the harness takes
   * it when its turn ends. Like `deliver`, the runner guards EVERY write it makes with `kernel.act` on that pane itself,
   * so a caller must not wrap it in a second act (the two would wait on each other). A handle with nothing behind it
   * rejects; it never starts anything. Absent: the runner cannot queue, and the harness seam answers `plugin_unavailable`.
   * Its rejections carry a {@link RunnerDeliveryFailure} exactly as `deliver`'s do.
   */
  queue?(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<QueueOutcome>;
  /**
   * Additive (harness-refusals, today's `TmuxSendTerminal.pressStopKey` under `shouldPressStopKey`): reads the ferret's
   * pane ONCE and presses `stop.key` — exactly one keystroke, never `C-c`, never retried — only when
   * {@link shouldPressStopKey} says so for what it read; then reads the pane again for `working`. Like `deliver`, the
   * runner guards the write with `kernel.act` on that pane itself, so a caller must not wrap it in a second act. A pane
   * that is gone rejects with `not_ready`/`exited`, a hold its act meets with `held` (nothing pressed), both on
   * `deliveryFailure`. Absent: the runner cannot stop a turn safely, and the harness seam refuses `plugin_unavailable`.
   */
  stopTurn?(handle: RunnerHandle, stop: RunnerStop, ferret?: FerretId): Promise<RunnerStopOutcome>;
  /**
   * Additive (U3, today's `SessionLifecycleLauncher.settled`): waits, boundedly, until the harness has finished its OWN
   * startup after the first turn was delivered. Delivery is not startup: Codex takes a submission while it is still
   * starting and parks it until its account check answers. Answers `settled` when the harness is up and `timed-out`
   * when the bound passes first (not a failure). Rejects when the pane dies first, with an error that carries
   * `parked: true` (see {@link diedParked}) when a frame showed the first turn parked before the pane died. It only
   * reads: no key is ever written. Absent: the runner cannot tell, and a start does not wait.
   */
  settled?(handle: RunnerHandle, ferret?: FerretId): Promise<'settled' | 'timed-out'>;
  /**
   * Additive (U3, today's `PaneScreenReader.text`): what the pane behind `handle` last showed, dead or alive, so a
   * harness can explain a start that failed ({@link Harness.startFailure}). It only reads, and the text is handed to the
   * harness only: it is never logged, stored or quoted in any answer. A handle with nothing behind it answers `''`.
   */
  lastScreen?(handle: RunnerHandle, ferret?: FerretId): Promise<string>;
  /**
   * Additive (c58-37, Restart CLI and Move): the pane behind `handle` RIGHT NOW, read-only (unlike {@link Runner.attach},
   * which adopts and remembers). It is what a move addresses a pane by: the triple handle, pid and start, because pane ids
   * restart with the runner's server and pids are reused, so a bare handle could name another pane later. `'gone'` ONLY when
   * the pane is PROVED absent; `undefined` when the runner cannot tell, which a caller must treat as unknown, never as
   * gone. It never writes, and it names no path, credential or screen text. Absent: the runner cannot say, and a move
   * finds the pane unknown (it refuses unless the person forces it).
   */
  identify?(handle: RunnerHandle): Promise<RunnerPaneIdentity | 'gone' | undefined>;
  /**
   * Additive (c58-37, the Warden's "ask to stop background jobs"): ONE signal to ONE pid, delivered only if that pid, with
   * this start, descends from this pane's root at the moment of the call. `false`: not delivered (not a descendant, the
   * pid was reused, it is protected, or the pane is gone). Never init, the daemon or its parents. It is the narrowest
   * kill there is: the runner proves descent, so core holds no capability to signal an arbitrary pid. Absent: nothing is
   * signalled, and the job's own pane is left to the person.
   */
  signalDescendant?(
    handle: RunnerHandle,
    pid: number,
    start: string | undefined,
    signal: 'SIGTERM' | 'SIGKILL',
  ): Promise<boolean>;
  /**
   * Additive (U4, today's `StorageTurnPorts.pane` over `PaneFrames`): ONE look at the live ferret pane behind `handle`,
   * read as turn evidence, for Ferrets' turn watch. The runner reads the pane inside `kernel.act(terminal %n, 'read')`
   * itself (a Vault hold refuses it: `undefined`, nothing read), masks the screen inside one `Redaction.read` before it
   * parses it, and keeps no unmasked text in what it answers. It only reads: no key is typed, no size changed. A handle
   * with nothing live behind it, or a pane that is not a ferret's own, answers `undefined`. Absent: the runner cannot be
   * watched, and the ferret's turn is decided from what else is known.
   */
  look?(handle: RunnerHandle, ferret?: FerretId): Promise<RunnerLook | undefined>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.observe`): ONE read of what the ferret's pane shows for a send to
   * decide where a message may go (type it, queue it, revive first). Reads only: no key is typed. The runner reads
   * inside the pane's own binding and masks `blockingPrompt` before it leaves; `draft` is the person's OWN unsent text
   * (as `composer_occupied` carries it) and goes only to the send that must refuse around it. A handle with nothing
   * live behind it answers `undefined`. Absent: the runner cannot be read, so a send cannot prove a pane safe to type
   * into and Conversation refuses (`plugin_unavailable`).
   */
  observe?(handle: RunnerHandle, ferret?: FerretId): Promise<RunnerPaneObservation | undefined>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.heldAt`): where the pane still shows `text` held, in the composer or
   * in the harness's visible queue and nowhere else on screen; `undefined` when it shows it in neither. REJECTS when the
   * pane cannot be read, or its queue runs past what the pane shows: an unread pane proves nothing, and "not held" is
   * what licenses typing a message again. Reads only.
   */
  heldAt?(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<RunnerHeldAt | undefined>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.clearComposer`): erases `text` from the composer ONLY when the
   * composer holds exactly that and nothing else, one `C-u` at a time, reading the composer before each key; a person's
   * own draft is never erased (`foreign`). Like `deliver`, the runner guards every write with `kernel.act` on that pane
   * itself, so a caller must not wrap it in a second act. Its rejections carry a {@link RunnerDeliveryFailure}.
   */
  clearComposer?(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<RunnerComposerCleared>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.submitComposer`): presses Enter ONCE, only when the composer holds
   * exactly `text` at a pane that is not mid-turn or behind a prompt (`strict` also refuses a clipped drawing of it),
   * then watches it leave or not. Guarded and rejecting as {@link Runner.clearComposer} is.
   */
  submitComposer?(
    handle: RunnerHandle,
    text: string,
    strict?: boolean,
    ferret?: FerretId,
  ): Promise<RunnerComposerSubmitted>;
  /**
   * Additive (send path, today's `TmuxSendTerminal.stopActiveTurn`, the send-now's stop): presses the harness's stop
   * key under {@link shouldPressStopKey} exactly as {@link Runner.stopTurn} does, waits boundedly for the pane to come
   * back to a prompt (a wait that gives up is not a failure: the answer is what a READ afterwards shows) and answers that
   * read, or `undefined` when the pane could not be read. Guarded and rejecting as `stopTurn` is.
   */
  stopActiveTurn?(
    handle: RunnerHandle,
    stop: RunnerStop,
    ferret?: FerretId,
  ): Promise<RunnerPaneObservation | undefined>;
  /**
   * Additive (structured questions): ONE capture of the pane behind `handle` for the question-form driver, inside
   * `kernel.act(terminal %n, 'read')` (a hold refuses it: `undefined`), masked before it leaves. Reads only. `undefined`
   * for a handle with nothing live behind it or a pane that is not a ferret's own. Absent: the form cannot be read.
   */
  formCapture?(handle: RunnerHandle, ferret?: FerretId): Promise<RunnerFormCapture | undefined>;
  /**
   * Additive (structured questions): ONE key of {@link FORM_KEYS} typed at the pane, guarded exactly as `deliver`'s
   * writes are (`kernel.act(terminal %n, 'keys')` by the runner itself, so a Vault hold types NOTHING). Rejects with a
   * {@link RunnerDeliveryFailure} as `deliver` does. Absent: the form cannot be driven.
   */
  formKey?(handle: RunnerHandle, key: FormKey, ferret?: FerretId): Promise<void>;
  /**
   * Additive (live model switch): ONE row digit of {@link PICKER_KEYS} typed at the pane for a numbered model picker,
   * guarded exactly as {@link Runner.formKey} is. A SEPARATE member, never a widening of {@link FORM_KEYS}. Absent: a
   * numbered picker cannot be driven.
   */
  pickerKey?(handle: RunnerHandle, key: PickerKey, ferret?: FerretId): Promise<void>;
  /** Additive (structured questions): `text` pasted into the pane as one bracketed paste; guarded as {@link Runner.formKey}. */
  formPaste?(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<void>;
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
  /**
   * The harness is visibly COMPACTING its context (&B188). A subset of `activeWork` that outranks a stored status: a
   * person can start `/compact` from `awaiting_user` or `interrupted`, so those records say nothing about it.
   */
  readonly compacting?: boolean;
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

/**
 * The closed set of keys a structured-question form is driven with (today's v4 driver sends exactly these). A key
 * outside it cannot be named, so the form seam can never be used to type an arbitrary key: no `C-c`, no `y`, and NO
 * DIGIT: a digit CONFIRMS a permission prompt's row the moment it is pressed, so no navigation-only caller can name one.
 */
export const FORM_KEYS = ['Enter', 'Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Space'] as const;
export type FormKey = (typeof FORM_KEYS)[number];

/**
 * The closed set of keys a numbered model picker is driven with: the digit of the row to choose. It is a set of its OWN,
 * pressed through its own runner member ({@link Runner.pickerKey}), so a caller that drives a form or a permission prompt
 * through {@link FORM_KEYS} can never name a digit. Its one caller reads the picker's rows off the pane and re-verifies the
 * row immediately before each press.
 */
export const PICKER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export type PickerKey = (typeof PICKER_KEYS)[number];

/**
 * ONE capture of a ferret's pane for the structured-question driver (today's `PaneState`): the visible screen and the
 * scrollback, MASKED inside one `Redaction.read` before they leave the runner. It is the form's own evidence and goes to
 * the driver only; it is never logged, stored or quoted in any answer.
 */
export interface RunnerFormCapture {
  readonly alive: boolean;
  /** The pane exists but its process is gone. */
  readonly dead: boolean;
  /** The harness is at a prompt and will accept typed input. */
  readonly promptReady: boolean;
  readonly visible: string;
  readonly history: string;
  /** The harness is visibly mid-turn on the VISIBLE frame (terminals' `paneShowsActiveWork`, computed by the runner, which owns that fact). */
  readonly activeWork: boolean;
  /**
   * The runner's own permission-prompt and dialog readers say the VISIBLE frame is one of these, so it is not a question
   * form whatever text it shares with one. A closed code, never the prompt's words. Absent when neither reader claims it.
   */
  readonly blocking?: 'permission' | 'dialog' | undefined;
  /**
   * Additive (stuck-send snapshot): where tmux put the cursor on the VISIBLE frame, zero-based, when it said. The
   * cursor is what tells a composer's placeholder from typed input, so a frame kept to explain a send that could not be
   * typed is unreadable without it. Absent when tmux did not answer.
   */
  readonly cursorX?: number | undefined;
  readonly cursorY?: number | undefined;
}

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
