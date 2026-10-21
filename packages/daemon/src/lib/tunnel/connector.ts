/**
 * `cloudflared`: WHERE IT IS, HOW IT IS STARTED, AND WHAT IT SAYS — `docs/relay-protocol.md` §15.
 *
 * `cloudflared` IS A DEPENDENCY, NOT A DOWNLOAD. The Nix package puts it on the daemon's path, the
 * Homebrew cask depends on the formula, and a standalone install needs it on `PATH` or at
 * `FY_CLOUDFLARED`. Ferretry never fetches a binary itself: an executable this daemon downloaded and
 * ran would be a supply chain the operator never chose. Without one the carrier is off, and the boot
 * and `fyd --check` say so with the remedy.
 *
 * THE CONNECTOR TOKEN NEVER APPEARS IN AN ARGUMENT. Argument vectors are world-readable in a process
 * list, so the token travels in the child's environment as `TUNNEL_TOKEN` — which `cloudflared tunnel
 * run` reads for exactly this reason — and {@link CLOUDFLARED_ARGUMENTS} is a constant with no slot a
 * token could be put into.
 */

/** The operator's explicit path to the binary. It wins over the search, and does not fall back. */
export const CLOUDFLARED_OVERRIDE_VARIABLE = 'FY_CLOUDFLARED';

/** The variable `cloudflared tunnel run` reads its connector token from. */
export const CONNECTOR_TOKEN_VARIABLE = 'TUNNEL_TOKEN';

/**
 * The whole argument vector, from §15: a remotely managed tunnel, run with the token from the
 * environment, over QUIC, and never replacing its own binary — an auto-update would swap the
 * executable the operator's package manager installed for one nobody chose.
 */
export const CLOUDFLARED_ARGUMENTS: readonly string[] = Object.freeze([
  'tunnel',
  '--no-autoupdate',
  'run',
  '--protocol',
  'quic',
]);

/** Where this daemon found `cloudflared`, or why it did not. */
export type CloudflaredLocation =
  | { readonly kind: 'found'; readonly path: string; readonly via: 'override' | 'path' }
  | { readonly kind: 'absent'; readonly reason: string };

/** Finds the binary. A port because asking the filesystem is not something a domain module does. */
export interface CloudflaredLocatorPort {
  locate(): CloudflaredLocation;
}

/** The sentence for a named override that names nothing runnable. It does NOT fall back to `PATH`. */
export function cloudflaredOverrideRefusal(path: string): CloudflaredLocation {
  return {
    kind: 'absent',
    reason: `${CLOUDFLARED_OVERRIDE_VARIABLE} names ${path}, which is not an executable file`,
  };
}

/** The sentence for a search that found nothing. */
export const CLOUDFLARED_NOT_ON_PATH: CloudflaredLocation = Object.freeze({
  kind: 'absent' as const,
  reason: 'cloudflared is not on this daemon’s PATH',
});

/**
 * The remedy, in one line: the consequence, then what to do. Ferretry never downloads it, and saying so
 * here stops a reader from waiting for a daemon to fetch something it never will.
 */
export function cloudflaredRemedy(reason: string): string {
  return (
    `${reason}, so this daemon has no tunnel carrier — install cloudflared (Homebrew: brew install ` +
    `cloudflared; Nix: the ferretry package carries it; otherwise your package manager) or set ` +
    `${CLOUDFLARED_OVERRIDE_VARIABLE} to its path, then restart. Ferretry never downloads it itself.`
  );
}

/**
 * The connector's environment ADDITIONS: the token, and nothing else. The process adapter merges this
 * over the daemon's own environment for that one child and never writes it anywhere.
 */
export function connectorEnvironment(token: string): Readonly<Record<string, string>> {
  return { [CONNECTOR_TOKEN_VARIABLE]: token };
}

/** What one line of `cloudflared`'s log says about its edge connections, when it says anything. */
export type ConnectorEvent =
  | { readonly kind: 'registered'; readonly connection: string }
  | { readonly kind: 'unregistered'; readonly connection: string };

const CONNECTION_INDEX = /\bconnIndex=(\d+)/u;

/**
 * Reads `Registered tunnel connection connIndex=0 …` and `Unregistered tunnel connection connIndex=0`.
 *
 * `cloudflared` holds up to four edge connections and logs each by its index, so registration is a SET
 * of indices rather than a flag: one connection dropping while three stay up is still a reachable
 * tunnel. A line with no index is counted as connection `0`, so a format change degrades to "one
 * connection" rather than to "never registered".
 */
export function connectorEvent(line: string): ConnectorEvent | undefined {
  const connection = CONNECTION_INDEX.exec(line)?.[1] ?? '0';
  if (line.includes('Unregistered tunnel connection')) return { kind: 'unregistered', connection };
  if (line.includes('Registered tunnel connection')) return { kind: 'registered', connection };
  return undefined;
}
