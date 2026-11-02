/**
 * One STANDING SIGN-IN RULE as the owner reads it (Settings › Secure copy, and a sign-in's Rule tab): which account, where,
 * what it types, who may use it and until when, with the daemon's flags drawn from its structured `flags` array. The
 * owner can narrow it (drop the code, end earlier, lower the cap) or revoke it without a passkey, because that only takes
 * away; resuming or approving it again opens the sheet and needs a passkey. Nothing here is a value.
 */

import type { SignInRuleNarrow, SignInRuleView } from '@ferretry/protocol';
import { useId, useState } from 'react';
import {
  canRenew,
  canResume,
  type EndUnit,
  narrowEnd,
  ruleWordsOf,
  statusWords,
  viewFlags,
} from '../../lib/sign-in-rules.ts';
import { SignInRuleWords } from './sign-in-rule-words.tsx';

export interface SignInRuleCardProps {
  readonly rule: SignInRuleView;
  readonly busy: boolean;
  readonly failure?: string | undefined;
  /** Whether a passkey can be asked on this device; resume and renew need one. */
  readonly canUsePasskey: boolean;
  readonly onNarrow: (narrow: SignInRuleNarrow) => void;
  readonly onRevoke: () => void;
  readonly onReapprove: (origin: 'resume' | 'renew' | 'widen') => void;
}

export function SignInRuleCard({
  rule,
  busy,
  failure,
  canUsePasskey,
  onNarrow,
  onRevoke,
  onReapprove,
}: SignInRuleCardProps) {
  const id = useId();
  const [narrowing, setNarrowing] = useState(false);
  const [dropTotp, setDropTotp] = useState(false);
  const [endIn, setEndIn] = useState('');
  const [endUnit, setEndUnit] = useState<EndUnit>('days');
  const [cap, setCap] = useState('');
  const live = rule.status === 'active' || rule.status === 'suspended';
  const endAt = () => (endIn === '' ? undefined : narrowEnd(endIn, endUnit, rule.expiresAt, Date.now()));
  const end = endAt();

  const narrowed = (): SignInRuleNarrow => {
    const fresh = endAt();
    return {
      ...(dropTotp ? { dropTotp: true as const } : {}),
      ...(fresh?.ok === true ? { expiresAt: fresh.at } : {}),
      ...(cap === '' ? {} : { uses: Number(cap) }),
    };
  };
  const narrowProblem =
    end?.ok === false
      ? end.problem
      : cap !== '' && !(Number(cap) >= 1 && (rule.remaining === undefined || Number(cap) < rule.remaining))
        ? 'Lower the cap below what is left.'
        : undefined;
  const empty = !dropTotp && endIn === '' && cap === '';

  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
      data-rule={rule.id}
      data-rule-status={rule.status}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 break-words text-ui font-medium text-fg" data-rule-title="">
          {rule.place.kind === 'terminal'
            ? `${rule.place.tool} on ${rule.place.host}`
            : `${rule.account.label}${rule.username === undefined ? '' : ` · ${rule.username}`}`}
        </span>
        <span
          className={`text-meta ${rule.status === 'active' ? 'text-ok' : rule.status === 'suspended' ? 'text-warn' : 'text-muted'}`}
          data-rule-status-words=""
        >
          {statusWords(rule)}
        </span>
      </div>
      <SignInRuleWords {...ruleWordsOf(rule)} flags={viewFlags(rule)} />
      {failure === undefined ? null : (
        <p className="m-0 text-meta text-err" data-rule-failure="" role="alert">
          {failure}
        </p>
      )}

      {narrowing ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-rule-narrow-form="">
          <legend className="sr-only">Narrow this rule</legend>
          {rule.totp ? (
            <label
              className="flex min-h-[44px] cursor-pointer items-start gap-3 text-ui text-fg"
              htmlFor={`${id}-drop`}
            >
              <input
                checked={dropTotp}
                className="mt-0.5 h-5 w-5 shrink-0"
                data-rule-drop-totp=""
                id={`${id}-drop`}
                onChange={event => setDropTotp(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>Stop typing the 2FA code</span>
            </label>
          ) : null}
          <div className="flex min-w-0 items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-muted" htmlFor={`${id}-end`}>
              End in
              <input
                className="kt-input min-h-[44px] min-w-0"
                data-rule-end-days=""
                id={`${id}-end`}
                inputMode="numeric"
                onChange={event => setEndIn(event.currentTarget.value.trim())}
                type="number"
                value={endIn}
              />
            </label>
            <label className="sr-only" htmlFor={`${id}-unit`}>
              Days or hours
            </label>
            <select
              className="kt-input min-h-[44px]"
              data-rule-end-unit=""
              id={`${id}-unit`}
              onChange={event => setEndUnit(event.currentTarget.value === 'hours' ? 'hours' : 'days')}
              value={endUnit}
            >
              <option value="days">days</option>
              <option value="hours">hours</option>
            </select>
          </div>
          <label className="flex min-w-0 flex-col gap-1 text-meta text-muted" htmlFor={`${id}-cap`}>
            Most uses{rule.remaining === undefined ? '' : ` (fewer than ${String(rule.remaining)})`}
            <input
              className="kt-input min-h-[44px] min-w-0"
              data-rule-cap=""
              id={`${id}-cap`}
              inputMode="numeric"
              onChange={event => setCap(event.currentTarget.value.trim())}
              type="number"
              value={cap}
            />
          </label>
          {narrowProblem === undefined ? null : (
            <p className="m-0 text-meta text-warn" role="status">
              {narrowProblem}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button className="kt-btn min-h-[44px]" onClick={() => setNarrowing(false)} type="button">
              Cancel
            </button>
            <button
              className="kt-btn min-h-[44px]"
              data-rule-narrow-apply=""
              data-variant="primary"
              disabled={busy || empty || narrowProblem !== undefined}
              onClick={() => {
                onNarrow(narrowed());
                setNarrowing(false);
                setDropTotp(false);
                setEndIn('');
                setCap('');
              }}
              type="button"
            >
              Narrow it
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="flex flex-wrap gap-2" data-rule-actions="">
          {live && rule.status === 'active' ? (
            <button
              className="kt-btn min-h-[44px]"
              data-rule-narrow=""
              disabled={busy}
              onClick={() => setNarrowing(true)}
              type="button"
            >
              Narrow
            </button>
          ) : null}
          {rule.status === 'active' ? (
            <button
              className="kt-btn min-h-[44px]"
              data-rule-widen=""
              disabled={busy || !canUsePasskey}
              onClick={() => onReapprove('widen')}
              type="button"
            >
              Change (passkey)…
            </button>
          ) : null}
          {canResume(rule) ? (
            <button
              className="kt-btn min-h-[44px]"
              data-rule-resume=""
              disabled={busy || !canUsePasskey}
              onClick={() => onReapprove('resume')}
              type="button"
            >
              Resume with passkey
            </button>
          ) : null}
          {canRenew(rule) ? (
            <button
              className="kt-btn min-h-[44px]"
              data-rule-renew=""
              disabled={busy || !canUsePasskey}
              onClick={() => onReapprove('renew')}
              type="button"
            >
              Approve again
            </button>
          ) : null}
          <button
            className="kt-btn min-h-[44px]"
            data-rule-revoke=""
            data-variant="danger"
            disabled={busy}
            onClick={onRevoke}
            type="button"
          >
            Revoke
          </button>
        </div>
      )}
    </article>
  );
}
