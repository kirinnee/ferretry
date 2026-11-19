/**
 * THE TWO RATE LISTS: the rates this machine's operator configured (edit / remove), and the list prices the model
 * catalogs give the models nobody configured (read-only, with Override). Each is ONE group of rows, one row per rate,
 * which is three columns from a tablet up and stacks on a phone. There is no table and no second phone layout, so a
 * rate is drawn once, and nothing is a bordered card inside the group's own border.
 */
import { Button } from '@ferretry/app/ui';
import { SettingGroup } from '@ferretry/app';
import type { AnalyticsPricingRate } from '../../../contract/index.ts';
import { EffectiveDates, Identity, Provenance, RateActions, RateAmounts } from './pricing-rate-parts.tsx';
import { PROVIDER_LABELS } from './pricing-model.ts';

const ROW = 'fy-usage-ledger-row gap-3 px-panel py-3';

/**
 * The prices the model catalogs give the models no operator rate claims (docs/model-catalog.md
 * § Prices): what insights charges a session at when nobody configured one. Read-only — they change
 * with the catalog — and Override starts a manual rate from one, which then wins for that model.
 */
export function ModelCatalogRates({
  rates,
  busy,
  onOverride,
}: {
  readonly rates: readonly AnalyticsPricingRate[];
  readonly busy: boolean;
  readonly onOverride: (rate: AnalyticsPricingRate) => void;
}) {
  if (rates.length === 0) return null;
  return (
    <div className="min-w-0" data-pricing-model-catalog="">
      <SettingGroup label="From the model catalog">
        {rates.map(rate => (
          <li key={rate.pricingKey} className={ROW} data-pricing-catalog-rate={rate.pricingKey}>
            <div className="min-w-0">
              <p className="m-0 break-words font-mono text-ui font-semibold text-fg">{rate.modelId}</p>
              <p className="mb-0 mt-1 text-meta text-muted">{PROVIDER_LABELS[rate.provider]}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <RateAmounts rates={rate.rates} />
              <Provenance rate={rate} />
            </div>
            <div>
              <Button
                type="button"
                className="min-h-[44px]"
                disabled={busy}
                data-pricing-override={rate.pricingKey}
                onClick={() => onOverride(rate)}
              >
                Override
              </Button>
            </div>
          </li>
        ))}
      </SettingGroup>
      <p className="mb-0 mt-2 px-1 text-meta leading-base text-muted">
        {rates.length} list price{rates.length === 1 ? '' : 's'} from the providers' pricing pages, used for any model
        above has no rate for. A rate you add for a model replaces its catalog price.
      </p>
    </div>
  );
}

export function CatalogLedger({
  rates,
  catalogPriced,
  busy,
  confirmingKey,
  onEdit,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: {
  readonly rates: readonly AnalyticsPricingRate[];
  /** Whether the model catalogs price models this table does not, so nothing is unpriced by default. */
  readonly catalogPriced: boolean;
  readonly busy: boolean;
  readonly confirmingKey: string | null;
  readonly onEdit: (rate: AnalyticsPricingRate) => void;
  readonly onRequestRemove: (pricingKey: string) => void;
  readonly onCancelRemove: () => void;
  readonly onRemove: (pricingKey: string) => void;
}) {
  if (rates.length === 0)
    return (
      <SettingGroup label="Current catalog">
        <li className="flex min-w-0 flex-col gap-1 px-panel py-3" data-pricing-empty="">
          <span className="text-ui font-semibold text-fg">No model rates configured</span>
          <span className="text-meta leading-base text-muted">
            {catalogPriced
              ? 'Sessions are priced from the model catalog below. Add a rate to set your own price for a model.'
              : 'Usage stays explicitly unpriced until an operator adds a rate or applies selected provider changes.'}
          </span>
        </li>
      </SettingGroup>
    );

  return (
    <div className="min-w-0" data-pricing-ledger="">
      <SettingGroup label="Current catalog">
        {rates.map(rate => (
          <li key={rate.pricingKey} className={ROW} data-pricing-row={rate.pricingKey}>
            <Identity rate={rate} />
            <div className="flex min-w-0 flex-col gap-3">
              <RateAmounts rates={rate.rates} />
              <div className="fy-usage-fit">
                <div className="fy-usage-pair gap-3">
                  <Provenance rate={rate} />
                  <EffectiveDates rate={rate} />
                </div>
              </div>
            </div>
            <RateActions
              rate={rate}
              busy={busy}
              confirming={confirmingKey === rate.pricingKey}
              onEdit={() => onEdit(rate)}
              onRequestRemove={() => onRequestRemove(rate.pricingKey)}
              onCancelRemove={onCancelRemove}
              onRemove={() => onRemove(rate.pricingKey)}
            />
          </li>
        ))}
      </SettingGroup>
    </div>
  );
}
