import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_LINK_STORE_LIMITS,
  LINK_ENVELOPE_MAX_BYTES,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_OPERATOR_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  LinkStoreAdvertisementSchema,
  linkBundlePath,
  linkFetchPath,
  linkPeekPath,
  linkStoreRefusalBody,
} from '../../../worker/src/lib/link-store-forwarding.ts';

describe('the link-store forwarding vocabulary', () => {
  it('names the store paths and the per-link paths', () => {
    expect(LINK_STORE_SERVICE_PATH).toBe('/v1/link-store');
    expect(LINK_STORE_CHALLENGE_PATH).toBe('/v1/link-store/challenge');
    expect(LINK_STORE_STATUS_PATH).toBe('/v1/link-store/status');
    expect(LINK_STORE_OPERATOR_PATH).toBe('/v1/operator/link-store');
    expect(linkBundlePath('abc')).toBe('/v1/links/abc');
    expect(linkPeekPath('abc')).toBe('/v1/links/abc/peek');
    expect(linkFetchPath('abc')).toBe('/v1/links/abc/fetch');
    expect(LINK_ENVELOPE_MAX_BYTES).toBe(3 * 1024 * 1024);
    expect(DEFAULT_LINK_STORE_LIMITS).toEqual({ perDaemon: { liveLinks: 50 } });
  });

  it('reads an advertisement of the store, and refuses an extra key', () => {
    const advertisement = { version: 1 as const, available: true, maxEnvelopeBytes: 100, maxLiveLinks: 5 };
    expect(LinkStoreAdvertisementSchema.parse(advertisement)).toEqual(advertisement);
    expect(LinkStoreAdvertisementSchema.safeParse({ ...advertisement, more: 1 }).success).toBe(false);
  });

  it('spells the one refusal a daemon is told when the store is not taking requests', () => {
    expect(JSON.parse(linkStoreRefusalBody('link_store_unavailable'))).toEqual({
      error: {
        code: 'link_store_unavailable',
        message: 'This link store is not taking requests right now. Try again later.',
      },
    });
  });
});
