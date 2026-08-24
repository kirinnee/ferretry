/**
 * Classifying one account home's credential, and digesting it so a REPLACEMENT can be detected.
 *
 * This is an adapter because it needs the secret. `lib/health.ts` decides verdicts from a state and
 * an opaque digest and can therefore be a pure module; somebody has to read the keychain item or the
 * `auth.json` first, and that is here.
 *
 * ## The digest, and why it is not a "hash of the token"
 *
 * `fingerprint` answers exactly one question — **did this credential change between two
 * observations?** — and it exists to stop a stale rejection landing on a fresh login: a `401` that
 * was in flight while somebody signed in again must not condemn the credential that replaced it.
 *
 * So it is a SHA-256 over the whole material, truncated, and it is compared only against another
 * fingerprint from this same function. Three properties are load-bearing:
 *
 * - **It is never persisted alongside anything that could invert it**, and nothing in the repository
 *   accepts it as an input other than an equality test.
 * - **It is over the whole blob, not a parsed token.** Parsing first would mean a credential whose
 *   shape this build cannot read produces no digest — precisely the case where a replacement is most
 *   likely — and it would also put a token in a local variable for no reason.
 * - **A read that found nothing has no fingerprint at all.** `absent` and `unreadable` produce
 *   `undefined` rather than a digest of the empty string, because "there is nothing here" and "there
 *   is something here whose bytes hash to X" must not compare equal.
 *
 * Truncated to 32 hex characters: 128 bits is far past any collision that matters for an equality
 * test against one previous value, and a shorter string is one less thing to mistake for a token in a
 * log line. It is still never logged.
 */
import type { FleetCredentialClassifier, LocalCredentialReading } from '../lib/health.ts';
import { classifyCredential, type CredentialMaterial } from '../lib/identity.ts';
import type { FleetManifestAccount, HarnessKind } from '../lib/manifest.ts';

/** Reading one home's raw credential. Satisfied structurally by the platform credential store. */
export interface CredentialMaterialReader {
  material(kind: HarnessKind, home: string): Promise<CredentialMaterial>;
}

export interface StoreCredentialClassifierDeps {
  readonly credentials: CredentialMaterialReader;
  readonly now: () => number;
}

/** Hex characters kept from the digest. See the note above on why it is truncated. */
export const CREDENTIAL_FINGERPRINT_LENGTH = 32;

/**
 * An opaque digest of credential material, for equality against another digest and nothing else.
 *
 * Exported so a test can assert the properties that matter — same bytes give the same value, different
 * bytes give a different one, and the material itself does not appear in the result — rather than
 * asserting one hard-coded constant, which would prove neither.
 */
export function credentialFingerprint(blob: string): string {
  return new Bun.CryptoHasher('sha256').update(blob).digest('hex').slice(0, CREDENTIAL_FINGERPRINT_LENGTH);
}

export class StoreCredentialClassifier implements FleetCredentialClassifier {
  constructor(private readonly deps: StoreCredentialClassifierDeps) {}

  async classify(account: FleetManifestAccount): Promise<LocalCredentialReading> {
    const material = await this.deps.credentials.material(account.kind, account.home);
    const reading = classifyCredential(account.kind, material, this.deps.now());
    return {
      state: reading.state,
      ...(reading.expiresAt === undefined ? {} : { expiresAt: reading.expiresAt }),
      // Only material that was actually found has a digest. See the note above.
      ...(material.outcome === 'found' ? { fingerprint: credentialFingerprint(material.blob) } : {}),
    };
  }
}
