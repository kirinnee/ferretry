import { definePort } from '@ferretry/kernel/contract';
import type { TidyTotals } from './wire.ts';

/** Tidy's port (§2.3): what the sweeps have reclaimed, for the health report and the app. Sweeping is a route. */
export interface TidyApi {
  totals(): Promise<TidyTotals>;
}
export const TidyPort = definePort<TidyApi>('tidy');
