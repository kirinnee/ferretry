import { defineEvent, definePort, type FerretId, type RefusalCode } from '@ferretry/kernel/contract';
import type { Instant, JsonValue, Result } from '@ferretry/std';
import { z } from 'zod';
import type { LaunchOrigin } from './launch-origin.ts';
import { CompactAtSchema } from './view/compact-at.ts';
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
  FormKey,
  RunnerFormCapture,
  PaneNotReadyReason,
  QueueOutcome,
  RunnerComposerCleared,
  RunnerComposerSubmitted,
  RunnerDelivery,
  RunnerHeldAt,
  RunnerPaneObservation,
  RunnerHandle,
  SitrepLine,
  BoundTranscriptReader,
  HarnessTranscriptBytes,
  TurnUsage,
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
  /** How to start it beyond who and where ({@link StartOptionsSchema}). */
  readonly options?: StartOptions;
}

export type StartFailure =
  | { readonly code: 'refused' | 'unservable_model'; readonly reason: string } // a start.decide taker said no, or a test-mode runner refused a real harness (`real_harness`) (`unservable_model`: what the start asked of its model cannot be given)
  | { readonly code: 'folder'; readonly reason: string } // WorkFolders refused the folder
  | { readonly code: 'harness_unavailable' | 'runner_unavailable' | 'login_unavailable'; readonly reason: string }
  | { readonly code: 'state_home' | 'state_home_unresolved'; readonly reason: string } // a ferret's start in (or through a link to) the state home, or the fence could not be built (an agent start only)
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

/** What a queue may carry beyond its text (additive, ruling #45). */
export interface HarnessQueueOptions {
  /**
   * The send this message is, so a message long enough to go by file is written to `channel/queued-<send id>.md`: the
   * name the app reads the send back by. One outside the protocol's grammar (`[\w-]{1,128}`) is not used; a fresh id is.
   */
  readonly sendId?: string;
}

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

/** What {@link FerretHarness.askedQuestion} reads: the hook's payload, when it was written, and the proved transcript. */
export interface AskedQuestionFile {
  readonly payload: string;
  /** The question file's modification time. */
  readonly writtenAt: Instant;
  /** The ferret's proved transcript path, or `undefined` when the harness proves none (then the payload proves nothing). */
  readonly transcript?: string;
}

/** The form seam of {@link FerretHarness}: capture the pane, press one closed key, paste text. */
export interface HarnessForm {
  capture(): Promise<Result<RunnerFormCapture, HarnessRefusal>>;
  key(key: FormKey): Promise<Result<void, HarnessDeliveryFailure>>;
  paste(text: string): Promise<Result<void, HarnessDeliveryFailure>>;
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
   *
   * Ruling #45 (today's `routeSend` / `paneMidTurn`): ONE look at the pane first (the runner's `look`, which never
   * writes). A pane that shows the harness at work and no prompt answers `not_ready` / `busy` AT ONCE, nothing typed,
   * so the caller can queue the message instead of waiting out the delivery's readiness wait (about 27 s). A look that
   * sees nothing (no `look`, a hold, an unreadable pane) decides nothing: the delivery goes on as before.
   */
  deliver(delivery: RunnerDelivery): Promise<Result<DeliveryOutcome, HarnessDeliveryFailure>>;
  /**
   * Additive (U3): puts `text` into the ferret's BUSY pane's own queue (the runner's `queue`). Exactly like `deliver`, it
   * is NOT wrapped in a second act here: the runner acts on the pane for each write it makes, and an outer act would
   * wait on the inner one so that neither ever settled. A runner that cannot queue answers `plugin_unavailable`; its
   * other answers are `deliver`'s.
   *
   * Additive (ruling #45): a `text` over 1000 characters is never typed inline (today's `native-file` path). It is
   * written first, durably and `0600`, to the ferret's own `channel/queued-<send id>.md` (`options.sendId`, else a
   * fresh id), and the queue is handed the one-line pointer to it. With no session folder bound to write it to, a long
   * `text` answers `plugin_unavailable` and nothing is typed.
   */
  queue(text: string, options?: HarnessQueueOptions): Promise<Result<QueueOutcome, HarnessDeliveryFailure>>;
  /**
   * Stops the current turn with the HARNESS's stop key (its `turnStop.key`, today's `Escape`; never the runner's raw
   * `C-c`, which quits an idle Codex), pressed by the runner's `stopTurn` only under {@link shouldPressStopKey}: at a
   * pane that shows active work, or an interactive ferret whose harness's key is harmless when idle. Refused
   * `plugin_unavailable` when the harness names no stop or the runner cannot stop a turn; `no_pane` when the ferret has
   * no live pane, or a pane that changed between the read and the press (nothing pressed); a hold as its `RefusalCode`,
   * pressing nothing. The caller owns the refusals only it can make, and makes them BEFORE this is called (today's
   * `interruptLocked`): a session whose last stop was never confirmed (`kill_failed`, the session layer's status), a
   * pending structured question (a stop would answer it by accident), and a session with no running turn.
   */
  interrupt(): Promise<Result<HarnessInterrupted, HarnessRefusal>>;
  /**
   * Additive (send path): ONE read of the ferret's pane for a send (the runner's `observe`). Reads only. `no_pane` when
   * the ferret has no live pane or nothing could be read; `plugin_unavailable` when the runner cannot observe.
   */
  observe?(): Promise<Result<RunnerPaneObservation, HarnessRefusal>>;
  /**
   * Additive (send path): where the pane still shows `text` held (the runner's `heldAt`). Rejects, as the runner does,
   * when the pane cannot be read: that proves nothing either way.
   */
  heldAt?(text: string): Promise<Result<RunnerHeldAt | undefined, HarnessRefusal>>;
  /**
   * Additive (send path): erases `text` from the composer only when it holds exactly that (the runner's `clearComposer`).
   * Not wrapped in a second act here, for the reason `deliver` is not. Answers as `deliver` does for a refusal.
   */
  clearComposer?(text: string): Promise<Result<RunnerComposerCleared, HarnessDeliveryFailure>>;
  /**
   * Additive (send path): one Enter for a composer holding exactly `text` (the runner's `submitComposer`). Not wrapped
   * in a second act here. Answers as `deliver` does for a refusal.
   */
  submitComposer?(text: string, strict?: boolean): Promise<Result<RunnerComposerSubmitted, HarnessDeliveryFailure>>;
  /**
   * Additive (send path, the send-now's stop): the harness's stop key, pressed ONLY while the pane the runner reads shows
   * active work, and NEVER at an idle pane, whichever harness or mode (unlike {@link interrupt}, whose idle rule is the
   * person's own Stop): an idle pane may be parked on a permission prompt or a question that Escape would answer. Then the
   * pane read once it settled (the runner's `stopActiveTurn`). `plugin_unavailable` when the harness names no stop or the
   * runner cannot. The pane read is `undefined` when it could not be read. The caller reads the pane first and presses
   * only for a send-now that is busy with a pane it proved free of a prompt and of a pending question.
   */
  stopActive?(): Promise<Result<RunnerPaneObservation | undefined, HarnessRefusal>>;
  /**
   * Additive (send path, attachments): hands files to THIS ferret by writing them into its own session folder's
   * `attachments/` folder (made `0700`; each file `0600`, published through a temporary name), the one place an agent
   * may read them without being asked (`FERRET_READABLE_FOLDERS`). The write goes through a handle scoped to that folder
   * ALONE (no link from the home down to it, checked at each filesystem call), so an `attachments` that is a link, to a
   * sibling in the session or anywhere else, refuses with nothing written. Answers the absolute path of each file, in
   * order. A `name` (and a `folder`) is a bare name: one that names a path writes NOTHING (the whole call is refused first). It is a file
   * write into the ferret's own folder, not a key on its pane, so it neither types nor presses anything. Rejects when
   * the folder cannot be named or a file cannot be written; absent when this daemon cannot write session files.
   */
  deliverFiles?(files: readonly HarnessFile[]): Promise<readonly string[]>;
  /**
   * The seam's own ferret's transcript through its harness, already masked (rejects with 503 while the harness is off).
   * It is bound to that ferret and names no other.
   */
  /**
   * Additive (structured questions): what Claude Code's `AskUserQuestion` hook recorded in THIS ferret's own
   * `question-asked.json` (`FY_QUESTION_FILE`), read bounded, with the ferret's proved transcript path (the harness's
   * `transcriptStamp().file`) that `parseAskedQuestion` demands the payload name. `undefined` when the file is absent,
   * unreadable, over its bound, or no transcript is proved. Reads only; `writtenAt` is the file's mtime, so a caller
   * compares it to skip an unchanged file. The payload is the hook's raw text and goes to Conversation's one writer only.
   */
  askedQuestion?(): Promise<AskedQuestionFile | undefined>;
  /**
   * Additive (structured questions): the form's own acts on the ferret's pane, for the structured-answer driver. Each is
   * the runner's, guarded by `kernel.act(<pane>, 'keys'|'read')` exactly like `deliver` (so Vault holds apply and a hold
   * types NOTHING, answered as its `RefusalCode`); `key` takes only a {@link FormKey}. SECURITY-SENSITIVE: this is a raw
   * write on a ferret's pane, so a caller drives it only against a form it has positively bound on `capture`.
   * `capture` answers `no_pane` / `plugin_unavailable` as `observe` does; `key` and `paste` answer as `deliver` does.
   */
  readonly form?: HarnessForm;
  readonly transcript: BoundTranscriptReader;
  /**
   * Additive (G162): the seam's own ferret's transcript as raw bytes ({@link HarnessTranscriptBytes}), UNMASKED, for
   * the ONE reader that parses records itself (Conversation's). Rejects 503 `plugin_unavailable` while the ferret's
   * harness is off; `undefined` when the harness proves none or offers no bytes. Bound: names no other ferret.
   */
  transcriptBytes?(): Promise<HarnessTranscriptBytes | undefined>;
}

/**
 * One file {@link FerretHarness.deliverFiles} hands to a ferret: a bare file name and its bytes, and optionally the bare
 * name of a folder of its own inside `attachments/` (v4 kept each attachment in a folder named by its FULL id, so two
 * files of one name never meet). Neither names a path; one that does writes nothing.
 */
export interface HarnessFile {
  readonly name: string;
  readonly folder?: string;
  readonly contents: Uint8Array;
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
  /**
   * Additive (#45 BG-051, today's `writeTurn`): writes the NEXT numbered turn document `turns/turn-NNN.md` (`0600`,
   * through a temporary name, its author beside it as `turn-NNN.by.json`), numbered after the higher of the session
   * counter and the documents on disk, and counts it so a later revive numbers after it. Answers its number and the
   * absolute path the agent is pointed at. The same store the revive writes.
   */
  write?(request: { readonly document: string; readonly by?: FerretTurnAuthor }): Promise<FerretTurnWritten>;
  /**
   * Additive (#45 BG-053, today's `writeQueuedPayload`): writes a message too long to type into a busy pane to
   * `channel/queued-<send id>.md` (`0600`, through a temporary name; the same id rewrites the same file) and answers
   * its absolute path. Rejects for an id outside `[a-z0-9_-]{1,128}`: the caller does not substitute one, because the
   * send's row names the file.
   */
  writeQueued?(sendId: string, payload: string): Promise<string>;
  /** Additive (#45 BG-051, today's `clearMarkers`): clears the completion markers a previous turn left. */
  clearMarkers?(): Promise<void>;
}

/** A turn document Ferrets wrote: its number and the absolute file the agent is pointed at. */
export interface FerretTurnWritten {
  readonly turn: number;
  readonly file: string;
}

/**
 * What a ferret's pane is asking right now (additive, U4; today's `turnPrompt`, `permissionRequest` and
 * `harnessDialog` of its state document, `lib/protocol/session-dialog.ts` and `session-permission.ts`), for the panels
 * that show it. Every text in it was read from a masked screen and is masked again inside one `Redaction.read` on the
 * way out. Nothing here answers a dialog: no option is ever chosen.
 */
export interface FerretPrompt {
  /** The turn the observer last recorded; absent when none is recorded. */
  readonly turnState?: 'working' | 'your-turn' | 'needs-input';
  /** The harness dialog's words behind a `needs-input`. */
  readonly prompt?: string;
  /** The tool-permission prompt behind a `needs-input`, as data. */
  readonly permissionRequest?: JsonValue;
  /** The harness's own dialog behind a `needs-input`, as data. */
  readonly dialog?: JsonValue;
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

/** What one auto-resume pass did: how many ferrets came back, and which could not, each with the reason a person can act on. */
export interface AutoResumeReport {
  /** When the pass ran (an ISO instant). */
  readonly at: string;
  readonly resumed: number;
  readonly skipped: readonly { readonly sessionId: string; readonly reason: string }[];
}

/** A ferret's whole status: its state, its turn, what plugins add, and its blockers from the Asks port. */
export interface Sitrep {
  readonly ferret: FerretSummary;
  readonly lines: readonly SitrepLine[];
  /** Open asks about this ferret (ids, `!A3`). */
  readonly blockers: readonly string[];
}

/**
 * A limit a LIVE ferret's pane proves its login has reached (today's `storagePaneLimits` row): the harness announced a
 * usage or spend limit that the provider's own reading cannot see. One row per limited live ferret, derived from its
 * state each time it is read and kept nowhere, so it ends the moment the ferret is released (the pane shows no limit
 * any more, or it is stopped) or its reset time passes.
 *
 * `notice` is the harness's own sentence, read from a masked screen. `login` is the login the ferret launched on;
 * `runtime` is the runtime it was started on, for a ferret whose record names no login.
 */
export interface FerretPaneLimit {
  readonly ferret: FerretId;
  readonly runtime?: string;
  readonly login?: string;
  readonly notice: string;
  /** Whether it is a spend limit (money), as opposed to a usage window. */
  readonly spend: boolean;
  /** When the login is usable again, epoch milliseconds; absent when the harness gave no time. */
  readonly retryAt?: number;
}

/**
 * The Ferrets port (§2.2): who each ferret is, its lineage, its state; start, stop and resume through the harness
 * and runner plugins. "A ferret touches only its own; a lead also its helpers'" is `mayTouch`, decided here and
 * nowhere else.
 */
export interface FerretsApi {
  /** The effective `limits.yaml` settings, read fresh on every call; Ferrets serves it (a consumer may still bind it optionally). */
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
   * What the last "Auto-resume after restart" pass did (today's `machine.lastAutoResume`), for the Machine view's
   * "Last restart" lines: `null` when none has run or it could not be read. Optional, so it is additive: a Ferrets
   * that keeps none reads as no pass.
   */
  lastAutoResume?(): Promise<AutoResumeReport | null>;
  /**
   * The model a ferret is actually running, for display (today's `displayModel`): what the harness last reported, else the
   * model it was configured with, else the wrapper's declared hint, else `default`. A launch option (`FerretSummary.model`)
   * is only what was ASKED for: it goes stale after a switch inside the session. `undefined` for a ferret this daemon does
   * not know. Optional, so it is additive: absent reads as the launch option.
   */
  displayModel?(ferret: FerretId): Promise<string | undefined>;
  /**
   * What a ferret spent, turn by turn, read through ITS harness (`Harness.usage`; Ferrets owns which harness a ferret
   * runs, so Usage never reaches one). Token counts only, never transcript text. `undefined` means PARTIAL: the ferret is
   * unknown, its harness is off, or the reader threw. It is never counted as zero; an empty list is a ferret that spent
   * nothing yet.
   */
  turnUsage(ferret: FerretId, since?: Instant): Promise<readonly TurnUsage[] | undefined>;
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
   * What the ferret's pane is asking right now (additive, U4): the dialog or permission prompt the turn watch recorded,
   * masked, for Claude Code's panels. `undefined` for a ferret this daemon does not know; `{}` when nothing is asked or
   * its state could not be read. Same `mayTouch` rule as `harness`: a `caller` reaching beyond itself and its helpers
   * is refused with a 403 `forbidden`. Read only: it never answers the dialog.
   */
  prompt?(ferret: FerretId, caller?: FerretId): Promise<FerretPrompt | undefined>;
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
   * Additive (usage and Packs read it): the limits live ferrets' panes prove, one row per limited ferret, derived from
   * their state now (see {@link FerretPaneLimit}). A reader that wants them by login aggregates them (Usage owns that).
   */
  paneLimits?(): Promise<readonly FerretPaneLimit[]>;
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
