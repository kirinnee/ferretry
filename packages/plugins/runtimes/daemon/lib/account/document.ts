/**
 * What is left of the single-file fleet configuration: the sentence that refuses it.
 *
 * The machine's configuration used to be ONE `fleet/config.yaml`. It is now a file per building block
 * under `config/` (docs/config-files.md, `../config-files/`), and a `config.yaml` that is still there is
 * REFUSED with {@link RetiredFleetConfigError} — never converted and never read alongside the files —
 * so a machine cannot run on a configuration nobody edits any more. The caller's file is left exactly
 * where it is, and the sentence tells the person how to set the machine up again.
 *
 * Pure: the caller decides whether the file exists.
 */

/** Where the retired single file lived, relative to the fleet directory. */
export const RETIRED_FLEET_CONFIG_FILE = 'config.yaml' as const;

/**
 * What a person is told about a retired `config.yaml` at `path`: where it is, that it is no longer
 * read, and how to get a working machine back.
 */
export const RETIRED_FLEET_CONFIG_SENTENCE = (path: string): string =>
  `${path} is the old single-file configuration, which this Ferretry no longer reads: each login, component, profile and runtime is now its own file under config/ in the state home. Move it aside (for example rename it to config.yaml.old), then set this machine up again from the app or with \`fy daemon setup\`.`;

/** A retired `config.yaml`; its message is {@link RETIRED_FLEET_CONFIG_SENTENCE}. */
export class RetiredFleetConfigError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(RETIRED_FLEET_CONFIG_SENTENCE(path));
    this.name = 'RetiredFleetConfigError';
    this.path = path;
  }
}

const NAME_LIMIT = 64;

/** The nearest letters-digits-dashes name to `value`, or `fallback` when nothing of it survives. */
export function slugName(value: string, fallback: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, NAME_LIMIT)
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? fallback : slug;
}
