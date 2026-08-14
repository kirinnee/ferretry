/**
 * Restart-safe fork orchestration.
 *
 * THE ORDER IS THE DESIGN, and it is one line long:
 *
 * ```
 * prepare → claim the receipt → create the target → persist the plan → import → capture the
 * target's provenance → start
 * ```
 *
 * Everything before the claim reads and decides; everything after it writes, and writes only into a
 * session that did not exist when the decision was made. That split is what makes a crash
 * survivable at every boundary. Before the claim, a crash leaves NOTHING behind — no receipt, no
 * session, no partial state — and the caller simply asks again. After it, every remaining step is
 * bound to the reserved target and safe to repeat, so a replay finishes the same fork rather than
 * starting a second one.
 *
 * THE CLAIM COMES BEFORE THE CREATE, NOT AFTER IT, and the order is not interchangeable. Creating
 * first and recording second leaves a window in which a session exists that no receipt names: the
 * retry — which for a client on a lost response is milliseconds away — finds no receipt, prepares
 * again against a source whose transcript has moved on, and creates a SECOND session carrying a
 * different conversation. The reserved id is written down before anything can be made under it, so
 * that window does not exist.
 *
 * SOURCE DECISIONS ARE DERIVED EXACTLY ONCE PER FORK. Preparation happens only on the path that
 * found no durable receipt. A real import validation-only rereads the provenance and point pinned in
 * that persisted plan, and may refuse but never replace its frozen messages. A replay whose target
 * already proves the complete import returns its deterministic report from that target evidence
 * instead, so losing only the receipt advance cannot make later source pruning undo completed work.
 * Once a receipt exists, every retry applies that same decision rather than preparing again.
 */

import type { SessionView } from '@ferretry/protocol';
import { SessionForkRequestConflictError } from './failures.ts';
import { type SessionForkCommand, type SessionForkKey, sessionForkFingerprint } from './identity.ts';
import {
  advanceSessionForkReceipt,
  claimSessionForkReceipt,
  parseSessionForkReceipt,
  type SessionForkImportReport,
  type SessionForkPhase,
  type SessionForkReceipt,
  sessionForkPhaseRank,
  sessionForkReport,
} from './receipt.ts';
import type { SessionForkPorts, SessionForkResult } from './types.ts';

export class SessionForkService {
  constructor(private readonly ports: SessionForkPorts) {}

  /**
   * Forks `key.sourceSessionId` through the message the command names, at most once per key.
   *
   * The composite key is the unit of both serialisation and durability: the same request id
   * presented against a different source is a different fork and shares nothing with this one.
   */
  async fork(key: SessionForkKey, command: SessionForkCommand): Promise<SessionForkResult> {
    return await this.ports.serial.run(key, async () => await this.forkUnderKey(key, command));
  }

  private async forkUnderKey(key: SessionForkKey, command: SessionForkCommand): Promise<SessionForkResult> {
    const requestFingerprint = sessionForkFingerprint(command);
    const held = await this.ports.receipts.read(key);
    const receipt =
      held === undefined ? await this.claim(key, command, requestFingerprint) : parseSessionForkReceipt(held, key);

    /**
     * Checked on BOTH paths, and after the claim rather than before it: a claim that lost the
     * compare-and-set answers with the receipt that won, which may have been claimed for a
     * different payload entirely. One test decides it either way.
     */
    if (receipt.requestFingerprint !== requestFingerprint) throw new SessionForkRequestConflictError(key);
    return await this.drive(receipt);
  }

  /**
   * Prepares, reserves a fresh target, and takes durable ownership of the key.
   *
   * The id is minted here rather than by whatever creates the session, because the id has to exist
   * in the receipt before anything can be created under it. `preparedAt` and the claim share one
   * reading of the clock so the plan and the receipt that carries it agree about when the decision
   * was made.
   */
  private async claim(
    key: SessionForkKey,
    command: SessionForkCommand,
    requestFingerprint: string,
  ): Promise<SessionForkReceipt> {
    const target = await this.ports.resolver.resolve(command);
    const at = this.ports.clock.now();
    const plan = await this.ports.preparer.prepare({
      sourceSessionId: key.sourceSessionId,
      requestId: key.requestId,
      target,
      cutMessagePoint: command.through,
      selectionBinding: command.selectionBinding,
      preparedAt: at,
    });

    /**
     * THE LAST TWO QUESTIONS, ASKED WHILE THE ANSWER IS STILL FREE.
     *
     * Both need the prepared plan and neither may run after the claim, which is what puts them
     * exactly here. `validate` re-asks the catalogue in the working directory the plan just froze —
     * resolution could only use a daemon-owned fallback, because the target's directory is the
     * SOURCE's and nothing had read the source yet. `assertDeliverable` renders the opening turn the
     * plan implies and refuses one the target's first-turn document could not hold.
     *
     * A refusal from either is an ordinary refusal that wrote NOTHING. The same two conditions found
     * one line later — after the claim — would instead be a durable receipt whose every replay fails
     * identically, forever, because every post-claim step is idempotent and re-driven by design.
     */
    await this.ports.resolver.validate(plan.target, plan.durable.cwd);
    this.ports.opening.assertDeliverable(plan);

    const claimed = claimSessionForkReceipt({
      key,
      requestFingerprint,
      targetSessionId: this.ports.ids.next(),
      plan,
      at,
    });
    return parseSessionForkReceipt(await this.ports.receipts.claim(claimed), key);
  }

  /**
   * Runs whatever the receipt says is still outstanding.
   *
   * There is one code path for a first attempt and for a replay: a first attempt is simply a
   * receipt with everything outstanding. So the crash-recovery path is not a second implementation
   * that can rot — it is the only implementation, exercised by every fork this daemon performs.
   */
  private async drive(receipt: SessionForkReceipt): Promise<SessionForkResult> {
    // Both anchors together: the reserved id, and the plan the receipt froze. Every bound operation
    // reconciles the target against P0 rather than against whatever is installed beside it — a valid
    // substitute under the same deterministic plan id must not be able to satisfy the later phases.
    const target = this.ports.binder.bind(receipt.targetSessionId, receipt.plan);
    let current = receipt;

    if (outstanding(current, 'target_created')) {
      await target.lifecycle.create(current.plan);
      current = await this.stamp(current, 'target_created');
    }
    if (outstanding(current, 'plan_persisted')) {
      await target.plans.persist(current.plan);
      current = await this.stamp(current, 'plan_persisted');
    }
    if (outstanding(current, 'imported')) {
      const report = await target.importer.importPlan(current.plan, current.targetSessionId);
      current = await this.stamp(current, 'imported', report);
    }
    if (outstanding(current, 'provenance_captured')) {
      await target.lifecycle.captureTranscriptProvenance();
      current = await this.stamp(current, 'provenance_captured');
    }

    /**
     * A fork that has already completed is answered from its durable receipt plus the target's
     * CURRENT view. Starting again would be the one repeat that is not harmless: a lost response
     * arriving after an operator stopped the new session would quietly start it back up.
     */
    let session: SessionView;
    if (outstanding(current, 'completed')) {
      session = await target.lifecycle.start();
      current = await this.stamp(current, 'completed');
    } else {
      session = await target.lifecycle.view();
    }

    return {
      targetSessionId: current.targetSessionId,
      session,
      plan: current.plan,
      report: sessionForkReport(current),
    };
  }

  /** Records a crossed boundary, durably, before the next one is attempted. */
  private async stamp(
    receipt: SessionForkReceipt,
    phase: SessionForkPhase,
    report?: SessionForkImportReport,
  ): Promise<SessionForkReceipt> {
    const next = advanceSessionForkReceipt(receipt, { phase, at: this.ports.clock.now(), report });
    await this.ports.receipts.advance(next);
    return next;
  }
}

/** Whether this fork still has to cross the named boundary. */
function outstanding(receipt: SessionForkReceipt, phase: SessionForkPhase): boolean {
  return sessionForkPhaseRank(receipt.phase) < sessionForkPhaseRank(phase);
}
