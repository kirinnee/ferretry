import type { FerretId } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import type { LaunchOrigin } from '../launch-origin.ts';
import { CompactAtSchema } from '../view/compact-at.ts';
import {
  FerretCardIdSchema,
  type FerretRole,
  type FerretSummary,
  FerretTitleSchema,
  type HarnessKey,
  type PackId,
} from '../ids.ts';
import type { RunnerHandle } from '../kinds.ts';

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
 * Padded standard base64, checked in LINEAR time: whole four-character groups of the base64 alphabet, with at most two
 * `=` and only at the very end. Today's protocol used one backtracking pattern
 * (`^(?:[A-Za-z0-9+/]{4})*(?:…==|…=)?$`) that answers false for VALID base64 once the text passes about 6.9 M characters
 * on Bun (a file of about 5 MiB), so a start under the stated 32 MiB bound was refused as malformed. This check holds
 * for any length the transport lets through.
 */
const isPaddedBase64 = (text: string): boolean => text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(text);

/**
 * One file attached to a start's opening message (today's `fy start -f`, `protocol/src/lib/session.ts`
 * `StartSessionBaseSchema.initialAttachments`): the bytes travel INLINE as base64 in the start body, read by the CLI on
 * the caller's machine. The count and size bounds are the receiving Conversation's (its `decodeInitialAttachments`:
 * sixteen files, 32 MiB decoded in all), as today's daemon's were, and their refusal is a sentence naming the limit; the
 * transport's body cap sits just above one 32 MiB file. The schema states the shape only.
 */
export const InitialAttachmentSchema = z.strictObject({
  filename: z.string().min(1),
  mime: z.string().min(1).optional(),
  base64: z
    .string()
    .min(1)
    .refine(isPaddedBase64, { message: 'an attachment must be padded standard base64 (A-Z, a-z, 0-9, +, /, =)' }),
});
export type InitialAttachment = z.infer<typeof InitialAttachmentSchema>;

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
  /**
   * Where this ferret's harness compacts its own conversation, in tokens, or `auto` (docs/compact-at.md). Its OWN value:
   * it overrides the login's default on every launch, and `auto` suppresses a numeric default. A value larger than the
   * launch model's window is not used (the launch falls back to Auto), as v4's `resolveCompactAt` did.
   */
  compactAt: CompactAtSchema.optional(),
  /** `auto` for an autonomous teammate (needs a prompt), `interactive` for a human terminal. */
  mode: z.enum(['auto', 'interactive']).optional(),
  /**
   * `fy new --auto`: let Ferretry choose — the models the routing prompt names, in its order, then the ready one with
   * the most headroom. Never together with a named runtime.
   */
  auto: z.boolean().optional(),
  /**
   * `fy new --allow-scratch`, a request fact (never stored). Absent: nobody asked for the temporary-folder check (a plain
   * `fy start`). `false`: `fy new` asks for it — a helper may not start in a temporary folder the caller NAMED. `true`: the
   * caller says a temporary folder is meant. The check itself is a `start.decide` taker's (Packs).
   */
  allowScratch: z.boolean().optional(),
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
  /**
   * Files attached to the opening message (`start -f`). A start's own request only: the start hands them to the
   * attachment owner and writes none into the ferret's `details.json` (that file omits this member), so the bytes live
   * only in the ferret's own `attachments/` folder.
   */
  initialAttachments: z.array(InitialAttachmentSchema).optional(),
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
  readonly by: 'owner' | 'ferret' | 'pack' | 'board' | 'warden';
  /**
   * `fy start --detach` (v4's meaning): answer as soon as the ferret is recorded (`starting`); the launch carries on in the
   * background and a launch that fails settles the ferret as a failed start, as any other does. A request-only fact: it is
   * never written into the ferret's `details.json`.
   */
  readonly detach?: boolean;
  /** How to start it beyond who and where ({@link StartOptionsSchema}). */
  readonly options?: StartOptions;
}

export type StartFailure =
  | { readonly code: 'refused' | 'unservable_model'; readonly reason: string } // a start.decide taker said no, or a test-mode runner refused a real harness (`real_harness`) (`unservable_model`: what the start asked of its model cannot be given)
  | { readonly code: 'folder'; readonly reason: string } // WorkFolders refused the folder
  | { readonly code: 'harness_unavailable' | 'runner_unavailable' | 'login_unavailable'; readonly reason: string }
  /** A well-shaped harness key that no installed plugin declares: the request is wrong, not the machine (a 4xx, never a 503). */
  | { readonly code: 'harness_not_installed'; readonly reason: string }
  | { readonly code: 'state_home' | 'state_home_unresolved'; readonly reason: string } // a ferret's start in (or through a link to) the state home, or the fence could not be built (an agent start only)
  | { readonly code: 'failed'; readonly reason: string };

/**
 * How a resume differs from a person's plain one (today's `ResumePolicy.automatic`, copied). It defaults to `false`: an
 * explicit resume by a person is not automatic. Replacing a LIVE pane is a move's, through Ferrets' own service, and the
 * Warden's alone through {@link ResumeOptions.replaceLiveTerminal}.
 */
export interface ResumeOptions {
  /**
   * Who the revive is FOR, as the admitted credential decided it (required, no default): this is AUTHORITY, unlike
   * {@link actor}, which only names the turn's author. An agent's revive binds its folder under the state-home policy; the
   * Warden's own is an agent's unless a person asked for it.
   */
  readonly origin: LaunchOrigin;
  /**
   * Automated recovery rather than a person asking (the Warden's revive, a restart drain): recorded with the
   * `session.resumed` event so history tells the two apart.
   */
  readonly automatic?: boolean;
  /**
   * Additive (U3 fix1): who asked, for the author recorded beside the revive's turn document — the Warden's revive is
   * Ferretry's Warden (today's `resumeTurnAuthor('warden')`), so its words are never drawn as the owner's. ATTRIBUTION
   * only, never authority: it changes no policy, admission or refusal. `peer` is a ferret's send that revived this
   * one (today's `resumeTurnAuthor('peer')`): the turn names a ferret as its author. Absent: the turn names no author.
   */
  readonly actor?: 'warden' | 'peer';
  /**
   * Additive (U3 fix2): told, ONCE and under the ferret's own queue, what this resume decided — `running`: the ferret
   * was not stopped, so nothing was relaunched and a message was NOT handed over (the send shortcut); `relaunching`: it
   * was stopped and is being relaunched, with a message as its own turn. A caller that must hand a message over itself
   * decides from this answer, never from an earlier read of the ferret's state that a start or stop in between could
   * make wrong (today's one resume decided send vs. relaunch under the session lock). Not called for a resume refused
   * before it decided. Attribution of nothing: it changes no policy, admission or refusal.
   */
  readonly decided?: (disposition: 'running' | 'relaunching') => void;
  /**
   * Additive (#45 revive-on-send, today's `reviver.revive` answer): told, ONCE, what the relaunch typed into the new pane
   * for the message — the one line pointing at the numbered turn document it was written to (`text`), that turn's number
   * and the document's absolute path — right after it was typed. A message handed to a resume is carried as that pointer,
   * so it is the pointer, not the message, that the transcript will record; a caller that must prove the message landed
   * looks for exactly this text. Not called when nothing was typed (a ferret that was already running, a relaunch that
   * failed, an interactive resume with no message). A caller's own failure here never changes the resume. Attribution of
   * nothing: it changes no policy, admission or refusal; `resume`'s answer type is unchanged.
   */
  readonly onCarried?: (typed: { readonly text: string; readonly turn: number; readonly file: string }) => void;
  /**
   * Additive (Warden's alone, c58-55): replace a LIVE pane instead of answering `running` (the send shortcut). The
   * conversation's start gate, login and folder are judged FIRST, then the old pane is stopped and the ferret relaunched
   * through the ordinary launch, all in this one resume. Any other consumer is refused with a sentence, nothing resumed.
   */
  readonly replaceLiveTerminal?: boolean;
}

/** Why a move did not happen (today's `SessionMoveFailure` words and sentence). */
export interface MoveFailure {
  readonly code: string;
  readonly reason: string;
}

/** What a move may carry beyond where it goes (today's move request, minus what only the route sets). */
export interface MoveOptions {
  /**
   * Who the move's relaunch is FOR, as the admitted credential decided it (required, no default): an agent's relaunch
   * never binds a folder inside the daemon's state home. Unlike {@link actor} and {@link movedBy}, which name who to credit,
   * this is authority.
   */
  readonly origin: LaunchOrigin;
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

/** Starting, stopping, resuming, adopting and moving a ferret: the lifecycle the Ferrets service owns. */
export interface LifecycleApi {
  /**
   * Starts a ferret FOR `origin`: who the start is for, as the admitted credential decided it (required, no default). An
   * agent's start never binds a folder inside the daemon's state home.
   */
  start(request: StartRequest, origin: LaunchOrigin): Promise<Result<FerretId, StartFailure>>;
  /** Stops a ferret; `reason` is recorded in its history (today's default: "stopped by client"). */
  stop(ferret: FerretId, how: 'polite' | 'now', reason?: string): Promise<void>;
  /**
   * Revives a stopped ferret with its conversation. `message` is recorded in its history; delivering it into the
   * conversation is the Conversation's.
   */
  resume(
    ferret: FerretId,
    message: string | undefined,
    options: ResumeOptions,
  ): Promise<Result<FerretId, StartFailure>>;
  /**
   * Adopts a live process by its runner handle without restarting it (spine D15). It launches nothing; `origin` (required,
   * no default) is the admitted caller. An attach may only TIGHTEN the birth, never loosen it: a record that has a birth
   * keeps it whoever attaches; a record with none is stamped `agent` by an agent origin and stays without one (so stays
   * fenced) for a person or the daemon.
   */
  attach(ferret: FerretId, handle: RunnerHandle, origin: LaunchOrigin): Promise<Result<FerretId, StartFailure>>;
  /**
   * The runner handle of a running ferret (Terminals: its tmux pane id), as `ferret.json` keeps it, so a harness finds
   * the ferret's pane after a daemon restart. `undefined` for a stopped or unknown ferret. Not a secret.
   */
  handle(ferret: FerretId): Promise<RunnerHandle | undefined>;
  /**
   * Moves a ferret onto another runtime (decision #19, additive; today's move of a session): the moves module's flow, whose
   * relaunch is a resume that replaces the live pane through the ordinary launch. Same `mayTouch` rule as above.
   */
  move?(
    ferret: FerretId,
    runtime: string,
    options: MoveOptions,
    caller?: FerretId,
  ): Promise<Result<FerretSummary, MoveFailure>>;
  /**
   * Additive (r11 S10, in-process only: no route, no capability): offers a title made from the ferret's conversation (the
   * Conversation plugin's, from the first exchange or the CLI's own generated title). Written only while the ferret's title is
   * not the owner's, and recorded as `auto`: `adopted` when it was written, `kept` when the owner's title (or the same one) stood
   * or the offer was empty. A title is bounded and stripped of control characters as any other is.
   */
  adoptTitle?(ferret: FerretId, title: string): Promise<'adopted' | 'kept'>;
}
