import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { HousekeepingSchema, TidyConfigSchema, tidyLoosens } from './wire.ts';

/** `state/tidy/housekeeping.json`: what the sweeps have reclaimed so far. */
export const HousekeepingFile = defineState({
  name: 'housekeeping',
  path: 'housekeeping.json',
  store: 'json',
  format: 1,
  schema: HousekeepingSchema,
});

/** `config/tidy.yaml`. The leaf's `ConfigDef` is invariant in its shape, so the manifest takes the widened def. */
export const TidyConfigFile = defineConfig({
  file: 'tidy.yaml',
  schema: TidyConfigSchema,
  axis: 'configure',
  loosens: tidyLoosens,
});
export const TidyConfigDef = TidyConfigFile as ConfigDef;
