/**
 * The launch flags of a v4 settings component, sorted into what becomes a settings key and what is carried as it is.
 *
 * A v5 settings item holds ANY launch flag in its `flags` list (owner decision !A525), so nothing is held for being a flag.
 * Two families still have an exact, better v5 form: Codex `-c key=value` / `--config key=value` is a config override (a
 * key of the item's `settings` table) and Claude `--disallowedTools X` is `settings.permissions.deny`. The flags v4's own
 * fixed layer discarded (`SUPERSEDED_FLAGS`: the permission, sandbox and approval switches) never reached a v4 ferret, so
 * they are named as left out and never carried (carrying one would LOOSEN). EVERY other flag word is carried verbatim, in
 * order, and named by NAME only in a report.
 */

export interface FlagOutcome {
  /** Claude tool patterns to add to `settings.permissions.deny`. */
  readonly deny: readonly string[];
  /** Codex config overrides: dotted key to its value. */
  readonly config: readonly (readonly [string, unknown])[];
  /** Flags v4 itself discarded (names only). */
  readonly superseded: readonly string[];
  /** The words of every other flag, verbatim and in order: the item's `flags`. */
  readonly carried: readonly string[];
  /** The names of the carried flags (never a value), for a report. */
  readonly carriedNames: readonly string[];
  /** Whether a flag was not text, so it has no word to carry. */
  readonly notText: boolean;
}

type Shape = 'bare' | 'value';
const CLAUDE_SUPERSEDED: Readonly<Record<string, Shape>> = {
  '--permission-mode': 'value',
  '--dangerously-skip-permissions': 'bare',
  '--allow-dangerously-skip-permissions': 'bare',
  '--append-system-prompt': 'value',
};
const CODEX_SUPERSEDED: Readonly<Record<string, Shape>> = {
  '--dangerously-bypass-approvals-and-sandbox': 'bare',
  '--full-auto': 'bare',
  '--ask-for-approval': 'value',
  '-a': 'value',
  '--sandbox': 'value',
  '-s': 'value',
};
/** A Codex `-c` key v4's fixed layer decides itself (`CODEX_FIXED_CONFIG_KEYS`): v4 discarded the flag. */
const isFixedCodexKey = (key: string): boolean =>
  key === 'approval_policy' ||
  key === 'sandbox_mode' ||
  key === 'developer_instructions' ||
  key === 'mcp_servers.ferretry' ||
  key.startsWith('mcp_servers.ferretry.');

const UNSAFE_KEY_PART = new Set(['__proto__', 'constructor', 'prototype']);

/** Claude tool patterns, split on commas and spaces outside parentheses (`Bash(git commit:*) Edit`). */
function splitPatterns(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || /\s/u.test(char))) {
      if (current !== '') out.push(current);
      current = '';
    } else current += char;
  }
  if (current !== '') out.push(current);
  return out;
}

/** A Codex `-c` value is TOML; text that is not valid TOML is a plain string (as Codex reads it). */
function configValue(raw: string): unknown {
  try {
    return (Bun.TOML.parse(`v = ${raw}`) as { v: unknown }).v;
  } catch {
    return raw;
  }
}

export function carryFlags(harness: 'claude-code' | 'codex', flags: readonly unknown[]): FlagOutcome {
  const deny: string[] = [];
  const config: [string, unknown][] = [];
  const superseded: string[] = [];
  const carried: string[] = [];
  const carriedNames: string[] = [];
  const text = flags.filter((flag): flag is string => typeof flag === 'string');
  const notText = text.length !== flags.length;
  const table = harness === 'codex' ? CODEX_SUPERSEDED : CLAUDE_SUPERSEDED;
  const isFlag = (token: string | undefined): boolean => token?.startsWith('-') === true;
  for (let index = 0; index < text.length; index++) {
    const token = text[index] as string;
    // A flag NAME is all a report may carry: `--flag=VALUE` splits at `=`; a short flag with a value attached
    // (`-cKEY=VALUE`, `-k=VALUE`) is its first two characters and the rest is the value.
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const shortWithValue = !token.startsWith('--') && token.startsWith('-') && token.length > 2;
    const name = equals > 0 ? token.slice(0, equals) : shortWithValue ? token.slice(0, 2) : token;
    const inline =
      equals > 0 ? token.slice(equals + 1) : shortWithValue ? token.slice(2).replace(/^=/u, '') : undefined;
    if (harness === 'claude-code' && (name === '--disallowedTools' || name === '--disallowed-tools')) {
      const values: string[] = inline === undefined ? [] : [inline];
      if (inline === undefined)
        while (index + 1 < text.length && !isFlag(text[index + 1])) values.push(text[++index] as string);
      const patterns = values.flatMap(splitPatterns);
      if (patterns.length === 0) {
        // No pattern to hold as a setting: the flag is carried as it was written.
        carried.push(token, ...(inline === undefined ? values : []));
        carriedNames.push(name);
      } else deny.push(...patterns);
      continue;
    }
    if (harness === 'codex' && (name === '-c' || name === '--config')) {
      const assignment = inline ?? text[index + 1];
      if (inline === undefined) index++;
      const split = assignment?.indexOf('=') ?? -1;
      const key = assignment === undefined || split < 1 ? '' : assignment.slice(0, split).trim();
      const parts = key.split('.');
      if (isFixedCodexKey(key)) {
        superseded.push(`${name} ${key}`);
        continue;
      }
      if (
        key === '' ||
        parts.some(part => part === '' || UNSAFE_KEY_PART.has(part)) ||
        key.startsWith('mcp_servers.')
      ) {
        // No settings key to hold it under (an empty or unsafe key, an MCP server table): carried as it was written.
        carried.push(token, ...(inline === undefined && assignment !== undefined ? [assignment] : []));
        carriedNames.push(key === '' ? name : `${name} ${key}`);
        continue;
      }
      config.push([key, configValue((assignment as string).slice(split + 1).trim())]);
      continue;
    }
    const shape = table[name];
    if (shape !== undefined) {
      superseded.push(name);
      if (shape === 'value' && inline === undefined && !isFlag(text[index + 1])) index++;
      continue;
    }
    carried.push(token);
    if (!token.startsWith('-')) continue; // the stray value of a flag already named: carried, never named
    carriedNames.push(name);
    // An unknown flag's value is never named (it may be a secret, and may start with `-`). A next token is a real
    // flag only when it is `--name` or a bare `-x`; a longer single-dash token (`-VALUE`, `-cKEY=VALUE`) is taken as
    // the value; a plain next token is the value. Either way it is carried as it was written, right after its flag.
    const following = inline === undefined ? text[index + 1] : undefined;
    if (following !== undefined) {
      const clearFlag = following.startsWith('--') || (following.startsWith('-') && following.length === 2);
      if (!clearFlag) {
        carried.push(following);
        index++;
      }
    }
  }
  return { deny, config, superseded, carried, carriedNames, notText };
}
