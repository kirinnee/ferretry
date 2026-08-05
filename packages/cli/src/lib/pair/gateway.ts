import {
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  PairingCodeStatusResponseSchema,
  type PairingCodeStatusResponse,
  type PairingId,
} from '@ferretry/protocol';
import type { IPairGateway, PairingApiClient } from './ports.ts';

/**
 * Where codes are minted.
 *
 * Distinct from `/v1/pair`, which is where a DEVICE redeems one. The two are different privileges —
 * minting belongs to whoever is already on the host, redeeming to anybody holding a live code — and the
 * daemon enforces that difference. Minting is governed by the `pairing` capability rather than by the
 * `host` scope, which is what lets a browser on the machine add a device too: loopback is ungoverned,
 * and off the host the operator's grant decides. This command always runs on the host, so nothing here
 * ever meets that refusal.
 */
export const PAIRING_CODE_PATH = '/v1/pair/code';

/**
 * One minted code's fate, addressed by pairing id.
 *
 * The id and not the code, and that is why a mint answers with both: this path is a URL, and a URL
 * reaches the daemon's access log. A code in a log is a code that outlives its two minutes.
 */
export function pairingCodePath(pairingId: PairingId): string {
  return `${PAIRING_CODE_PATH}/${encodeURIComponent(pairingId)}`;
}

/**
 * Speaks the pairing routes through the protocol client.
 *
 * Both responses are parsed against a protocol schema before anything reads them, which is what makes a
 * daemon answering with an error envelope fail here — with a stated reason — rather than inside a
 * renderer building a QR out of `undefined`. The mint schema also re-checks that `pairUrl` carries the
 * daemon, code and fingerprint it was minted with, so the CLI never draws a link the daemon assembled
 * from mismatched parts.
 */
export class ProtocolPairingGateway implements IPairGateway {
  constructor(private readonly client: PairingApiClient) {}

  /**
   * Minting is bodyless.
   *
   * The device names ITSELF when it redeems, so there is nothing for the host to send — and the request
   * schema is strict, so inventing a field here would be refused rather than ignored.
   */
  async mint(): Promise<PairingCodeMintResponse> {
    return await this.client.request(PAIRING_CODE_PATH, PairingCodeMintResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  }

  async status(pairingId: PairingId): Promise<PairingCodeStatusResponse> {
    return await this.client.request(pairingCodePath(pairingId), PairingCodeStatusResponseSchema);
  }
}
