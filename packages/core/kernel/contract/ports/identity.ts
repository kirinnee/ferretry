/**
 * The daemon's identity as any plugin may read it (§2.2): the id the pairing QR and the rendezvous path carry, and
 * the daemon's display name (the owner's, else the normalised hostname). The key is never reachable from here.
 */
export interface IdentityPort {
  /** `fy_daemon_` + base64url SHA-256 of the identity's SPKI (R41). */
  readonly daemonId: string;
  /**
   * What this machine is called, read at every use: the owner's name from `config/host.yaml` when there is one, else
   * the host name with control and format characters removed, trimmed, at most 100 characters. It can change while the
   * daemon runs, so a plugin reads it where it needs it and never holds it.
   */
  readonly daemonName: string;
  /**
   * The product's binary names, single-sourced from the `bin` keys of `packages/cli/package.json` and this package:
   * the client the owner types (`fy`) and the daemon (`fyd`). Plugins name them in sentences and requests from here,
   * never as a literal.
   */
  readonly binaries: BinaryNames;
}

/** The names of the two programs the product ships. */
export interface BinaryNames {
  readonly client: string;
  readonly daemon: string;
}
