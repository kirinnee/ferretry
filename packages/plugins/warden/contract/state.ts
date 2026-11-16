import { defineConfig, defineState } from '@ferretry/kernel/contract';
import {
  JevChecksFileSchema,
  RememberedFileSchema,
  WardenFileSchema,
  WardenStateFileSchema,
  wardenLoosens,
} from './wire.ts';

/** `state/warden/state.json`: sweep memory, blessings, the move ledger, daily statistics. */
export const WARDEN_STATE = defineState({
  name: 'state',
  path: 'state.json',
  store: 'json',
  format: 1,
  schema: WardenStateFileSchema,
});
/** Investigation reports, one markdown file each (and its provenance sidecar). Read through the guarded `report` route only. */
export const WARDEN_REPORTS = defineState({ name: 'reports', path: 'reports/*', store: 'opaque', format: 1 });
/** Jev's checks, one file per UTC day. */
export const WARDEN_JEV_CHECKS = defineState({
  name: 'jev-checks',
  path: 'jev-checks/*.json',
  store: 'json',
  format: 1,
  schema: JevChecksFileSchema,
});
/**
 * Blessings ("leave it alone"). A blessing only ever makes the warden hold back, so a damaged file reading as none is
 * the narrower reading the contract allows: the warden judges every ferret again. It grants nothing.
 */
export const WARDEN_REMEMBERED = defineState({
  name: 'remembered',
  path: 'remembered.json',
  store: 'json',
  format: 1,
  schema: RememberedFileSchema,
  onDamaged: { narrower: 'reads as no blessings: the warden judges every ferret again' },
});

/** `config/warden.yaml`: loosening edits (a bigger cap, a new act it may take alone, a layer on) wait for the owner. */
export const WARDEN_CONFIG = defineConfig({
  file: 'warden.yaml',
  schema: WardenFileSchema,
  axis: 'configure',
  loosens: wardenLoosens,
});
