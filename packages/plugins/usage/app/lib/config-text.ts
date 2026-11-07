/**
 * A configuration file's TEXT, edited one top-level key at a time so the owner's comments and key order survive
 * byte for byte. Copied from the config service's `yaml-text.ts` (only `readConfigText`'s value and `setConfigKey`):
 * the budget editor writes `usage.yaml` from the browser, and the service's module is host code.
 *
 * Pure: text in, text out.
 */
import { type Document, isMap, parseDocument } from 'yaml';

/** Read with YAML 1.2's core schema: `off` and `no` are strings, not booleans, wherever they are read. */
const PARSE_OPTIONS = { version: '1.2', uniqueKeys: true, prettyErrors: false } as const;

/** The plain value of a file, or `null` when it does not parse. An empty file is an empty mapping. */
export function readConfigValue(text: string): unknown {
  const document = parseDocument(text, PARSE_OPTIONS);
  if (document.errors.length > 0) return null;
  return document.toJS() ?? {};
}

/**
 * The text of a file with ONE top-level key set to `value`, or removed when `value` is `undefined` —
 * every other key, and every comment, exactly as it was. Throws when the text does not parse or is not a
 * mapping: a file nobody can read is fixed by a person, not overwritten by a verb.
 */
export function setConfigKey(text: string, key: string, value: unknown): string {
  const document: Document = parseDocument(text, PARSE_OPTIONS);
  if (document.errors.length > 0) throw new Error(`the file does not parse: ${document.errors[0]?.message ?? ''}`);
  if (document.contents === null) document.contents = document.createNode({});
  if (!isMap(document.contents)) throw new Error('the file is not a mapping of keys');
  if (value === undefined) document.delete(key);
  else document.set(key, document.createNode(value));
  return document.toString({ lineWidth: 0 });
}
