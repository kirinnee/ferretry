/**
 * The fleet configuration as text — `config.yaml` read in and written out (docs/design/account-model.md
 * §5.3).
 *
 * This is the one place `config.yaml` text becomes an {@link AccountModel} and the one place a model
 * becomes that text, so every surface that reads or writes the file agrees on both directions.
 *
 * A document from the retired account format — no `version` key, `version: 1`, an empty document or
 * `{}` — is REFUSED with {@link RetiredFleetConfigError}, never converted and never treated as an
 * empty machine: the caller's file is left exactly where it is, and the sentence tells the person how
 * to set the machine up again. A missing file is not a document at all and stays the caller's to
 * decide.
 *
 * Pure: the caller reads and writes the file.
 */
import { type AccountModel, parseAccountModel } from './schema.ts';

/**
 * What a person is told about a `config.yaml` at `path` still written in the retired format: where it
 * is, that it is no longer read, and how to get a working machine back.
 */
export const RETIRED_FLEET_CONFIG_SENTENCE = (path: string): string =>
  `${path} uses the old account format, which this Ferretry no longer reads. Move it aside (for example rename it to config.yaml.old), then set this machine up again from the app or with \`fy daemon setup\`.`;

/** A `config.yaml` written in the retired account format; its message is {@link RETIRED_FLEET_CONFIG_SENTENCE}. */
export class RetiredFleetConfigError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(RETIRED_FLEET_CONFIG_SENTENCE(path));
    this.name = 'RetiredFleetConfigError';
    this.path = path;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse `config.yaml` text found at `path`.
 *
 * Throws {@link RetiredFleetConfigError} for a document with no `version` (including an empty one and
 * `{}`) or `version: 1`; every other document is checked as version 2, so a broken version-2 file
 * throws the `ZodError` that names what is wrong, and a YAML syntax error throws as the parser does.
 */
export function parseAccountConfigText(text: string, path: string): AccountModel {
  const raw: unknown = Bun.YAML.parse(text);
  if (!isRecord(raw) || raw.version === undefined || raw.version === 1) {
    throw new RetiredFleetConfigError(path);
  }
  return parseAccountModel(raw);
}

/** The version-2 `config.yaml`, as written. */
export function renderConfig(model: AccountModel): string {
  return `${Bun.YAML.stringify(model, null, 2).replace(/\n*$/u, '')}\n`;
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
