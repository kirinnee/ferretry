import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomInt,
} from 'node:crypto';
import type { PairingCryptography } from '../../lib/pairing/index.ts';

// Keep this byte-for-byte aligned with `PairingCodeSchema`: U is excluded alongside 0, 1, I, L
// and O because it is commonly confused with V in terminal fonts.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEVICE_TOKEN_BYTES = 32;
const OPAQUE_ID_BYTES = 16;
const DEVICE_HASH_DOMAIN = 'ferretry-device-token-v1';

export interface PairingIdentityMaterial {
  readonly privateKeyPem: string;
  readonly daemonId: string;
}

type RandomBytes = (size: number) => Buffer;
type RandomInteger = (maximum: number) => number;
type IdentityKeyPair = () => { readonly privateKey: KeyObject };

/** All pairing secrets and durable daemon identity material come from the platform CSPRNG. */
export class NodePairingCryptography implements PairingCryptography {
  constructor(
    private readonly random: RandomBytes = randomBytes,
    private readonly integer: RandomInteger = maximum => randomInt(maximum),
    private readonly keyPair: IdentityKeyPair = () => generateKeyPairSync('ed25519'),
  ) {}

  pairingCode(): string {
    const symbols = Array.from({ length: 8 }, () => CODE_ALPHABET.charAt(this.integer(CODE_ALPHABET.length)));
    return `${symbols.slice(0, 4).join('')}-${symbols.slice(4).join('')}`;
  }

  pairingId(): string {
    return `fy_pair_${this.random(OPAQUE_ID_BYTES).toString('base64url')}`;
  }

  deviceToken(): string {
    return `fy_device_${this.random(DEVICE_TOKEN_BYTES).toString('base64url')}`;
  }

  deviceId(): string {
    return `fy_device_id_${this.random(OPAQUE_ID_BYTES).toString('base64url')}`;
  }

  hashDeviceToken(daemonId: string, token: string): string {
    return createHash('sha256')
      .update(DEVICE_HASH_DOMAIN, 'utf8')
      .update('\0', 'utf8')
      .update(daemonId, 'utf8')
      .update('\0', 'utf8')
      .update(token, 'utf8')
      .digest('base64url');
  }

  newIdentity(): PairingIdentityMaterial {
    const { privateKey } = this.keyPair();
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    return { privateKeyPem, daemonId: daemonIdFromPrivateKey(privateKeyPem) };
  }

  identityFromPrivateKey(privateKeyPem: string): PairingIdentityMaterial {
    return { privateKeyPem, daemonId: daemonIdFromPrivateKey(privateKeyPem) };
  }
}

function daemonIdFromPrivateKey(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return `fy_daemon_${createHash('sha256').update(publicKey).digest('base64url')}`;
}
