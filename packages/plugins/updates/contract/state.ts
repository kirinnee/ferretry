/**
 * Updates' declared files (§9.2): what the last check found, the report the last update left, the update's own log
 * and `config/updates.yaml`. The manifest declares them; the daemon half reads and writes them through the kernel.
 */
import { defineConfig, defineState } from '@ferretry/kernel/contract';
import { UpdateCheckSchema, UpdateReportSchema } from './view.ts';
import { UpdatesConfigSchema, updatesLoosens } from './wire.ts';

/** Today's `state/update/latest.json`: the last answer GitHub gave, so a restart inside the six hours asks nothing. */
export const UPDATES_LATEST = defineState({
  name: 'latest',
  path: 'update/latest.json',
  store: 'json',
  format: 1,
  schema: UpdateCheckSchema,
});
/** Today's `state/update/report.json`: the one thing that crosses the restart, written by the update when it ends. */
export const UPDATES_REPORT = defineState({
  name: 'report',
  path: 'update/report.json',
  store: 'json',
  format: 1,
  schema: UpdateReportSchema,
});
/** The output of the update process the daemon started. */
export const UPDATES_LOG = defineState({ name: 'log', path: 'update.log', store: 'opaque', format: 1 });

export const UPDATES_CONFIG = defineConfig({
  file: 'updates.yaml',
  schema: UpdatesConfigSchema,
  axis: 'configure',
  loosens: updatesLoosens,
});
