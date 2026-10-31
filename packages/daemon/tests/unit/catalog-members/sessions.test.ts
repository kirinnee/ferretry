import { describe, it } from 'bun:test';
import should from 'should';
import { LiveMemberSessions } from '../../../src/lib/catalog-members/sessions.ts';
import { keyId, memberId } from './support.ts';

function rigOf() {
  const live = new LiveMemberSessions();
  const ended: string[] = [];
  const open = (member: number, key: number, session?: string) => {
    const name = `${String(member)}/${String(key)}`;
    const release = live.track(
      memberId(member),
      keyId(key),
      () => {
        ended.push(name);
        release();
      },
      session ?? `session-${name}`,
    );
    return release;
  };
  return { live, ended, open };
}

describe('LiveMemberSessions', () => {
  it('should count what is open and stop counting what ended, however often it is told', () => {
    // Arrange
    const r = rigOf();
    const release = r.open(1, 1);
    r.open(1, 2);

    // Act
    const opened = r.live.size;
    release();
    release();

    // Assert
    should(opened).equal(2);
    should(r.live.size).equal(1);
  });

  it('should end every session of a revoked member and no one else', async () => {
    // Arrange
    const r = rigOf();
    r.open(1, 1);
    r.open(1, 2);
    r.open(2, 3);

    // Act
    await r.live.closeMember(memberId(1));

    // Assert
    should(r.ended.sort()).eql(['1/1', '1/2']);
    should(r.live.size).equal(1);
  });

  it('should end only the sessions of a removed key', async () => {
    // Arrange
    const r = rigOf();
    r.open(1, 1);
    r.open(1, 1);
    r.open(1, 2);
    r.open(2, 1);

    // Act
    await r.live.closeKey(memberId(1), keyId(1));

    // Assert
    should(r.ended).eql(['1/1', '1/1']);
    should(r.live.size).equal(2);
  });

  it('should end nothing when no session matches', async () => {
    // Arrange
    const r = rigOf();
    r.open(1, 1);

    // Act
    await r.live.closeMember(memberId(9));
    await r.live.closeKey(memberId(1), keyId(9));

    // Assert
    should(r.ended).eql([]);
    should(r.live.size).equal(1);
  });

  it('should end a session once, even when closed twice', async () => {
    // Arrange
    const r = rigOf();
    r.open(1, 1);

    // Act
    await r.live.closeMember(memberId(1));
    await r.live.closeMember(memberId(1));

    // Assert
    should(r.ended).eql(['1/1']);
  });

  describe('sparing the session that asks for its own key to go', () => {
    it('should leave a spared session out of closeKey, and close it again once it is no longer spared', async () => {
      // Arrange
      const r = rigOf();
      r.open(1, 1, 'leaving');
      r.open(1, 1, 'other-browser-tab');
      const unspare = r.live.spare('leaving');

      // Act
      await r.live.closeKey(memberId(1), keyId(1));
      const whileSpared = [...r.ended];
      unspare();
      await r.live.closeKey(memberId(1), keyId(1));

      // Assert
      should(whileSpared).eql(['1/1']);
      should(r.ended).eql(['1/1', '1/1']);
    });

    it('should still end a spared session when the whole member is revoked', async () => {
      // Arrange
      const r = rigOf();
      r.open(1, 1, 'leaving');
      r.live.spare('leaving');

      // Act
      await r.live.closeMember(memberId(1));

      // Assert
      should(r.ended).eql(['1/1']);
    });

    it('should spare nothing for a session it does not know', async () => {
      // Arrange
      const r = rigOf();
      r.open(1, 1, 'known');
      const unspare = r.live.spare('unknown');

      // Act
      await r.live.closeKey(memberId(1), keyId(1));
      unspare();

      // Assert
      should(r.ended).eql(['1/1']);
    });
  });
});
