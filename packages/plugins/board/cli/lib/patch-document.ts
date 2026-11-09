/**
 * A PATCH DOCUMENT'S TEXT (`fy card patch`, `fy card progress --file`): YAML or JSON in, a plain value out, and the editable
 * document back out as YAML for `show --yaml`. JSON is YAML, so one reader takes both.
 *
 * Read with YAML 1.2's core schema, as the configuration files are: `no`, `off`
 * and `yes` stay words, which matters when the document is mostly prose. Pure: text in, value or text out.
 */
import { readConfigText } from '@ferretry/std/yaml';
import { stringify } from 'yaml';
import type { z } from 'zod';

/** Where a problem is, as a person finds it in their file: `line 3, column 4: `, or nothing when the reader gave no place. */
const placed = (position: { readonly line: number; readonly column: number } | undefined): string =>
  position === undefined ? '' : `line ${String(position.line)}, column ${String(position.column)}: `;

/**
 * The document a patch file holds, or the sentence that says why it is not one. The text is read by the shared bounded
 * reader, so a patch over 256 KiB, an alias bomb or a directive flood is refused in one fixed sentence (a real patch is
 * a few fields, each at most 64 KiB), and every syntax problem keeps its line and column.
 */
export function readPatchText(
  text: string,
  source: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly problem: string } {
  if (text.trim() === '') return { ok: false, problem: `${source} is empty: a patch names at least one field` };
  const read = readConfigText(text);
  if (!read.ok) {
    const said = read.errors.map(error => `  ${placed(error.position)}${error.message}`).join('\n');
    return { ok: false, problem: `${source} is not YAML or JSON:\n${said}` };
  }
  const value = read.read.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: `${source} must be a mapping of field: value (YAML) or an object (JSON)` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** A path as a reader writes it: `tabs.Status`, `links[0].target`. */
const shownPath = (path: readonly PropertyKey[], rename: Readonly<Record<string, string>>): string =>
  path
    .map((part, index) =>
      typeof part === 'number' ? `[${part}]` : `${index === 0 ? '' : '.'}${rename[String(part)] ?? String(part)}`,
    )
    .join('');

/**
 * Every problem a patch has, one line each and all of them at once, named by the field the reader wrote: an unknown
 * key is named with the keys a patch takes, so a typo is never silently nothing.
 */
export function patchProblems(
  error: z.ZodError,
  keys: readonly string[],
  rename: Readonly<Record<string, string>> = {},
): readonly string[] {
  return error.issues.flatMap(issue => {
    if (issue.code === 'unrecognized_keys') {
      // A nested unknown key (`status.later`) names the field it sits in, not the top-level keys.
      const takes = issue.path.length === 0 ? ` (it takes: ${keys.join(', ')})` : '';
      return issue.keys.map(key => `${shownPath([...issue.path, key], rename)}: not a field a patch changes${takes}`);
    }
    const path = shownPath(issue.path, rename);
    return [`${path === '' ? 'the patch' : path}: ${issue.message}`];
  });
}

/** Whether two plain values are the same document value: key order never matters, list order does. */
export function samePatchValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, each]) => each !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${stableJson(each)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * The editable document as YAML: multi-line Markdown as literal block text (`|`), never folded, so what a ferret reads
 * is what it writes back. `header` lines go first as comments.
 */
export function patchYaml(document: Record<string, unknown>, header: readonly string[]): string {
  const comments = header.map(line => `# ${line}`).join('\n');
  const body = stringify(document, {
    version: '1.2',
    lineWidth: 0,
    blockQuote: 'literal',
    aliasDuplicateObjects: false,
  });
  return `${comments}\n${body}`.trimEnd();
}
