/**
 * THE SMALL PARTS A PRICING RATE IS DRAWN FROM: its identity, its amounts, where it came from, when it applies, and
 * what can be done to it. Each is a plain block with no border of its own, so a rate sits as ONE row in a group
 * (see `pricing-ledger.tsx`) and is never a card inside a card.
 */
import { Badge, Button, cn, PanelPath } from '@ferretry/app/ui';
import {
  ANALYTICS_PRICING_RATE_SLOTS,
  type AnalyticsPricingRate,
  type AnalyticsPricingRates,
  analyticsPricingRateUnit,
} from '../../../contract/index.ts';
import { formatInstant, formatUsdMicros, RATE_LABELS, UNIT_LABELS } from './pricing-model.ts';

export function DateValue({
  value,
  fallback = 'Open-ended',
}: {
  readonly value: string | null;
  readonly fallback?: string;
}) {
  return value === null ? (
    <span className="text-faint">{fallback}</span>
  ) : (
    <time dateTime={value}>{formatInstant(value)}</time>
  );
}

/** Every slot's amount, two to a line when the block itself is 560px wide, so nine slots are five lines and not nine. */
export function RateAmounts({ rates }: { readonly rates: AnalyticsPricingRates }) {
  return (
    <div className="fy-usage-fit">
      <dl className="fy-usage-amounts m-0 gap-x-6 gap-y-1">
        {ANALYTICS_PRICING_RATE_SLOTS.map(slot => {
          const amount = rates[slot];
          return (
            <div
              key={slot}
              className="flex min-w-0 flex-wrap justify-between gap-x-2 text-meta leading-base"
              data-pricing-rate={slot}
            >
              <dt className="text-muted">{RATE_LABELS[slot]}</dt>
              <dd
                className={cn(
                  'm-0 min-w-0 break-words text-right font-mono',
                  amount === null ? 'text-faint' : 'text-fg',
                )}
              >
                {amount === null
                  ? 'Not set'
                  : `${formatUsdMicros(amount)} USD / ${UNIT_LABELS[analyticsPricingRateUnit(slot)]}`}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** Where the rate came from: one badge, then the source and the date that backs it. */
export function Provenance({ rate }: { readonly rate: AnalyticsPricingRate }) {
  if (rate.source.kind === 'manual')
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge>Manual</Badge>
        <span className="text-meta leading-base text-muted">Entered or overridden by an operator.</span>
      </div>
    );
  if (rate.source.kind === 'model_catalog')
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div>
          <Badge>Model catalog · {rate.source.catalog}</Badge>
        </div>
        <PanelPath value={rate.source.sourceUrl} className="block text-meta leading-base text-muted" label="Source" />
        <p className="m-0 text-meta text-faint">
          Verified: <DateValue value={rate.verifiedAt} />
        </p>
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div>
        <Badge tone="ok">Provider sync · {rate.source.provider}</Badge>
      </div>
      <PanelPath value={rate.source.sourceUrl} className="block text-meta leading-base text-muted" label="Source" />
      <p className="m-0 text-meta text-faint">
        Last sync: <DateValue value={rate.lastSyncedAt} fallback="Not recorded" />
      </p>
    </div>
  );
}

export function Identity({ rate }: { readonly rate: AnalyticsPricingRate }) {
  return (
    <div className="min-w-0">
      <p className="m-0 break-words font-mono text-ui font-semibold text-fg">{rate.modelId}</p>
      <p className="mb-0 mt-1 text-meta text-muted">{rate.provider}</p>
      <p className="mb-0 mt-1 break-words text-meta leading-base text-faint">
        Aliases: {rate.aliases.length === 0 ? 'None' : rate.aliases.join(', ')}
      </p>
      <p className="mb-0 mt-1 flex min-w-0 gap-1 text-meta text-faint">
        Key: <PanelPath value={rate.pricingKey} className="text-faint" />
      </p>
    </div>
  );
}

export function EffectiveDates({ rate }: { readonly rate: AnalyticsPricingRate }) {
  return (
    <dl className="m-0 grid gap-1 text-meta leading-base">
      <div>
        <dt className="inline text-muted">Effective: </dt>
        <dd className="m-0 inline font-mono text-fg">
          <DateValue value={rate.validFrom} />
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Through: </dt>
        <dd className="m-0 inline font-mono text-fg">
          <DateValue value={rate.validThrough} />
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Verified: </dt>
        <dd className="m-0 inline font-mono text-fg">
          <DateValue value={rate.verifiedAt} />
        </dd>
      </div>
    </dl>
  );
}

/** Edit / Remove, and the one-step "are you sure" that replaces them while a removal waits. */
export function RateActions({
  rate,
  busy,
  confirming,
  onEdit,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: {
  readonly rate: AnalyticsPricingRate;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onEdit: () => void;
  readonly onRequestRemove: () => void;
  readonly onCancelRemove: () => void;
  readonly onRemove: () => void;
}) {
  return confirming ? (
    <fieldset
      className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0"
      aria-label={`Confirm removal of ${rate.modelId}`}
    >
      <Button type="button" className="min-h-[44px] border-err-border text-err" disabled={busy} onClick={onRemove}>
        Confirm removal
      </Button>
      <Button type="button" className="min-h-[44px]" disabled={busy} onClick={onCancelRemove}>
        Keep rate
      </Button>
    </fieldset>
  ) : (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        className="min-h-[44px]"
        disabled={busy}
        data-pricing-edit={rate.pricingKey}
        onClick={onEdit}
      >
        Edit
      </Button>
      <Button
        type="button"
        className="min-h-[44px] text-err"
        disabled={busy}
        data-pricing-remove={rate.pricingKey}
        onClick={onRequestRemove}
      >
        Remove
      </Button>
    </div>
  );
}
