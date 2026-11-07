/**
 * One configuration file, checked: does it parse, does it hold a raw secret, does it satisfy its schema — every
 * problem located to a line and column and said with a plain fix. This is the one check every editor gets: the
 * daemon on every reload and every write. Today's `checkConfigFile`, taken from the fixed list of kinds to a
 * plugin's own `defineConfig` schema.
 *
 * Pure.
 */
import type { z } from 'zod';
import type { AnyConfigDef as ConfigDef } from './claims.ts';
import { findRawSecrets, RAW_SECRET_MESSAGE, rawSecretFix } from './secrets.ts';
import { readConfigText, type TextPosition } from './yaml-text.ts';

/** A located finding. */
export interface ConfigIssue {
  /** The file, relative to `config/`. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix: string;
}

export interface CheckedConfigText {
  readonly ok: true;
  readonly value: unknown;
  /** The plain value as written, before defaults: what a comment-keeping edit starts from. */
  readonly written: unknown;
  readonly text: string;
}

/** Why a file did not check, so a write can say `refused` with the right reason. */
export type ConfigRefusal = 'yaml' | 'raw_secret' | 'schema';

export interface RefusedConfigText {
  readonly ok: false;
  readonly reason: ConfigRefusal;
  readonly issues: readonly ConfigIssue[];
}

const at = (position: TextPosition | undefined): Pick<ConfigIssue, 'line' | 'column'> =>
  position === undefined ? {} : { line: position.line, column: position.column };

/** A dotted path a person can find in the file: `env.ANTHROPIC_AUTH_TOKEN`, `contents[2]`. */
export function describePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, part) =>
      typeof part === 'number' ? `${text}[${String(part)}]` : text === '' ? String(part) : `${text}.${String(part)}`,
    '',
  );
}

/** The plain fix for one schema issue. Specific where the cause is common, the message itself otherwise. */
function fixFor(issue: z.core.$ZodIssue, where: string): string {
  if (issue.code === 'unrecognized_keys') {
    return `remove ${issue.keys.map(key => `"${key}"`).join(', ')}${where === '' ? '' : ` from ${where}`} — this file has no such setting`;
  }
  if (issue.code === 'invalid_type' && /received undefined$/u.test(issue.message)) {
    return `add "${String(issue.path.at(-1) ?? '')}" — it is required`;
  }
  if (issue.code === 'custom') return `correct ${where === '' ? 'the file' : where}`;
  return where === '' ? `change the file: ${issue.message}` : `change ${where}: ${issue.message}`;
}

/** The issues a failed schema parse means, each located in the file. */
export function schemaIssues(
  path: string,
  error: z.ZodError,
  locate: (path: readonly PropertyKey[]) => TextPosition | undefined,
): readonly ConfigIssue[] {
  return error.issues.map(issue => {
    const site = issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys.slice(0, 1)] : issue.path;
    const where = describePath(issue.path);
    return {
      path,
      ...at(locate(site)),
      severity: 'error' as const,
      message: where === '' || issue.code === 'custom' ? issue.message : `${where}: ${issue.message}`,
      fix: fixFor(issue, where),
    };
  });
}

/** Check one file's text against the schema its definition declares. */
export function checkConfigText(
  def: ConfigDef,
  path: string,
  text: string,
  binary: string,
): CheckedConfigText | RefusedConfigText {
  const read = readConfigText(text);
  if (!read.ok) {
    return {
      ok: false,
      reason: 'yaml',
      issues: read.errors.map(error => ({
        path,
        ...at(error.position),
        severity: 'error' as const,
        message: `this is not valid YAML: ${error.message}`,
        fix: 'correct the YAML at that line — check the indentation, and quote a value that holds a colon',
      })),
    };
  }
  const secrets = findRawSecrets(read.read.value);
  if (secrets.length > 0) {
    return {
      ok: false,
      reason: 'raw_secret',
      issues: secrets.map(finding => ({
        path,
        ...at(read.read.locate(finding.path)),
        severity: 'error' as const,
        // The path to the value, never the value: a secret pasted by mistake travels no further than its file.
        message: `${describePath(finding.path)}: ${RAW_SECRET_MESSAGE}`,
        fix: rawSecretFix(binary),
      })),
    };
  }
  const parsed = def.schema.safeParse(read.read.value);
  if (!parsed.success)
    return { ok: false, reason: 'schema', issues: schemaIssues(path, parsed.error, read.read.locate) };
  return { ok: true, value: parsed.data, written: read.read.value, text };
}
