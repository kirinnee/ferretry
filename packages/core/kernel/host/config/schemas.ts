import { z } from 'zod';
import type { AnyConfigDef as ConfigDef } from './claims.ts';
import type { ConfigDeclaration } from './claims.ts';
import { SCHEMA_FOLDER, SCHEMA_MANIFEST } from '@ferretry/std/yaml';
import { CONFIG_EXTENSION, ConfigPathClaimError, claimOf } from './claims.ts';

/**
 * A schema's file name under `config/.schema/`: the claim with its separators flattened. A file keeps its stem
 * (`runtimes.yaml` is `runtimes.json`); a collection's schema describes one item of its folder, so it ends `--item`
 * (`runtimes/` is `runtimes--item.json`) and never meets a file of the same stem.
 */
export const schemaFileName = (def: ConfigDef): string => {
  const flat = claimOf(def)
    .replaceAll('/', '--')
    .replace(new RegExp(`\\${CONFIG_EXTENSION}$`, 'u'), '');
  return def.shape === 'collection' ? `${flat}--item.json` : `${flat}.json`;
};

/**
 * Every file the daemon publishes under `config/.schema/`, in the order it writes them: each schema, then the manifest
 * naming them, so a name is listed only once its file is there and `fy config schema` serves nothing the daemon did not write.
 */
export const schemaPublications = (defs: readonly ConfigDef[]): readonly { name: string; text: string }[] => [
  ...defs.map(def => ({ name: schemaFileName(def), text: configJsonSchemaText(def) })),
  { name: SCHEMA_MANIFEST, text: `${JSON.stringify(defs.map(schemaFileName).toSorted())}\n` },
];

/** Refuses two declarations that would publish one schema name: a later write would hide the earlier schema. */
export function assertDistinctSchemaNames(declarations: readonly ConfigDeclaration[]): void {
  const owners = new Map<string, ConfigDeclaration>();
  for (const declaration of declarations) {
    const name = schemaFileName(declaration.def);
    const first = owners.get(name);
    if (first !== undefined) {
      const spell = (item: ConfigDeclaration): string =>
        `${item.plugin} (${item.def.shape === 'file' ? item.def.file : `${item.def.collection}/`})`;
      throw new ConfigPathClaimError(
        `${spell(first)} and ${spell(declaration)} would both publish the editor schema ${SCHEMA_FOLDER}/${name}, so one would hide the other; rename one of them`,
      );
    }
    owners.set(name, declaration);
  }
}

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
