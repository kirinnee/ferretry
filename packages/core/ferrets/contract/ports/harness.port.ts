import type { FerretId, RefusalCode } from '@ferretry/kernel/contract';
import type { Instant, Result } from '@ferretry/std';
import type {
  DeliveryOutcome,
  FormKey,
  PickerKey,
  RunnerFormCapture,
  PaneNotReadyReason,
  QueueOutcome,
  RunnerComposerCleared,
  RunnerComposerSubmitted,
  RunnerDelivery,
  RunnerHeldAt,
  RunnerPaneObservation,
  BoundTranscriptReader,
  HarnessTranscriptBytes,
} from '../kinds.ts';

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
  /** Additive (live model switch): a numbered picker's row digit, from its own closed set (never a {@link FormKey}). */
  pickerKey?(key: PickerKey): Promise<Result<void, HarnessDeliveryFailure>>;
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
   * Additive (a plugin's made picture): the same hand-over as {@link deliverFiles}, into THIS ferret's own `media/` folder
   * (`FY_MEDIA_DIR`) instead, so what the chat shows with `src: media:<name>` is there with no step by the ferret. Same
   * rules: a handle scoped to that folder alone, `0700` folder, `0600` files, a bare name or nothing is written (a
   * `folder` is not taken: media is flat). Answers each file's name as `src: media:<name>` takes it, in order. Rejects when
   * a file cannot be written; absent when this daemon cannot write session files.
   */
  deliverMedia?(files: readonly HarnessFile[]): Promise<readonly string[]>;
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
   * the reader that parses records itself (Conversation's; Logins' passive usage pass keeps only the normalized `rate_limits` fields and timestamps). Rejects 503 `plugin_unavailable` while the ferret's
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

/** The harness seam (decision #18): deliver, interrupt and the transcript of one ferret. */
export interface HarnessApi {
  /**
   * The harness seam (decision #18, additive): deliver, interrupt and the transcript of one ferret. `undefined` for a
   * ferret this daemon does not know. With `caller` (a ferret acting), only itself and its helpers are reachable, by
   * the same `mayTouch` rule as stop and resume: anyone else is refused with a 403 `forbidden`.
   */
  harness?(ferret: FerretId, caller?: FerretId): Promise<FerretHarness | undefined>;
}
