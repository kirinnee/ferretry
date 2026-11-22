/**
 * What `POST /v1/runtimes/proposals/:proposalId/apply` adds around the service for an import or a clone (C59 O5-10b):
 *
 * 1. **One act, one passkey.** An import writes several owners' files (the login, Claude Code's settings, Runtimes' own
 *    set). Each can loosen, and Gate's judge used to spend a remote device's one proof on the first, then hold the next
 *    and throw part-way: the first file landed, the runtimes never did. The apply now opens ONE loosening act
 *    (`openLooseningAct`) and it opens INSIDE the service's serialised apply (`ApplyBracket.open`), once the change is
 *    resolved and before any work: the kind is read from the change that is really being applied, never from a read
 *    that raced an apply in flight. The proof PROVED FOR `loosen-config` is claimed before anything is written and
 *    covers every file of the act; a device without one is answered `403 grant_step_up_required` (`loosen-config`)
 *    with nothing written and the change still pending, so the carrier asks for the passkey and sends the apply
 *    again. Somebody at the machine claims nothing, as before.
 * 2. **The act ends with the request.** It closes when the apply settles AND when the request ends (its signal): a
 *    request that ended while it waited its turn consumes nothing and writes nothing, and one that ends mid-way ends
 *    the act, so no later loosening of that request rides on its proof.
 * 3. **Every refused, held or unfinished apply is a log line.** A handler's 409 is not an admission refusal, so the
 *    daemon's log used to say nothing at all while a phone waited. The line names the change id (only an id this
 *    daemon minted), its kind, the status and a FIXED code: never a path segment, an error's name or a sentence (a
 *    refusal can quote a budget), never a value. What an executor left held or refused behind a `200` is read from
 *    structured state it reports (`ExecutorCaller.left`), never parsed out of its words.
 */
import { openLooseningAct } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type Log,
  type PlainApiResponse,
} from '@ferretry/kernel/contract';
import type { AccountChangeOutcome } from '../../contract/index.ts';
import type { ApplyAct, ApplyBracket, ApplyLeft } from '../lib/service/catalog-service.ts';

/** The changes an EXECUTOR carries out across owners: one person act each, confirmed once. */
const ACT_KINDS: ReadonlySet<string> = new Set(['setup.import', 'clone.import']);

const ACT_WORDS: Readonly<Record<string, string>> = {
  'setup.import': 'import this setup',
  'clone.import': 'copy this setup',
};

/** A change id this daemon minted (`fy_fprop_` and 22 URL-safe characters); anything else is never logged. */
const MINTED_ID = /^fy_fprop_[A-Za-z0-9_-]{22}$/u;

/** The act could not open: what the caller is answered, before anything was written. */
class ActRefused extends Error {
  constructor(readonly response: PlainApiResponse) {
    super('the loosening act needs a passkey');
    this.name = 'ActRefused';
  }
}

/** Whether an answered apply was cut short: structured fields only. */
function unfinished(outcome: AccountChangeOutcome): boolean {
  const apply =
    outcome.outcome === 'applied' ? outcome.apply : outcome.outcome === 'login-changed' ? outcome.moved : undefined;
  return apply?.outcome === 'rolled-back' || apply?.outcome === 'rollback-incomplete';
}

/** The apply's refusal as the log keeps it: the status and a code the daemon itself chose, never a name or a sentence. */
function refusalOf(error: unknown): { readonly status: number; readonly code: string } {
  if (error instanceof ApiError) return { status: error.status, code: error.code ?? 'refused' };
  return { status: 500, code: 'error' };
}

/**
 * Runs one apply: lends the service the act's bracket (the act opens inside its serialised section, for an import or a
 * clone), then `work` with it, and logs every refusal and every held, refused or unfinished answer.
 */
export async function applyAsOneAct(input: {
  readonly call: CallContext;
  readonly id: string;
  readonly log: Log | undefined;
  readonly work: (bracket: ApplyBracket) => Promise<ApiResponse>;
  /** What the service answered, when it answered one: read for the unfinished line. */
  readonly answered: () => AccountChangeOutcome | undefined;
}): Promise<ApiResponse> {
  const { call, log } = input;
  const change = MINTED_ID.test(input.id) ? input.id : 'unrecognised';
  // The kind of the change the service RESOLVED (a member of the contract's closed set), never text from the request.
  let kind = 'unknown';
  const known = (named: string): void => {
    kind = named;
  };
  const left = new Set<ApplyLeft>();
  const say = (fields: Readonly<Record<string, string | number>>): void => {
    log?.warn('runtimes: a change was not fully applied', { change, kind, ...fields });
  };
  const signal = call.request.signal;
  const bracket: ApplyBracket = {
    ...(signal === undefined ? {} : { signal }),
    open: (named): ApplyAct | undefined => {
      known(named);
      if (!ACT_KINDS.has(named)) return undefined;
      const act = openLooseningAct(call, ACT_WORDS[named] ?? 'apply this change');
      if ('refused' in act) throw new ActRefused(act.refused);
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        signal?.removeEventListener('abort', end);
        act.end();
      };
      // The request's own end closes the act too: nothing the request still spawns rides on its proof.
      signal?.addEventListener('abort', end, { once: true });
      return { covered: act.covered, end };
    },
    left: (state, named) => {
      known(named);
      left.add(state);
    },
  };
  try {
    const response = await input.work(bracket);
    if (response.status >= 400) say({ status: response.status, code: 'refused' });
    else {
      const outcome = input.answered();
      if (outcome !== undefined && unfinished(outcome)) left.add('unfinished');
      if (outcome?.outcome === 'login-changed' && outcome.result === 'held') left.add('held');
      for (const state of left) say({ status: response.status, code: state });
    }
    return response;
  } catch (error) {
    if (error instanceof ActRefused) {
      say({ status: error.response.status, code: 'grant_step_up_required', act: 'loosen-config' });
      return error.response;
    }
    say(refusalOf(error));
    throw error;
  }
}
