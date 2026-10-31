import { describe, it } from 'bun:test';
import should from 'should';
import { LiveMemberSessions } from '../../../src/lib/catalog-members/sessions.ts';
import { keyId, memberId } from './support.ts';

function rigOf() {
  const live = new LiveMemberSessions();
  const ended: string[] = [];
  const open = (member: number, key: number) => {
    const name = `${String(member)}/${String(key)}`;
    const release = live.track(memberId(member), keyId(key), () => {
      ended.push(name);
      release();
    });
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
});
