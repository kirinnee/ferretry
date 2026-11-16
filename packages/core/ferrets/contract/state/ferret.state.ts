import { defineState } from '@ferretry/kernel/contract';
import { FerretRecordSchema } from '../ids.ts';

/** Ferrets' declared files (§9.2). Every JSON document has `format: 1` first. */

export const FerretFiles = defineState({
  name: 'ferret',
  path: '*/ferret.json',
  store: 'json',
  format: 1,
  schema: FerretRecordSchema,
});
