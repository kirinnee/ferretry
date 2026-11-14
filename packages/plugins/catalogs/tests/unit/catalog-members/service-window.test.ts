import { describe, it } from 'bun:test';
import should from 'should';
import {
  catalogId,
  failure,
  HOUR,
  iso,
  MINUTE,
  rig,
  shareId,
  singleFor,
  storedShare,
  sharesDoc,
  T0,
} from './support.ts';

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * WHEN A SHARE INVITE WAS LIVE is the daemon's own fact (docs/pairing.md, "Never show it to an agent"): the QR and link a
 * share sheet shows are a credential, and the agent browser refuses what a page showed while one could be on it.
 */
describe('CatalogMemberService share window', () => {
  it('should be live from the mint and answer yes or no without any share code or id', async () => {
    const r = await rig();
    should(r.service.window.live()).be.false();
    should(r.service.window.liveSince(T0)).be.false();

    const minted = await r.service.mint(singleFor('Alice', [catalogId(1)]));

    should(r.service.window.live()).be.true();
    should(r.service.window.liveSince(T0)).be.true();
    should(JSON.stringify(r.service.window)).not.containEql(minted.code);
  });

  it('should keep the interval after the owner ENDS the share, and end it', async () => {
    const r = await rig();
    const minted = await r.service.mint(singleFor('Alice', [catalogId(1)]));
    r.clock.now = T0 + 5 * MINUTE;

    await r.service.endShare(minted.share.shareId);
    r.clock.now = T0 + 6 * MINUTE;

    should(r.service.window.live()).be.false();
    should(r.service.window.liveSince(T0 + 4 * MINUTE)).be.true();
    should(r.service.window.liveSince(T0 + 5 * MINUTE + 1)).be.false();
  });

  it("should end at the share's own deadline with nothing asking", async () => {
    const r = await rig();
    await r.service.mint(singleFor('Alice', [catalogId(1)]));
    r.clock.now = T0 + 2 * HOUR;

    should(r.service.window.live()).be.false();
    should(r.service.window.liveSince(T0 + HOUR - MINUTE)).be.true();
    should(r.service.window.liveSince(T0 + HOUR + 1)).be.false();
  });

  it('should be live for a share still live ON DISK at start (a page may have held its link since before)', async () => {
    const r = await rig({
      shares: sharesDoc(storedShare(1, { createdAt: iso(T0 - MINUTE), expiresAt: iso(T0 + HOUR) })),
    });

    should(r.service.window.live()).be.true();
    should(r.service.window.liveSince(T0 - HOUR)).be.true();
  });

  it('should answer YES to everything until the shares have been read', async () => {
    const r = await rig({ unloaded: true });

    should(r.service.window.live()).be.true();
    should(r.service.window.liveSince(T0)).be.true();
    await r.service.ready();
    should(r.service.window.live()).be.false();
  });

  describe('a write that can still roll back', () => {
    const live = () =>
      rig({ shares: sharesDoc(storedShare(1, { createdAt: iso(T0 - MINUTE), expiresAt: iso(T0 + HOUR) })) });

    it('should keep a live share protected when ending it FAILS (the share is joinable again)', async () => {
      const r = await live();
      r.shares.failing = true;
      r.clock.now = T0 + 5 * MINUTE;

      await failure(() => r.service.endShare(shareId(1)));
      r.clock.now = T0 + 6 * MINUTE;

      should(r.service.window.live()).be.true();
      should(r.service.window.liveSince(T0 + 5 * MINUTE + 1)).be.true();
    });

    it('should keep it protected while the ending write is PENDING, and when that write then fails', async () => {
      const r = await live();
      const release = r.shares.hold();
      r.clock.now = T0 + 5 * MINUTE;

      const ending = r.service.endShare(shareId(1)).catch((error: unknown) => error);
      await settle();
      r.clock.now = T0 + 6 * MINUTE;
      should(r.service.window.live()).be.true();
      should(r.service.window.liveSince(T0 + 5 * MINUTE + 1)).be.true();

      r.shares.failing = true;
      release();
      await ending;
      r.clock.now = T0 + 7 * MINUTE;

      should(r.service.window.live()).be.true();
      should(r.service.window.liveSince(T0 + 6 * MINUTE)).be.true();
    });

    it('should close it only once the ending write has committed', async () => {
      const r = await live();
      const release = r.shares.hold();
      r.clock.now = T0 + 5 * MINUTE;

      const ending = r.service.endShare(shareId(1));
      await settle();
      should(r.service.window.live()).be.true();
      release();
      await ending;
      r.clock.now = T0 + 8 * MINUTE;

      should(r.service.window.live()).be.false();
      should(r.service.window.liveSince(T0 + 4 * MINUTE)).be.true();
      should(r.service.window.liveSince(T0 + 6 * MINUTE)).be.false();
    });

    it('should keep it protected when a catalog removal that would end the share fails to write', async () => {
      const r = await live();
      r.shares.failing = true;
      r.clock.now = T0 + 5 * MINUTE;

      await failure(() => r.service.forgetCatalog(catalogId(1)));
      r.clock.now = T0 + 6 * MINUTE;

      should(r.service.window.live()).be.true();
      should(r.service.window.liveSince(T0 + 5 * MINUTE + 1)).be.true();
    });

    it('should protect a freshly minted share while its first write is still pending', async () => {
      const r = await rig();
      const release = r.shares.hold();

      const minting = r.service.mint(singleFor('Alice', [catalogId(1)]));
      await settle();
      should(r.service.window.live()).be.true();
      release();
      await minting;
      should(r.service.window.live()).be.true();
    });
  });
});
