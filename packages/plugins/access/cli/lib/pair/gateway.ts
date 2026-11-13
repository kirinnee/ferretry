import {
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  type PairingCodeStatusResponse,
  PairingCodeStatusResponseSchema,
  type PairingGrantSet,
  type PairingId,
} from '../../../contract/index.ts';
import { callDaemon } from '../../shell.ts';
import type { IPairGateway, PairingApiClient } from './ports.ts';

/**
 * Where codes are minted.
 *
 * Redemption is not a route at all: a DEVICE redeems a code inside a sealed session whose daemon it has
 * already proved against the QR fingerprint. The two are different privileges — minting belongs to
 * whoever is already on the host, redeeming to anybody holding a live code — and the daemon enforces that
 * difference. Minting is governed by the `pairing` capability rather than by the
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

/** The route keys this gateway calls, exactly as `manifest.ts` declares them. */
export const PAIRING_ROUTES = {
  mint: 'POST /v1/pair/code',
  status: 'GET /v1/pair/code/:pairingId',
} as const;

/**
 * Speaks the pairing routes through the plugin client.
 *
 * Both responses are parsed against a contract schema before anything reads them, which is what makes a
 * daemon answering with an error envelope fail here — with a stated reason — rather than inside a
 * renderer building a QR out of `undefined`. The mint schema also re-checks that `pairUrl` carries the
 * daemon, code and fingerprint it was minted with, so the CLI never draws a link the daemon assembled
 * from mismatched parts.
 */
export class ProtocolPairingGateway implements IPairGateway {
  constructor(private readonly client: PairingApiClient) {}

  /**
   * The body names only what the device will hold, and only when that is not the default.
   *
   * The device names ITSELF when it redeems, so there is nothing else for the host to send — and the
   * request schema is strict, so inventing a field here would be refused rather than ignored. The
   * default sends `{}`.
   */
  async mint(grants: PairingGrantSet): Promise<PairingCodeMintResponse> {
    return PairingCodeMintResponseSchema.parse(
      await callDaemon(this.client, PAIRING_ROUTES.mint, { body: grants === 'full' ? {} : { grants } }),
    );
  }

  /** The pairing id travels as a path parameter (`pairingCodePath`'s shape); the code never does. */
  async status(pairingId: PairingId): Promise<PairingCodeStatusResponse> {
    return PairingCodeStatusResponseSchema.parse(
      await callDaemon(this.client, PAIRING_ROUTES.status, { params: { pairingId } }),
    );
  }
}
