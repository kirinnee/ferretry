import type { ConfigCollectionDef, ConfigPort } from '@ferretry/kernel/contract';
import {
  ENDPOINTS_CONFIG,
  type EndpointFile,
  LOGINS_CONFIG,
  type LoginFile,
  MODELS_CONFIG,
  type ModelCatalogFile,
} from '../../contract/index.ts';

/**
 * The contract widens its typed config defs to `ConfigDef` so a manifest accepts them (`contract/config-def.ts`); a
 * half reading one narrows it back here, once, to the shape the def's own schema parsed.
 */
export const loginFiles = (config: ConfigPort): ReadonlyMap<string, LoginFile> =>
  config.collection(LOGINS_CONFIG as ConfigCollectionDef<LoginFile>);
export const endpointFiles = (config: ConfigPort): ReadonlyMap<string, EndpointFile> =>
  config.collection(ENDPOINTS_CONFIG as ConfigCollectionDef<EndpointFile>);
export const modelFiles = (config: ConfigPort): ReadonlyMap<string, ModelCatalogFile> =>
  config.collection(MODELS_CONFIG as ConfigCollectionDef<ModelCatalogFile>);
