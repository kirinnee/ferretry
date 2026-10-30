import type { SendUnaccountedReason } from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { ObservedHumanInput } from '../../transcript/types.ts';
import { paneMidTurn, typedIntoBusyPane } from './policy.ts';
import { strandablePointer } from './stranded.ts';
import {
  attemptsAllowed,
  deadlineOf,
  isOpenSend,
  isRepairableSend,
  judgeWatchedSends,
  type SendTrackerSettings,
  type SendVerdict,
} from './tracking.ts';
import {
  type SendHeldAt,
  type SendLedger,
  type SendRecord,
  type SendRepository,
  SendRetypeWithheld,
  type SendTarget,
  type SendTerminal,
  type SendTracking,
  TERMINAL_SEND_STATUSES,
} from './types.ts';

/**
 * Where a send WENT — the matcher the send ledger always said belonged to a monitor that did not
 * exist, so every send stayed `accepted` forever and a reader could not tell a delivered message from
 * a lost one.
 *
 * ONLY PROOF MOVES A FATE. A send becomes `queued` when the harness wrote its own queue record for it,
 * `delivered` when a user record carrying it appears in the transcript, and nothing else does either.
 * At a send's deadline the tracker looks at everything that could still be holding it — the
 * transcript's queue, the composer, the harness's visible queue — and only when ALL of them are
 * readable and empty is the send proven absent. Absent is safe to type again under the same id, so
 * the daemon does, a bounded number of times; after the last attempt the send is `timed_out`. When
 * any of them cannot be read the send is `unaccounted` instead: it may have landed, and saying
 * otherwise would invite a duplicate.
 *
 * EVENT-DRIVEN, NOT A LOOP. Nothing runs while nothing is in flight. A transport asks for one early
 * look; each look schedules the next only for a send that is still open, at that send's own
 * deadline; and a reader of the ledger asks for a look before it reads. A daemon restart re-derives
 * every in-flight send from the transcript at boot rather than re-typing anything.
 */

/** One read of a session's transcript evidence. `readable: false` means absence cannot be proven. */
export interface SendEvidenceReading {
  readonly readable: boolean;
  /** The session has no transcript the daemon can prove is its own, which no amount of waiting fixes. */
  readonly unbound?: true;
  readonly inputs: readonly ObservedHumanInput[];
}

/** The transcript side: what the harness has recorded the agent receiving or holding. */
export interface SendEvidenceSource {
  /**
   * What the transcript holds from `since` on — the acceptance of the oldest send being looked for,
   * before which nothing can prove one. A source may read less than the whole file because of it.
   */
  read(id: SessionId, since: string): Promise<SendEvidenceReading>;
}

/** One pending look per session; scheduling again replaces it. */
export interface SendScheduler {
  schedule(id: SessionId, delayMs: number, run: () => void): void;
  cancelAll(): void;
}

/** Types a send again under its original id, or presses Enter again for its stranded pointer. */
export interface SendReattempter {
  /**
   * Answers the record as it then stands — retyped, or proven `queued` when the pane showed it held.
   * Throws `SendRetypeWithheld` when the pane said not to type at all.
   */
  reattempt(id: SessionId, sendId: string): Promise<SendRecord>;
  /**
   * One more verified Enter for this send's own pointer, still typed in the composer. Answers the
   * record as it then stands; every condition is the implementer's to re-check under its lock.
   */
  resubmit(id: SessionId, sendId: string): Promise<SendRecord | undefined>;
}

/** Tells an agent that its message did not arrive. */
export interface SendFailureNotifier {
  notify(sender: string, recipient: SessionId, record: SendRecord): Promise<void>;
}

/** Every session this daemon holds, for the re-derivation a restart owes its in-flight sends. */
export interface SendRoster {
  sessions(): readonly SessionId[];
}

export interface SendTrackerPorts {
  readonly ledger: Pick<SendLedger, 'list' | 'settle'>;
  readonly evidence: SendEvidenceSource;
  readonly terminal: Pick<SendTerminal, 'observe' | 'heldAt'>;
  readonly repository: Pick<SendRepository, 'read' | 'journal'>;
  readonly attempts: SendReattempter;
  readonly notifier: SendFailureNotifier;
  readonly scheduler: SendScheduler;
  readonly roster: SendRoster;
  /** Its own queue: a look reads a whole transcript and must not hold the send lock while it does. */
  readonly serial: SerialExecutor;
  readonly clock: ClockPort;
}

/** The background half of the tracker, as the composition root arms it. */
export interface SendTrackingLoop {
  /** Re-derives every session's in-flight sends, then returns the disarm. */
  arm(): () => void;
}

const UNREADABLE: SendEvidenceReading = { readable: false, inputs: [] };

/** One look at where the pane holds a send: a place, nowhere, or a pane that could not be read. */
type PaneHold = SendHeldAt | 'nowhere' | 'unreadable';

export class SendTracker implements SendTracking, SendTrackingLoop {
  constructor(
    private readonly ports: SendTrackerPorts,
    private readonly settings: SendTrackerSettings,
  ) {}

  track(id: SessionId): void {
    this.ports.scheduler.schedule(id, this.settings.firstCheckMs, () => void this.check(id).catch(() => undefined));
  }

  /**
   * Re-derives every session's sends at boot, ONE SESSION AT A TIME.
   *
   * It used to start every session's look at once, and a look can open a transcript window hundreds of
   * megabytes back to prove a send absent: a restart over a fleet of long conversations parsed all of
   * them together on the event loop, which is exactly when a freshly started daemon most needs to
   * answer. Walking the roster in turn costs the same work spread out, with the loop free between
   * looks. A disarm stops the walk as well as the scheduled looks.
   */
  arm(): () => void {
    let armed = true;
    void (async () => {
      for (const id of this.ports.roster.sessions()) {
        if (!armed) return;
        await this.check(id).catch(() => undefined);
      }
    })();
    return () => {
      armed = false;
      this.ports.scheduler.cancelAll();
    };
  }

  /**
   * Looks once at one session's sends, settles what it can prove, and schedules the next look.
   *
   * A LOOK THAT THROWS STILL SCHEDULES ONE. The next look used to be scheduled only by a look that
   * finished, and every caller drops the error, so one failed read — a ledger write, a session file —
   * left every open send `accepted` with nothing ever coming back to it: the person's message read
   * "Sending" for good. The retry waits as long as a busy agent's would; the error still reaches the
   * caller.
   */
  async check(id: SessionId): Promise<void> {
    try {
      await this.ports.serial.run(id, async () => await this.checkLocked(id));
    } catch (error) {
      this.ports.scheduler.schedule(
        id,
        this.settings.busyExtensionMs,
        () => void this.check(id).catch(() => undefined),
      );
      throw error;
    }
  }

  /** Whether a look at this session could change anything, so a reader knows one is worth taking. */
  async watching(id: SessionId): Promise<boolean> {
    const now = Date.parse(this.ports.clock.now());
    return (await this.ports.ledger.list(id)).some(record => this.watches(record, now));
  }

  /**
   * Open sends, and settled-but-unproven ones for a while: one that was unconfirmed may still turn up
   * in the transcript, and the honest thing then is to say it was delivered after all.
   *
   * A REPAIRABLE one is watched for longer. A send settled unconfirmed only because its transcript
   * could not be read, and one a person cancelled while it showed as unconfirmed, were both often
   * answered by the agent anyway — the transcript simply had not been read far enough to say so.
   */
  private watches(record: SendRecord, now: number): boolean {
    if (record.held === true) return false;
    if (isOpenSend(record)) return true;
    const age = now - Date.parse(record.acceptedAt);
    if (isRepairableSend(record)) return age < this.settings.repairLimitMs;
    return (record.fate === 'unaccounted' || record.fate === 'timed_out') && age < this.settings.holdLimitMs;
  }

  private async checkLocked(id: SessionId): Promise<void> {
    const records = await this.ports.ledger.list(id);
    const now = Date.parse(this.ports.clock.now());
    const watched = records.filter(record => this.watches(record, now));
    if (watched.length === 0) return;
    const oldest = Math.min(...watched.map(record => Date.parse(record.acceptedAt)));
    const since = new Date(oldest - this.settings.matchSlackMs).toISOString();
    const reading = await this.ports.evidence.read(id, since).catch(() => UNREADABLE);
    const claimed = new Set(records.flatMap(record => (record.evidence === undefined ? [] : [record.evidence.key])));
    // Presence is proof whatever else could not be read: a record that carries the send IS the send
    // arriving. Only absence needs the whole transcript, and `expire` is where absence is decided.
    const verdicts = judgeWatchedSends(watched, claimed, reading.inputs, this.settings.matchSlackMs);
    let next: number | undefined;
    for (const record of watched) {
      const verdict = verdicts.get(record.sendId);
      if (verdict?.delivered !== undefined) {
        await this.deliver(id, record, verdict);
        continue;
      }
      if (!isOpenSend(record)) continue;
      const proven =
        verdict?.queuedAt !== undefined && record.fate === 'accepted'
          ? await this.queued(id, record, verdict.queuedAt, 'transcript')
          : record;
      const { record: nudged, hold } = await this.nudged(id, proven, await this.paneHold(id, proven), now);
      const current = await this.observed(id, nudged, hold, now);
      const deadline = deadlineOf(current, this.settings);
      const after = now < deadline ? current : await this.expire(id, current, reading, verdict, hold, now);
      if (!isOpenSend(after)) continue;
      // A send this look re-typed is looked at again soon, like any fresh transport.
      const due = deadlineOf(after, this.settings);
      const at =
        after.attempt !== current.attempt
          ? now + this.settings.firstCheckMs
          : hold === 'composer' && after.typedNotSent !== true
            ? Math.min(due, this.composerLookAt(after, now))
            : due;
      next = next === undefined ? at : Math.min(next, at);
    }
    if (next !== undefined)
      this.ports.scheduler.schedule(id, Math.max(0, next - now), () => void this.check(id).catch(() => undefined));
  }

  private async deliver(id: SessionId, record: SendRecord, verdict: SendVerdict): Promise<void> {
    await this.ports.ledger.settle(id, record.sendId, {
      fate: 'delivered',
      fateAt: this.ports.clock.now(),
      evidence: verdict.delivered,
      deadlineAt: undefined,
      unaccountedReason: undefined,
      retryable: undefined,
      cancelEffect: undefined,
    });
    await this.ports.repository.journal(id, 'control.send_delivered', {
      sendId: record.sendId,
      attempt: record.attempt ?? 1,
      // A repair says what it corrected, so the history shows the earlier fate was a reading failure.
      ...(isOpenSend(record) ? {} : { corrected: record.fate }),
    });
  }

  private async queued(
    id: SessionId,
    record: SendRecord,
    queuedAt: string,
    proof: 'transcript' | 'pane',
  ): Promise<SendRecord> {
    const next = await this.ports.ledger.settle(id, record.sendId, {
      fate: 'queued',
      fateAt: this.ports.clock.now(),
      queuedAt,
      queueProof: proof,
      typedNotSent: undefined,
    });
    await this.ports.repository.journal(id, 'control.send_queued', { sendId: record.sendId, proof });
    return next ?? record;
  }

  /** Where the pane holds this send right now. A held-for-revive record has no pane to look in. */
  private async paneHold(id: SessionId, record: SendRecord): Promise<PaneHold> {
    const text = record.matchText ?? record.message;
    return await this.ports.terminal.heldAt(id, text).then(
      where => where ?? 'nowhere',
      () => 'unreadable' as const,
    );
  }

  /**
   * Moves what the pane shows onto the record, on EVERY look rather than only at a deadline.
   *
   * A message left TYPED in the composer is said as itself once it has sat there `typedStableMs` — a harness never submits
   * composer text on its own, so "Sending" would be a promise nothing is keeping. One that shows up in
   * the harness's own queue becomes `queued` on that proof, and a typed flag the pane no longer
   * supports is dropped.
   */
  private async observed(id: SessionId, record: SendRecord, hold: PaneHold, now: number): Promise<SendRecord> {
    if (hold === 'queue' && record.fate === 'accepted')
      return await this.queued(id, record, this.ports.clock.now(), 'pane');
    // Text still in the composer is only SAID to be unsent once it has sat there for `typedStableMs`: a
    // harness needs a moment between Enter and its transcript record, and a flag raised in that window
    // flips to "delivered" a second later. Once raised it stays for as long as the pane shows the text.
    const typed =
      hold === 'composer' &&
      (record.typedNotSent === true || now - this.typedSince(record) >= this.typedAfterMs(record));
    if (hold === 'unreadable' || typed === (record.typedNotSent === true)) return record;
    const next = await this.ports.ledger.settle(id, record.sendId, { typedNotSent: typed ? true : undefined });
    if (typed) await this.ports.repository.journal(id, 'control.send_typed_not_sent', { sendId: record.sendId });
    return next ?? record;
  }

  /** When the current attempt put this send in the composer, in epoch milliseconds. */
  private typedSince(record: SendRecord): number {
    return Date.parse(record.attemptAt ?? record.acceptedAt);
  }

  /**
   * Presses Enter again for a POINTER of ours left typed in the composer, when its next nudge is due.
   *
   * A swallowed Enter used to end the daemon's part: the pointer sat in the composer, the row read
   * "typed, not sent", and every later send was refused over a draft the person never wrote. Only a
   * pointer is nudged — its text is the daemon's own, so it can never be a person's draft — and only
   * `submitNudgesMs.length` times an attempt. The pane is read again afterwards, since a nudge that
   * took leaves nothing in the composer to report.
   */
  private async nudged(
    id: SessionId,
    record: SendRecord,
    hold: PaneHold,
    now: number,
  ): Promise<{ readonly record: SendRecord; readonly hold: PaneHold }> {
    const due = this.nudgeDue(record);
    if (hold !== 'composer' || record.typedNotSent === true || due === undefined || now < due) return { record, hold };
    const after = await this.ports.attempts.resubmit(id, record.sendId).catch(() => undefined);
    if (after === undefined) return { record, hold };
    return { record: after, hold: await this.paneHold(id, after) };
  }

  /** When this send's next Enter nudge is due, or `undefined` when it is not a pointer or has none left. */
  private nudgeDue(record: SendRecord): number | undefined {
    if (strandablePointer(record) === undefined) return undefined;
    const offset = this.settings.submitNudgesMs[record.submitNudges ?? 0];
    return offset === undefined ? undefined : this.typedSince(record) + offset;
  }

  /** How long text must sit in the composer before it is said to be typed and not sent. */
  private typedAfterMs(record: SendRecord): number {
    if (strandablePointer(record) === undefined) return this.settings.typedStableMs;
    return (this.settings.submitNudgesMs.at(-1) ?? 0) + this.settings.typedStableMs;
  }

  /**
   * The next look a send still in the composer needs: its next nudge, or the moment it becomes typed
   * and not sent. A nudge already due — one the pane deferred, mid-turn or behind a dialog — is looked
   * at again no sooner than a first check would be, so a pane that stays busy is not polled hot.
   */
  private composerLookAt(record: SendRecord, now: number): number {
    const typed = this.typedSince(record) + this.typedAfterMs(record);
    const nudge = this.nudgeDue(record);
    return nudge === undefined ? typed : Math.min(typed, Math.max(nudge, now + this.settings.firstCheckMs));
  }

  /**
   * A send's deadline passed without proof. Decides, from everything readable, whether it is still
   * held somewhere, proven absent (re-attempt, or `timed_out` after the last attempt), or unprovable.
   */
  private async expire(
    id: SessionId,
    record: SendRecord,
    reading: SendEvidenceReading,
    verdict: SendVerdict | undefined,
    hold: PaneHold,
    now: number,
  ): Promise<SendRecord> {
    if (!reading.readable) {
      // A harness parked on a dialog writes no transcript at all, so "unreadable" was true and useless:
      // the screen says what is wrong, and the person can fix it. A transcript that was never PROVEN
      // is said as itself, because its remedy is a restart and a re-send would only add a copy.
      const blocked = await this.ports.terminal.observe(id).catch(() => undefined);
      const reason: SendUnaccountedReason =
        blocked?.blockingPrompt !== undefined
          ? 'blocked_by_prompt'
          : reading.unbound === true
            ? 'transcript_unbound'
            : 'transcript_unreadable';
      return await this.settle(id, record, 'unaccounted', reason);
    }
    if (record.path === 'revive') return await this.unprovenRevive(id, record, verdict, hold, now);
    const target = await this.ports.repository.read(id);
    if (target === undefined || TERMINAL_SEND_STATUSES.has(target.status))
      return await this.settle(id, record, 'timed_out', 'session_ended');
    const pane = await this.ports.terminal.observe(id).catch(() => undefined);
    if (pane === undefined) return await this.settle(id, record, 'unaccounted', 'pane_unreadable');
    if (!pane.alive || pane.dead) return await this.settle(id, record, 'timed_out', 'session_ended');
    // Not delivered, and nothing will be until somebody answers the dialog: retyping would type into it.
    if (pane.blockingPrompt !== undefined) return await this.settle(id, record, 'unaccounted', 'blocked_by_prompt');
    // A send typed into a mid-turn pane is in the harness's queue, and the queue is where a frame can
    // fail to show it: a long message pushes its own head off the top of a short pane. That is a reason
    // to WAIT, not to report — the turn's end either submits what the queue held (the transcript then
    // proves it delivered) or leaves it provably empty. Only a pane no turn is running in has nothing
    // left to wait for, and an unreadable one is then said as unconfirmed.
    const waitsForTurnEnd = paneMidTurn(target, pane) && typedIntoBusyPane(record);
    if (hold === 'unreadable' && !waitsForTurnEnd)
      return await this.settle(id, record, 'unaccounted', 'pane_unreadable');
    // Still held — behind a busy turn, or sitting in the composer. That is waiting, not loss.
    if (verdict?.holding === true || hold !== 'nowhere') return await this.wait(id, record, now);
    // A mid-turn pane can hold a copy where no reading reaches: a queue rendering this daemon does not
    // recognise is exactly that, and calling it lost is how one message became four copies. So a send
    // already typed into a mid-turn pane is proven absent only once the turn ends — when the harness
    // has either submitted what it held, and the transcript says so, or holds nothing at all.
    if (waitsForTurnEnd) return await this.wait(id, record, now);
    // The agent took a turn AFTER this send went in. Whatever the transcript matcher could not read, a
    // message that was typed or queued and then followed by a turn was what that turn worked on: typing
    // it again is the duplicate in the receiver's chat. Waiting is safe — the transcript can still prove
    // it, and the hold ceiling still ends it as unconfirmed rather than as lost.
    if (turnStartedAfter(record, target)) return await this.wait(id, record, now);
    // PROVEN ABSENT: not in the transcript, not in the harness's queue, not on screen.
    const reason: SendUnaccountedReason = verdict?.released === true ? 'composer_discarded' : 'not_delivered';
    if ((record.attempt ?? 1) < attemptsAllowed(record, this.settings)) {
      const retried = await this.ports.attempts.reattempt(id, record.sendId).then(
        (next): SendRecord | SendRetypeWithheld | undefined => next,
        (error: unknown) => (error instanceof SendRetypeWithheld ? error : undefined),
      );
      // The pane, re-read under the send lock, said not to type: held or mid-turn is waiting, and a
      // pane that could not rule a held copy out is unconfirmed — never "not delivered".
      if (retried instanceof SendRetypeWithheld)
        return retried.reason === 'unreadable'
          ? await this.settle(id, record, 'unaccounted', 'pane_unreadable')
          : await this.wait(id, record, now);
      // A retry that found the send held proved it `queued` instead of typing it, and waits like one.
      if (retried !== undefined)
        return retried.attempt === record.attempt ? await this.wait(id, retried, now) : retried;
    }
    return await this.settle(id, record, 'timed_out', reason);
  }

  /**
   * A revive-carried send past its deadline with no proof: UNCONFIRMED, NEVER "NOT DELIVERED".
   *
   * Its message was written to the turn file the relaunch started on, and the pointer typed at that
   * file is all a transcript can show. So a missing pointer is missing PROOF — the agent may have read
   * the file, worked, and even finished before this look — and a sender told "it did not reach it"
   * sends the copy that lands twice. Nor is it ever typed again: the relaunch is not the tracker's to
   * repeat. A pointer still visibly held on screen is waiting; anything else is said as unconfirmed,
   * and stays watched, so a pointer that turns up later still proves it delivered.
   */
  private async unprovenRevive(
    id: SessionId,
    record: SendRecord,
    verdict: SendVerdict | undefined,
    hold: PaneHold,
    now: number,
  ): Promise<SendRecord> {
    if (verdict?.holding === true || hold === 'composer' || hold === 'queue') return await this.wait(id, record, now);
    const pane = await this.ports.terminal.observe(id).catch(() => undefined);
    const reason: SendUnaccountedReason =
      pane?.blockingPrompt !== undefined ? 'blocked_by_prompt' : 'revive_unconfirmed';
    return await this.settle(id, record, 'unaccounted', reason);
  }

  /** Pushes the look out rather than counting it against an attempt, up to the hold ceiling. */
  private async wait(id: SessionId, record: SendRecord, now: number): Promise<SendRecord> {
    if (now - Date.parse(record.acceptedAt) >= this.settings.holdLimitMs)
      return await this.settle(id, record, 'unaccounted', 'timeout');
    const extended = await this.ports.ledger.settle(id, record.sendId, {
      deadlineAt: new Date(now + this.settings.busyExtensionMs).toISOString(),
    });
    return extended ?? record;
  }

  /** A final fate, journalled, and handed back to an agent that sent it. */
  private async settle(
    id: SessionId,
    record: SendRecord,
    fate: 'unaccounted' | 'timed_out',
    reason: SendUnaccountedReason,
  ): Promise<SendRecord> {
    const next =
      (await this.ports.ledger.settle(id, record.sendId, {
        fate,
        fateAt: this.ports.clock.now(),
        unaccountedReason: reason,
        // Only a send proven absent from a session that can still take input may be retried as-is.
        retryable: fate === 'timed_out' && reason !== 'session_ended',
        deadlineAt: undefined,
      })) ?? record;
    await this.ports.repository.journal(
      id,
      fate === 'timed_out' ? 'control.send_timed_out' : 'control.send_unaccounted',
      {
        sendId: record.sendId,
        reason,
        attempt: record.attempt ?? 1,
      },
    );
    if (record.senderKind === 'agent' && record.from !== undefined)
      await this.ports.notifier.notify(record.from, id, next).catch(() => undefined);
    return next;
  }
}

/**
 * Whether the session's turn clock moved after this send's current attempt reached the agent.
 *
 * A QUEUED send is measured from the moment the harness held it — the turn running then ends and the
 * next one starts on it. Any other is measured from its attempt, and only a turn that is `working`
 * counts: an idle boundary after a send typed into a composer says nothing about it. An unreadable
 * clock proves nothing, so it never withholds a retry.
 */
function turnStartedAfter(record: SendRecord, target: SendTarget): boolean {
  if (target.turnStateAt === undefined) return false;
  const queued = record.fate === 'queued' || record.queueProof !== undefined;
  if (!queued && target.turnState !== 'working') return false;
  const since = Date.parse(
    queued ? (record.queuedAt ?? record.attemptAt ?? record.acceptedAt) : (record.attemptAt ?? record.acceptedAt),
  );
  const changed = Date.parse(target.turnStateAt);
  return Number.isFinite(since) && Number.isFinite(changed) && changed > since;
}

/**
 * How long a ledger read waits for the look it asks for before answering with the ledger as it is.
 * Most looks settle in well under a second; this is the ceiling, not the expectation.
 */
export const SEND_READ_LOOK_BUDGET_MS = 3_000;

/**
 * A READ IS A LOOK — BOUNDED. Asking where a send went is when a fresh answer matters, so a ledger
 * read asks the tracker to look first. It used to WAIT for that look however long it took, and a look
 * reads the whole transcript and the pane behind a per-session queue: a slow one held every reader of
 * the ledger with it, and the phone that polls it showed its message as "Sending" for as long as the
 * look took. Past the budget the look carries on by itself and the reader gets the ledger now; the
 * look's own result reaches the next read, and its journal event the live feed.
 */
export async function lookBeforeReading(
  tracker: Pick<SendTracker, 'watching' | 'check'>,
  id: SessionId,
  wait: (milliseconds: number) => Promise<void>,
  budgetMs: number = SEND_READ_LOOK_BUDGET_MS,
): Promise<void> {
  if (!(await tracker.watching(id))) return;
  await Promise.race([tracker.check(id).catch(() => undefined), wait(budgetMs)]);
}
