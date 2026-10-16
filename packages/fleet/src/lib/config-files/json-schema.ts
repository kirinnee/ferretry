/**
 * The JSON Schema of every configuration file, for editors: `fy config schema <kind>` prints one, the
 * daemon writes them all into `config/.schema/`, and every file's first line points at its own
 * (`# yaml-language-server: $schema=…`), so an editor completes keys and flags a typo as it is typed.
 *
 * Generated from the same zod schemas the daemon checks a file with, so the two cannot disagree. A
 * rule zod cannot express in JSON Schema (a cross-field check) is simply absent from the editor's
 * view; the daemon and `fy config check` still enforce it.
 *
 * Pure.
 */
import { CONFIG_SCHEMA_IDS, type ConfigSchemaId } from '@ferretry/protocol';
import { z } from 'zod';
import { CONFIG_FILE_SCHEMAS } from './kinds.ts';

/** One file kind's JSON Schema, titled with the schema id. */
export function configJsonSchema(id: ConfigSchemaId): Record<string, unknown> {
  return {
    ...z.toJSONSchema(CONFIG_FILE_SCHEMAS[id], { io: 'input', unrepresentable: 'any' }),
    title: `Ferretry ${id} configuration file`,
  };
}

/** Every schema, by id, as the text written to `config/.schema/<id>.json`. */
export function configJsonSchemaFiles(): ReadonlyMap<ConfigSchemaId, string> {
  return new Map(CONFIG_SCHEMA_IDS.map(id => [id, `${JSON.stringify(configJsonSchema(id), null, 2)}\n`]));
}
