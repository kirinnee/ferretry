import type { Clock } from '@ferretry/kernel/contract';
import { jsonObject } from '@ferretry/std';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import type { GateDecision, InflightReport } from '../lib/moves/inflight-report.ts';
import type { ObservedSession } from '../lib/moves/outcome-render.ts';
import type { MovePreflight } from '../lib/moves/preflight-service.ts';
import type { MoveReportStore } from '../lib/moves/report-store.ts';
import { SessionConfigSchema, type SessionView } from '../lib/protocol/session.ts';
import { SessionMoveError, type SessionMoveSubsystem } from '../lib/runtime/mounts/session-move.ts';
import { ResumeRefused } from '../lib/session/resume/index.ts';
import type { ResumeOutcome, ResumeRequest } from '../lib/session/resume/service.ts';
import {
  MOVE_INTENT_KEY,
  moveIntentOf,
  restoreRestamped,
  settleRejectedRelaunch,
  settleUnrevivedRelaunch,
} from '../lib/session/resume/unrevived-relaunch.ts';
import type { SessionId } from '../lib/session-id.ts';
import type { z } from 'zod';
import type { HarnessKey } from '../../contract/index.ts';

/**
 * RESTART CLI on a 5.0 ferret (c58-37): relaunching the harness CLI of a ferret on the runtime it is ALREADY on — and the
 * one relaunch a MOVE onto another login of the same harness shares (`relaunchInPlace`, called by `move-login.ts`).
 *
 * The subject is the ferret's registry record, not a lifecycle half of its session document: the ferret's pane is reached
 * through its runner by the record's handle (`MovePane`), and the relaunch is `FerretsService.resume` with the live pane
 * replaced. A harness home belongs to the FERRET in 5.0, so the conversation stays where it is and a Restart carries
 * nothing; it only restamps the incarnation counter and the move record (the spend meter reads them) and resumes the
 * conversation the record is bound to. Nothing is planned, so no account, catalogue or planner is asked, and nothing
 * Restart does can change the model, the login or the harness.
 *
 * What a person relied on in 4.x is kept: the gate refuses work it cannot show will survive (writing nothing but the
 * refusal), the report is written before the pane dies, the config is put back only when the registered pane is provably
 * the one that served before, and a refused relaunch leaves a working ferret working.
 */

type MoveRequest = Parameters<SessionMoveSubsystem['move']>[1];

/** What a Restart or a move keeps of a ferret: the facts only the registry owns. */
interface RestartRecord {
  /** The runtime it is on (what a Restart relaunches on); a ferret with none cannot be restarted this way. */
  readonly runtime: string | undefined;
  /** The harness it runs: what a move onto another login must stay on. */
  readonly harness: HarnessKey;
  /** The pane the runner holds for it now, which the gate looked at: the relaunch refuses if it has changed since. */
  readonly handle: string | undefined;
}

/** Which conversation the relaunch opens: the one the ferret is bound to, or a new one. */
type RestartConversation = { readonly kind: 'resume' } | { readonly kind: 'fresh' };

export interface RestartRelaunch {
  readonly id: SessionId;
  readonly origin: ResumeRequest['origin'];
  readonly actor?: ResumeRequest['actor'];
  readonly message: string | undefined;
  /** The pane the gate looked at: judged under the ferret's own queue, so a pane replaced meanwhile refuses with nothing written. */
  readonly expectHandle: string | undefined;
  readonly conversation: RestartConversation;
  /**
   * Called once the relaunch can no longer be refused for a reason that leaves the ferret as it was, and before the live pane
   * is released: where the session document is restamped, so a refusal before it writes nothing at all.
   */
  readonly committed: () => Promise<void>;
  /**
   * A MOVE: the runtime (and so the login) the relaunch is on, with the model and effort the move planned and the
   * conversation to resume (absent for a fresh one). Absent for a Restart, which stays on the record's own.
   */
  readonly onto?: {
    readonly runtime: string;
    readonly model?: string;
    readonly effort?: string;
    readonly conversation?: string;
  };
}

/** What the Ferrets service lends a Restart (bound where the service is: `daemon/features/moves.feature.ts`). */
export interface RestartNeeds {
  readonly record: (id: SessionId) => RestartRecord | undefined;
  /** The relaunch itself: refuses (`ResumeRefused`) with a sentence, or answers how it ended. */
  readonly relaunch: (request: RestartRelaunch) => Promise<ResumeOutcome>;
}

/** What a Restart is run from: the move's own closures, handed in so this file imports nothing from the module that calls it. */
export interface RestartContext {
  readonly storage: Pick<DaemonStorage, 'append' | 'updateConfig'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly reports: MoveReportStore;
  readonly preflight: MovePreflight;
  readonly restart: RestartNeeds;
  readonly paneIdentity: (id: SessionId) => Promise<string | undefined>;
  /** The gate's look at the pane (the requesting call, when this is a self-restart, is already left out). */
  readonly inspect: () => Promise<InflightReport>;
  /** Journals one refusal: the only write a refused Restart makes. */
  readonly refused: (report: InflightReport, decision: GateDecision) => Promise<void>;
  readonly view: (when: string) => Promise<SessionView>;
  readonly observed: () => Promise<ObservedSession | undefined>;
}

/** A session's moves before this one, oldest first: its `moves` list. A malformed entry is dropped, not thrown. */
function priorMoves(config: Readonly<Record<string, unknown>>): { from: string; to: string; at: string }[] {
  const parsed = SessionConfigSchema.pick({ moves: true }).safeParse(config);
  if (!parsed.success) return [];
  return [...(parsed.data.moves ?? [])];
}

/** The inventory items that blocked a Restart, as the journal records them: a title and, where there is one, its detail. */
function blockersOf(described: {
  readonly items: ReadonlyArray<{ readonly blocks: boolean; readonly title: string; readonly detail?: string }>;
}): Array<{ title: string; detail?: string }> {
  return described.items
    .filter(item => item.blocks)
    .map(item => ({ title: item.title, ...(item.detail === undefined ? {} : { detail: item.detail }) }));
}

/** What a relaunch that threw something other than a refusal answers: the cause is in the move report, not in the answer. */
const RELAUNCH_FAILED = 'the relaunch failed before it could be completed; the move report and the journal say why';

function relaunchRefusal(error: unknown): never {
  // A refusal's sentence is written to be shown. Anything else is a fault whose message can carry paths and internals.
  if (error instanceof ResumeRefused) throw new SessionMoveError('refused', error.message);
  throw new SessionMoveError('failed', RELAUNCH_FAILED);
}

/** Restarts ferret `id` on the runtime it is on. The caller has already proved the request names that runtime. */
export async function restartInPlace(
  ctx: RestartContext,
  id: SessionId,
  request: MoveRequest,
  config: z.infer<typeof SessionConfigSchema>,
): Promise<SessionView> {
  const record = ctx.restart.record(id);
  if (record === undefined) throw new SessionMoveError('not_found', `no ferret ${id}`);
  const agent = record.runtime;
  if (agent === undefined) throw new SessionMoveError('not_found', `ferret ${id} is on no runtime to restart on`);
  if (request.conversation === 'convert')
    throw new SessionMoveError(
      'unavailable',
      'converting a conversation onto another harness is not built yet, so a Restart cannot do it',
    );
  if (request.model !== undefined && request.model !== config.model)
    throw new SessionMoveError(
      'unavailable',
      `a Restart keeps the model this ferret is on; to run on ${request.model}, move the ferret onto a runtime that serves it`,
    );
  // REFUSED BEFORE ANY WRITE OR KILL, as `convert` is: the harness's finder for "the earlier conversation" lists the OWNER'S
  // own history, never the ferret's home, so answering it would unbind the ferret's real conversation for one of the
  // person's. It waits for a reader the harness scopes to the ferret's home.
  if (request.conversation === 'previous')
    throw new SessionMoveError(
      'unavailable',
      'going back to an earlier conversation is not built yet, so a Restart cannot do it',
    );
  const conversation: RestartConversation = request.conversation === 'fresh' ? { kind: 'fresh' } : { kind: 'resume' };
  return await relaunchInPlace(ctx, id, request, config, {
    from: agent,
    to: agent,
    ...(config.model === undefined ? {} : { model: config.model }),
    handle: record.handle,
    conversation,
    // A Restart restamps only the bookkeeping: the runtime, model, effort and login are the ones it is already on.
    restamp: retained => retained,
  });
}

/** What one relaunch in place is: where the ferret comes from and goes to, and what it restamps on the way. */
export interface RelaunchShape {
  /** The runtime the ferret is on now (the same as `to` for a Restart). */
  readonly from: string;
  readonly to: string;
  /** The model the relaunch runs, for the report and the journal; absent when the target names none. */
  readonly model?: string;
  /** The pane the gate looks at: the relaunch refuses, writing nothing, if the registry's handle is not this one by then. */
  readonly handle: string | undefined;
  readonly conversation: RestartConversation;
  /** The target a MOVE relaunches on (see {@link RestartRelaunch.onto}); absent for a Restart. */
  readonly onto?: RestartRelaunch['onto'];
  /** What the move writes onto the session document beside the bookkeeping, over the document as it stands. */
  readonly restamp: (retained: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
}

/**
 * The relaunch a Restart and a move onto another login of the same harness share, after each has decided what it is (and
 * refused what it will not do, writing nothing): the gate, the report written before the pane dies, the restamp, and the
 * resume with the live pane replaced under the ferret's own queue. Everything that can refuse before the pane is released
 * has already refused when it gets to the kill, and a refusal puts the restamped keys back exactly.
 */
export async function relaunchInPlace(
  ctx: RestartContext,
  id: SessionId,
  request: MoveRequest,
  config: z.infer<typeof SessionConfigSchema>,
  shape: RelaunchShape,
): Promise<SessionView> {
  const { from, to: agent, model } = shape;
  const by = request.movedBy ?? 'owner';
  const { conversation } = shape;

  const report = await ctx.inspect();
  const decision = ctx.preflight.gate(report, { force: request.forceInflight });
  if (!decision.proceed) {
    // EVERY REFUSAL IS COUNTED: the one write a refused Restart makes (the session's config and record are untouched).
    await ctx.refused(report, decision);
    throw new SessionMoveError('refused', `${decision.reason}\n${ctx.preflight.summarize(report)}`, {
      inflight: ctx.preflight.describe(report),
    });
  }
  const at = ctx.clock.now() as string;
  if (decision.forced)
    await ctx.storage.append(id, 'session.move_forced', {
      to: agent,
      verdict: report.worstVerdict,
      went_past: blockersOf(ctx.preflight.describe(report)),
    });
  const reportPath = await ctx.reports.write(
    id,
    ctx.preflight.document(report, {
      sessionId: id,
      targetAgent: agent,
      ...(model === undefined ? {} : { targetModel: model }),
      forced: decision.forced,
      at,
    }),
  );
  const generation = config.runtimeGeneration + 1;
  // The record as it stood, to put back if the old harness is still the one serving after a failed relaunch. Absent until the
  // document is restamped, which happens only once everything that can refuse without launching has passed (`committed`).
  let recordBefore: Readonly<Record<string, unknown>> | undefined;
  const restamp = async (): Promise<void> => {
    await ctx.storage.updateConfig(id, current => {
      const retained = jsonObject(current) ?? {};
      recordBefore = retained;
      return {
        ...shape.restamp(retained),
        // THE INTENT RIDES IN THIS SAME WRITE: config.json and the record are two files, so a crash after this write and
        // before the record is retargeted leaves them disagreeing. The next boot reads this and puts config.json back.
        [MOVE_INTENT_KEY]: moveIntentOf(retained, { from, to: agent, at }),
        incarnation: `${id}-${generation}`,
        runtimeGeneration: generation,
        move: { from, to: agent, at },
        // The whole history, for the spend meter: the last 999 earlier moves and this one.
        moves: [...priorMoves(retained).slice(-999), { from, to: agent, at }],
        updatedAt: at,
      };
    });
  };
  await ctx.storage.append(id, 'session.moving', {
    from,
    to: agent,
    by,
    ...(model === undefined ? {} : { model }),
    conversation: conversation.kind === 'resume' ? 'resumed' : 'fresh',
    report: reportPath,
    verdict: report.worstVerdict,
  });
  const settle = async (ok: boolean, detail?: string): Promise<void> => {
    const observed = await ctx.observed();
    await ctx.reports.append(
      id,
      ctx.preflight.settle({
        ok,
        from,
        targetAgent: agent,
        ...(model === undefined ? {} : { targetModel: model }),
        at: ctx.clock.now() as string,
        ...(detail === undefined ? {} : { detail }),
        ...(observed === undefined ? {} : { observed }),
      }),
    );
    await ctx.storage.append(id, ok ? 'session.moved' : 'session.move_failed', {
      from,
      to: agent,
      by,
      ...(detail === undefined ? {} : { detail }),
    });
  };
  const paneBefore = await ctx.paneIdentity(id);
  const rollBack = async (): Promise<void> => {
    const before = recordBefore;
    // Nothing to put back for a refusal that came before the document was restamped: it was never written.
    if (before === undefined) return;
    await ctx.storage.updateConfig(id, current => restoreRestamped(before, jsonObject(current) ?? {}));
  };
  const handoff = ctx.preflight.handoff(report, reportPath, config.mode);
  const outcome = await ctx.restart
    .relaunch({
      id,
      origin: request.origin,
      ...(request.actor === undefined ? {} : { actor: request.actor }),
      message: request.note === undefined ? handoff : `${request.note}\n\n${handoff}`,
      // The pane the gate judged: if it was replaced (or stopped) between the gate and the kill, nothing is written.
      expectHandle: shape.handle,
      conversation,
      committed: restamp,
      ...(shape.onto === undefined ? {} : { onto: shape.onto }),
    })
    .catch(async (error: unknown) => {
      const rolledBack = await settleRejectedRelaunch({
        from,
        paneBefore,
        paneNow: await ctx.paneIdentity(id),
        rollBack,
      });
      await settle(false, (error instanceof Error ? error.message : String(error)) + rolledBack);
      relaunchRefusal(error);
    });
  if (outcome.disposition !== 'revived') {
    const detail = await settleUnrevivedRelaunch({
      disposition: outcome.disposition,
      from,
      to: agent,
      paneBefore,
      paneNow: await ctx.paneIdentity(id),
      rollBack,
    });
    await settle(false, detail);
    throw new SessionMoveError('failed', detail);
  }
  await settle(true);
  // Read back through the SAME reader the list and the single read serve, so a Restart or a move answers with the view
  // those surfaces will show rather than a projection of its own writes.
  return await ctx.view(from === agent ? 'was restarted' : 'was moved');
}
