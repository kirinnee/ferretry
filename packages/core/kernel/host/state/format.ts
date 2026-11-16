import { err, ok, type Result } from '@ferretry/std';
import type { StateDamage, StateFileDef } from '../../contract/index.ts';

/**
 * The one-format rule (§9.3 "One file at a time"): a reader accepts EXACTLY the format its definition names. Every
 * JSON document and every JSONL line is an object whose first key is `"format": <n>`; the port stamps it on write
 * and strips it on read, so a schema describes the document WITHOUT `format` (a schema that names `format` itself
 * is tried second and works too).
 *
 * Pure.
 */

type Reason = StateDamage['reason'];

/** The folder-relative label every damage names: `state/<id>/<path>`. */
export const stateLabel = (pluginId: string, relativePath: string): string => `state/${pluginId}/${relativePath}`;

const SENTENCES: Readonly<Record<Reason, (label: string, detail: string) => string>> = {
  unparsable: (label, detail) =>
    `${label} cannot be read (${detail}), so Ferretry will not use it. Nothing was changed or deleted: restore the file from a backup.`,
  no_format: label =>
    `${label} has no "format" number, so Ferretry will not use it. Nothing was changed or deleted: restore the file from a backup.`,
  lower_format: (label, detail) =>
    `${label} was written in an older format (${detail}), so Ferretry will not use it. Nothing was changed or deleted.`,
  higher_format: (label, detail) =>
    `${label} was written by a newer Ferretry (format ${detail}), so this one will not use it. Update Ferretry to read it.`,
  schema: (label, detail) =>
    `${label} does not hold what Ferretry expects (${detail}), so Ferretry will not use it. Nothing was changed or deleted: restore the file from a backup.`,
  missing: label =>
    `${label} is missing, and Ferretry cannot start this part without it. Nothing was changed: restore the file from a backup.`,
  io: (label, detail) => `${label} could not be read (${detail}), so Ferretry will not use it. Nothing was changed.`,
};

export function damageOf(label: string, reason: Reason, detail = ''): StateDamage {
  return { file: label, reason, sentence: SENTENCES[reason](label, detail) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const describeFault = (error: unknown): string =>
  error instanceof Error ? error.message.split('\n')[0] || error.name : String(error);

/** Check the `format` of a decoded document and hand back the rest of it. */
export function openDocument(
  def: StateFileDef,
  label: string,
  decoded: unknown,
): Result<Record<string, unknown>, StateDamage> {
  if (!isRecord(decoded)) return err(damageOf(label, 'no_format'));
  const { format, ...rest } = decoded;
  if (typeof format !== 'number' || !Number.isInteger(format)) return err(damageOf(label, 'no_format'));
  if (format < def.format)
    return err(damageOf(label, 'lower_format', `format ${format}; this release reads ${def.format}`));
  if (format > def.format) return err(damageOf(label, 'higher_format', String(format)));
  return ok(rest);
}

/** The schema's reading of a document body, or the damage that says why it was refused. */
export function shapeOf<Shape>(
  def: StateFileDef<string, Shape>,
  label: string,
  body: Record<string, unknown>,
): Result<Shape, StateDamage> {
  if (def.schema === undefined) return ok(body as Shape);
  const bare = def.schema.safeParse(body);
  if (bare.success) return ok(bare.data);
  const stamped = def.schema.safeParse({ format: def.format, ...body });
  if (stamped.success) return ok(stamped.data);
  const first = bare.error.issues[0];
  const where = first === undefined || first.path.length === 0 ? '' : `${first.path.join('.')}: `;
  return err(damageOf(label, 'schema', `${where}${first?.message ?? 'invalid'}`));
}

/** Decode one JSON document's text: parse, then format, then schema. */
export function decodeJson<Shape>(
  def: StateFileDef<string, Shape>,
  label: string,
  text: string,
): Result<Shape, StateDamage> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    return err(damageOf(label, 'unparsable', describeFault(error)));
  }
  const opened = openDocument(def, label, decoded);
  return opened.ok ? shapeOf(def, label, opened.value) : opened;
}

/** The document text a write lands: `"format"` first, then the value's own keys, one record per line for JSONL. */
export function encodeDocument(def: StateFileDef, value: unknown, pretty: boolean): string {
  if (!isRecord(value)) throw new TypeError(`state ${def.name}: a JSON document is an object (it carries "format")`);
  if (def.schema !== undefined) {
    const { format: _own, ...bare } = value;
    if (!def.schema.safeParse(bare).success && !def.schema.safeParse({ format: def.format, ...bare }).success)
      throw new TypeError(`state ${def.name}: the value does not satisfy its schema`);
  }
  const { format: _dropped, ...rest } = value;
  return JSON.stringify({ format: def.format, ...rest }, null, pretty ? 2 : undefined);
}
