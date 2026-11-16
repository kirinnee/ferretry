import { randomBytes, randomInt } from 'node:crypto';
import type { PairingCryptography } from '../../lib/pairing/index.ts';

// Keep this byte-for-byte aligned with `PairingCodeSchema`: U is excluded alongside 0, 1, I, L
// and O because it is commonly confused with V in terminal fonts.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const OPAQUE_ID_BYTES = 16;

type RandomBytes = (size: number) => Buffer;
type RandomInteger = (maximum: number) => number;

/** All pairing secrets and durable daemon identity material come from the platform CSPRNG. */
export class NodePairingCryptography implements PairingCryptography {
  constructor(
    private readonly random: RandomBytes = randomBytes,
    private readonly integer: RandomInteger = maximum => randomInt(maximum),
  ) {}

  pairingCode(): string {
    const symbols = Array.from({ length: 8 }, () => CODE_ALPHABET.charAt(this.integer(CODE_ALPHABET.length)));
    return `${symbols.slice(0, 4).join('')}-${symbols.slice(4).join('')}`;
  }

  pairingId(): string {
    return `fy_pair_${this.random(OPAQUE_ID_BYTES).toString('base64url')}`;
  }

  deviceId(): string {
    return `fy_device_id_${this.random(OPAQUE_ID_BYTES).toString('base64url')}`;
  }
}
