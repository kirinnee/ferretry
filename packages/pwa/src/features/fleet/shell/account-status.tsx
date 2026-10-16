/**
 * The account model's four status words, each with its own SHAPE (docs/design/account-model.md §4.1
 * rule 7): ● Ready, ◐ Refresh due, ○ Needs sign-in, ◌ Checking.
 *
 * Shape first, colour second, words always: the glyph is never the only signal, so a reader who
 * cannot tell the tones apart still sees four different marks, and a screen reader hears the word.
 * The same four marks answer "is this machine reachable" on the switcher (● Online, ○ Offline,
 * ◌ Checking), because the prototype draws both with them.
 */

import type { FleetCredentialStatusWord, ProviderQuotaReading, ProviderQuotaWindow } from '@ferretry/protocol';
import { cn } from '../../../lib/class-names.ts';
import { formatQuotaMoney, quotaResetsIn } from '../../../shell/quota-readout.tsx';

interface AccountStatusDefinition {
  readonly glyph: string;
  readonly tone: string;
  readonly label: string;
}

export const ACCOUNT_STATUS_SHAPES: Readonly<Record<FleetCredentialStatusWord, AccountStatusDefinition>> = {
  ready: { glyph: '●', tone: 'text-ok', label: 'Ready' },
  refresh_due: { glyph: '◐', tone: 'text-warn', label: 'Refresh due' },
  needs_sign_in: { glyph: '○', tone: 'text-err', label: 'Needs sign-in' },
  checking: { glyph: '◌', tone: 'text-muted', label: 'Checking' },
};

export interface AccountStatusProps {
  readonly word: FleetCredentialStatusWord;
  /** Overrides the spoken and shown word, e.g. "Online" for a reachable machine. */
  readonly label?: string;
  /** Show the word beside the mark; otherwise it is only spoken and shown on hover. */
  readonly showLabel?: boolean;
  readonly className?: string;
}

export function AccountStatus({ word, label, showLabel = false, className }: AccountStatusProps) {
  const shape = ACCOUNT_STATUS_SHAPES[word];
  const text = label ?? shape.label;
  return (
    <span data-status-shape={word} className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span aria-hidden="true" title={text} className={cn('shrink-0 leading-none', shape.tone)}>
        {shape.glyph}
      </span>
      {showLabel ? <span className="min-w-0 truncate">{text}</span> : <span className="sr-only">{text}</span>}
    </span>
  );
}

// ── An environment login's provider quota ────────────────────────────────────────────────────────

const WINDOW_NAMES: Readonly<Record<ProviderQuotaWindow['label'], string>> = {
  '5h': '5 h',
  week: 'Week',
  month: 'Month',
  key: 'Key',
  tools: 'Tools',
};

/** "12 of 50 prompts", "$4.20 of $10.00", "$3.10" — only what the provider said. */
export function providerWindowAmount(window: ProviderQuotaWindow): string | null {
  if (window.used === undefined) return null;
  const amount = (value: number) =>
    window.unit === 'usd' ? formatQuotaMoney(value, 'USD') : String(Math.round(value * 100) / 100);
  const unit = window.unit === undefined || window.unit === 'usd' ? '' : ` ${window.unit}`;
  return window.limit === undefined
    ? `${amount(window.used)}${unit}`
    : `${amount(window.used)} of ${amount(window.limit)}${unit}`;
}

/** One window's line, said in words for a screen reader. */
export function providerWindowText(window: ProviderQuotaWindow, now: number): string {
  const resets = quotaResetsIn(window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt), now);
  return [
    window.usedPercent === undefined ? null : `${String(Math.round(window.usedPercent))}% used`,
    providerWindowAmount(window),
    resets === null ? null : `resets in ${resets}`,
  ]
    .filter(part => part !== null)
    .join(' · ');
}

export interface ProviderQuotaProps {
  readonly reading: ProviderQuotaReading;
  readonly now: number;
}

/**
 * An environment login's quota as its provider reported it (docs/provider-quotas.md): each window with
 * what is known of it, the money left, or what this machine's own sessions cost this month — and when
 * none of those could be read, "Usage unknown" with the reason. Nothing is drawn as 0 that nobody
 * measured: a window with no share used has no bar.
 */
export function ProviderQuota({ reading, now }: ProviderQuotaProps) {
  return (
    <div className="flex flex-col gap-1 text-meta" data-provider-quota={reading.via}>
      {reading.windows.map(window => (
        <div key={window.label} className="flex min-w-0 items-center gap-2" data-provider-quota-window={window.label}>
          <span className="w-10 shrink-0 text-muted">{WINDOW_NAMES[window.label]}</span>
          {window.usedPercent === undefined ? null : (
            <span
              role="img"
              aria-label={`${WINDOW_NAMES[window.label]}: ${providerWindowText(window, now)}`}
              className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
            >
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full',
                  window.usedPercent >= 75 ? 'bg-warn' : 'bg-accent',
                )}
                style={{ width: `${String(Math.min(100, window.usedPercent))}%` }}
              />
            </span>
          )}
          <span className={cn('text-muted', window.usedPercent === undefined ? 'min-w-0 flex-1' : 'shrink-0')}>
            {providerWindowText(window, now) || 'not measured'}
          </span>
        </div>
      ))}
      {reading.balance === undefined ? null : (
        <p className="m-0 text-muted" data-provider-quota-balance="">
          Balance: <span className="text-fg">{formatQuotaMoney(reading.balance.amount, reading.balance.currency)}</span>
        </p>
      )}
      {reading.spend === undefined ? null : (
        <p className="m-0 text-muted" data-provider-quota-spend="">
          This month, from this machine’s sessions:{' '}
          <span className="text-fg">{formatQuotaMoney(reading.spend.amountUsd, 'USD')}</span>
          {reading.spend.unpriced > 0 ? ` (${String(reading.spend.unpriced)} unpriced, so at least this)` : ''}
        </p>
      )}
      {reading.via === 'unknown' ? (
        <p className="m-0 text-muted" data-credential-usage="unknown">
          Usage unknown{reading.note === undefined ? '' : ` — ${reading.note}`}
        </p>
      ) : reading.note === undefined ? null : (
        <p className="m-0 text-faint">{reading.note}</p>
      )}
      {reading.exhausted && reading.via === 'endpoint' ? (
        <p className="m-0 font-semibold text-err">At its limit — the provider says this login can do no more now.</p>
      ) : null}
      {reading.unverified ? (
        <p className="m-0 text-faint">This provider’s quota is read from a source it does not document.</p>
      ) : null}
    </div>
  );
}
