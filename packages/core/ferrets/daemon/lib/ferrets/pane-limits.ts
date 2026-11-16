/**
 * THE LIMITS LIVE FERRETS' PANES PROVE (today's `storagePaneLimits`, `docs/pack-mode.md` § Quota).
 *
 * The provider's own quota reading cannot see a spend limit that is only announced on a pane ("You've hit your org's
 * monthly spend limit"), nor a usage limit between two measurements. A session parked on such a dialog — or whose
 * newest turn the transcript says ended on the limit — is recorded `rate_limited` with the harness's sentence in its
 * quota (`peers/turn.ts` `limitPatch`). This reads those sessions back, one row per limited live ferret.
 *
 * Derived from the session documents on every call and kept nowhere, so a limit ends the moment its session is
 * released (its state goes back to running), the ferret stops, or its reset time passes.
 *
 * Reads only: nothing is written, no option is ever chosen, and a damaged document is one ferret read as not limited.
 */
import type { FerretPaneLimit, FerretRecord } from '../../../contract/index.ts';
import { SessionStateSchema } from '../protocol/session.ts';

/** What this reads of the session store and the registry. */
export interface PaneLimitSources {
  /** The indexed sessions, each with the status its index row holds (a cheap pre-filter: only `rate_limited` are read). */
  sessions(): Iterable<{ readonly id: string; readonly status?: string | undefined }>;
  /** A session's state document, raw. A failure reads as no document. */
  readState(id: string): Promise<unknown>;
  /** The ferret's record: its runtime and login, and whether it is still live. */
  record(id: string): FerretRecord | undefined;
  nowMs(): number;
}

/** The harness's own words for the limit: its usage-limit dialog's first line, else the notice its quota records. */
function noticeOf(state: {
  readonly harnessDialog?:
    | { readonly kind: string; readonly title: string; readonly body?: string | undefined }
    | undefined;
  readonly quota?: { readonly limitNotice?: string | undefined } | undefined;
}): string | undefined {
  const dialog = state.harnessDialog;
  if (dialog?.kind === 'usage-limit') return dialog.body?.split('\n')[0]?.trim() || dialog.title;
  return state.quota?.limitNotice;
}

/** One row per live ferret whose pane proves a limit that still holds. */
export async function livePaneLimits(sources: PaneLimitSources): Promise<readonly FerretPaneLimit[]> {
  const limits: FerretPaneLimit[] = [];
  const nowMs = sources.nowMs();
  for (const indexed of sources.sessions()) {
    if (indexed.status !== 'rate_limited') continue;
    const record = sources.record(indexed.id);
    // A stopped ferret holds no login any more: its limit is released with it.
    if (record === undefined || record.state === 'stopped') continue;
    const raw = await sources.readState(indexed.id).catch(() => undefined);
    const state = SessionStateSchema.safeParse(raw);
    if (!state.success || state.data.status !== 'rate_limited') continue;
    const notice = noticeOf(state.data);
    if (notice === undefined) continue;
    const retryAt = state.data.quota?.retryAt;
    if (retryAt !== undefined && retryAt <= nowMs) continue;
    limits.push({
      ferret: record.id,
      ...(record.runtime === undefined ? {} : { runtime: record.runtime }),
      ...(record.login === undefined ? {} : { login: record.login }),
      notice,
      spend: state.data.quota?.unavailableReason === 'spend_limit',
      ...(retryAt === undefined ? {} : { retryAt }),
    });
  }
  return limits;
}
