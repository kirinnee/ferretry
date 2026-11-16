import type { ConfigCollectionDef, ConfigFileDef } from '../../contract/index.ts';

/** A config def of any shape. `any` because `loosens` is contravariant in the shape: a typed def would not fit `ConfigDef<unknown>`. */
// biome-ignore lint/suspicious/noExplicitAny: see above
export type AnyConfigDef = ConfigFileDef<any> | ConfigCollectionDef<any>;

/** One plugin's declared config def. */
export interface ConfigDeclaration {
  readonly plugin: string;
  readonly def: AnyConfigDef;
}

/** Two declarations that could claim one path: the build refuses them (§7.2). */
export class ConfigPathClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigPathClaimError';
  }
}

/** The file extension every config file has; `<name>.yaml` inside a collection. */
export const CONFIG_EXTENSION = '.yaml';

/** What a def claims under `config/`: a file's path, or a collection's folder. */
export const claimOf = (def: AnyConfigDef): string => (def.shape === 'file' ? def.file : def.collection);

const describe = (declaration: ConfigDeclaration): string =>
  `${declaration.plugin} (${declaration.def.shape === 'file' ? declaration.def.file : `${declaration.def.collection}/`})`;

function assertPath(declaration: ConfigDeclaration): void {
  const claim = claimOf(declaration.def);
  const segments = claim.split('/');
  const bad =
    claim === '' ||
    claim.startsWith('/') ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.')) ||
    (declaration.def.shape === 'file' && !claim.endsWith(CONFIG_EXTENSION));
  if (bad)
    throw new ConfigPathClaimError(
      `${describe(declaration)}: "${claim}" is not a path under config/ (a file ends ${CONFIG_EXTENSION}; nothing starts with a dot)`,
    );
}

/**
 * Refuses two declarations that could claim one path: the same file or folder, a file inside a collection's folder,
 * or one collection folder inside another. Plugins never share a path, and one plugin never declares it twice.
 */
export function assertNoSharedPaths(declarations: readonly ConfigDeclaration[]): void {
  for (const declaration of declarations) assertPath(declaration);
  for (const [index, left] of declarations.entries()) {
    for (const right of declarations.slice(index + 1)) {
      const a = claimOf(left.def);
      const b = claimOf(right.def);
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        throw new ConfigPathClaimError(`${describe(left)} and ${describe(right)} claim the same path under config/`);
    }
  }
}

/** The declared file or collection item a path under `config/` names, or `undefined` when no plugin reads it. */
export function targetOfPath(
  declarations: readonly ConfigDeclaration[],
  path: string,
): { readonly plugin: string; readonly def: AnyConfigDef; readonly name?: string } | undefined {
  for (const { plugin, def } of declarations) {
    if (def.shape === 'file') {
      if (def.file === path) return { plugin, def };
      continue;
    }
    const prefix = `${def.collection}/`;
    if (!path.startsWith(prefix) || !path.endsWith(CONFIG_EXTENSION)) continue;
    const name = path.slice(prefix.length, -CONFIG_EXTENSION.length);
    if (!name.includes('/') && def.name.test(name)) return { plugin, def, name };
  }
  return undefined;
}
