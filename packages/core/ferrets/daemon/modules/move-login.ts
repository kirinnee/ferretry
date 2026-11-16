import type { RuntimeStartResolution } from '../../contract/index.ts';
import type { RuntimeModelCatalog } from '../../contract/view/runtime-control.ts';
import type { BoundConversation } from '../lib/ferrets/bound-conversation.ts';
import { planLoginMove } from '../lib/moves/login-plan.ts';
import type { SessionConfig, SessionState, SessionView } from '../lib/protocol/session.ts';
import { SessionMoveError, type SessionMoveSubsystem } from '../lib/runtime/mounts/session-move.ts';
import type { SessionId } from '../lib/session-id.ts';
import { type RestartContext, relaunchInPlace } from './restart-in-place.ts';

/**
 * MOVE A FERRET ONTO ANOTHER LOGIN of the same harness (c58-37): the move that spends another runtime's login, with the
 * conversation, the work and the ferret itself kept.
 *
 * A move is a Restart onto another runtime (`relaunchInPlace`): the same gate, the same report before the pane dies, the
 * same replaced-pane resume under the ferret's own queue. What is its own is what is decided FIRST, from reads alone, so
 * that every refusal costs nothing and leaves the record, the session documents and the live pane exactly as they were:
 *
 *   1. what 5.0 does not do yet (converting a conversation onto another harness, going back to an earlier one) is refused
 *      by name;
 *   2. Runtimes resolves the target (`runtime.start`): the harness it runs and whether it can serve a launch at all. A
 *      runtime of ANOTHER harness is refused (moving to another harness is not built yet);
 *   3. what the target serves (`catalog?`) decides the model, the window and the effort, in one pure planner
 *      (`planLoginMove`);
 *   4. the conversation the ferret is bound to must be the harness's to resume: its home belongs to the FERRET, not to a
 *      login, so a same-harness move carries nothing and the conversation stays where it is. It is checked present BEFORE
 *      anything is written, so a launch never quietly opens a NEW one (the person may choose Start fresh).
 *
 * A move never names a login: `runtime.start` is the only answer to which credential a relaunch spends, and the SAME
 * resolution runs again at the launch, before the live pane is released.
 */

type MoveRequest = Parameters<SessionMoveSubsystem['move']>[1];

/** What a move onto another login borrows of another plugin and of the Ferrets service. */
export interface LoginMoveNeeds {
  /** Runtimes: the harness and login the runtime NAMED starts with, or the sentence saying why it cannot serve a launch. */
  readonly resolve: (runtime: string) => Promise<RuntimeStartResolution>;
  /** Runtimes: what the runtime NAMED serves, or `undefined` when it cannot say (no such runtime, or no provider that reads one). */
  readonly catalog: (runtime: string) => Promise<RuntimeModelCatalog | undefined>;
  /** The conversation the ferret is bound to and whether its harness has it (read-only). */
  readonly conversation: (id: SessionId) => Promise<BoundConversation>;
}

const unavailable = (sentence: string): SessionMoveError => new SessionMoveError('unavailable', sentence);

/** Moves ferret `id` onto the runtime `request.agent` names, which the caller has proved is not the one it is on. */
export async function moveToLogin(
  ctx: RestartContext,
  needs: LoginMoveNeeds,
  id: SessionId,
  request: MoveRequest,
  documents: { readonly config: SessionConfig; readonly state: SessionState },
): Promise<SessionView> {
  const { config, state } = documents;
  const record = ctx.restart.record(id);
  if (record === undefined) throw new SessionMoveError('not_found', `no ferret ${id}`);
  const target = request.agent;
  // REFUSED BEFORE ANY READ, WRITE OR KILL. A conversion is the one way across harnesses and is not built yet; the harness's
  // finder for "the earlier conversation" lists the OWNER'S own history, never the ferret's home, so answering it would
  // unbind the ferret's real conversation for one of the person's.
  if (request.conversation === 'convert')
    throw unavailable('converting a conversation onto another harness is not built yet, so a move cannot do it');
  if (request.conversation === 'previous')
    throw unavailable('going back to an earlier conversation is not built yet, so a move cannot do it');

  const resolved = await needs.resolve(target).catch(
    (): RuntimeStartResolution => ({
      ok: false,
      sentence: `runtime ${target} could not be checked, so the ferret was not moved`,
    }),
  );
  if (!resolved.ok) throw unavailable(resolved.sentence);
  // SAME-KIND, ENFORCED HERE: the first thing decided once the target's family is known, before anything reads a catalogue
  // or the host. A different harness cannot carry this conversation, and no converter is built yet.
  if (resolved.harness !== record.harness)
    throw unavailable(
      `runtime ${target} runs the ${resolved.harness} harness and this ferret runs ${record.harness}: moving to another harness is not built yet`,
    );
  const targetCatalog = await needs.catalog(target).catch(() => undefined);
  if (targetCatalog === undefined)
    throw unavailable(
      `Ferretry cannot tell what models runtime ${target} serves, so a move onto it cannot be planned (nothing was changed)`,
    );
  const from = record.runtime ?? config.agent;
  const sourceCatalog =
    record.runtime === undefined ? undefined : await needs.catalog(record.runtime).catch(() => undefined);

  const plan = planLoginMove({
    config,
    state,
    requestedModel: request.model,
    allowContextDowngrade: request.allowContextDowngrade,
    source: sourceCatalog,
    target: targetCatalog,
  });
  if (plan.kind === 'unservable_model') throw new SessionMoveError('unservable_model', plan.reason);
  if (plan.kind === 'context_downgrade')
    throw new SessionMoveError('context_downgrade', plan.reason, { downgrade: plan.downgrade });

  // NEVER A SILENT NEW CONVERSATION: still before the first write, so a refusal leaves the ferret exactly as it was and the
  // person can choose to start fresh. A doubt (a harness that cannot tell) resumes as asked, as a launch does.
  const wanted = request.conversation === 'fresh' ? undefined : await needs.conversation(id);
  if (wanted !== undefined && wanted.id === undefined)
    throw new SessionMoveError(
      'unresumable',
      'This ferret has no recorded conversation, so there is nothing Ferretry can resume. Nothing was changed.',
    );
  if (wanted?.present === false)
    throw new SessionMoveError(
      'unresumable',
      'The conversation this ferret is bound to is not in its home any more, so there is nothing to resume. Nothing was changed.',
    );

  return await relaunchInPlace(ctx, id, request, config, {
    from,
    to: target,
    ...(plan.model === undefined ? {} : { model: plan.model }),
    handle: record.handle,
    conversation: wanted === undefined ? { kind: 'fresh' } : { kind: 'resume' },
    onto: {
      runtime: target,
      ...(plan.model === undefined ? {} : { model: plan.model }),
      ...(plan.effort === undefined ? {} : { effort: plan.effort }),
      ...(wanted?.id === undefined ? {} : { conversation: wanted.id }),
    },
    // The session document names where the ferret now runs and how that was chosen. The effort and fast mode are the
    // previous login's launch record and are dropped with it: the target starts on the effort the plan carried, or its own.
    restamp: retained => {
      const { model: _model, launchReasoningEffort: _effort, launchFast: _fast, ...rest } = retained;
      return {
        ...rest,
        agent: target,
        ...(plan.model === undefined ? {} : { model: plan.model }),
        modelHint: plan.model ?? '',
        launchModelSource: plan.modelSource,
        ...(plan.effort === undefined ? {} : { launchReasoningEffort: plan.effort }),
      };
    },
  });
}
