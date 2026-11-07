/**
 * The small slice of TOML Codex's `config.toml` needs when Ferretry generates it: tables of scalars, arrays and nested
 * records. Values are JSON; a nested record is written as an inline table, which TOML 1.0 allows anywhere a value goes.
 * A key that is not a bare word is quoted.
 */

const BARE_KEY = /^[A-Za-z0-9_-]+$/u;

const key = (name: string): string => (BARE_KEY.test(name) ? name : tomlString(name));

/** A TOML basic string. */
export function tomlString(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters must be escaped in a TOML string.
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/gu, character => {
    switch (character) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
  return `"${escaped}"`;
}

/** One JSON value as a TOML value. `null` has no TOML spelling and is left out by the caller. */
function value(input: unknown): string {
  if (typeof input === 'string') return tomlString(input);
  if (typeof input === 'number') return Number.isFinite(input) ? String(input) : '0';
  if (typeof input === 'boolean') return input ? 'true' : 'false';
  if (Array.isArray(input))
    return `[${input
      .filter(item => item !== null)
      .map(value)
      .join(', ')}]`;
  if (typeof input === 'object' && input !== null) {
    const entries = Object.entries(input).filter(([, item]) => item !== null && item !== undefined);
    return entries.length === 0
      ? '{}'
      : `{ ${entries.map(([name, item]) => `${key(name)} = ${value(item)}`).join(', ')} }`;
  }
  return '""';
}

/** `[mcp_servers.name]` tables from a record of records, one table per entry, in the order given. */
export function tomlTables(
  table: string,
  entries: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
  return Object.entries(entries)
    .map(([name, fields]) => {
      const lines = Object.entries(fields)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([field, item]) => `${key(field)} = ${value(item)}`);
      return [`[${table}.${key(name)}]`, ...lines].join('\n');
    })
    .join('\n\n');
}
