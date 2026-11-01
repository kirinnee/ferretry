/**
 * One configuration file, checked: does it parse, does it hold a raw secret, does it satisfy its
 * schema — every problem located to a line and column and said with a plain fix.
 *
 * This is the one check every editor gets: the daemon on every reload, `fy config check` without a
 * daemon, the app's "Edit as YAML" before it saves, and an agent's `config.validate`. Cross-file rules
 * (a profile naming a component that does not exist) are the whole directory's, in `./evaluate.ts`.
 *
 * Pure.
 */
import {
  type ConfigFileAddress,
  type ConfigIssue,
  type ConfigSchemaId,
  classifyConfigPath,
  configSchemaId,
} from '@ferretry/protocol';
import type { z } from 'zod';
import { type ComponentSourceRule, componentSourceProblem } from '../state-home-fence.ts';
import { CONFIG_FILE_SCHEMAS, type ConfigValues, configValue } from './kinds.ts';
import { findRawSecrets, RAW_SECRET_FIX, RAW_SECRET_MESSAGE } from './secrets.ts';
import { readConfigText, type TextPosition } from './yaml-text.ts';

/** A file that checked: what it is and what it means. */
export interface CheckedConfigFile {
  readonly ok: true;
  readonly address: ConfigFileAddress;
  readonly schema: ConfigSchemaId;
  readonly value: ConfigValues[keyof ConfigValues];
  /** Warnings only; a file with an error is never `ok`. */
  readonly issues: readonly ConfigIssue[];
  /** Where a path inside the file is written, for a cross-file issue found later. */
  locate(path: readonly PropertyKey[]): TextPosition | undefined;
}

/** A file that did not check, and every reason why. */
export interface RefusedConfigFile {
  readonly ok: false;
  readonly address: ConfigFileAddress | undefined;
  readonly issues: readonly ConfigIssue[];
}

export type ConfigFileCheck = CheckedConfigFile | RefusedConfigFile;

/** Where an issue is, as the wire carries it: both halves of a position, or neither. */
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
    return `remove ${issue.keys.map(key => `"${key}"`).join(', ')}${where === '' ? '' : ` from ${where}`} — this file has no such setting; \`fy config schema\` lists what it takes`;
  }
  // zod 4 reports a missing key as an invalid type whose input was `undefined`, said in the message.
  if (issue.code === 'invalid_type' && /received undefined$/u.test(issue.message)) {
    return `add "${String(issue.path.at(-1) ?? '')}" — it is required`;
  }
  // A rule's own message is already a sentence naming what is wrong and what exists instead.
  if (issue.code === 'custom') return `correct ${where === '' ? 'the file' : where}, then run \`fy config check\``;
  return where === '' ? `change the file: ${issue.message}` : `change ${where}: ${issue.message}`;
}

/** The issues a failed schema parse means, each located in the file. */
export function schemaIssues(
  path: string,
  error: z.ZodError,
  locate: (path: readonly PropertyKey[]) => TextPosition | undefined,
): readonly ConfigIssue[] {
  return error.issues.map(issue => {
    // Unknown keys are reported on the object holding them; the first of them is where to look.
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

/**
 * Settings renamed for the agenda wire, per file: the older key is still read until the agenda removal
 * release, so it is a warning that says where it went, and a file that writes BOTH is told which one counts.
 */
const RENAMED_KEYS: Partial<Record<ConfigSchemaId, ReadonlyArray<{ readonly old: string; readonly renamed: string }>>> =
  {
    machine: [{ old: 'attentionNudge', renamed: 'agendaNudge' }],
  };

function renamedKeyWarnings(
  path: string,
  schema: ConfigSchemaId,
  value: unknown,
  locate: (path: readonly PropertyKey[]) => TextPosition | undefined,
): readonly ConfigIssue[] {
  const written = value as Record<string, unknown>;
  return (RENAMED_KEYS[schema] ?? []).flatMap(({ old, renamed }): readonly ConfigIssue[] => {
    if (written[old] === undefined) return [];
    const both = written[renamed] !== undefined;
    return [
      {
        path,
        ...at(locate([old])),
        severity: 'warning',
        message: both
          ? `${old} is renamed to ${renamed}, and both are written: ${renamed} wins and ${old} is ignored`
          : `${old} is renamed to ${renamed}; still read until the agenda removal release`,
        fix: both ? `delete ${old}` : `rename ${old} to ${renamed}`,
      },
    ];
  });
}

/** What a check knows about this machine beyond the file. Absent, only what the file alone decides is checked. */
export interface ConfigCheckContext {
  /**
   * The component-source fence (`../state-home-fence.ts`): a component whose `file` or `directory`
   * names the daemon's state home is an error, so it never comes into effect.
   */
  readonly componentSources?: ComponentSourceRule;
}

/** The fields of a component that name a document on the disk. */
const COMPONENT_SOURCE_FIELDS = ['file', 'directory'] as const;

/** A component source that names the daemon's own state home, as an error at the field that names it. */
function fencedSourceIssues(
  path: string,
  value: unknown,
  rule: ComponentSourceRule,
  locate: (path: readonly PropertyKey[]) => TextPosition | undefined,
): ConfigIssue[] {
  if (typeof value !== 'object' || value === null) return [];
  return COMPONENT_SOURCE_FIELDS.flatMap(field => {
    const reference = (value as Record<string, unknown>)[field];
    const problem = typeof reference === 'string' ? componentSourceProblem(rule, reference) : undefined;
    return problem === undefined
      ? []
      : [
          {
            path,
            ...at(locate([field])),
            severity: 'error' as const,
            message: `${field}: ${problem}`,
            fix: 'name a document outside the Ferretry home, or put a copy of it in the fleet asset folder',
          },
        ];
  });
}

/** Check one file, found at `path` relative to the config directory, with this text. */
export function checkConfigFile(path: string, text: string, context: ConfigCheckContext = {}): ConfigFileCheck {
  const address = classifyConfigPath(path);
  if (address === undefined) {
    return {
      ok: false,
      address,
      issues: [
        {
          path,
          severity: 'warning',
          message: 'Ferretry does not read this file',
          fix: 'name it machine.yaml, warden.yaml, learning.yaml, voice.yaml, pack.yaml, models-guide.yaml, account-defaults.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml — or move it out of the config directory',
        },
      ],
    };
  }
  const read = readConfigText(text);
  if (!read.ok) {
    return {
      ok: false,
      address,
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
      address,
      issues: secrets.map(finding => ({
        path,
        ...at(read.read.locate(finding.path)),
        severity: 'error' as const,
        message: `${describePath(finding.path)}: ${RAW_SECRET_MESSAGE}`,
        fix: RAW_SECRET_FIX,
      })),
    };
  }
  const schema = configSchemaId(address);
  const parsed = CONFIG_FILE_SCHEMAS[schema].safeParse(read.read.value);
  if (!parsed.success) {
    return { ok: false, address, issues: schemaIssues(path, parsed.error, read.read.locate) };
  }
  const fenced =
    address.kind === 'component' && context.componentSources !== undefined
      ? fencedSourceIssues(path, parsed.data, context.componentSources, read.read.locate)
      : [];
  if (fenced.length > 0) return { ok: false, address, issues: fenced };
  return {
    ok: true,
    address,
    schema,
    value: configValue(schema, parsed.data),
    issues: renamedKeyWarnings(path, schema, read.read.value, read.read.locate),
    locate: read.read.locate,
  };
}
