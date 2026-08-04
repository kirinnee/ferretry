/**
 * The key the daemon signs its rendezvous claim with — which is the key it already had.
 *
 * THERE IS EXACTLY ONE DAEMON IDENTITY AND THIS IS NOT WHERE IT IS MINTED. Pairing creates a durable
 * Ed25519 key on the daemon's first boot and stores it as `<state>/daemon-identity.json`; its SHA-256
 * fingerprint IS the `daemonId` printed in the pairing QR, and that fingerprint is what a browser pins
 * before it will send a device token. A relay identity of its own would have a different fingerprint,
 * so every paired browser would compute a mismatch, refuse the handshake — correctly — and the person
 * would be left with a daemon that is up, a phone that will not connect, and nothing anywhere saying
 * why. So this module reads that document and never writes one.
 *
 * The refusals are result values rather than exceptions, deliberately. A daemon whose relay key cannot
 * be read must still serve every direct client it has; failing the boot would take away the carrier
 * that works to punish the absence of the one that does not. What it must never do is dial anyway —
 * the reason travels with the refusal so a surface can say it out loud.
 */

import type { DaemonIdentity } from '@ferretry/relay';
import { z } from 'zod';
import type { FileSystemPort } from '../ports.ts';

/** Owner-only. A signing key another account on this host can read is not an identity. */
export const DAEMON_IDENTITY_FILE_MODE = 0o600;

/** The document pairing writes. Read here, never written: one writer per file. */
const IdentityDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  privateKeyPem: z.string().min(1),
});

/** Turning stored key material into a usable signing identity, as the one operation that needs a
 *  platform. The private half never enters the domain: an adapter keeps it behind a key handle. */
export interface RelayIdentityKeys {
  load(privateKeyPem: string): Promise<DaemonIdentity>;
}

export type RelayIdentityResult =
  | { readonly ok: true; readonly identity: DaemonIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * Read this daemon's identity for signing a rendezvous claim.
 *
 * The mode is tightened whenever it cannot be proved tight — a careless `chmod`, a restore that forgot
 * modes, an archive unpacked under a permissive umask. Refusing instead would strand a daemon whose
 * key is perfectly good; trusting instead would leave the fingerprint every paired device pins
 * forgeable by anybody with a shell on this host. An absent stat is the case FOR tightening, not
 * evidence that tightening is unnecessary.
 */
export async function readDaemonRelayIdentity(
  fileSystem: FileSystemPort,
  path: string,
  keys: RelayIdentityKeys,
): Promise<RelayIdentityResult> {
  const stored = await fileSystem.readText(path);
  if (stored === undefined) {
    return {
      ok: false,
      reason: `${path} does not exist yet, so this daemon has no identity to claim a rendezvous with`,
    };
  }
  const information = await fileSystem.information(path);
  if (information === undefined || (information.mode & 0o077) !== 0) {
    await fileSystem.setMode(path, DAEMON_IDENTITY_FILE_MODE);
  }
  const document = IdentityDocumentSchema.safeParse(parseJson(stored));
  if (!document.success) {
    return { ok: false, reason: `${path} is not a daemon identity document this daemon can read` };
  }
  try {
    return { ok: true, identity: await keys.load(document.data.privateKeyPem) };
  } catch (error) {
    return {
      ok: false,
      reason: `${path} does not hold a usable Ed25519 identity (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
