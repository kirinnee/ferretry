/** OpenPGP private packets exist only in daemon memory and the sealed vault. GnuPG sees PUBLIC packets only. */
import { createMessage, generateKey, readKeys, reformatKey, sign, SignaturePacket, type PrivateKey } from 'openpgp';
import { ApiError } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES } from '../../../contract/index.ts';

export interface GpgMaterial {
  readonly fingerprint: string;
  readonly secretKey: string;
  readonly publicKey: string;
}

export interface GpgIdentity {
  readonly name: string;
  readonly email: string;
}

const refused = () =>
  new ApiError(400, 'give one usable OpenPGP signing key without a passphrase', GIT_ACCOUNT_CODES.invalidRequest);

export async function privateKeyOf(armoredKeys: string): Promise<PrivateKey> {
  try {
    // unarmor consumes only the first block. Require the whole submission, then count ALL transferable keys.
    if (
      !/^\s*-----BEGIN PGP PRIVATE KEY BLOCK-----\r?\n(?:(?!-----BEGIN|-----END)[\s\S])*-----END PGP PRIVATE KEY BLOCK-----\s*$/u.test(
        armoredKeys,
      )
    )
      throw refused();
    const keys = await readKeys({ armoredKeys });
    const key = keys[0];
    if (keys.length !== 1 || key === undefined || !key.isPrivate() || !key.isDecrypted() || key.keyPacket.version !== 4)
      throw refused();
    await key.getSigningKey();
    return key;
  } catch {
    throw refused();
  }
}

function materialOf(key: PrivateKey): GpgMaterial {
  return { fingerprint: key.getFingerprint().toUpperCase(), secretKey: key.armor(), publicKey: key.toPublic().armor() };
}

export async function makeGpg(identity: GpgIdentity): Promise<GpgMaterial> {
  const { privateKey } = await generateKey({
    // The pinned library's default ECC curve makes a v4 Ed25519 signing primary (no encryption subkeys).
    type: 'ecc',
    userIDs: [identity],
    subkeys: [],
    format: 'object',
  });
  return materialOf(privateKey);
}

export async function receiveGpg(secret: string, identity: GpgIdentity): Promise<GpgMaterial> {
  try {
    let key = await privateKeyOf(secret);
    if (!key.users.some(user => user.userID?.email.toLowerCase() === identity.email.toLowerCase())) {
      const userIDs = key.users.flatMap(user =>
        user.userID === null
          ? []
          : [
              {
                name: user.userID.name,
                email: user.userID.email,
                comment: user.userID.comment,
              },
            ],
      );
      key = (await reformatKey({ privateKey: key, userIDs: [...userIDs, identity], format: 'object' })).privateKey;
    }
    // Prove this key can sign before anything is stored or registered.
    await signGpg(key, new TextEncoder().encode('proof\n'));
    return materialOf(key);
  } catch {
    throw refused();
  }
}

/** Binary payload: OpenPGP text canonicalisation would change Git's commit bytes. */
export async function signGpg(key: PrivateKey, payload: Uint8Array): Promise<string> {
  const signature = await sign({
    message: await createMessage({ binary: payload }),
    signingKeys: key,
    detached: true,
    format: 'object',
  });
  const packet = signature.packets[0];
  if (!(packet instanceof SignaturePacket) || packet.created === null) throw new Error('OpenPGP returned no signature');
  const signingKey = await key.getSigningKey(packet.issuerKeyID);
  const status = `[GNUPG:] SIG_CREATED D ${packet.publicKeyAlgorithm} ${packet.hashAlgorithm} 00 ${Math.floor(packet.created.getTime() / 1000)} ${signingKey.getFingerprint().toUpperCase()}`;
  return `${status}\n${signature.armor()}`;
}
