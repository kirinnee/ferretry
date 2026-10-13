/**
 * Signs a built release: an Ed25519 signature over the EXACT bytes of `release-manifest.json`,
 * written to `release-manifest.sig`. Called only by `scripts/ci/sign-pwa-release.sh`, which owns the
 * private key's file and removes it.
 *
 *   bun run scripts/sign-release.ts <pkcs8-pem-file> [distDirectory] [--public-key <pem>]
 *
 * It refuses to sign with a key whose public half is not the committed
 * `packages/pwa/release-signing-key.pub`: every new install pins that file, so a release signed by
 * any other key would be refused by everyone who installs it. It never prints key material.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ED25519_SPKI_PREFIX,
  RELEASE_MANIFEST_FILE,
  RELEASE_SIGNATURE_FILE,
  formatReleaseSignature,
  fromBase64Url,
  releaseKeyFromPem,
  toBase64Url,
} from '../src/lib/release-manifest.ts';
import { firstUseTrust, sha256Base64Url, verifyReleaseManifest } from '../src/lib/release-verification.ts';
import { COMMITTED_RELEASE_KEY, flagValue, positionals } from './build-release.ts';

const packageRoot = resolve(import.meta.dir, '..');
const fail = (message: string): never => {
  throw new Error(`❌ ${message}`);
};

const pemBody = (pem: string, label: string): Uint8Array<ArrayBuffer> => {
  const match = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`, 'u').exec(pem);
  if (match === null) fail(`the signing key is not a PKCS#8 "${label}" PEM block`);
  return Uint8Array.from(atob((match?.[1] ?? '').replace(/\s+/gu, '')), character =>
    character.charCodeAt(0),
  ) as Uint8Array<ArrayBuffer>;
};

export const signRelease = async (
  keyFile: string,
  distDirectory: string,
  publicKeyFile = COMMITTED_RELEASE_KEY,
): Promise<void> => {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(await readFile(keyFile, 'utf8'), 'PRIVATE KEY'),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  // An Ed25519 JWK carries the public half as `x`, so the key's own public key comes from the key.
  const { x } = await crypto.subtle.exportKey('jwk', privateKey);
  const raw = fromBase64Url(x ?? '');
  if (raw === null) fail('the signing key has no public half');
  const spki = Uint8Array.from([...ED25519_SPKI_PREFIX, ...(raw ?? [])]);
  const committed = releaseKeyFromPem(await readFile(publicKeyFile, 'utf8'));
  if (toBase64Url(spki) !== committed) fail(`the signing key is not the key in ${publicKeyFile}`);

  const manifestBytes = new Uint8Array(await readFile(join(distDirectory, RELEASE_MANIFEST_FILE)));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, manifestBytes));
  const signatureText = formatReleaseSignature(await sha256Base64Url(spki), signature);

  // Prove it with the same verifier the service worker runs, before anything is published.
  const decision = await verifyReleaseManifest({ manifestBytes, signatureText }, firstUseTrust(toBase64Url(spki)), {
    allowUnsigned: false,
  });
  if (!decision.accepted) fail('the signed release does not verify');
  await writeFile(join(distDirectory, RELEASE_SIGNATURE_FILE), signatureText, 'utf8');
  console.log('✅ release signed');
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [keyFile, distDirectory] = positionals(args);
  if (keyFile === undefined) fail('usage: sign-release.ts <pkcs8-pem-file> [distDirectory] [--public-key <pem>]');
  await signRelease(
    resolve(keyFile ?? ''),
    resolve(distDirectory ?? join(packageRoot, 'dist')),
    resolve(flagValue(args, '--public-key', COMMITTED_RELEASE_KEY)),
  );
}
