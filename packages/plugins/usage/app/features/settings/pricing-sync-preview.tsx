/**
 * THE REVIEW OF A PROVIDER FEED: what the feed would add or change, one row per entry with its own checkbox, and a bar
 * that applies the ticked ones. Nothing is ticked until a person does. Current and proposed sit side by side as two plain
 * columns under a small label (no box around each), so an entry is one row of the group and never a card inside it.
 */
import { SettingGroup } from '@ferretry/app';
import { Badge, Button, PanelPath } from '@ferretry/app/ui';
import { useEffect, useRef } from 'react';
import type {
  AnalyticsPricingRate,
  AnalyticsPricingSyncChange,
  AnalyticsPricingSyncPreview,
} from '../../../contract/index.ts';
import { DateValue, EffectiveDates, Identity, Provenance, RateAmounts } from './pricing-rate-parts.tsx';

const NOTE_ERR = 'm-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-meta leading-base text-err';

function PreviewRate({ label, rate }: { readonly label: string; readonly rate: AnalyticsPricingRate }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">{label}</p>
      <Identity rate={rate} />
      <RateAmounts rates={rate.rates} />
      <Provenance rate={rate} />
      <EffectiveDates rate={rate} />
    </div>
  );
}

function PreviewChange({
  change,
  selected,
  disabled,
  onSelect,
}: {
  readonly change: AnalyticsPricingSyncChange;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (selected: boolean) => void;
}) {
  const selectable = change.kind !== 'unchanged';
  return (
    <li className="flex min-w-0 flex-col gap-3 px-panel py-3" data-pricing-change={change.kind}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span>
            <Badge tone={change.kind === 'added' ? 'ok' : change.kind === 'updated' ? 'warn' : 'pend'}>
              {change.kind === 'added' ? 'Added' : change.kind === 'updated' ? 'Changed' : 'Unchanged'}
            </Badge>
          </span>
          <PanelPath value={change.pricingKey} className="block text-ui font-semibold text-fg" />
        </div>
        {selectable ? (
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-ui font-semibold text-fg has-[:focus-visible]:outline-focus">
            <input
              type="checkbox"
              checked={selected}
              disabled={disabled}
              data-pricing-select={change.pricingKey}
              onChange={event => onSelect(event.currentTarget.checked)}
            />
            Apply this entry
          </label>
        ) : (
          <span className="text-meta text-faint">No action available</span>
        )}
      </div>
      <div className={change.kind === 'updated' ? 'grid min-w-0 gap-x-6 gap-y-4 lg:grid-cols-2' : 'grid min-w-0 gap-3'}>
        {change.kind === 'added' ? <PreviewRate label="Proposed" rate={change.after} /> : null}
        {change.kind === 'updated' ? (
          <>
            <PreviewRate label="Current" rate={change.before} />
            <PreviewRate label="Proposed" rate={change.after} />
          </>
        ) : null}
        {change.kind === 'unchanged' ? <PreviewRate label="Current · no change" rate={change.before} /> : null}
      </div>
    </li>
  );
}

export function SyncPreview({
  preview,
  selected,
  busy,
  invalidMessage,
  error,
  onSelect,
  onApply,
  onFreshPreview,
}: {
  readonly preview: AnalyticsPricingSyncPreview;
  readonly selected: ReadonlySet<string>;
  readonly busy: boolean;
  readonly invalidMessage: string | null;
  readonly error: string | null;
  readonly onSelect: (pricingKey: string, selected: boolean) => void;
  readonly onApply: () => void;
  readonly onFreshPreview: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-3 outline-none"
      aria-label="Provider changes"
      data-pricing-preview-id={preview.previewId}
    >
      <SettingGroup label="Provider changes">
        <li className="flex min-w-0 flex-col gap-1 px-panel py-3 text-meta leading-base text-muted">
          <span>
            Fetched from configured source <span className="font-mono text-fg">{preview.sourceId}</span> at{' '}
            <DateValue value={preview.fetchedAt} />. Nothing is selected by default.
          </span>
          <PanelPath value={preview.sourceUrl} className="block text-faint" label="Source" />
        </li>
        {preview.changes.length === 0 ? (
          <li className="px-panel py-3 text-ui text-muted" data-pricing-preview-empty="">
            This configured feed proposed no catalog entries.
          </li>
        ) : (
          preview.changes.map(change => (
            <PreviewChange
              key={change.pricingKey}
              change={change}
              selected={selected.has(change.pricingKey)}
              disabled={busy || invalidMessage !== null}
              onSelect={checked => onSelect(change.pricingKey, checked)}
            />
          ))
        )}
      </SettingGroup>
      {invalidMessage ? (
        <div
          className="flex min-w-0 flex-col items-start gap-2 rounded-panel border border-warn-border bg-warn-bg p-panel text-warn"
          role="alert"
          data-pricing-preview-stale=""
        >
          <p className="m-0 text-ui font-semibold">This preview can no longer be applied</p>
          <p className="m-0 text-meta leading-base">{invalidMessage}</p>
          <Button type="button" className="min-h-[44px]" disabled={busy} onClick={onFreshPreview}>
            Run a fresh preview
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className={NOTE_ERR} role="alert">
          {error}
        </p>
      ) : null}
      <div className="sticky bottom-2 flex flex-wrap items-center justify-between gap-2 rounded-panel border border-border bg-surface p-3 shadow-panel">
        <p className="m-0 text-meta font-semibold text-muted" aria-live="polite">
          {selected.size} selected · {preview.changes.filter(change => change.kind !== 'unchanged').length} applicable
        </p>
        <Button
          type="button"
          variant="primary"
          className="min-h-[44px]"
          disabled={busy || selected.size === 0 || invalidMessage !== null}
          data-pricing-apply=""
          onClick={onApply}
        >
          {busy ? 'Applying…' : 'Apply selected'}
        </Button>
      </div>
    </section>
  );
}
