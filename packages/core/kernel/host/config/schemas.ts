import { z } from 'zod';
import type { AnyConfigDef as ConfigDef } from './claims.ts';
import { CONFIG_EXTENSION, claimOf, SCHEMA_FOLDER } from './claims.ts';

/** A schema's file name under `config/.schema/`: the claim with its separators flattened. */
export const schemaFileName = (def: ConfigDef): string =>
  `${claimOf(def)
    .replaceAll('/', '--')
    .replace(new RegExp(`\\${CONFIG_EXTENSION}$`, 'u'), '')}.json`;

/** The JSON Schema editors read, generated from the same zod schema the daemon checks a file with. */
export function configJsonSchemaText(def: ConfigDef): string {
  const schema = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' });
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/** The first line of a file: where its schema is, relative to the file. */
export function schemaModeline(def: ConfigDef, path: string): string {
  const depth = path.split('/').length - 1;
  return `# yaml-language-server: $schema=${'../'.repeat(depth)}${SCHEMA_FOLDER}/${schemaFileName(def)}`;
}
