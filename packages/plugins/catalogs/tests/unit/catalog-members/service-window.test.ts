import { describe, it } from 'bun:test';
import should from 'should';
import { catalogId, HOUR, iso, MINUTE, rig, singleFor, storedShare, sharesDoc, T0 } from './support.ts';

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
});
