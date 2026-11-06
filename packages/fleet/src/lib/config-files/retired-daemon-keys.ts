/**
 * The keys `config/daemon.json` once took and no longer does, each with the one sentence that says what
 * to do about it.
 *
 * ONE OWNER, TWO READERS. The daemon refuses a document that holds one of these at boot, and `fy config
 * check` reports the same document without a daemon; both read this list, so the operator is told the
 * same remedy by whichever finds it first and the two can never disagree about which keys are retired.
 *
 * Pure. Only key NAMES are inspected, never values.
 */

import type { ConfigIssue } from '@ferretry/protocol';

/** The file these keys are written in, inside the config directory. */
export const DAEMON_DOCUMENT_FILE = 'daemon.json';

/** One retired key: where it was written and what to do about it. */
export interface RetiredDaemonKey {
  /** The key as an operator reads it: `attention`, `sessionWorkers.enabled`. */
  readonly key: string;
  /** Where the key sits in the document, from the top. */
  readonly path: readonly [string] | readonly [string, string];
  /** The whole sentence: what to do, and why the daemon no longer reads it. */
  readonly remedy: string;
}

export const RETIRED_DAEMON_KEYS: readonly RetiredDaemonKey[] = [
  {
    key: 'attention',
    path: ['attention'],
    remedy: 'rename `attention` to `agenda` in config/daemon.json (renamed in v4.116.0)',
  },
  {
    key: 'accountModel',
    path: ['accountModel'],
    remedy:
      'remove `accountModel` from config/daemon.json; it is no longer read (the account model is always on; retired in v3.38.0)',
  },
  {
    key: 'fleet',
    path: ['fleet'],
    remedy:
      'remove `fleet` from config/daemon.json; it is no longer read (starting the daemon never imports anything, so set the machine up from the app or `fy daemon setup`; retired in v3.39.0)',
  },
  {
    key: 'sessionWorkers.enabled',
    path: ['sessionWorkers', 'enabled'],
    remedy:
      'remove `enabled` from `sessionWorkers` in config/daemon.json; it is no longer read (every running session is observed on a worker thread; retired in v4.71.0)',
  },
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The retired keys a parsed `daemon.json` document holds, in list order. Anything that is not an object holds none. */
export function retiredDaemonKeysIn(document: unknown): readonly RetiredDaemonKey[] {
  if (!isRecord(document)) return [];
  return RETIRED_DAEMON_KEYS.filter(retired => {
    const [head, tail] = retired.path;
    if (!Object.hasOwn(document, head)) return false;
    if (tail === undefined) return true;
    const inner = document[head];
    return isRecord(inner) && Object.hasOwn(inner, tail);
  });
}

/** One sentence naming every retired key a document holds, or `undefined` when it holds none. */
export function retiredDaemonKeysSentence(document: unknown): string | undefined {
  const held = retiredDaemonKeysIn(document);
  if (held.length === 0) return undefined;
  return `config/daemon.json holds ${held.length === 1 ? 'a key' : 'keys'} this daemon no longer accepts: ${held.map(retired => `"${retired.key}" — ${retired.remedy}`).join('; ')}`;
}

/**
 * The same finding as `fy config check` reports it: one ERROR per retired key, because a daemon that
 * refuses to start over the key is not a warning. Names the key and carries the remedy; never a value.
 */
export function retiredDaemonKeyIssues(path: string, document: unknown): readonly ConfigIssue[] {
  return retiredDaemonKeysIn(document).map(retired => ({
    path,
    severity: 'error' as const,
    message: `"${retired.key}" is retired, and the daemon will not start while it is there`,
    fix: retired.remedy,
  }));
}
