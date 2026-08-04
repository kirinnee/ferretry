import { FY_DEFAULT_DAEMON_URL as FY_PROTOCOL_DEFAULT_DAEMON_URL } from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';

/**
 * Request headers that attribute a CLI call.
 *
 * The daemon splits `admin-cli` from `admin-ui` on the client header, and attributes an in-pane
 * caller to itself on the session header. The two names are duplicated here on purpose: the CLI may
 * import `@ferretry/protocol` and nothing else from the monorepo, and these constants do not live
 * in the protocol package yet. They belong there the moment that package's owner adds them.
 */
export const FY_CLIENT_HEADER = 'x-ferretry-client';
export const FY_SESSION_ID_HEADER = 'x-ferretry-session-id';
/** How this client identifies itself in `FY_CLIENT_HEADER`. */
export const FY_CLIENT_NAME = 'cli';

/**
 * Where `fyd` listens when the environment does not say otherwise.
 *
 * RE-EXPORTED from the protocol package rather than written out, because the daemon's own default
 * has to be the same number and the two packages may not import each other. A client that kept its
 * own copy of a moved default fails silently: it probes an address nothing holds and reports the
 * daemon down while it serves perfectly one port away.
 */
export const FY_DEFAULT_DAEMON_URL = FY_PROTOCOL_DEFAULT_DAEMON_URL;

export interface ConnectionInput {
  /** `FY_URL` — the daemon base URL; defaults to the local daemon. */
  readonly url?: string;
  /** `FY_TOKEN` — the daemon API token. */
  readonly token?: string;
  /** `FY_SESSION_ID` — set when the caller is itself running inside a session pane. */
  readonly sessionId?: string;
}

export interface DaemonConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Resolves where the daemon is and who is calling it.
 *
 * The CLI never reads the state home to find this out — §4 of the migration plan makes the HTTP API
 * the only seam — so the address and token arrive as environment values and a missing one is a
 * plain, actionable message rather than a connection refused.
 */
export function resolveConnection(input: ConnectionInput): DaemonConnection {
  const url = input.url?.trim() ?? '';
  const baseUrl = url === '' ? FY_DEFAULT_DAEMON_URL : url;
  const token = input.token?.trim() ?? '';
  if (token === '')
    throw new SessionCommandError('FY_TOKEN is not set — export the token fyd issued so the CLI can authenticate', 1);

  const sessionId = input.sessionId?.trim();
  return {
    baseUrl,
    token,
    headers: {
      [FY_CLIENT_HEADER]: FY_CLIENT_NAME,
      ...(sessionId === undefined || sessionId === '' ? {} : { [FY_SESSION_ID_HEADER]: sessionId }),
    },
  };
}
