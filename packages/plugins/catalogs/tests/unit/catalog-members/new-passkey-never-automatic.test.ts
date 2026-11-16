import { describe, it } from 'bun:test';
import should from 'should';
import { catalogId, memberId, membersDoc, rig, singleFor, storedKey, storedMember } from './support.ts';

const forAlice = {
  catalogIds: [catalogId(1)],
  member: { kind: 'existing' as const, memberId: memberId(1) },
  expiresIn: '1h' as const,
  uses: { kind: 'single' as const },
};

/** Alice exists and has lost her last passkey: the one case the app pre-ticks "They need a new passkey" for. */
const aliceWithNoPasskey = () =>
  rig({ members: membersDoc(storedMember(1, { label: 'Alice', keys: [storedKey(1, { passkeyCount: 0 })] })) });

describe('"They need a new passkey" is never set for the owner', () => {
  it('should tell the app the person has no passkey left, and still leave the invite unmarked', async () => {
    // Arrange
    const r = await aliceWithNoPasskey();

    // Act
    const minted = await r.service.mint(forAlice);

    // Assert
    should(minted.noPasskeyLeft).equal(true);
    should(minted.share.newPasskey).equal(undefined);
    should(r.shares.document.shares[0]?.newPasskey).equal(undefined);
  });

  it('should keep refusing a join on that unmarked invite: the person is blocked, not opened', async () => {
    // Arrange
    const r = await aliceWithNoPasskey();
    const { code } = await r.service.mint(forAlice);

    // Act
    const need = r.service.joinNeed(code, r.clock.now);

    // Assert
    should(need?.need).equal('blocked');
  });

  it('should open the same invite only once the owner marks it, and only that invite', async () => {
    // Arrange
    const r = await aliceWithNoPasskey();
    const marked = await r.service.mint(forAlice);
    const other = await r.service.mint(forAlice);

    // Act
    await r.service.markNewPasskey(marked.share.shareId, true);

    // Assert
    should(r.service.joinNeed(marked.code, r.clock.now)?.need).equal('owner-approved');
    should(r.service.joinNeed(other.code, r.clock.now)?.need).equal('blocked');
  });

  it('should not set the mark for a first invite, or for a person who still has a passkey', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(storedMember(1, { label: 'Alice', keys: [storedKey(1)] })) });

    // Act
    const first = await r.service.mint(singleFor('Carol'));
    const later = await r.service.mint(forAlice);

    // Assert
    should(first.noPasskeyLeft).equal(undefined);
    should(later.noPasskeyLeft).equal(undefined);
    should(r.shares.document.shares.some(share => share.newPasskey === true)).equal(false);
  });
});
