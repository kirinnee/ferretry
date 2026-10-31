import { describe, it } from 'bun:test';
import should from 'should';
import {
  codeOf,
  DAY,
  failure,
  iso,
  joinOf,
  keyId,
  memberId,
  memberOf,
  membersDoc,
  MINUTE,
  newKey,
  rig,
  sharesDoc,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

describe('CatalogMemberService.sweep', () => {
  it('should answer nothing and write nothing when time has ended no browser', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [storedKey(71)] })) });

    // Act
    const removed = await r.service.sweep();

    // Assert
    should(removed).eql([]);
    should(r.log).eql([]);
  });

  it('should remove a joined browser with no passkey at the moment its ten minutes close, and not before', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    const joined = await r.service.commit(reservation, newKey(1));
    await r.service.flushed();
    r.log.length = 0;

    // Act
    r.clock.now = T0 + 10 * MINUTE - 1;
    const early = await r.service.sweep();
    r.clock.now = T0 + 10 * MINUTE;
    const removed = await r.service.sweep();

    // Assert
    should(early).eql([]);
    should(removed).eql([{ memberId: memberId(1), keyId: joined.keyId, why: 'passkey-window' }]);
    should(memberOf(r.members.document, 1).keys).eql([]);
    should(r.log).eql(['members.write', `closeKey:${memberId(1)}:${joined.keyId}`]);
  });

  it('should keep a browser that registered a passkey, and stop listing its closed window', async () => {
    // Arrange
    const key = storedKey(71, { passkeyCount: 1, passkeyWindowEndsAt: iso(T0 - 1) });
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [key] })) });

    // Act
    const removed = await r.service.sweep();

    // Assert
    should(removed).eql([]);
    should(r.log).eql(['members.write']);
    should(memberOf(r.members.document, 7).keys[0]).not.have.property('passkeyWindowEndsAt');
  });

  it('should remove a browser nobody has used for ninety days, and close its sessions after the write', async () => {
    // Arrange
    const idle = storedKey(71, { lastSeenAt: iso(T0 - 90 * DAY) });
    const busy = storedKey(72, { lastSeenAt: iso(T0 - DAY) });
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [idle, busy] })) });

    // Act
    const removed = await r.service.sweep();

    // Assert
    should(removed).eql([{ memberId: memberId(7), keyId: keyId(71), why: 'idle' }]);
    should(memberOf(r.members.document, 7).keys.map(key => key.keyId)).eql([keyId(72)]);
    should(r.log).eql(['members.write', `closeKey:${memberId(7)}:${keyId(71)}`]);
  });

  it('should close the sessions of every browser it removed, in order', async () => {
    // Arrange
    const members = membersDoc(
      storedMember(7, { keys: [storedKey(71, { lastSeenAt: iso(T0 - 100 * DAY) })] }),
      storedMember(8, { keys: [storedKey(81, { lastSeenAt: iso(T0 - 100 * DAY) })] }),
    );
    const r = await rig({ members });

    // Act
    const removed = await r.service.sweep();

    // Assert
    should(removed).have.length(2);
    should(r.log).eql([
      'members.write',
      `closeKey:${memberId(7)}:${keyId(71)}`,
      `closeKey:${memberId(8)}:${keyId(81)}`,
    ]);
  });

  it('should put the browsers back, and close nothing, when the write fails', async () => {
    // Arrange
    const idle = storedKey(71, { lastSeenAt: iso(T0 - 91 * DAY) });
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [idle] })) });
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.sweep());

    // Assert
    should(error.message).equal('members disk full');
    should((await r.service.listMembers()).members[0]?.keys).have.length(1);
    should(r.log.some(entry => entry.startsWith('closeKey'))).be.false();
  });

  it('should load the documents first when nobody has yet', async () => {
    // Arrange
    const idle = storedKey(71, { lastSeenAt: iso(T0 - 91 * DAY) });
    const r = await rig({ unloaded: true, members: membersDoc(storedMember(7, { keys: [idle] })) });

    // Act
    const removed = await r.service.sweep();

    // Assert
    should(removed).have.length(1);
    should(r.members.reads).equal(1);
  });
});
