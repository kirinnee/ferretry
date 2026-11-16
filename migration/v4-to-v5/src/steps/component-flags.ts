/**
 * The launch flags of a v4 settings component, sorted into what v5 can hold and what it cannot.
 *
 * v5 settings items hold no launch flags (`SettingsItemSchema` is `{ description?, settings }`), but two flag families
 * have an exact v5 form: Codex `-c key=value` / `--config key=value` is a config override (a key of the item's `settings`
 * table) and Claude `--disallowedTools X` is `settings.permissions.deny`. The flags v4's own fixed layer discarded
 * (`SUPERSEDED_FLAGS`: the permission, sandbox and approval switches) never reached a v4 ferret, so they are named as
 * left out and never carried (carrying one would LOOSEN). Every other flag is not carried, and is named by NAME only.
 */

export interface FlagOutcome {
  /** Claude tool patterns to add to `settings.permissions.deny`. */
  readonly deny: readonly string[];
  /** Codex config overrides: dotted key to its value. */
  readonly config: readonly (readonly [string, unknown])[];
  /** Flags v4 itself discarded (names only). */
  readonly superseded: readonly string[];
  /** Flags with no v5 form (names only, never a value). */
  readonly uncarried: readonly string[];
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
  const uncarried: string[] = [];
  const text = flags.filter((flag): flag is string => typeof flag === 'string');
  if (text.length !== flags.length) uncarried.push('(a flag that is not text)');
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
      if (patterns.length === 0) uncarried.push(name);
      else deny.push(...patterns);
      continue;
    }
    if (harness === 'codex' && (name === '-c' || name === '--config')) {
      const assignment = inline ?? text[index + 1];
      if (inline === undefined) index++;
      const split = assignment?.indexOf('=') ?? -1;
      const key = assignment === undefined || split < 1 ? '' : assignment.slice(0, split).trim();
      const parts = key.split('.');
      if (key === '' || parts.some(part => part === '' || UNSAFE_KEY_PART.has(part))) {
        uncarried.push(name);
        continue;
      }
      if (isFixedCodexKey(key)) superseded.push(`${name} ${key}`);
      else if (key.startsWith('mcp_servers.')) uncarried.push(`${name} ${key}`);
      else config.push([key, configValue((assignment as string).slice(split + 1).trim())]);
      continue;
    }
    const shape = table[name];
    if (shape !== undefined) {
      superseded.push(name);
      if (shape === 'value' && inline === undefined && !isFlag(text[index + 1])) index++;
      continue;
    }
    if (!token.startsWith('-')) continue; // the stray value of a flag already named
    uncarried.push(name);
    // An unknown flag's value is never named (it may be a secret, and may start with `-`). A next token is a real
    // flag only when it is `--name` or a bare `-x`; a longer single-dash token (`-VALUE`, `-cKEY=VALUE`) is taken as
    // the value (a placeholder says so, the token is never echoed); a plain next token is the value.
    const following = inline === undefined ? text[index + 1] : undefined;
    if (following !== undefined) {
      const clearFlag = following.startsWith('--') || (following.startsWith('-') && following.length === 2);
      if (!clearFlag) {
        if (following.startsWith('-')) uncarried.push('(a flag value that starts with -)');
        index++;
      }
    }
  }
  return { deny, config, superseded, uncarried };
}
