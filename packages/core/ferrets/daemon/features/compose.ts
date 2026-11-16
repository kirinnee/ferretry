import { composeFeatures } from '@ferretry/kernel/manifest';
import type { FerretsApi } from '../../contract/index.ts';
import type { FerretsContext, FerretsFeature } from './types.ts';

/** Registers every Ferrets feature: the plugin kit's `composeFeatures` (`@ferretry/kernel/manifest`) labelled `ferrets`. */
export const registerFeatures = (features: readonly FerretsFeature[], context: FerretsContext) =>
  composeFeatures<FerretsContext, FerretsApi>('ferrets', features, context);
