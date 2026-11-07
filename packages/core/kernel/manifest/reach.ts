import type { Needer } from './types.ts';

/** `'*'` in `permissions.spawn` / `network`: any program or host. A core piece's alone: `effectivePermissions` drops it from any other manifest. */
export const WILDCARD = '*';

/** The last path segment of a program (`/usr/bin/tmux` → `tmux`). */
export const programName = (program: string): string => program.slice(program.lastIndexOf('/') + 1);

/** `*.example.com` matches subdomains only; an exact host matches itself. */
export function hostAllowed(host: string, declared: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return declared.some(entry => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('*.')
      ? lower.endsWith(pattern.slice(1)) && lower !== pattern.slice(2)
      : lower === pattern;
  });
}

/**
 * Whether a program is among `named` program names (no installed items): a declared name matches the program or its
 * basename, a declared path only that exact path, and `'*'` anything. The kernel's own spawn check reads the same rule.
 */
export function programAmong(named: readonly string[], program: string): boolean {
  if (named.includes(WILDCARD)) return true;
  const exact = new Set(named.filter(entry => entry.includes('/')));
  const allowed = new Set(named.filter(entry => !entry.includes('/')));
  return exact.has(program) || allowed.has(program) || allowed.has(programName(program));
}

const strings = (entries: readonly unknown[] | undefined): readonly string[] =>
  (entries ?? []).filter((entry): entry is string => typeof entry === 'string');

/**
 * What a provider that acts for a caller narrows to (§3.7). Only literal entries count: an `{ items }` or resolver
 * entry names hosts and programs the kernel reads at the call, which a provider cannot see, so it grants nothing here
 * (fail closed). A needer's `'*'` was already dropped unless it is a core piece.
 */
export const neederMayRun = (needer: Needer, program: string): boolean =>
  programAmong(strings(needer.permissions.spawn), program);

/** Whether the needer's literal `network` entries allow `hostname` (no port). */
export const neederMayReach = (needer: Needer, hostname: string): boolean => {
  const named = strings(needer.permissions.network);
  return named.includes(WILDCARD) || hostAllowed(hostname, named);
};
