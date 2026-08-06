import type { SessionState, SessionView, StructuredQuestionAnswer } from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import {
  AnswerAcknowledged,
  type AnswerLedger,
  type AnswerOperationRecord,
  AnswerReleased,
  AnswerRequestConflict,
  type AnswerRequestPayload,
  AnswerTerminalFailure,
  AnswerToolAlreadyHandled,
  AnswerUnconfirmed,
  answerEvidenceForQuestion,
  answerFingerprint,
  decideAnswerAdmission,
  reconcileUnconfirmedAnswer,
} from './answer-ledger.ts';
import { StructuredQuestionAttemptFailed, StructuredQuestionRefused } from './service.ts';

/**
 * The narrow verb this coordinator needs from the answer domain: validate, drive, clear.
 *
 * A port rather than the concrete service, so the ordering rules below can be proved without a
 * terminal — and so that what this file adds (identity, joining, durability) stays visibly separate
 * from what the service already guarantees (the exact bound form, the visible advance, the atomic
 * clear). `StructuredQuestionService` satisfies it as written; nothing about it changes here.
 */
export interface StructuredAnswerPerformer {
  answer(input: {
    readonly id: SessionId;
    readonly toolUseId: string;
    readonly labels: readonly string[];
    readonly other?: string | undefined;
    readonly responses?: readonly string[] | undefined;
    readonly answers?: readonly StructuredQuestionAnswer[] | undefined;
  }): Promise<void>;
}

export interface StructuredAnswerCoordinatorPorts {
  readonly service: StructuredAnswerPerformer;
  readonly ledger: AnswerLedger;
  /**
   * Serializes every answer on one session, and MUST be this slice's own queue.
   *
   * Not the storage executor: clearing the answered form re-enters that queue under the same session
   * key, and a keyed queue chains work behind the tail it already holds — so holding it across the
   * drive would make the clear wait for the drive that is waiting for the clear. Sessions stay
   * concurrent with each other either way; only one session's answers line up.
   */
  readonly serial: SerialExecutor;
  readonly clock: ClockPort;
  /** The durable state, read only to reconcile an unsettled receipt against the authoritative fact. */
  readonly state: (id: SessionId) => Promise<SessionState | undefined>;
  /** The settled view, RE-READ on every answer and replay: a stored view is stale by construction. */
  readonly view: (id: SessionId) => Promise<SessionView>;
  /** Asks a person to look, when nothing can prove whether an earlier attempt reached the form. */
  readonly quarantine: (id: SessionId, record: AnswerOperationRecord) => Promise<void>;
}

/** One in-flight operation, so an identical retry observes it instead of starting a second one. */
interface InflightAnswer {
  readonly fingerprint: string;
  readonly running: Promise<SessionView>;
}

function inflightKey(id: SessionId, requestId: string): string {
  return JSON.stringify([id, requestId]);
}

/**
 * ONE LOGICAL ANSWER PERFORMS AT MOST ONE DRIVE OF THE RENDERED FORM.
 *
 * WHAT THIS REPLACES, because the shape of the defect is the argument for the shape of the fix. The
 * answer path used to hold a settled-view map keyed by session and request id, consulted on the way
 * in and written on the way out. Two things were wrong with it and only the second is obvious. The
 * obvious one is that a map does not survive a restart. The one that mattered is that the map was
 * written AFTER the drive finished, and the read of the pending question took no lock at all — so
 * two overlapping requests both saw no entry, both read the same open form, and both typed into it.
 * The second one's durable clear was refused, correctly and far too late: the keys were already
 * gone. A retry is not hypothetical here — the client re-sends a POST three times on a transport
 * failure, and the browser form mints one deterministic id per rendered question, so a re-click
 * after a lost answer carries the same id as the attempt that may already be running.
 *
 * THREE MECHANISMS, EACH DOING EXACTLY ONE THING. None of them substitutes for another.
 *
 *   THE PER-SESSION QUEUE makes two answers on one session sequential, so a second request can never
 *   observe the form state a first request is in the middle of changing. On its own it is not
 *   enough: it makes the second attempt WAIT and then run, which is still a second drive.
 *
 *   THE IN-FLIGHT REGISTRY makes an identical retry BE the first attempt rather than follow it. The
 *   promise is registered before it is awaited, so a replay joins the running operation and observes
 *   the same view or the same refusal — it never learns something the original did not. This is what
 *   turns "wait then repeat" into "wait then share".
 *
 *   THE DURABLE RECEIPT answers for everything this daemon no longer remembers: a retry that arrives
 *   after the answer settled, and any retry at all after a restart.
 *
 * THE ORDER IS THE SAFETY ARGUMENT, and there is exactly one correct one.
 *
 *   1. The receipt is written `accepted` BEFORE a key is sent. A daemon that dies mid-drive then
 *      leaves evidence rather than silence, which is the whole reason the ambiguous state has a name.
 *   2. The service drives the form and, on success, clears it — stamping the answered tool id in the
 *      same atomic write. THAT is the commit point, not anything in this file.
 *   3. The receipt is settled `confirmed`. A crash between 2 and 3 is harmless: the state document
 *      still proves the answer landed, and reconciliation promotes the receipt without a keystroke.
 *
 * A REFUSAL BEFORE THE FIRST KEY IS TOMBSTONED; A FAILURE AFTER IT IS NOT. `StructuredQuestionRefused`
 * is raised only while binding and validating — no key has reached the terminal — so its receipt is
 * `withdrawn` and the same id may honestly start over once the caller fixes the request. Every other
 * failure happened at or after the drive, where whether keys landed is genuinely unknown, so the
 * receipt stays `accepted` and the next request under that id is refused rather than repeated.
 * Guessing in that state is how a form gets answered twice.
 */
export class StructuredAnswerCoordinator {
  readonly #inflight = new Map<string, InflightAnswer>();

  constructor(private readonly ports: StructuredAnswerCoordinatorPorts) {}

  /**
   * The view this logical answer produced, driving the form at most once.
   *
   * The conflict check runs against the in-flight entry BEFORE the queue is joined, so a caller that
   * reused an id for a different answer is refused immediately rather than after waiting behind the
   * operation it is about to be told it may not have.
   */
  async answer(input: {
    readonly id: SessionId;
    readonly requestId: string;
    readonly request: AnswerRequestPayload;
  }): Promise<SessionView> {
    const fingerprint = answerFingerprint(input.request);
    const key = inflightKey(input.id, input.requestId);
    const existing = this.#inflight.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new AnswerRequestConflict(input.requestId);
      return await existing.running;
    }
    // Registered before it is awaited, and started with a CALL rather than an await, so no other
    // caller can interleave between the miss above and the registration below.
    const running = this.#perform(input.id, input.requestId, fingerprint, input.request);
    this.#inflight.set(key, { fingerprint, running });
    try {
      return await running;
    } finally {
      // A failure is not remembered here. The durable receipt already holds whichever of the two
      // stories is true — tombstoned, or ambiguous — and it holds it across a restart as well.
      if (this.#inflight.get(key)?.running === running) this.#inflight.delete(key);
    }
  }

  async #perform(
    id: SessionId,
    requestId: string,
    fingerprint: string,
    request: AnswerRequestPayload,
  ): Promise<SessionView> {
    await this.ports.serial.run(id, async () => {
      const records = await this.ports.ledger.all(id);
      const admission = decideAnswerAdmission({ existing: records.get(requestId), fingerprint });
      if (admission.kind === 'conflict') throw new AnswerRequestConflict(requestId);
      if (admission.kind === 'replay') return;
      if (admission.kind === 'failed') throw new AnswerTerminalFailure(admission.record);
      if (admission.kind === 'quarantined') throw new AnswerReleased(admission.record);
      if (admission.kind === 'acknowledged') throw new AnswerAcknowledged(admission.record);
      if (admission.kind === 'reconcile') {
        await this.#reconcile(id, requestId, admission.record);
        return;
      }

      // Request identity does not supersede tool identity. A caller can mint a fresh id, but it
      // cannot thereby authorize a second drive of the same rendered form.
      const prior = answerEvidenceForQuestion(
        [...records.values()].filter(record => record.requestId !== requestId),
        request.toolUseId,
      );
      if (prior.kind === 'unconfirmed') {
        await this.#reconcile(id, prior.record.requestId, prior.record);
        throw new AnswerToolAlreadyHandled(request.toolUseId, prior.record.requestId, 'confirmed');
      }
      if (prior.kind !== 'none')
        throw new AnswerToolAlreadyHandled(request.toolUseId, prior.record.requestId, prior.record.outcome);
      await this.#drive(id, requestId, fingerprint, request);
    });
    // The session reader proactively projects transcript/ledger evidence under this SAME serial
    // queue. Reading the view while holding it would re-enter the key and deadlock; the operation is
    // already settled here, so release first and then derive the current view.
    return await this.ports.view(id);
  }

  /** Settles a receipt an earlier attempt left open, from the state document and nothing else. */
  async #reconcile(id: SessionId, requestId: string, record: AnswerOperationRecord): Promise<void> {
    const verdict = reconcileUnconfirmedAnswer({ record, state: await this.ports.state(id) });
    if (verdict === 'quarantine') {
      // Absence of the answer stamp says only that the accepted operation is unresolved. It does
      // NOT prove the native form was released: an unconfirmed Escape may have left the exact form
      // on screen, and replacing `accepted` with `quarantined` here would let prose reach it. Only
      // the monitor's positive transcript-advance evidence or a confirmed cancellation may make
      // that transition. Keep the receipt open and let projection retain the exact binding.
      throw new AnswerUnconfirmed(
        requestId,
        record.toolUseId,
        record.reason ?? 'the durable session state could not prove either an answer or a release',
      );
    }
    await this.ports.ledger.append(id, {
      ...record,
      outcome: 'confirmed',
      reason: 'the answered form was already stamped durably; the receipt was behind',
    });
  }

  /** The only path that reaches a terminal, and the only one that writes an `accepted` receipt. */
  async #drive(id: SessionId, requestId: string, fingerprint: string, request: AnswerRequestPayload): Promise<void> {
    const accepted: AnswerOperationRecord = {
      requestId,
      toolUseId: request.toolUseId,
      fingerprint,
      acceptedAt: this.ports.clock.now(),
      outcome: 'accepted',
    };
    await this.ports.ledger.append(id, accepted);
    try {
      await this.ports.service.answer({
        id,
        toolUseId: request.toolUseId,
        labels: request.labels,
        ...(request.other === undefined ? {} : { other: request.other }),
        ...(request.responses === undefined ? {} : { responses: request.responses }),
        ...(request.answers === undefined ? {} : { answers: request.answers }),
      });
    } catch (error) {
      // Binding refusals are retryable. A recovered attempt carries the exact terminal receipt it
      // earned; an unrecovered failure deliberately leaves `accepted` as the crash-safe ambiguity.
      if (error instanceof StructuredQuestionRefused)
        await this.ports.ledger.append(id, {
          ...accepted,
          outcome: 'withdrawn',
          reason: `refused before any key was sent: ${error.message}`,
        });
      if (error instanceof StructuredQuestionAttemptFailed) {
        const settlement: AnswerOperationRecord = {
          ...accepted,
          outcome: error.receipt,
          reason: error.message,
        };
        // `accepted` remains deliberately unresolved, but append its diagnostic reason so a daemon
        // restart does not erase why release could not be proved. It still authorizes no second
        // drive; only the authoritative stamp or positive monitor evidence may settle it.
        if (settlement.outcome === 'quarantined') await this.ports.quarantine(id, settlement);
        await this.ports.ledger.append(id, settlement);
      }
      throw error;
    }
    await this.ports.ledger.append(id, { ...accepted, outcome: 'confirmed' });
  }
}
