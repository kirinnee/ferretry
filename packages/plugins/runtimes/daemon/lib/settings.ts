/**
 * Layered harness settings — parse, deep-merge, serialize.
 *
 * A profile may declare settings as a stack: file references (a shared template) with inline
 * objects layered on top. Layering concatenates those stacks (see `./account/layering.ts`), so by the time
 * they reach here the ordering is already the contract: later layers win.
 *
 * Reading a referenced file is IO and therefore an adapter's job. This module takes the *contents*
 * and decides what the resulting file says. That split is what makes the merge rules testable
 * without a filesystem.
 */
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

/** The config formats the supported harnesses read. */
export type SettingsFormat = 'json' | 'toml';

export type SettingsObject = Readonly<Record<string, unknown>>;

const isPlainObject = (value: unknown): value is SettingsObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merge `overlay` onto `base`. Nested plain objects merge key by key; every other value — scalar,
 * array, null — is replaced wholesale. Arrays deliberately do not concatenate: a settings list
 * such as `permissions.allow` is a complete statement, and appending to it would make an override
 * unable to *remove* anything.
 */
export function deepMergeSettings(base: SettingsObject, overlay: SettingsObject): SettingsObject {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = merged[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(overlayValue)
        ? deepMergeSettings(baseValue, overlayValue)
        : overlayValue;
  }
  return merged;
}

/** Collapse a whole layer stack, left to right. An empty stack is an empty object. */
export function mergeSettingsLayers(layers: readonly SettingsObject[]): SettingsObject {
  return layers.reduce<SettingsObject>((merged, layer) => deepMergeSettings(merged, layer), {});
}

/** Raised when a settings layer is not a document the harness could have read. */
export class SettingsParseError extends Error {
  constructor(
    readonly format: SettingsFormat,
    readonly reason: string,
    /** Where a TOML document stopped (1-based), when the parser said: numbers only, never the line it quoted. */
    readonly line?: number,
    readonly column?: number,
  ) {
    super(`cannot parse ${format} settings: ${reason}`);
    this.name = 'SettingsParseError';
  }
}

/**
 * Parse one settings document. A document whose root is not a table is rejected: a bare array or
 * scalar cannot be merged with anything, and silently discarding it is how a settings layer goes
 * missing without a word.
 */
export function parseSettings(text: string, format: SettingsFormat): SettingsObject {
  let parsed: unknown;
  try {
    parsed = format === 'toml' ? parseToml(text) : JSON.parse(text);
  } catch (error) {
    const at = error as { codeblock?: unknown; line?: unknown; column?: unknown } | null;
    // Only smol-toml's own error says where in the DOCUMENT it stopped; a `SyntaxError` from `JSON.parse` has a `line` of the
    // engine's own source.
    const located = typeof at?.codeblock === 'string' && typeof at.line === 'number' && typeof at.column === 'number';
    throw new SettingsParseError(
      format,
      error instanceof Error ? error.message : String(error),
      ...(located ? [at.line as number, at.column as number] : []),
    );
  }
  if (!isPlainObject(parsed)) {
    throw new SettingsParseError(format, 'the document root must be an object');
  }
  return parsed;
}

/** Serialize merged settings, always with exactly one trailing newline. */
export function serializeSettings(settings: SettingsObject, format: SettingsFormat): string {
  const text = format === 'toml' ? stringifyToml(settings) : JSON.stringify(settings, null, 2);
  return text.endsWith('\n') ? text : `${text}\n`;
}
