/** The relay's link-store dispatch vocabulary, copied from today's relay/link-store; no link state lives here. */
import { z } from 'zod';
export const LINK_STORE_VERSION = 1 as const;
export const LINK_STORE_SERVICE_PATH = '/v1/link-store';
export const LINK_STORE_CHALLENGE_PATH = '/v1/link-store/challenge';
export const LINK_STORE_STATUS_PATH = '/v1/link-store/status';
export const LINK_STORE_OPERATOR_PATH = '/v1/operator/link-store';
export const linkBundlePath = (id: string): string => `/v1/links/${id}`;
export const linkPeekPath = (id: string): string => `/v1/links/${id}/peek`;
export const linkFetchPath = (id: string): string => `/v1/links/${id}/fetch`;
export const LINK_ENVELOPE_MAX_BYTES = 3 * 1024 * 1024;
export const DEFAULT_LINK_STORE_LIMITS = { perDaemon: { liveLinks: 50 } };
export const LinkStoreAdvertisementSchema = z.strictObject({
  version: z.literal(LINK_STORE_VERSION),
  available: z.boolean(),
  maxEnvelopeBytes: z.number().int().min(1),
  maxLiveLinks: z.number().int().min(1),
});
export const linkStoreRefusalBody = (_code: 'link_store_unavailable'): string =>
  JSON.stringify({
    error: {
      code: 'link_store_unavailable',
      message: 'This link store is not taking requests right now. Try again later.',
    },
  });
