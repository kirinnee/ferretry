import type { HarnessDialog, SessionState, SessionTurnState } from '@ferretry/protocol';
import type { TranscriptEvent } from '../../transcript/types.ts';

/**
 * A SESSION PARKED ON "YOU'VE HIT YOUR … LIMIT".
 *
 * Claude Code answers an out-of-quota turn with its `/rate-limit-options` dialog, and the session sits
 * there with a live pane and a `running` status — so nothing downstream (the Warden,
 * `fy recommend`) could tell its login was spent. This module reads that dialog as a quota fact and
 * says how the session's state document should record it. It never picks an option: all three change
 * what the person has chosen to wait for.
 *
 * Codex shows no dialog: it ends the turn at once with "Usage limit reached" on the pane and writes
 * the reason on the turn's own boundary in its rollout (`task_complete` with
 * `error.codex_error_info: usage_limit_exceeded`). Read as an ordinary end of turn, a sub-ferret on a
 * spent login sat at `your-turn` for hours while every message to it ended the same way in half a
 * second (2026-10-31). {@link transcriptUsageLimit} reads that record as the same quota fact.
 *
 * Pure: a dialog and a clock in, a value out.
 */

/** What the dialog says about the login it came from. */
export interface UsageLimit {
  /** The harness's own sentence: "You've hit your org's monthly spend limit · run /usage-credits …". */
  readonly notice: string;
  /** Whether it is a spend limit (money), as opposed to a usage window. */
  readonly spend: boolean;
  /** When the harness says it continues by itself, epoch milliseconds in the host's local time. */
  readonly retryAt?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

/** "continue automatically at Nov 1, 12am" / "at Nov 1, 3:30pm": month, day, hour, optional minutes, am or pm. */
const CONTINUE_AT =
  /continue automatically at\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])m\b/iu;

/**
 * The instant "Nov 1, 12am" names, in the host's local time, or `undefined` when the label has none.
 *
 * The harness prints no year, so it is the nearest one that puts the instant at or after `nowMs`
 * (a reset is never in the past). An hour or day out of range reads as no time at all.
 */
export function parseContinueAt(label: string, nowMs: number): number | undefined {
  const match = CONTINUE_AT.exec(label);
  if (match === null) return undefined;
  const month = MONTHS.indexOf((match[1] as string).toLowerCase() as (typeof MONTHS)[number]);
  const day = Number(match[2]);
  const hour12 = Number(match[3]);
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + ((match[5] as string).toLowerCase() === 'p' ? 12 : 0);
  const year = new Date(nowMs).getFullYear();
  for (const candidate of [year, year + 1]) {
    const at = new Date(candidate, month, day, hour, minute);
    if (at.getMonth() === month && at.getDate() === day && at.getTime() >= nowMs) return at.getTime();
  }
  return undefined;
}

/** The limit a dialog reports, or `undefined` when it is not the usage-limit dialog. */
export function usageLimitOf(dialog: HarnessDialog | undefined, nowMs: number): UsageLimit | undefined {
  if (dialog?.kind !== 'usage-limit') return undefined;
  const notice = dialog.body?.split('\n')[0]?.trim() || dialog.title;
  const retryAt = dialog.options
    .map(option => parseContinueAt(option.label, nowMs))
    .find((at): at is number => at !== undefined);
  return { notice, spend: /\bspend\b/iu.test(notice), ...(retryAt === undefined ? {} : { retryAt }) };
}

type Quota = NonNullable<SessionState['quota']>;

/**
 * The error codes a harness writes on a turn its provider refused for quota. Codex's
 * `codex_error_info`; anything else — a stream error, a refusal, a crash — is not a quota fact.
 */
const USAGE_LIMIT_CODES: ReadonlySet<string> = new Set(['usage_limit_exceeded']);

/**
 * The limit the transcript's NEWEST turn ended on, or `undefined` when that turn ended any other way,
 * has not ended, or there is no turn at all.
 *
 * Read from the end: the boundary's own error is written right after it, so an error met before any
 * boundary is the newest turn's. Bookkeeping (usage, settings, attachments) is skipped; anything else —
 * a message, a tool call, a new `started` — means a later turn and so no limit.
 */
export function transcriptUsageLimit(events: readonly TranscriptEvent[]): UsageLimit | undefined {
  let limit: UsageLimit | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TranscriptEvent;
    if (event.kind === 'usage' || event.kind === 'settings' || event.kind === 'attachment') continue;
    if (event.kind === 'error') {
      if (limit === undefined && event.error.code !== undefined && USAGE_LIMIT_CODES.has(event.error.code)) {
        const notice = event.error.message.split('\n')[0]?.trim() || 'The login hit its usage limit';
        limit = { notice, spend: /\bspend\b/iu.test(notice) };
      }
      continue;
    }
    return event.kind === 'turn' && event.state !== 'started' ? limit : undefined;
  }
  return undefined;
}

/** The quota fields this module owns: the ones it sets and the ones it removes again. */
const OWNED = ['atLimit', 'unavailable', 'unavailableReason', 'retryAt', 'resetAt', 'limitNotice'] as const;

/** The quota a limited session records: the login is at its limit, and until when when that is known. */
export function limitedQuota(current: Quota | undefined, limit: UsageLimit): Quota {
  return {
    ...clearedQuota(current),
    atLimit: true,
    limitNotice: limit.notice,
    ...(limit.spend ? { unavailable: true, unavailableReason: 'spend_limit' as const } : {}),
    ...(limit.retryAt === undefined ? {} : { retryAt: limit.retryAt, resetAt: limit.retryAt }),
  };
}

/** The quota once the limit is gone: this module's fields removed, everything else kept. */
export function clearedQuota(current: Quota | undefined): Quota | undefined {
  if (current === undefined) return undefined;
  const rest = { ...current };
  for (const field of OWNED) delete rest[field];
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * The status and quota to record beside a turn change, or `undefined` when the change settles neither.
 *
 * Limited: a live session whose dialog is the usage-limit one, or whose newest turn the transcript says
 * ended on its limit (`proved`, from {@link transcriptUsageLimit}), becomes `rate_limited` with the limit
 * in its quota. A turn seen WORKING is a turn the provider accepted, so it proves no limit whatever an
 * older record says. Released: a `rate_limited` session this module limited — its recorded dialog was
 * the usage-limit one, or its quota carries the notice this module wrote — goes back to `running` once
 * neither shows a limit, and a `running` one loses a notice a send left behind; only on that signature,
 * so a `rate_limited` this module did not set is never undone by it.
 */
export function limitPatch(
  current: Pick<SessionState, 'status' | 'quota' | 'harnessDialog'>,
  dialog: HarnessDialog | undefined,
  nowMs: number,
  proved?: { readonly limit: UsageLimit | undefined; readonly to: SessionTurnState | undefined },
): { readonly status: 'rate_limited' | 'running'; readonly quota: Quota | undefined } | undefined {
  const limit = usageLimitOf(dialog, nowMs) ?? (proved?.to === 'working' ? undefined : proved?.limit);
  if (limit !== undefined) return { status: 'rate_limited', quota: limitedQuota(current.quota, limit) };
  const ours = current.harnessDialog?.kind === 'usage-limit' || current.quota?.limitNotice !== undefined;
  if (current.status === 'rate_limited' && ours) return { status: 'running', quota: clearedQuota(current.quota) };
  // A send moves a limited session to `running` without touching its quota; its next turn that proves no
  // limit takes the stale notice away, so no reader counts a login spent on a session that is working.
  if (current.status === 'running' && current.quota?.limitNotice !== undefined)
    return { status: 'running', quota: clearedQuota(current.quota) };
  return undefined;
}
