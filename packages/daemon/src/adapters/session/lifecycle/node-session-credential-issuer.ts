import { createHash, randomBytes } from 'node:crypto';
import { SESSION_CREDENTIAL_PREFIX } from '../../../lib/api/authentication.ts';
import type { SessionCredential, SessionCredentialIssuer } from '../../../lib/session/lifecycle/index.ts';

/**
 * 256 bits, because this credential is the only thing distinguishing one session from another once
 * a board is mounted: the shared admin token authenticates the DAEMON's caller, and the session id
 * header is an attribution anyone holding that token can spoof.
 */
const CREDENTIAL_BYTES = 32;

/**
 * Base64url so the value survives an environment variable, a header and a JSON document unescaped, behind
 * the `fys_` prefix that lets the daemon tell a session credential from its shape alone when one arrives
 * as a bearer. The hash is of the whole value, prefix included.
 */
export class NodeSessionCredentialIssuer implements SessionCredentialIssuer {
  constructor(private readonly random: (size: number) => Buffer = randomBytes) {}

  issue(): SessionCredential {
    const capability = `${SESSION_CREDENTIAL_PREFIX}${this.random(CREDENTIAL_BYTES).toString('base64url')}`;
    return { capability, hash: createHash('sha256').update(capability, 'utf8').digest('hex') };
  }
}
