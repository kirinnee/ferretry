import { describe, it } from 'bun:test';
import { SHARE_LINK_RELAYED_NOTICE } from '@ferretry/protocol';
import should from 'should';
import {
  existingMemberWarning,
  renderCatalogTaken,
  renderKeyRemoved,
  renderMemberList,
  renderMemberRenamed,
  renderMemberRevoked,
  renderMint,
  renderShareEnded,
  renderShareList,
} from '../../../src/lib/catalog-share/render';
import { catalog, CATALOG_ID, OTHER_CATALOG_ID } from '../catalog/fixtures';
import {
  AT,
  KEY_ID,
  LATER,
  LINK,
  RELAYED_LINK,
  MEMBER_ID,
  memberList,
  memberView,
  mintResponse,
  OTHER_KEY_ID,
  SHARE_CODE,
  SHARE_ID,
  shareList,
  shareView,
} from './fixtures';

const catalogs = [catalog(), catalog({ id: OTHER_CATALOG_ID, name: 'Side tools', items: [] })];
const QR = '█▀█\n█▄█';

describe('rendering the shares list', () => {
  it('should say how to start when nothing is shared', () => {
    should(renderShareList(shareList([]), catalogs)).equal(
      'No shares yet. Make one with: fy catalog share <catalog> --member <name> --expires 1h',
    );
  });

  it('should show a live single-use share with the catalog names', () => {
    const text = renderShareList(shareList(), catalogs);
    should(text).containEql(`${SHARE_ID} · Sam (${MEMBER_ID}) · live until ${LATER}`);
    should(text).containEql('  Team tools · single use');
  });

  it('should show an ended state by name, several catalogs, and a catalog this machine no longer has by its id', () => {
    const gone = `cat_${'z'.repeat(22)}`;
    const text = renderShareList(
      shareList([shareView({ state: 'expired', catalogIds: [CATALOG_ID, OTHER_CATALOG_ID, gone] })]),
      catalogs,
    );
    should(text).containEql(`Sam (${MEMBER_ID}) · expired`);
    should(text).containEql(`Team tools, Side tools, ${gone}`);
  });

  it('should show a multi-use share by how many uses are taken, and who took each', () => {
    const text = renderShareList(
      shareList([
        shareView({
          uses: { kind: 'multi', cap: 5 },
          usedBy: [
            { clientName: 'Firefox on a Mac', keyId: KEY_ID, at: AT },
            { clientName: 'Safari', keyId: OTHER_KEY_ID, at: LATER },
          ],
        }),
      ]),
      catalogs,
    );
    should(text).containEql('2 of 5 uses taken');
    should(text).containEql(`  used by Firefox on a Mac (${KEY_ID}) at ${AT}`);
    should(text).containEql(`  used by Safari (${OTHER_KEY_ID}) at ${LATER}`);
  });

  it('should separate shares by a blank line and say no catalogs for an empty set', () => {
    const text = renderShareList(shareList([shareView(), shareView({ catalogIds: [] })]), catalogs);
    should(text).containEql('\n\n');
    should(text).containEql('no catalogs · single use');
  });

  it('should never contain a code or a link', () => {
    should(renderShareList(shareList(), catalogs)).not.containEql('fy_share_');
  });
});

describe('rendering the members list', () => {
  it('should say how to start when nobody has joined', () => {
    should(renderMemberList(memberList([]), catalogs)).equal(
      'Nobody has joined yet. Share a catalog with: fy catalog share <catalog> --member <name> --expires 1h',
    );
  });

  it('should show a person, what they read, and each browser', () => {
    const text = renderMemberList(memberList(), catalogs);
    should(text).containEql(`Sam (${MEMBER_ID}) · since ${AT}`);
    should(text).containEql('  reads: Team tools');
    should(text).containEql(`  Firefox on a Mac (${KEY_ID}) · joined ${AT} · last seen ${LATER} · 1 passkey`);
    should(text).not.containEql('may register a passkey');
  });

  it('should say never seen, count passkeys and show an open passkey window', () => {
    const text = renderMemberList(
      memberList([
        memberView({
          catalogIds: [],
          keys: [
            {
              keyId: KEY_ID,
              clientName: 'Phone',
              joinedAt: AT,
              passkeys: 0,
              passkeyWindowEndsAt: LATER,
            },
            { keyId: OTHER_KEY_ID, clientName: 'Laptop', joinedAt: AT, lastSeenAt: LATER, passkeys: 2 },
          ],
        }),
      ]),
      catalogs,
    );
    should(text).containEql('reads: no catalogs');
    should(text).containEql(
      `Phone (${KEY_ID}) · joined ${AT} · never seen · 0 passkeys · may register a passkey until ${LATER}`,
    );
    should(text).containEql('2 passkeys');
  });

  it('should say no browsers for a person with none, and separate people by a blank line', () => {
    const text = renderMemberList(memberList([memberView({ keys: [] }), memberView({ label: 'Alex' })]), catalogs);
    should(text).containEql('  no browsers');
    should(text).containEql('\n\n');
  });
});

describe('rendering the one-line outcomes', () => {
  it('should say a share ended and its code no longer works', () => {
    should(renderShareEnded(shareView({ state: 'ended' }))).equal(
      `Ended share ${SHARE_ID} for Sam. Its code no longer works.`,
    );
  });

  it('should say a person was renamed', () => {
    should(renderMemberRenamed(memberView({ label: 'Samuel' }))).equal(`${MEMBER_ID} is now called Samuel.`);
  });

  it('should count what a revoke removed, singular and plural', () => {
    should(renderMemberRevoked('Sam', { memberId: MEMBER_ID, keysRemoved: 2, sharesEnded: 1 })).equal(
      `Removed Sam (${MEMBER_ID}): 2 browsers signed out, 1 share ended.`,
    );
    should(renderMemberRevoked('Sam', { memberId: MEMBER_ID, keysRemoved: 1, sharesEnded: 0 })).equal(
      `Removed Sam (${MEMBER_ID}): 1 browser signed out, 0 shares ended.`,
    );
  });

  it('should say a browser was removed and the others still work', () => {
    should(renderKeyRemoved('Sam', { memberId: MEMBER_ID, keyId: KEY_ID })).equal(
      `Removed browser ${KEY_ID} of Sam. Their other browsers still work.`,
    );
  });

  it('should say a catalog was taken away', () => {
    should(renderCatalogTaken('Sam', 'Team tools', { memberId: MEMBER_ID, catalogId: CATALOG_ID })).equal(
      `Sam (${MEMBER_ID}) can no longer read Team tools (${CATALOG_ID}).`,
    );
  });

  it('should word the existing-member warning around what the person can already read', () => {
    should(existingMemberWarning('Sam')).equal(
      'Whoever opens this link can read everything Sam can read, on top of what you are sharing now.',
    );
  });
});

describe('rendering the mint screen', () => {
  const base = {
    mint: mintResponse(),
    catalogs,
    qr: QR,
    columns: 80 as number | undefined,
    warning: undefined as string | undefined,
    binaryName: 'fy',
  };

  it('should show who, what, when, the QR, the link once and how to end the share', () => {
    const text = renderMint(base);
    should(text).containEql('Share link for Sam: Team tools');
    should(text).containEql(`live until ${LATER} · single use`);
    should(text).containEql('  █▀█\n  █▄█');
    should(text.split(LINK).length - 1).equal(1);
    should(text).containEql('This is the only time the link is shown.');
    should(text).containEql(`\`fy catalog unshare ${SHARE_ID}\``);
    should(text).not.containEql('WARNING');
  });

  it('should say the relay carries a loopback-only machine’s link, right under it, and nothing for a direct one', () => {
    const text = renderMint({ ...base, mint: { ...mintResponse(), link: RELAYED_LINK } });
    should(text).containEql(`${RELAYED_LINK}\n${SHARE_LINK_RELAYED_NOTICE}\n`);
    should(renderMint(base)).not.containEql(SHARE_LINK_RELAYED_NOTICE);
  });

  it('should never print the bare code beside the link', () => {
    should(renderMint(base).replace(LINK, '')).not.containEql(SHARE_CODE);
  });

  it('should print the warning in capitals above the QR when sharing to an existing member', () => {
    const text = renderMint({ ...base, warning: existingMemberWarning('Sam') });
    should(text).containEql('WARNING: Whoever opens this link can read everything Sam can read');
    should(text.indexOf('WARNING')).be.below(text.indexOf('█▀█'));
  });

  it('should withhold a QR wider than the window, say so, and still print the link', () => {
    const text = renderMint({ ...base, columns: 4 });
    should(text).not.containEql('█▀█');
    should(text).containEql('The QR needs 5 columns and this window has 4, so it is not drawn');
    should(text).containEql(LINK);
  });

  it('should draw the QR when it just fits and when the width is unknown', () => {
    should(renderMint({ ...base, columns: 5 })).containEql('█▀█');
    should(renderMint({ ...base, columns: undefined })).containEql('█▀█');
  });

  it('should draw no QR block when none was made', () => {
    const text = renderMint({ ...base, qr: undefined });
    should(text).not.containEql('█');
    should(text).not.containEql('The QR needs');
    should(text).containEql(LINK);
  });

  it('should say the uses taken for a multi-use link, and use the binary name given', () => {
    const text = renderMint({
      ...base,
      binaryName: 'ferretry',
      mint: mintResponse({ uses: { kind: 'multi', cap: 20 } }),
    });
    should(text).containEql('0 of 20 uses taken');
    should(text).containEql(`\`ferretry catalog unshare ${SHARE_ID}\``);
  });
});
