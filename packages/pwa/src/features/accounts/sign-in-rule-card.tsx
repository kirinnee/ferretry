/**
 * One STANDING SIGN-IN RULE as the owner reads it (Settings › Secure copy, and a sign-in's Rule tab): which account, where,
 * what it types, who may use it and until when, with the daemon's flags drawn from its structured `flags` array. The
 * owner can narrow it (drop the code, end earlier, lower the cap) or revoke it without a passkey, because that only takes
 * away; resuming or approving it again opens the sheet and needs a passkey. Nothing here is a value.
 */

import type { SignInRuleNarrow, SignInRuleView } from '@ferretry/protocol';
import { TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import {
  canRenew,
  canResume,
  RULE_TERMINAL_RESIDUAL,
  rootBadge,
  scopeWords,
  statusWords,
  timeWords,
  usesLeftWords,
  viewFlags,
} from '../../lib/sign-in-rules.ts';

export interface SignInRuleCardProps {
  readonly rule: SignInRuleView;
  readonly busy: boolean;
  readonly failure?: string | undefined;
  /** Whether a passkey can be asked on this device; resume and renew need one. */
  readonly canUsePasskey: boolean;
  readonly onNarrow: (narrow: SignInRuleNarrow) => void;
  readonly onRevoke: () => void;
  readonly onReapprove: (origin: 'resume' | 'renew') => void;
}

const DAY_MS = 86_400_000;

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
  const [endDays, setEndDays] = useState('');
  const [cap, setCap] = useState('');
  const flags = viewFlags(rule);
  const live = rule.status === 'active' || rule.status === 'suspended';
  const leftDays = Math.max(1, Math.floor((Date.parse(rule.expiresAt) - Date.now()) / DAY_MS));

  const narrowed = (): SignInRuleNarrow => ({
    ...(dropTotp ? { dropTotp: true as const } : {}),
    ...(endDays === '' ? {} : { expiresAt: new Date(Date.now() + Number(endDays) * DAY_MS).toISOString() }),
    ...(cap === '' ? {} : { uses: Number(cap) }),
  });
  const narrowProblem =
    endDays !== '' && !(Number(endDays) >= 1 && Number(endDays) < leftDays)
      ? 'End earlier than it does now, in whole days.'
      : cap !== '' && !(Number(cap) >= 1 && (rule.remaining === undefined || Number(cap) < rule.remaining))
        ? 'Lower the cap below what is left.'
        : undefined;
  const empty = !dropTotp && endDays === '' && cap === '';

  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
      data-rule={rule.id}
      data-rule-status={rule.status}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0 break-words text-ui font-medium text-fg" data-rule-title="">
          {rule.account.label}
          {rule.username === undefined ? '' : ` · ${rule.username}`}
        </span>
        <span className="min-w-0 break-words text-meta text-muted" data-rule-place="">
          {rule.place.kind === 'terminal' ? `${rule.place.tool} on ${rule.place.host}` : rule.place.domains.join(', ')}
        </span>
      </div>
      <span
        className={`text-meta ${rule.status === 'active' ? 'text-ok' : rule.status === 'suspended' ? 'text-warn' : 'text-muted'}`}
        data-rule-status-words=""
      >
        {statusWords(rule)}
      </span>
      {flags.map(flag => (
        <span
          className={`flex items-start gap-1.5 text-meta font-medium ${flag.tone === 'err' ? 'text-err' : 'text-warn'}`}
          data-rule-flag={flag.name}
          key={flag.name}
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          <span className="min-w-0 break-words">
            {flag.name === 'root' ? `${rootBadge(rule.place)} · ${flag.words}` : flag.words}
          </span>
        </span>
      ))}
      {flags.some(flag => flag.name === 'root') ? (
        <span className="text-meta text-err" data-rule-terminal-residual="">
          {RULE_TERMINAL_RESIDUAL}
        </span>
      ) : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta text-muted">
        <dt>Types</dt>
        <dd className="m-0 min-w-0 break-words text-fg" data-rule-fields="">
          {rule.fields.map(field => (field === 'totp' ? '6-digit code' : field)).join(', ')}
        </dd>
        <dt>Who</dt>
        <dd className="m-0 min-w-0 break-words text-fg">{scopeWords(rule.scope)}</dd>
        <dt>Until</dt>
        <dd className="m-0 text-fg">
          <span className="mono">{timeWords(rule.expiresAt)}</span>
        </dd>
        <dt>Uses</dt>
        <dd className="m-0 text-fg" data-rule-uses="">
          {usesLeftWords(rule)} · used {rule.usage.count}×
          {rule.usage.lastUsedAt === undefined ? '' : `, last ${timeWords(rule.usage.lastUsedAt)}`}
        </dd>
        <dt>Approved with</dt>
        <dd className="m-0 min-w-0 break-words text-fg" data-rule-device="">
          {rule.approvedWith.device ?? 'a paired device'}
        </dd>
      </dl>
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
              <span>Stop typing the 6-digit code</span>
            </label>
          ) : null}
          <label className="flex min-w-0 flex-col gap-1 text-meta text-muted" htmlFor={`${id}-end`}>
            End in (days, fewer than {leftDays})
            <input
              className="kt-input min-h-[44px] min-w-0"
              data-rule-end-days=""
              id={`${id}-end`}
              inputMode="numeric"
              onChange={event => setEndDays(event.currentTarget.value.trim())}
              type="number"
              value={endDays}
            />
          </label>
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
                setEndDays('');
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
