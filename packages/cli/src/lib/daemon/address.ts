import { FY_DEFAULT_DAEMON_URL, isLoopbackHost, recordedBindAddress } from '@ferretry/protocol';

/**
 * Whether a daemon URL names this machine, and may therefore use the locally minted credential.
 *
 * THIS DECIDES FROM THE URL, which sounds obvious and was the bug. The check used to test whether
 * `FY_URL` was SET at all, so pointing the client at its own daemon on a non-default port was
 * classified as remote and refused for want of `FY_TOKEN` — while the owner-only token file that is
 * exactly the right credential sat unread in the state home. The comment beside it already said
 * "targets a remote daemon"; only the code disagreed.
 *
 * WHAT COUNTS AS THIS MACHINE IS NOT DECIDED HERE. It used to be: a private copy of the predicate
 * read the whole of `127.0.0.0/8` and every `.localhost` name while the protocol's own read three
 * spellings, so one host was two facts at once — `127.0.0.2` was this machine to the token spent on
 * it and a stranger to the pairing advertisement, which handed a phone a QR code for an address that
 * resolves to the phone. The protocol owns the whole domain now and this asks it.
 *
 * A URL THAT WILL NOT PARSE IS NOT LOOPBACK. The consequence of guessing wrong in that direction is
 * an admin credential sent off this machine, so the unparseable case takes the refusal.
 */
export function isLocalDaemonUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Where this client should look for the daemon.
 *
 * THE ORDER IS THE POINT. An explicit `FY_URL` is an operator saying exactly where to look and wins
 * outright. Otherwise the daemon's own configuration document is asked, because a daemon may have
 * chosen its own port — assuming the well-known default is how a client ends up reporting a healthy
 * daemon unreachable, which is the failure this resolution exists to prevent. The default is the
 * last resort, for a machine where no daemon has ever written a document.
 *
 * IT ASKS FOR THE BIND, NOT THE ADVERTISEMENT. `publicUrl` says where somebody ELSE reaches this
 * machine, and a client that followed it dialled a routed address for a daemon sitting on the same
 * desk — which `isLocalDaemonUrl` then correctly refused to spend a local credential on, so the one
 * command that mints a pairing code stopped working the moment its operator took the advice printed
 * beside it. The two questions have two functions in the protocol now, and this one asks the local one.
 *
 * `documentText` is passed IN rather than read here so the decision is a pure function of what the
 * file said, including the case where there is no file at all.
 */
export function resolveDaemonUrl(explicitUrl: string, documentText: string | undefined): string {
  if (explicitUrl.trim() !== '') return explicitUrl.trim();
  return recordedAddress(documentText) ?? FY_DEFAULT_DAEMON_URL;
}

/** The address the daemon bound, or `undefined` when the document is absent or unusable. */
function recordedAddress(documentText: string | undefined): string | undefined {
  if (documentText === undefined) return undefined;
  try {
    return recordedBindAddress(JSON.parse(documentText));
  } catch {
    // A document this client cannot read leaves it looking at the well-known default, which fails
    // visibly as "the daemon is not answering". The daemon parses the same file strictly and refuses
    // to boot on damage; catching it twice would only make a client refuse to run at all.
    return undefined;
  }
}
