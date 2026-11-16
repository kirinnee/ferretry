export { acceptedConfigFile, acceptedName, pathOfAcceptedName } from './accepted.ts';
export type { AnyConfigDef } from './claims.ts';
export { assertNoSharedPaths, CONFIG_EXTENSION, ConfigPathClaimError } from './claims.ts';
export type { ConfigDeclaration } from './claims.ts';
export type { CheckedConfigText, ConfigIssue, ConfigRefusal, RefusedConfigText } from './check.ts';
export { checkConfigText, describePath } from './check.ts';
export type { AcceptedConfig, ConfigEntryState, DiskState, EvaluatedConfig, EvaluateInput } from './evaluate.ts';
export { ABSENT_CONFIG_ETAG, defaultsOf, evaluateConfig } from './evaluate.ts';
export { configJsonSchemaText, schemaFileName, schemaModeline } from './schemas.ts';
export { RAW_SECRET_MESSAGE, rawSecretFix } from './secrets.ts';
export { findRawSecrets, looksLikeRawSecret } from '@ferretry/std/credential-words';
export type {
  ConfigEdit,
  ConfigFileView,
  ConfigFiles,
  ConfigFilesOptions,
  ConfigRemoveResult,
  ConfigStatus,
  ConfigWriteOptions,
  ConfigWriteRefusal,
  ConfigWriteResult,
  HeldConfigEdit,
} from './service.ts';
export { ACKNOWLEDGEMENT_TTL_MS, CONFIG_FILE_MAX_BYTES, createConfigFiles } from './service.ts';
export type { ConfigTreeEvents, ConfigWatchOptions, ConfigWatchTimers } from './watcher.ts';
export { watchConfigFiles } from './watcher.ts';
export type { ConfigRouteSources } from './routes.ts';
export { configRoutes } from './routes.ts';
