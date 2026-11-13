import type { StatePort } from '@ferretry/kernel/contract';
import { PRICING_STATE, type PricingFile } from '../../../contract/index.ts';
import type {
  AnalyticsPricingConfiguration,
  AnalyticsPricingConfigurationPort,
  AnalyticsPricingConfigurationRead,
  AnalyticsPricingConfigurationWrite,
  AnalyticsPricingConfigurationWriteResult,
} from '../../lib/analytics/pricing-service.ts';
import {
  analyticsPricingFingerprint,
  analyticsPricingSourcesFingerprint,
} from '../../lib/analytics/pricing-catalog.ts';

const EMPTY: PricingFile = { catalog: [], sources: [] };

/**
 * The owner's rate catalog and configured sources, in `state/usage/pricing.json`. A file that is missing is an empty
 * catalog (a fresh install); one that is DAMAGED is `unavailable`, never an empty catalog, because pricing an owner's fleet
 * from nothing would read as free.
 */
export class StatePricingConfiguration implements AnalyticsPricingConfigurationPort {
  constructor(private readonly state: StatePort) {}

  async readPricing(): Promise<AnalyticsPricingConfigurationRead> {
    const read = await this.state.read(PRICING_STATE);
    if (!read.ok) return { kind: 'unavailable', message: read.error.sentence };
    const file = read.value ?? EMPTY;
    return { kind: 'read', configuration: { catalog: file.catalog, sources: file.sources } };
  }

  async writePricing(input: AnalyticsPricingConfigurationWrite): Promise<AnalyticsPricingConfigurationWriteResult> {
    let outcome: AnalyticsPricingConfigurationWriteResult | undefined;
    const updated = await this.state.update(PRICING_STATE, current => {
      const file = current ?? EMPTY;
      const configuration: AnalyticsPricingConfiguration = { catalog: file.catalog, sources: file.sources };
      if (analyticsPricingFingerprint(file.catalog) !== input.expectedCatalogFingerprint) {
        outcome = { kind: 'stale_catalog', configuration };
        return file;
      }
      if (
        input.expectedSourcesFingerprint !== undefined &&
        analyticsPricingSourcesFingerprint(file.sources) !== input.expectedSourcesFingerprint
      ) {
        outcome = { kind: 'stale_sources', configuration };
        return file;
      }
      const synced = input.syncedSource;
      const sources =
        synced === undefined
          ? file.sources
          : file.sources.map(source =>
              source.id === synced.sourceId ? { ...source, lastSyncedAt: synced.lastSyncedAt } : source,
            );
      outcome = { kind: 'written', configuration: { catalog: input.catalog, sources } };
      return { catalog: input.catalog, sources };
    });
    if (!updated.ok) return { kind: 'unavailable', message: updated.error.sentence };
    return outcome ?? { kind: 'unavailable', message: 'the pricing file did not answer' };
  }
}
