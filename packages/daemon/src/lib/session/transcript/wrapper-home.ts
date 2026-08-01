/**
 * Where a fleet wrapper puts its harness's private home.
 *
 * A wrapper IS the declaration: `claude-auto-loge` is a shell script whose whole purpose is to
 * export `CLAUDE_CONFIG_DIR` and exec the harness, so the exported value is not a heuristic about
 * the account — it is the literal directory the launched process will write its transcript under.
 * Reading it is evidence; guessing it from the account name would not be.
 *
 * EVERY EXPANSION IS FAIL-CLOSED. A wrapper may write the home in terms of variables the daemon
 * does not hold, and a partially expanded path is worse than none: it is an absolute-looking string
 * that points at a directory nobody writes to, so a session would carry a transcript record naming
 * a file that never appears. An unresolvable reference therefore yields `undefined`, and the
 * session gets no transcript at all — which the caller can see and report.
 */

import type { Harness } from '@ferretry/protocol';

/** The variable each harness reads its private home from. */
const HOME_VARIABLE: Readonly<Record<Harness, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * `export NAME=value`, `export NAME="value"`, `NAME=value` — the three forms a generated wrapper
 * writes. An unquoted value stops at whitespace or a comment, so neither becomes part of the path.
 */
function assignedValue(source: string, variable: string): string | undefined {
  const pattern = new RegExp(
    String.raw`^[ \t]*(?:export[ \t]+)?${variable}=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'#]+))`,
    'mu',
  );
  const match = pattern.exec(source);
  if (match === null) return undefined;
  const value = match[1] ?? match[2] ?? match[3] ?? '';
  return value === '' ? undefined : value;
}

/** `$NAME` and `${NAME}` references, in the order they appear. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu;

/**
 * The value with every variable reference replaced by what the environment holds.
 *
 * `~` is expanded only in leading position, which is the only place a shell would have expanded it.
 */
function expand(value: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const home = environment.HOME ?? '';
  const tilde = value === '~' || value.startsWith('~/');
  // A `~` with no HOME behind it is the unresolvable case below, reached before the substitution
  // rather than after it.
  if (tilde && home === '') return undefined;
  let unresolved = false;
  const expanded = (tilde ? `${home}${value.slice(1)}` : value).replaceAll(
    REFERENCE,
    (_match, braced?: string, bare?: string) => {
      const resolved = environment[braced ?? bare ?? ''] ?? '';
      if (resolved === '') unresolved = true;
      return resolved;
    },
  );
  if (unresolved) return undefined;
  // A relative home would be resolved against whatever directory the harness started in, so it
  // names no durable location and is refused for the same reason an unresolved variable is.
  return expanded.startsWith('/') ? expanded : undefined;
}

/**
 * The harness home a wrapper script exports, or `undefined` when the script declares none this
 * daemon can resolve into an absolute path.
 */
export function harnessHomeFromWrapper(
  source: string,
  harness: Harness,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const declared = assignedValue(source, HOME_VARIABLE[harness]);
  return declared === undefined ? undefined : expand(declared, environment);
}

/** Reads the text of a launched wrapper. Absent when this host has no readable script there. */
export interface HarnessWrapperSource {
  read(executable: string): Promise<string | undefined>;
}
