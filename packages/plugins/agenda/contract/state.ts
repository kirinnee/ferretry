import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { AgendaConfigSchema, BuzzRecordSchema, ModesFileSchema, SeenFileSchema } from './wire.ts';

/** `state/agenda/seen.json`: when the owner last saw each ask, so an unread badge can clear. */
export const SEEN = defineState({ name: 'seen', path: 'seen.json', store: 'json', format: 1, schema: SeenFileSchema });
/** The buzz ledger: one line per moment the phone was buzzed, so a restart never buzzes twice. */
export const BUZZES = defineState({
  name: 'buzzes',
  path: 'buzzes.jsonl',
  store: 'jsonl',
  format: 1,
  schema: BuzzRecordSchema,
});
/** Each ferret's own recorded agenda mode; a recorded value always wins over the machine default. */
export const MODES = defineState({
  name: 'modes',
  path: 'modes.json',
  store: 'json',
  format: 1,
  schema: ModesFileSchema,
});

/** `config/agenda.yaml`: nothing here widens authority or spend. */
export const AGENDA_CONFIG = defineConfig({
  file: 'agenda.yaml',
  schema: AgendaConfigSchema,
  axis: 'configure',
  loosens: neverLoosens,
}) as ConfigDef;
