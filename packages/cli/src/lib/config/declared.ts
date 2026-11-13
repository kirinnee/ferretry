/**
 * What the compiled `fy` knows of the configuration files: every code plugin's declared `data.config`, the Kernel's
 * included. A plugin declares its own file or folder under `config/` (docs/config-files.md); the Kernel reads and writes
 * them all. No file name is written here: the names are the manifests'.
 */
import { config } from '@ferretry/kernel/host';
import type { CommandRegistry } from '../registry.ts';

export interface DeclaredConfig extends config.ConfigDeclaration {
  /** The owning plugin's title, as `fy` names it. */
  readonly title: string;
}

const EXTENSION = '.yaml';

export function declaredConfig(registry: CommandRegistry): readonly DeclaredConfig[] {
  return [registry.kernel, ...registry.plugins.map(plugin => ({ manifest: plugin.manifest }))].flatMap(entry =>
    (entry.manifest.data?.config ?? []).map(def => ({
      plugin: entry.manifest.id,
      title: entry.manifest.title,
      def: def as config.AnyConfigDef,
    })),
  );
}

/** What a declaration claims under `config/`, spelled for a person: `warden.yaml` or `runtimes/<name>.yaml`. */
export const claimSpelling = (declaration: config.ConfigDeclaration): string =>
  declaration.def.shape === 'file' ? declaration.def.file : `${declaration.def.collection}/<name>${EXTENSION}`;

/** A kind's name as `fy config schema` spells it: the schema file's stem (`warden`, `runtimes--item`). */
export const kindOf = (declaration: config.ConfigDeclaration): string =>
  config.schemaFileName(declaration.def).replace(/\.json$/u, '');
