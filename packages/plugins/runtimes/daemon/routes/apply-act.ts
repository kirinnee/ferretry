/**
 * What `POST /v1/runtimes/proposals/:proposalId/apply` adds around the service for an import or a clone (C59 O5-10b):
 *
 * 1. **One act, one passkey.** An import writes several owners' files (the login, Claude Code's settings, Runtimes' own
 *    set). Each can loosen, and Gate's judge used to spend a remote device's one proof on the first, then hold the next
 *    and throw part-way: the first file landed, the runtimes never did. The apply now opens ONE loosening act
 *    (`openLooseningAct`): the proof is claimed BEFORE anything is written and covers every file of the act; a device
 *    without one is answered `403 grant_step_up_required` (`loosen-config`) with nothing written, so the carrier asks
 *    for the passkey and sends the apply again. Somebody at the machine claims nothing, as before.
 * 2. **Every refused or held apply is a log line.** A handler's 409 is not an admission refusal, so the daemon's log
 *    used to say nothing at all while a phone waited. The line names the change id, its kind, the status and the code:
 *    ids and names only, never a sentence (a refusal can quote a budget), never a value.
 */
import { openLooseningAct } from '@ferretry/core-gate/contract';
import { ApiError, type ApiResponse, type CallContext, type Log } from '@ferretry/kernel/contract';
import type { AccountChangeOutcome } from '../../contract/index.ts';
import type { FleetCatalogService } from '../lib/service/catalog-service.ts';

/** The changes an EXECUTOR carries out across owners: one person act each, confirmed once. */
const ACT_KINDS: ReadonlySet<string> = new Set(['setup.import', 'clone.import']);

const ACT_WORDS: Readonly<Record<string, string>> = {
  'setup.import': 'import this setup',
  'clone.import': 'copy this setup',
};

/** The kind of the pending change `id`, or `undefined` when it cannot be read (the apply then refuses it itself). */
async function pendingKind(subsystem: Pick<FleetCatalogService, 'read'>, id: string): Promise<string | undefined> {
  try {
    const view = await subsystem.read(id);
    return view.state === 'pending' ? view.change.kind : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an answered apply left something waiting for the owner, or did not finish: worth a line. */
function heldOrUnfinished(outcome: AccountChangeOutcome): 'held' | 'unfinished' | undefined {
  if (outcome.outcome === 'login-changed' && outcome.result === 'held') return 'held';
  if (outcome.outcome === 'executed' && /\bheld\b/u.test(outcome.summary)) return 'held';
  const apply =
    outcome.outcome === 'applied' ? outcome.apply : outcome.outcome === 'login-changed' ? outcome.moved : undefined;
  return apply?.outcome === 'rolled-back' || apply?.outcome === 'rollback-incomplete' ? 'unfinished' : undefined;
}

/** The apply's refusal as the log keeps it: status and code, never the sentence. */
function refusalOf(error: unknown): { readonly status: number; readonly code: string } {
  if (error instanceof ApiError) return { status: error.status, code: error.code ?? 'refused' };
  return { status: 500, code: error instanceof Error ? error.name : 'error' };
}

/**
 * Runs one apply: opens the loosening act when the change is an import or a clone, then `work` with the claim the
 * service hands its executor (covered by the act's proof), and logs every refusal and every held or unfinished answer.
 */
export async function applyAsOneAct(input: {
  readonly call: CallContext;
  readonly id: string;
  readonly subsystem: Pick<FleetCatalogService, 'read'>;
  readonly log: Log | undefined;
  readonly work: (claim: () => boolean) => Promise<ApiResponse>;
  /** What the service answered, when it answered one: read for the held line. */
  readonly answered: () => AccountChangeOutcome | undefined;
}): Promise<ApiResponse> {
  const { call, id, log } = input;
  const kind = (await pendingKind(input.subsystem, id)) ?? 'unknown';
  const say = (fields: Readonly<Record<string, string | number>>): void => {
    log?.warn('runtimes: a change was not fully applied', { change: id, kind, ...fields });
  };
  const act = ACT_KINDS.has(kind) ? openLooseningAct(call, ACT_WORDS[kind] ?? 'apply this change') : undefined;
  if (act !== undefined && 'refused' in act) {
    say({ status: act.refused.status, code: 'grant_step_up_required', act: 'loosen-config' });
    return act.refused;
  }
  try {
    const response = await input.work(() => act?.covered === true || call.claimFreshStepUp?.() === true);
    if (response.status >= 400) say({ status: response.status, code: 'refused' });
    else {
      const outcome = input.answered();
      const left = outcome === undefined ? undefined : heldOrUnfinished(outcome);
      if (left !== undefined) say({ status: response.status, code: left });
    }
    return response;
  } catch (error) {
    say(refusalOf(error));
    throw error;
  } finally {
    act?.end();
  }
}
